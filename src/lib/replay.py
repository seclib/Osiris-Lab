"""
Osiris Event Replay System — Time-Travel Debugging
====================================================

Enables full event replay from Redis Streams for debugging,
simulation, and state reconstruction.

Architecture:
    Archive Stream ← Proxy Wrapper → Normal Streams
         │              │
    osiris:archive   osiris:system, ai, geoint, graph, alerts
         │
    ReplayEngine
         │
    ┌────┼────┬───────────┐
    Full  Filtered  Dry-Run  Time-Range

Usage:
    from lib.replay import ReplayEngine

    engine = ReplayEngine("redis://osiris-data-redis:6379")

    # Full replay of system stream
    for event in engine.replay("system"):
        print(event)

    # Filtered replay by time range
    for event in engine.replay("ai", start="-24h", end="-1h",
                                event_types=["inference.completed"]):
        handle(event)

    # Dry-run replay (no side effects flag)
    for event in engine.replay("alerts", dry_run=True):
        inspect(event)

CLI:
    python -m lib.replay --stream system --start "-1h" --type "error"
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from typing import Any, Callable, Dict, Generator, List, Optional

import redis

from lib.events import OsirisEventBus, Event, STREAMS

logger = logging.getLogger("osiris.replay")


# ─────────────────────────────────────────────────────────────────
# ARCHIVE STREAM — permanent append-only log
# ─────────────────────────────────────────────────────────────────

ARCHIVE_STREAM = "osiris:archive"
ARCHIVE_MAXLEN = 1_000_000  # 1M events retained (~200-500 MB)


# ─────────────────────────────────────────────────────────────────
# ARCHIVE PROXY — transparently archives events as they emit
# ─────────────────────────────────────────────────────────────────

class ArchiveProxy:
    """
    Transparent proxy that mirrors every emitted event to osiris:archive.

    Wraps OsirisEventBus and duplicates all XADD calls to the archive
    stream, which is kept with a very large MAXLEN for permanent storage.

    Usage:
        bus = OsirisEventBus("redis://...")
        proxy = ArchiveProxy(bus)
        proxy.emit("system", "test", payload={})  # → system + archive
    """

    def __init__(self, bus: OsirisEventBus):
        self.bus = bus
        self._client = bus.client

    def emit(self, stream: str, event_type: str, payload: Optional[Dict] = None,
             source: str = "unknown", severity: str = "info",
             correlation_id: Optional[str] = None) -> str:
        """Emit to target stream AND archive."""
        # Emit to target stream normally
        msg_id = self.bus.emit(stream, event_type, payload, source, severity, correlation_id)

        # Also emit to archive with stream reference
        stream_name = STREAMS.get(stream, stream)
        event = Event(
            event_type=event_type,
            source=source,
            payload=payload or {},
            severity=severity,
            correlation_id=correlation_id,
        )
        archive_data = event.to_dict()
        # Add archive metadata
        archive_data["_original_stream"] = stream_name
        archive_data["_original_msg_id"] = msg_id
        archive_data["_archived_at"] = datetime.now(timezone.utc).isoformat()

        try:
            self._client.xadd(ARCHIVE_STREAM, archive_data, maxlen=ARCHIVE_MAXLEN, approximate=True)
        except redis.RedisError as exc:
            logger.warning("Failed to archive event to %s: %s", ARCHIVE_STREAM, exc)

        return msg_id

    def __getattr__(self, name: str):
        # Delegate all other calls to the underlying bus
        return getattr(self.bus, name)


# ─────────────────────────────────────────────────────────────────
# REPLAY ENGINE — core time-travel logic
# ─────────────────────────────────────────────────────────────────

@dataclass
class ReplayConfig:
    """Configuration for a replay session."""
    stream: str = "system"
    start: Optional[str] = None       # "-1h", "-24h", "2026-06-01T00:00:00Z"
    end: Optional[str] = None         # "-30m", "now", None (unbounded)
    event_types: Optional[List[str]] = None  # filter by event_type
    sources: Optional[List[str]] = None     # filter by source service
    severities: Optional[List[str]] = None  # filter by severity
    dry_run: bool = False             # True → inhibit side-effect flag
    max_events: int = 10_000          # safety cap
    from_archive: bool = True         # use archive stream (permanent)


class ReplayEngine:
    """
    Core replay engine for time-travel debugging.

    Retrieves events from Redis Streams (osiris:archive or the target
    stream directly) with time-range filtering and optional dry-run mode.

    Parameters:
        redis_url  — Redis connection string
        proxy      — optional ArchiveProxy (if not provided, direct XREAD)
    """

    def __init__(self, redis_url: str = "redis://osiris-data-redis:6379"):
        self.bus = OsirisEventBus(redis_url)
        self.client = self.bus.client

    # ── Time parsing ──────────────────────────────────────────────

    def _parse_time(self, spec: str) -> str:
        """Convert a relative or absolute time spec to a Redis stream ID (ms-0 format)."""
        if spec is None or spec == "now":
            return "+"
        if spec == "beginning" or spec == "0":
            return "0"

        # Absolute ISO timestamp
        if "T" in spec:
            try:
                dt = datetime.fromisoformat(spec.replace("Z", "+00:00"))
                epoch_ms = int(dt.timestamp() * 1000)
                return f"{epoch_ms}-0"
            except ValueError:
                pass

        # Relative time (e.g. "-1h", "-30m", "-2d")
        if spec.startswith("-"):
            multipliers = {"s": 1, "m": 60, "h": 3600, "d": 86400}
            unit = spec[-1]
            value = int(spec[1:-1]) if len(spec) > 2 else int(spec[1:])
            seconds = value * multipliers.get(unit, 3600)
            epoch_ms = int((time.time() - seconds) * 1000)
            return f"{epoch_ms}-0"

        return spec  # assume it's already a Redis ID

    # ── Replay methods ────────────────────────────────────────────

    def replay(self, stream: str = "system", *,
               start: Optional[str] = None,
               end: Optional[str] = None,
               event_types: Optional[List[str]] = None,
               sources: Optional[List[str]] = None,
               severities: Optional[List[str]] = None,
               dry_run: bool = False,
               max_events: int = 10_000,
               from_archive: bool = True) -> Generator[Event, None, None]:
        """
        Replay events from a stream or archive.

        Args:
            stream      — stream name (e.g. "system", "ai")
            start       — time spec ("-1h", "2026-06-01T00:00:00Z", None=beginning)
            end         — time spec (None=unbounded)
            event_types — filter by event_type field
            sources     — filter by source field
            severities  — filter by severity field
            dry_run     — if True, events are marked as replayed (no side effects)
            max_events  — maximum number of events to yield
            from_archive — use osiris:archive (permanent log) if True

        Yields:
            Event objects with an extra `replayed` attribute set to True.
        """
        source_stream = ARCHIVE_STREAM if from_archive else STREAMS.get(stream, stream)
        start_id = self._parse_time(start or "0")
        end_id = self._parse_time(end or "+")

        logger.info("Replay session: stream=%s (source=%s), start=%s, end=%s, dry_run=%s, filters=%s",
                     stream, source_stream, start_id, end_id, dry_run,
                     {"types": event_types, "sources": sources, "severities": severities})

        yielded = 0
        cursor = start_id

        while yielded < max_events:
            try:
                results = self.client.xrange(source_stream, cursor, end_id, count=100)
            except redis.ResponseError:
                # Stream may not exist or be empty
                break

            if not results:
                break

            for msg_id_enc, data in results:
                event = Event.from_dict(data)
                # Mark as replayed
                event.payload["_replayed"] = True
                event.payload["_replay_dry_run"] = dry_run
                event.payload["_replay_source_stream"] = source_stream

                msg_id = msg_id_enc.decode() if isinstance(msg_id_enc, bytes) else msg_id_enc
                cursor = f"({msg_id}"  # exclusive range for next batch

                # ── Apply filters ──────────────────────────────────
                if event_types and event.event_type not in event_types:
                    continue
                if sources and event.source not in sources:
                    continue
                if severities and event.severity not in severities:
                    continue

                # ── Additional archive filter: original stream ────
                if from_archive:
                    orig_stream = event.payload.get("_original_stream") or data.get(b"_original_stream")
                    if orig_stream:
                        orig_stream = orig_stream.decode() if isinstance(orig_stream, bytes) else orig_stream
                        target = STREAMS.get(stream, stream)
                        if ":" not in stream:
                            target = f"osiris:{stream}"
                        if orig_stream != target and orig_stream != stream:
                            continue

                yield event
                yielded += 1
                if yielded >= max_events:
                    break

            if len(results) < 100:
                break  # end of stream reached

        logger.info("Replay complete: %d events yielded", yielded)

    def replay_by_time(self, stream: str, start: str, end: str, **kwargs) -> Generator[Event, None, None]:
        """Convenience: replay events in a specific time range."""
        return self.replay(stream, start=start, end=end, **kwargs)

    def replay_by_type(self, stream: str, event_types: List[str], **kwargs) -> Generator[Event, None, None]:
        """Convenience: replay events of specific types."""
        return self.replay(stream, event_types=event_types, **kwargs)

    def replay_dry_run(self, stream: str, **kwargs) -> Generator[Event, None, None]:
        """Convenience: dry-run replay (no side effects marked)."""
        return self.replay(stream, dry_run=True, **kwargs)

    # ── Stats ─────────────────────────────────────────────────────

    def archive_stats(self) -> Dict:
        """Return statistics about the archive stream."""
        try:
            info = self.client.xinfo_stream(ARCHIVE_STREAM)
            return {
                "length": info.get(b"length", 0) if isinstance(info.get(b"length"), int) else 0,
                "first_entry": info.get(b"first-entry", b"unknown"),
                "last_entry": info.get(b"last-entry", b"unknown"),
            }
        except redis.ResponseError:
            return {"length": 0, "first_entry": None, "last_entry": None}

    def count_events(self, stream: str = "system", **filters) -> int:
        """Count events matching filters without yielding them."""
        count = 0
        for _ in self.replay(stream, **filters):
            count += 1
        return count


# ─────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Osiris Event Replay CLI")
    parser.add_argument("--stream", default="system", help="Stream to replay")
    parser.add_argument("--start", default=None, help="Start time (-1h, -24h, ISO)")
    parser.add_argument("--end", default=None, help="End time")
    parser.add_argument("--type", default=None, help="Filter by event type")
    parser.add_argument("--source", default=None, help="Filter by source service")
    parser.add_argument("--severity", default=None, help="Filter by severity")
    parser.add_argument("--dry-run", action="store_true", help="Dry run mode")
    parser.add_argument("--max", type=int, default=100, help="Max events to output")
    parser.add_argument("--count", action="store_true", help="Only show count, not events")
    parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    engine = ReplayEngine()
    event_types = [args.type] if args.type else None
    sources = [args.source] if args.source else None
    severities = [args.severity] if args.severity else None

    if args.count:
        count = engine.count_events(
            args.stream, start=args.start, end=args.end,
            event_types=event_types, sources=sources, severities=severities,
        )
        print(f"{count}")
        sys.exit(0)

    for i, event in enumerate(engine.replay(
        args.stream, start=args.start, end=args.end,
        event_types=event_types, sources=sources, severities=severities,
        dry_run=args.dry_run, max_events=args.max,
    )):
        if args.json:
            print(json.dumps({
                "event_id": event.event_id,
                "event_type": event.event_type,
                "source": event.source,
                "severity": event.severity,
                "timestamp": event.timestamp,
                "payload": event.payload,
            }))
        else:
            print(f"[{event.timestamp[:19]}] {event.severity:8s} {event.source:20s} {event.event_type}")
            if event.payload and event.payload != {"_replayed": True, "_replay_dry_run": args.dry_run}:
                payload_str = json.dumps(event.payload, default=str)
                if len(payload_str) > 120:
                    payload_str = payload_str[:120] + "..."
                print(f"  └─ {payload_str}")