"""
Osiris Event SDK — Redis Streams Backed Event System
=====================================================

Production-grade, lightweight event bus using Redis Streams.
Replaces Kafka with a zero-dependency, local-first design.

Architecture:
    Producer                          Consumer
    ────────                          ────────
    emit("osiris:ai", data)     →     listen("osiris:ai", callback)
    emit("osiris:system", data) →     listen(["osiris:*"], callback)

Features:
    - Auto-reconnect on Redis failure
    - Consumer groups (XREADGROUP) for at-least-once delivery
    - Individual consumption (XREAD) for simple pub/sub
    - JSON message format
    - Dead letter stream (osiris:dead)
    - Ack strategy via consumer groups
    - Max stream length (auto-trim)

Usage:
    from lib.events import OsirisEventBus, Event

    bus = OsirisEventBus("redis://osiris-data-redis:6379")

    # Producer
    bus.emit("osiris:system", {"type": "startup", "status": "ok"})

    # Consumer (simple)
    for event in bus.listen("osiris:system"):
        print(event)

    # Consumer (group — at-least-once)
    bus.consume_group("osiris:ai", "ai-worker", callback)

Stream Naming Convention:
    osiris:ai       — AI inference tasks & results
    osiris:geoint   — Geospatial intelligence
    osiris:graph    — Knowledge graph changes
    osiris:system   — Platform health, config, lifecycle
    osiris:alerts   — Critical alerts & threats
    osiris:dead     — Failed/unprocessable events (DLQ)
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Generator, List, Optional

import redis

logger = logging.getLogger("osiris.events")

# ─────────────────────────────────────────────────────────────────
# STREAM NAMES — single source of truth
# ─────────────────────────────────────────────────────────────────

STREAMS = {
    "ai": "osiris:ai",
    "geoint": "osiris:geoint",
    "graph": "osiris:graph",
    "system": "osiris:system",
    "alerts": "osiris:alerts",
    "dead": "osiris:dead",
}

DEFAULT_MAXLEN = 10_000          # auto-trim after 10K entries per stream
DEFAULT_BLOCK_MS = 5000          # consumer block timeout
DEFAULT_GROUP = "osiris-default" # default consumer group


# ─────────────────────────────────────────────────────────────────
# EVENT MODEL
# ─────────────────────────────────────────────────────────────────

@dataclass
class Event:
    """
    Universal event envelope for all Osiris streams.

    Fields:
        event_type  — action identifier (e.g. "task.created", "alert.critical")
        source      — emitting service/component name
        payload     — arbitrary JSON-serializable data
        timestamp   — UTC ISO 8601
        event_id    — unique event identifier (UUID v4)
        correlation_id — link events into traces
        severity    — "info" | "warning" | "error" | "critical"
    """

    event_type: str
    source: str
    payload: Dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    event_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    correlation_id: Optional[str] = None
    severity: str = "info"

    def to_dict(self) -> Dict[str, str]:
        return {
            "event_type": self.event_type,
            "source": self.source,
            "payload": json.dumps(self.payload, default=str),
            "timestamp": self.timestamp,
            "event_id": self.event_id,
            "correlation_id": self.correlation_id or "",
            "severity": self.severity,
        }

    @classmethod
    def from_dict(cls, data: Dict[bytes, bytes]) -> "Event":
        def decode(key: bytes, default: str = "") -> str:
            val = data.get(key)
            if val is None:
                return default
            if isinstance(val, bytes):
                return val.decode()
            return str(val)

        payload_raw = decode(b"payload", "{}")
        try:
            payload = json.loads(payload_raw)
        except (json.JSONDecodeError,):
            payload = {}

        return cls(
            event_type=decode(b"event_type", "unknown"),
            source=decode(b"source", "unknown"),
            payload=payload,
            timestamp=decode(b"timestamp", datetime.now(timezone.utc).isoformat()),
            event_id=decode(b"event_id", uuid.uuid4().hex),
            correlation_id=decode(b"correlation_id") or None,
            severity=decode(b"severity", "info"),
        )


# ─────────────────────────────────────────────────────────────────
# EVENT BUS
# ─────────────────────────────────────────────────────────────────

class OsirisEventBus:
    """
    Redis Streams event bus for Osiris platform.

    Thread-safe, reconnection-tolerant, zero external dependencies
    beyond the `redis` Python client.

    Parameters:
        redis_url   — Redis connection string (e.g. "redis://localhost:6379")
        maxlen      — default MAXLEN for streams (auto-trim)
        blocking_ms — default block timeout for consumer reads
    """

    def __init__(
        self,
        redis_url: str = "redis://osiris-data-redis:6379",
        maxlen: int = DEFAULT_MAXLEN,
        blocking_ms: int = DEFAULT_BLOCK_MS,
    ):
        self.redis_url = redis_url
        self.maxlen = maxlen
        self.blocking_ms = blocking_ms
        self._client: Optional[redis.Redis] = None
        self._lock = threading.Lock()
        self._connect()

    # ── Redis connection ──────────────────────────────────────────

    def _connect(self) -> redis.Redis:
        with self._lock:
            if self._client is not None:
                try:
                    self._client.ping()
                    return self._client
                except redis.RedisError:
                    pass  # reconnect below

            self._client = redis.Redis.from_url(
                self.redis_url,
                decode_responses=False,  # raw bytes for stream fields
                socket_connect_timeout=3,
                socket_keepalive=True,
                health_check_interval=15,
            )
            logger.info("Connected to Redis at %s", self.redis_url)
            return self._client

    @property
    def client(self) -> redis.Redis:
        if self._client is None:
            return self._connect()
        try:
            self._client.ping()
        except (redis.RedisError, ConnectionError):
            return self._connect()
        return self._client

    # ── Emit (Producer) ───────────────────────────────────────────

    def emit(self, stream: str, event_type: str, payload: Optional[Dict] = None,
             source: str = "unknown", severity: str = "info",
             correlation_id: Optional[str] = None) -> str:
        """
        Publish one event to a Redis stream.

        Args:
            stream          — stream name or short key (see STREAMS)
            event_type      — e.g. "task.started", "alert.threat"
            payload         — arbitrary dict payload
            source          — emitting service name
            severity        — info / warning / error / critical
            correlation_id  — optional trace id

        Returns:
            Redis message ID (e.g. "1680000000000-0")
        """
        stream_name = self._resolve_stream(stream)
        event = Event(
            event_type=event_type,
            source=source,
            payload=payload or {},
            severity=severity,
            correlation_id=correlation_id,
        )
        msg_id = self.client.xadd(
            stream_name,
            event.to_dict(),
            maxlen=self.maxlen,
            approximate=True,
        )
        logger.debug("Emit [%s] %s → %s", stream_name, event_type, msg_id)
        return msg_id.decode() if isinstance(msg_id, bytes) else msg_id

    # ── Listen (Simple Consumer) ──────────────────────────────────

    def listen(self, streams: str | List[str], last_id: str = "0",
               count: int = 10) -> Generator[Optional[Event], None, None]:
        """
        Blocking iterator over events (firehose, no consumer group).

        ```python
        for event in bus.listen("osiris:system"):
            handle(event)
        ```
        """
        stream_names = self._resolve_streams(streams) if isinstance(streams, list) else [self._resolve_stream(streams)]
        streams_dict = {s: last_id for s in stream_names}

        while True:
            try:
                results = self.client.xread(
                    streams_dict,
                    count=count,
                    block=self.blocking_ms,
                )
                if results:
                    for sname_enc, messages in results:
                        sname = sname_enc.decode() if isinstance(sname_enc, bytes) else sname_enc
                        for msg_id_enc, data in messages:
                            msg_id = msg_id_enc.decode() if isinstance(msg_id_enc, bytes) else msg_id_enc
                            event = Event.from_dict(data)
                            yield event
                            streams_dict[sname] = msg_id
                else:
                    yield None  # timeout → signal heartbeat
            except (redis.RedisError, ConnectionError) as exc:
                logger.warning("Redis read error: %s — retrying in 1s", exc)
                time.sleep(1)
                self._connect()

    # ── Consumer Group (At-Least-Once) ────────────────────────────

    def consume_group(self, stream: str, group: str, consumer: str,
                      callback: Callable[[Event], bool],
                      count: int = 10,
                      create_if_missing: bool = True) -> None:
        """
        Consume events via a consumer group for at-least-once delivery.

        The callback receives an Event and must return True to ack.

        ```python
        def handle(event: Event) -> bool:
            process(event.payload)
            return True

        bus.consume_group("osiris:ai", "worker-ai", "worker-1", handle)
        ```
        """
        stream_name = self._resolve_stream(stream)
        self._ensure_group(stream_name, group, create_if_missing)

        while True:
            try:
                results = self.client.xreadgroup(
                    group, consumer,
                    {stream_name: ">"},
                    count=count,
                    block=self.blocking_ms,
                )
                if results:
                    for _sname_enc, messages in results:
                        for msg_id_enc, data in messages:
                            msg_id = msg_id_enc.decode() if isinstance(msg_id_enc, bytes) else msg_id_enc
                            event = Event.from_dict(data)
                            try:
                                ok = callback(event)
                            except Exception as exc:
                                logger.error("Consumer callback error: %s", exc)
                                ok = False
                            if ok:
                                self.client.xack(stream_name, group, msg_id)
                            else:
                                logger.warning("Unacked event → %s (msg %s)", stream_name, msg_id)
            except (redis.RedisError, ConnectionError) as exc:
                logger.warning("Redis group read error: %s — retrying", exc)
                time.sleep(1)
                self._connect()

    # ── Group Lifecycle ───────────────────────────────────────────

    def _ensure_group(self, stream_name: str, group: str, create: bool) -> None:
        try:
            self.client.xgroup_create(stream_name, group, id="0", mkstream=True)
            logger.info("Consumer group '%s' created for %s", group, stream_name)
        except redis.ResponseError as exc:
            if "BUSYGROUP" in str(exc):
                return  # group already exists
            raise

    def pending_count(self, stream: str, group: str) -> int:
        """Return the number of pending (unacknowledged) messages."""
        stream_name = self._resolve_stream(stream)
        info = self.client.xpending(stream_name, group)
        return info.get("pending", 0)

    # ── Dead Letter ───────────────────────────────────────────────

    def dead_letter(self, stream: str, event: Event, reason: str = "") -> str:
        """Move an unprocessable event to the dead letter stream."""
        dlq = STREAMS["dead"]
        data = event.to_dict()
        data["original_stream"] = stream
        data["dead_reason"] = reason
        msg_id = self.client.xadd(dlq, data, maxlen=self.maxlen, approximate=True)
        logger.warning("Dead-letter: %s → %s (reason: %s)", event.event_id, dlq, reason)
        return msg_id.decode() if isinstance(msg_id, bytes) else msg_id

    # ── Helpers ───────────────────────────────────────────────────

    def _resolve_stream(self, name: str) -> str:
        """Resolve short name to full stream name."""
        return STREAMS.get(name, name)

    def _resolve_streams(self, names: List[str]) -> List[str]:
        return [self._resolve_stream(n) for n in names]

    def stream_info(self, stream: str) -> Dict:
        """Return Redis XINFO STREAM data."""
        try:
            info = self.client.xinfo_stream(self._resolve_stream(stream))
            return {k.decode(): v for k, v in info.items()}
        except redis.ResponseError:
            return {}

    def stream_length(self, stream: str) -> int:
        """Return the number of entries in a stream."""
        return self.client.xlen(self._resolve_stream(stream))

    # ── Context Manager ───────────────────────────────────────────

    def __enter__(self):
        return self

    def __exit__(self, *args):
        if self._client:
            self._client.close()
            self._client = None


# ─────────────────────────────────────────────────────────────────
# GLOBAL INSTANCE (convenience singleton)
# ─────────────────────────────────────────────────────────────────

_default_bus: Optional[OsirisEventBus] = None


def get_event_bus(redis_url: str = "redis://osiris-data-redis:6379") -> OsirisEventBus:
    """Return the global OsirisEventBus singleton."""
    global _default_bus
    if _default_bus is None:
        _default_bus = OsirisEventBus(redis_url)
    return _default_bus


def emit(stream: str, event_type: str, payload: Optional[Dict] = None,
         source: str = "unknown", **kwargs) -> str:
    """Convenience: emit to the global bus."""
    return get_event_bus().emit(stream, event_type, payload, source, **kwargs)