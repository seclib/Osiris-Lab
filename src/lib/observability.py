"""
Osiris Observability Core — Unified System Truth Layer
========================================================

Single source of truth for all system signals. Aggregates events,
metrics, and health data from all Osiris streams.

Architecture:
    ┌─────────────────────────────────────────────────────┐
    │              OBSERVABILITY CORE                      │
    │                                                      │
    │  Events ──→ Normalizer ──→ Metrics                  │
    │                                                      │
    │  Streams:  osiris:system, ai, geoint, graph, alerts │
    │                                                      │
    │  APIs: /health, /metrics, /events (REST + WS)       │
    │  Feeds:  Event Monitor Dashboard                     │
    └─────────────────────────────────────────────────────┘

Normalized Event Schema:
    {
        event_type: str     — standardized action identifier
        source: str         — emitting service
        severity: str       — info | warning | error | critical
        timestamp: str      — ISO 8601 UTC
        payload: dict       — arbitrary JSON data
        event_id: str       — UUID v4
        correlation_id: str — optional trace id
    }

Usage:
    from lib.observability import ObservabilityCore

    core = ObservabilityCore("redis://osiris-data-redis:6379")
    health = core.get_health()
    metrics = core.get_metrics()
    events = core.get_recent_events(stream="system", count=50)
"""

from __future__ import annotations

import logging
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import redis

from lib.events import OsirisEventBus, Event, STREAMS

logger = logging.getLogger("osiris.observability")


# ─────────────────────────────────────────────────────────────────
# NORMALIZED EVENT SCHEMA
# ─────────────────────────────────────────────────────────────────

@dataclass
class NormalizedEvent:
    """Unified event representation across all streams."""

    event_id: str
    event_type: str
    source: str
    severity: str
    timestamp: str
    payload: Dict[str, Any]
    correlation_id: Optional[str] = None
    stream: str = "unknown"
    msg_id: str = ""

    @classmethod
    def from_redis_event(cls, data: Dict[bytes, bytes], stream: str, msg_id: str) -> "NormalizedEvent":
        """Convert raw Redis stream entry to normalized event."""
        def decode(key: bytes, default: str = "") -> str:
            val = data.get(key)
            if val is None:
                return default
            if isinstance(val, bytes):
                return val.decode()
            return str(val)

        import json

        payload_raw = decode(b"payload", "{}")
        try:
            payload = json.loads(payload_raw) if payload_raw else {}
        except json.JSONDecodeError:
            payload = {}

        return cls(
            event_id=decode(b"event_id", "unknown"),
            event_type=decode(b"event_type", "unknown"),
            source=decode(b"source", "unknown"),
            severity=decode(b"severity", "info"),
            timestamp=decode(b"timestamp", datetime.now(timezone.utc).isoformat()),
            payload=payload,
            correlation_id=decode(b"correlation_id") or None,
            stream=stream,
            msg_id=msg_id,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "event_id": self.event_id,
            "event_type": self.event_type,
            "source": self.source,
            "severity": self.severity,
            "timestamp": self.timestamp,
            "payload": self.payload,
            "correlation_id": self.correlation_id,
            "stream": self.stream,
            "msg_id": self.msg_id,
        }


# ─────────────────────────────────────────────────────────────────
# METRICS AGGREGATION
# ─────────────────────────────────────────────────────────────────

@dataclass
class StreamMetrics:
    """Aggregated metrics for a single stream."""

    stream: str
    total_events: int = 0
    events_by_type: Counter = field(default_factory=Counter)
    events_by_severity: Counter = field(default_factory=Counter)
    events_by_source: Counter = field(default_factory=Counter)
    last_event_timestamp: Optional[str] = None
    first_event_timestamp: Optional[str] = None

    def update(self, event: NormalizedEvent) -> None:
        self.total_events += 1
        self.events_by_type[event.event_type] += 1
        self.events_by_severity[event.severity] += 1
        self.events_by_source[event.source] += 1
        if not self.first_event_timestamp:
            self.first_event_timestamp = event.timestamp
        self.last_event_timestamp = event.timestamp

    def to_dict(self) -> Dict[str, Any]:
        return {
            "stream": self.stream,
            "total_events": self.total_events,
            "by_type": dict(self.events_by_type.most_common(20)),
            "by_severity": dict(self.events_by_severity),
            "by_source": dict(self.events_by_source.most_common(20)),
            "last_event": self.last_event_timestamp,
            "first_event": self.first_event_timestamp,
        }


# ─────────────────────────────────────────────────────────────────
# OBSERVABILITY CORE
# ─────────────────────────────────────────────────────────────────

class ObservabilityCore:
    """
    Centralized observability layer for the Osiris platform.

    Provides unified access to all system signals: health status,
    aggregated metrics, and normalized event feeds.

    Parameters:
        redis_url — Redis connection string
    """

    def __init__(self, redis_url: str = "redis://osiris-data-redis:6379"):
        self.redis_url = redis_url
        self.bus = OsirisEventBus(redis_url)
        self.client = self.bus.client
        self._started_at = time.time()

    # ── Health ────────────────────────────────────────────────────

    def get_health(self) -> Dict[str, Any]:
        """Return overall system health status."""
        uptime = int(time.time() - self._started_at)
        # Check Redis connectivity
        try:
            self.client.ping()
            redis_status = "healthy"
        except Exception:
            redis_status = "unhealthy"

        # Check all streams exist and have recent activity
        streams_health = {}
        now = time.time()
        for short_name, stream_name in STREAMS.items():
            if short_name == "dead":
                continue
            try:
                length = self.client.xlen(stream_name)
                # Get last event time
                last = self.client.xrevrange(stream_name, "+", "-", count=1)
                last_ts = 0
                if last:
                    msg_id = last[0][0]
                    if isinstance(msg_id, bytes):
                        msg_id = msg_id.decode()
                    last_ts = int(msg_id.split("-")[0]) / 1000
                staleness = now - last_ts if last_ts else -1
                streams_health[short_name] = {
                    "length": length,
                    "stale_seconds": round(staleness, 1) if staleness > 0 else None,
                    "healthy": staleness < 300 if last_ts else False,  # stale if >5min
                }
            except Exception:
                streams_health[short_name] = {"length": 0, "stale_seconds": None, "healthy": False}

        return {
            "status": "healthy" if redis_status == "healthy" else "degraded",
            "uptime_seconds": uptime,
            "redis": redis_status,
            "streams": streams_health,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }

    # ── Metrics ───────────────────────────────────────────────────

    def get_metrics(self, streams: Optional[List[str]] = None,
                    sample_size: int = 1000) -> Dict[str, Any]:
        """
        Aggregate metrics from one or all streams.

        Returns per-stream event counts, severity distribution,
        source distribution, and event type distribution.
        """
        if streams is None:
            streams = [s for s in STREAMS.keys() if s != "dead"]

        result = {}
        for short_name in streams:
            stream_name = STREAMS.get(short_name, f"osiris:{short_name}")
            metrics = StreamMetrics(stream=stream_name)

            try:
                results = self.client.xrevrange(stream_name, "+", "-", count=sample_size)
                for msg_id_enc, data in results:
                    msg_id = msg_id_enc.decode() if isinstance(msg_id_enc, bytes) else msg_id_enc
                    event = NormalizedEvent.from_redis_event(data, stream_name, msg_id)
                    metrics.update(event)
            except redis.ResponseError:
                pass  # stream may not exist

            result[short_name] = metrics.to_dict()

        return {
            "streams": result,
            "sampled_at": datetime.now(timezone.utc).isoformat(),
            "sample_size": sample_size,
        }

    def get_global_metrics(self) -> Dict[str, Any]:
        """Return consolidated cross-stream metrics."""
        all_metrics = self.get_metrics()
        total_events = 0
        severity_totals: Counter = Counter()
        source_totals: Counter = Counter()

        for short_name, data in all_metrics.get("streams", {}).items():
            total_events += data.get("total_events", 0)
            for sev, count in data.get("by_severity", {}).items():
                severity_totals[sev] += count
            for src, count in data.get("by_source", {}).items():
                source_totals[src] += count

        return {
            "total_events": total_events,
            "severity_distribution": dict(severity_totals),
            "top_sources": dict(source_totals.most_common(10)),
            "active_streams": len(all_metrics.get("streams", {})),
            "uptime_seconds": int(time.time() - self._started_at),
        }

    # ── Events ────────────────────────────────────────────────────

    def get_recent_events(self, stream: str = "system", count: int = 50,
                          severity: Optional[str] = None,
                          event_type: Optional[str] = None,
                          source: Optional[str] = None) -> List[Dict]:
        """Return recent normalized events from a stream with optional filters."""
        stream_name = STREAMS.get(stream, f"osiris:{stream}")
        events = []

        try:
            raw = self.client.xrevrange(stream_name, "+", "-", count=max(count * 2, 100))
            for msg_id_enc, data in raw:
                msg_id = msg_id_enc.decode() if isinstance(msg_id_enc, bytes) else msg_id_enc
                event = NormalizedEvent.from_redis_event(data, stream_name, msg_id)

                # Apply filters
                if severity and event.severity != severity:
                    continue
                if event_type and event.event_type != event_type:
                    continue
                if source and event.source != source:
                    continue

                events.append(event.to_dict())
                if len(events) >= count:
                    break
        except redis.ResponseError:
            pass

        return events

    def get_error_rate(self, stream: str = "system", window_seconds: int = 3600) -> float:
        """Calculate error rate (errors / total) over a time window."""
        stream_name = STREAMS.get(stream, f"osiris:{stream}")
        now_ms = int(time.time() * 1000)
        window_start = now_ms - (window_seconds * 1000)

        total = 0
        errors = 0
        try:
            results = self.client.xrange(stream_name, f"{window_start}-0", f"{now_ms}-0", count=1000)
            for _, data in results:
                sev = data.get(b"severity")
                if sev:
                    sev_str = sev.decode() if isinstance(sev, bytes) else sev
                    total += 1
                    if sev_str in ("error", "critical"):
                        errors += 1
        except redis.ResponseError:
            pass

        return round(errors / max(total, 1), 4)

    # ── Snapshot ──────────────────────────────────────────────────

    def get_full_snapshot(self) -> Dict[str, Any]:
        """Return a complete observability snapshot (health + metrics)."""
        return {
            "health": self.get_health(),
            "global_metrics": self.get_global_metrics(),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }


# ─────────────────────────────────────────────────────────────────
# GLOBAL INSTANCE
# ─────────────────────────────────────────────────────────────────

_obs_core: Optional[ObservabilityCore] = None


def get_observability_core(redis_url: str = "redis://osiris-data-redis:6379") -> ObservabilityCore:
    """Return the global ObservabilityCore singleton."""
    global _obs_core
    if _obs_core is None:
        _obs_core = ObservabilityCore(redis_url)
    return _obs_core