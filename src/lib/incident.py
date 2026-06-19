"""
Osiris Incident Intelligence Engine — Root Cause Detection
=============================================================

Automatically detects incidents, correlates events across streams,
identifies root cause chains, and produces structured incident reports.

Architecture:

    Raw Events (osiris:system, ai, geoint, graph, alerts)
              │
              ▼
    ┌─────────────────────────────────────────────────────────┐
    │            INCIDENT INTELLIGENCE ENGINE                  │
    │                                                          │
    │  1. Event Correlator                                    │
    │     ┌──────────────────────────────────────────────┐    │
    │     │ Links events by:                              │    │
    │     │  - correlation_id                             │    │
    │     │  - time window (±30s)                         │    │
    │     │  - service dependency chain                   │    │
    │     └──────────────────────────────────────────────┘    │
    │                                                          │
    │  2. Causal Graph Builder                                │
    │     ┌──────────────────────────────────────────────┐    │
    │     │  osiris-data-redis (died)                    │    │
    │     │      ├──→ osiris-gateway (unhealthy)         │    │
    │     │      ├──→ osiris-backend (error)             │    │
    │     │      └──→ osiris-worker-ai (timeout)         │    │
    │     └──────────────────────────────────────────────┘    │
    │                                                          │
    │  3. Root Cause Analyzer                                 │
    │     ┌──────────────────────────────────────────────┐    │
    │     │ Root cause: osiris-data-redis                │    │
    │     │ Impacted: gateway, backend, worker-ai        │    │
    │     │ Recommended fix: restart redis, verify conn  │    │
    │     └──────────────────────────────────────────────┘    │
    │                                                          │
    │  4. Incident Reporter → osiris:incidents stream         │
    └─────────────────────────────────────────────────────────┘

Usage:
    from lib.incident import IncidentEngine

    engine = IncidentEngine()

    for event in bus.listen(["system", "alerts"]):
        engine.ingest(event)  # automatically detects and reports incidents

    incidents = engine.get_active_incidents()
    report = engine.get_incident_report(incident_id)

Integration with Event SDK:
    The engine consumes events from osiris:system and osiris:alerts,
    correlates them, builds causal graphs, and emits structured
    incidents into osiris:incidents stream.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import defaultdict, OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

import redis

from lib.events import OsirisEventBus, Event, STREAMS

logger = logging.getLogger("osiris.incident")


# ─────────────────────────────────────────────────────────────────
# INCIDENT SEVERITY
# ─────────────────────────────────────────────────────────────────

class IncidentSeverity(str, Enum):
    P4 = "P4"  # minor, non-blocking
    P3 = "P3"  # moderate, degraded
    P2 = "P2"  # major, service impact
    P1 = "P1"  # critical, platform down


def severity_from_events(events: List[Event]) -> IncidentSeverity:
    scores = {"critical": 4, "error": 3, "warning": 2, "info": 1}
    max_score = max((scores.get(e.severity, 0) for e in events), default=0)
    impacted = len(set(e.source for e in events if e.severity in ("error", "critical")))
    if max_score >= 4 and impacted >= 2:
        return IncidentSeverity.P1
    if max_score >= 4:
        return IncidentSeverity.P2
    if max_score >= 3 and impacted >= 2:
        return IncidentSeverity.P2
    if max_score >= 3:
        return IncidentSeverity.P3
    return IncidentSeverity.P4


# ─────────────────────────────────────────────────────────────────
# SERVICE DEPENDENCY MAP — static knowledge
# ─────────────────────────────────────────────────────────────────

SERVICE_DEPENDENCIES: Dict[str, List[str]] = {
    "osiris-nginx-gateway": ["osiris-frontend", "osiris-backend"],
    "osiris-gateway": ["osiris-data-postgres", "osiris-data-redis", "osiris-infra-proxy"],
    "osiris-cp-engine": ["osiris-data-redis"],
    "osiris-backend": ["osiris-data-redis", "osiris-data-postgres"],
    "osiris-worker-ai": ["osiris-data-redis", "osiris-data-qdrant", "osiris-ai-ollama"],
    "osiris-worker-graph": ["osiris-data-redis", "osiris-data-memgraph"],
    "osiris-worker-geoint": ["osiris-data-redis"],
    "osiris-worker-threat": ["osiris-data-redis"],
    "osiris-worker-digitaltwin": ["osiris-data-redis"],
    "osiris-worker-predictive": ["osiris-data-redis"],
    "osiris-worker-policy": ["osiris-data-redis"],
}

REVERSE_DEPENDENCIES: Dict[str, List[str]] = defaultdict(list)
for svc, deps in SERVICE_DEPENDENCIES.items():
    for dep in deps:
        REVERSE_DEPENDENCIES[dep].append(svc)


# ─────────────────────────────────────────────────────────────────
# INCIDENT — structured output
# ─────────────────────────────────────────────────────────────────

@dataclass
class Incident:
    """
    Structured incident report produced by the Incident Engine.

    Fields:
        incident_id     — unique identifier (UUID)
        severity        — P1 (critical) → P4 (minor)
        title           — human-readable summary
        root_cause      — identified root cause service
        root_cause_event — the event that triggered root cause detection
        impacted_services — services affected (ordered by dependency chain)
        causal_graph    — adjacency dict of service → [dependent services]
        events          — all correlated events
        recommended_fix — suggested remediation action
        detected_at     — timestamp of detection
        status          — "open" | "investigating" | "resolved"
        correlation_window — events within this time window
    """

    incident_id: str
    severity: IncidentSeverity
    title: str
    root_cause: str
    root_cause_event: Optional[Event] = None
    impacted_services: List[str] = field(default_factory=list)
    causal_graph: Dict[str, List[str]] = field(default_factory=dict)
    events: List[Event] = field(default_factory=list)
    recommended_fix: str = ""
    detected_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    status: str = "open"
    correlation_window: Tuple[float, float] = (0, 0)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "incident_id": self.incident_id,
            "severity": self.severity.value,
            "title": self.title,
            "root_cause": self.root_cause,
            "root_cause_event_type": self.root_cause_event.event_type if self.root_cause_event else None,
            "impacted_services": self.impacted_services,
            "causal_graph": self.causal_graph,
            "event_count": len(self.events),
            "events": [
                {
                    "event_type": e.event_type,
                    "source": e.source,
                    "severity": e.severity,
                    "timestamp": e.timestamp,
                    "event_id": e.event_id,
                }
                for e in self.events[:20]  # cap at 20 for report
            ],
            "recommended_fix": self.recommended_fix,
            "detected_at": self.detected_at,
            "status": self.status,
        }


# ─────────────────────────────────────────────────────────────────
# EVENT CORRELATOR
# ─────────────────────────────────────────────────────────────────

class EventCorrelator:
    """
    Links related events across streams using:
        - correlation_id matching
        - time window proximity
        - service dependency chains
    """

    def __init__(self, window_seconds: float = 60.0):
        self.window_seconds = window_seconds
        self._lock = threading.Lock()
        self._recent_events: List[Tuple[float, Event]] = []

    def ingest(self, event: Event) -> None:
        """Store an event for correlation."""
        now = time.time()
        with self._lock:
            self._recent_events.append((now, event))
            # Purge old events
            cutoff = now - self.window_seconds
            self._recent_events = [(t, e) for t, e in self._recent_events if t > cutoff]

    def correlate(self, seed_event: Event) -> List[Event]:
        """
        Find all events correlated with the seed event.

        Correlation criteria:
            1. Same correlation_id
            2. Within time window of seed_event
            3. Service is in dependency chain
        """
        seed_ts = time.time()  # approximate
        related = [seed_event]
        seed_service = seed_event.source

        with self._lock:
            candidates = list(self._recent_events)

        # ── 1. Exact correlation_id match ──────────────────────────
        if seed_event.correlation_id:
            for ts, evt in candidates:
                if evt.correlation_id == seed_event.correlation_id and evt.event_id != seed_event.event_id:
                    related.append(evt)

        # ── 2. Dependency chain match ──────────────────────────────
        dependent_on = SERVICE_DEPENDENCIES.get(seed_service, [])
        dependants_of = REVERSE_DEPENDENCIES.get(seed_service, [])

        for ts, evt in candidates:
            if evt.event_id == seed_event.event_id:
                continue
            if evt in related:
                continue
            # If the event's source is a dependency or dependant of seed
            if evt.source in dependent_on or evt.source in dependants_of:
                related.append(evt)

        return related

    def correlate_events(self, events: List[Event]) -> List[List[Event]]:
        """
        Group multiple events into correlated clusters.

        Returns a list of event groups (each group is a list of correlated events).
        """
        visited: Set[str] = set()
        groups: List[List[Event]] = []

        for seed in events:
            if seed.event_id in visited:
                continue
            cluster = self.correlate(seed)
            group_ids = {e.event_id for e in cluster}
            visited.update(group_ids)
            groups.append(cluster)

        return groups


# ─────────────────────────────────────────────────────────────────
# CAUSAL GRAPH BUILDER
# ─────────────────────────────────────────────────────────────────

class CausalGraph:
    """
    Builds a directed acyclic graph (DAG) showing how failures propagate
    through service dependencies.

    Algorithm:
        1. For each failing service, look at its dependencies
        2. If a dependency also failed earlier, draw an edge
        3. The service with NO dependencies failing before it → root cause
    """

    def __init__(self):
        self._lock = threading.Lock()

    def build(self, events: List[Event]) -> Dict[str, List[str]]:
        """
        Build a causal graph from a set of correlated events.

        Returns:
            adjacency dict: service_name → [list of impacted dependant services]
        """
        # Collect events by service
        by_service: Dict[str, List[Event]] = defaultdict(list)
        for e in events:
            by_service[e.source].append(e)

        # Get the first failure time per service
        first_failure: Dict[str, str] = {}
        for svc, evts in by_service.items():
            first_failure[svc] = min(e.timestamp for e in evts)

        # Build causal edges
        graph: Dict[str, List[str]] = defaultdict(list)

        for svc in list(by_service.keys()):
            dependants = REVERSE_DEPENDENCIES.get(svc, [])
            for dep_svc in dependants:
                if dep_svc in by_service:
                    # If the dependency failed before the dependant → causal edge
                    if first_failure.get(svc, "9999") < first_failure.get(dep_svc, "9999"):
                        graph[svc].append(dep_svc)

        # Deduplicate and sort
        for svc in graph:
            graph[svc] = list(dict.fromkeys(graph[svc]))

        return dict(graph)

    def find_root_cause(self, events: List[Event]) -> Optional[str]:
        """
        Identify the root cause service from a set of events.

        The root cause is the service that:
            1. Is in the earliest failing events
            2. Has no failed dependency before it
            3. Has the highest number of impacted dependants

        Returns:
            service name (str) or None
        """
        graph = self.build(events)
        if not graph:
            # No causal edges → pick the service with earliest failure
            by_time = sorted(events, key=lambda e: e.timestamp)
            return by_time[0].source if by_time else None

        # Nodes with outgoing edges (causes) and no incoming edges (not caused by others)
        outgoing = set(graph.keys())
        incoming = set()
        for deps in graph.values():
            incoming.update(deps)

        root_candidates = outgoing - incoming
        if root_candidates:
            # Pick the one with most outgoing edges
            return max(root_candidates, key=lambda s: len(graph.get(s, [])))

        # Fallback: service with earliest failure
        by_time = sorted(events, key=lambda e: e.timestamp)
        return by_time[0].source if by_time else None

    def get_impacted_services(self, root_cause: str, graph: Dict[str, List[str]]) -> List[str]:
        """
        Get all services impacted by a root cause (transitive closure).
        """
        impacted: List[str] = []
        visited: Set[str] = set()
        queue: List[str] = [root_cause]

        while queue:
            svc = queue.pop(0)
            if svc in visited:
                continue
            visited.add(svc)
            if svc != root_cause:
                impacted.append(svc)
            for dep in graph.get(svc, []):
                if dep not in visited:
                    queue.append(dep)

        return impacted


# ─────────────────────────────────────────────────────────────────
# ROOT CAUSE ANALYZER
# ─────────────────────────────────────────────────────────────────

class RootCauseAnalyzer:
    """
    Analyzes correlated events to produce the root cause and recommendations.
    """

    RECOMMENDATIONS = {
        "container.died": "Restart the container and verify health endpoint",
        "container.die": "Restart the container and check crash logs",
        "container.unhealthy": "Restart the container and verify dependencies",
        "health_status.unhealthy": "Restart the container and verify dependencies",
        "resource.cpu_spike": "Scale the service and investigate CPU usage",
        "network.failure": "Verify network connectivity between containers",
        "ai.queue.backlog": "Scale worker or reduce queue depth",
        "graph.ingestion.error": "Restart graph worker and verify Memgraph connection",
        "geoint.anomaly.detected": "Trigger GEOINT analysis pipeline",
    }

    def analyze(self, events: List[Event], causal_graph: CausalGraph) -> Tuple[str, str, List[str]]:
        """
        Analyze events and return (root_cause, recommended_fix, impacted_services).

        Args:
            events: list of correlated Event objects
            causal_graph: CausalGraph instance

        Returns:
            (root_cause_service, recommended_fix_text, list_of_impacted_services)
        """
        # ── Find root cause ────────────────────────────────────────
        root_cause = causal_graph.find_root_cause(events) or "unknown"
        graph = causal_graph.build(events)
        impacted = causal_graph.get_impacted_services(root_cause, graph)

        # ── Generate recommendation ────────────────────────────────
        # Find the root cause event
        root_events = [e for e in events if e.source == root_cause]
        root_event = root_events[0] if root_events else None

        if root_event:
            fix = self.RECOMMENDATIONS.get(
                root_event.event_type,
                f"Investigate {root_cause}: check logs, health, and dependencies"
            )
        else:
            fix = f"Investigate {root_cause}: check logs and restart if needed"

        return root_cause, fix, impacted


# ─────────────────────────────────────────────────────────────────
# INCIDENT ENGINE — main orchestrator
# ─────────────────────────────────────────────────────────────────

class IncidentEngine:
    """
    Core incident intelligence engine.

    Ingests events in real-time, detects incident patterns, correlates
    related events, identifies root causes, and emits structured
    incident reports.

    Parameters:
        redis_url            — Redis connection string
        min_correlated_events — minimum events to form an incident
        correlation_window    — time window for correlation (seconds)
        max_active_incidents  — max incident events stored in memory

    Usage:
        engine = IncidentEngine()

        for event in bus.listen(["system", "alerts"]):
            engine.ingest(event)

        active = engine.get_active_incidents()
        for inc in active:
            print(inc.root_cause, inc.severity)
    """

    INCIDENT_STREAM = "osiris:incidents"
    MIN_CORRELATED_EVENTS = 3
    CORRELATION_WINDOW = 60.0
    INCIDENT_MIN_INTERVAL = 30  # seconds between incident emissions (dedup)

    def __init__(
        self,
        redis_url: str = "redis://osiris-data-redis:6379",
        min_correlated_events: int = 3,
        correlation_window: float = 60.0,
    ):
        self.bus = OsirisEventBus(redis_url)
        self.client = self.bus.client
        self.correlator = EventCorrelator(window_seconds=correlation_window)
        self.causal_graph = CausalGraph()
        self.root_cause_analyzer = RootCauseAnalyzer()
        self.min_correlated_events = min_correlated_events
        self.correlation_window = correlation_window
        self._lock = threading.Lock()
        self._buffer: List[Event] = []  # recent events pending correlation
        self._active_incidents: Dict[str, Incident] = OrderedDict()
        self._incidents_emitted = 0
        self._last_emit: Dict[str, float] = {}  # service → last emit time (dedup)

    # ── Ingestion ──────────────────────────────────────────────────

    def ingest(self, event: Event) -> Optional[Incident]:
        """
        Ingest a single event and check if it triggers an incident.

        Returns an Incident if one was created, None otherwise.
        """
        # Only process error/critical/warning events
        if event.severity not in ("error", "critical", "warning"):
            self.correlator.ingest(event)
            return None

        self.correlator.ingest(event)

        with self._lock:
            self._buffer.append(event)
            # Purge old events from buffer
            now = time.time()
            self._buffer = [e for e in self._buffer
                          if now - self._event_ts(e) < self.correlation_window]

            # Check if we have enough correlated events
            cluster = self.correlator.correlate(event)
            if len(cluster) < self.min_correlated_events:
                return None

            # Dedup: don't emit same root cause incident too frequently
            root_cause = self.causal_graph.find_root_cause(cluster) or event.source
            last_emit = self._last_emit.get(root_cause, 0)
            if now - last_emit < self.INCIDENT_MIN_INTERVAL:
                return None

            # ── Build incident ─────────────────────────────────────
            root_svc, fix, impacted = self.root_cause_analyzer.analyze(cluster, self.causal_graph)
            graph = self.causal_graph.build(cluster)

            incident = Incident(
                incident_id=f"INC-{int(now)}-{root_svc}",
                severity=severity_from_events(cluster),
                title=f"Root cause: {root_svc} failure affecting {len(impacted)} service(s)",
                root_cause=root_svc,
                impacted_services=impacted,
                causal_graph=graph,
                events=cluster,
                recommended_fix=fix,
                status="open",
            )

            # ── Emit ───────────────────────────────────────────────
            self._emit_incident(incident)
            self._last_emit[root_cause] = now
            self._incidents_emitted += 1

            with self._lock:
                self._active_incidents[incident.incident_id] = incident
                # Limit memory: keep last 50 active
                while len(self._active_incidents) > 50:
                    self._active_incidents.popitem(last=False)

            logger.warning(
                "Incident detected: %s (P%s, root=%s, impacted=%s)",
                incident.incident_id, incident.severity.value,
                root_svc, impacted,
            )
            return incident

    # ── Incident emission ──────────────────────────────────────────

    def _emit_incident(self, incident: Incident) -> str:
        """Emit an incident into the Redis incident stream."""
        try:
            data = incident.to_dict()
            msg_id = self.client.xadd(
                self.INCIDENT_STREAM,
                {k: json.dumps(v, default=str) if isinstance(v, (dict, list)) else str(v)
                 for k, v in data.items()},
                maxlen=10_000,
                approximate=True,
            )
            return msg_id.decode() if isinstance(msg_id, bytes) else msg_id
        except redis.RedisError as exc:
            logger.warning("Failed to emit incident: %s", exc)
            return ""

    # ── Query APIs ─────────────────────────────────────────────────

    def get_active_incidents(self) -> List[Dict]:
        """Return all active (open) incidents."""
        with self._lock:
            return [
                inc.to_dict()
                for inc in self._active_incidents.values()
                if inc.status == "open"
            ]

    def get_incident(self, incident_id: str) -> Optional[Dict]:
        with self._lock:
            inc = self._active_incidents.get(incident_id)
            return inc.to_dict() if inc else None

    def resolve_incident(self, incident_id: str) -> bool:
        with self._lock:
            inc = self._active_incidents.get(incident_id)
            if inc:
                inc.status = "resolved"
                self.bus.emit("system", "incident.resolved", payload={
                    "incident_id": incident_id,
                }, source="incident-engine", severity="info")
                return True
        return False

    def get_incident_history(self, count: int = 20) -> List[Dict]:
        """Get recent incident reports from Redis stream."""
        try:
            results = self.client.xrevrange(self.INCIDENT_STREAM, "+", "-", count=count)
            incidents = []
            for msg_id_enc, data in results:
                item = {}
                for k, v in data.items():
                    key = k.decode() if isinstance(k, bytes) else k
                    val = v.decode() if isinstance(v, bytes) else v
                    try:
                        val = json.loads(val)
                    except (json.JSONDecodeError, TypeError):
                        pass
                    item[key] = val
                incidents.append(item)
            return incidents
        except redis.ResponseError:
            return []

    # ── Stats ──────────────────────────────────────────────────────

    def stats(self) -> Dict:
        return {
            "incidents_emitted": self._incidents_emitted,
            "active_incidents": sum(1 for i in self._active_incidents.values() if i.status == "open"),
            "incident_stream": self.INCIDENT_STREAM,
            "correlation_window": self.correlation_window,
            "min_correlated_events": self.min_correlated_events,
        }

    # ── Helpers ────────────────────────────────────────────────────

    @staticmethod
    def _event_ts(event: Event) -> float:
        try:
            dt = datetime.fromisoformat(event.timestamp.replace("Z", "+00:00"))
            return dt.timestamp()
        except Exception:
            return time.time()


# ─────────────────────────────────────────────────────────────────
# GLOBAL INSTANCE
# ─────────────────────────────────────────────────────────────────

_incident_engine: Optional[IncidentEngine] = None


def get_incident_engine(redis_url: str = "redis://osiris-data-redis:6379") -> IncidentEngine:
    """Return the global IncidentEngine singleton."""
    global _incident_engine
    if _incident_engine is None:
        _incident_engine = IncidentEngine(redis_url)
    return _incident_engine