"""
Osiris Decision Engine — Autonomy Brain
=========================================

Evaluates incoming events against system context and event history
to produce optimized, deterministic system decisions.

Architecture:

    Raw Events (Redis Streams)
              │
              ▼
    ┌─────────────────────────────────────────┐
    │           DECISION ENGINE                │
    │                                          │
    │  ┌──────────────┐  ┌─────────────────┐  │
    │  │ Context      │  │ History         │  │
    │  │ Analyzer     │  │ Analyzer        │  │
    │  │ (system      │  │ (event patterns,│  │
    │  │  state,      │  │  frequency,     │  │
    │  │  health)     │  │  trends)        │  │
    │  └──────┬───────┘  └───────┬─────────┘  │
    │         │                  │             │
    │         └────────┬─────────┘             │
    │                  ▼                       │
    │         ┌───────────────┐               │
    │         │ Risk Scorer   │               │
    │         │ (severity ×   │               │
    │         │  frequency ×  │               │
    │         │  system state)│               │
    │         └───────┬───────┘               │
    │                 │                        │
    │                 ▼                        │
    │         ┌───────────────┐               │
    │         │ Decision      │               │
    │         │ Mapper        │               │
    │         │ (score →      │               │
    │         │  action)      │               │
    │         └───────┬───────┘               │
    │                 │                        │
    │                 ▼                        │
    │         Decision(level, action,          │
    │                   confidence,            │
    │                   reasoning)             │
    └─────────────────────────────────────────┘
              │
              ▼
    osiris:decisions (Redis Stream)
              │
              ▼
    Control Plane (RuleEngine + SafetyEngine)

Decision Levels:

    IGNORE           — no action needed (score < 10)
    LOG              — record for audit (score 10-30)
    ALERT            — emit alert event (score 30-50)
    RESTART_SERVICE  — restart a container (score 50-70)
    SCALE_SERVICE    — scale up/down (score 70-85)
    TRIGGER_ANALYSIS — invoke AI analysis (score 85-100)

Usage:

    from lib.decision import DecisionEngine, Decision

    engine = DecisionEngine()

    for event in bus.listen("system"):
        decision = engine.evaluate(event)
        print(decision.level, decision.action, decision.confidence)

Integration with Control Plane:

    from lib.decision import DecisionEngine
    from lib.safety import get_safety_engine

    dec_engine = DecisionEngine()
    safety = get_safety_engine()

    for event in bus.listen(["system", "alerts", "ai", "geoint", "graph"]):
        decision = dec_engine.evaluate(event)

        if decision.level == DecisionLevel.IGNORE:
            continue

        if safety.evaluate(
            action=decision.action,
            target=event.source,
            event_severity=decision.severity
        ) != Verdict.ALLOW:
            continue

        execute(decision)
"""

from __future__ import annotations

import json
import logging
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Tuple

import redis

from lib.events import OsirisEventBus, Event, STREAMS

logger = logging.getLogger("osiris.decision")


# ─────────────────────────────────────────────────────────────────
# DECISION LEVEL — ignore → trigger_analysis
# ─────────────────────────────────────────────────────────────────

class DecisionLevel(str, Enum):
    IGNORE = "ignore"
    LOG = "log"
    ALERT = "alert"
    RESTART_SERVICE = "restart_service"
    SCALE_SERVICE = "scale_service"
    TRIGGER_ANALYSIS = "trigger_analysis"


DECISION_SCORES = {
    DecisionLevel.IGNORE: 10,
    DecisionLevel.LOG: 30,
    DecisionLevel.ALERT: 50,
    DecisionLevel.RESTART_SERVICE: 70,
    DecisionLevel.SCALE_SERVICE: 85,
    DecisionLevel.TRIGGER_ANALYSIS: 100,
}


def level_for_score(score: int) -> DecisionLevel:
    if score < 10:
        return DecisionLevel.IGNORE
    elif score < 30:
        return DecisionLevel.LOG
    elif score < 50:
        return DecisionLevel.ALERT
    elif score < 70:
        return DecisionLevel.RESTART_SERVICE
    elif score < 85:
        return DecisionLevel.SCALE_SERVICE
    return DecisionLevel.TRIGGER_ANALYSIS


# ─────────────────────────────────────────────────────────────────
# DECISION — structured output
# ─────────────────────────────────────────────────────────────────

@dataclass
class Decision:
    """
    Structured decision produced by the Decision Engine.

    Fields:
        level       — IGNORE | LOG | ALERT | RESTART_SERVICE | SCALE_SERVICE | TRIGGER_ANALYSIS
        action      — concrete action string for execution
        confidence  — 0.0 to 1.0 confidence score
        reasoning   — human-readable reasoning chain
        severity    — event severity that triggered this decision
        context_score — risk score from context analysis (0-100)
        history_score — risk score from history analysis (0-100)
        total_score  — combined score (context + history weighted)
        trigger_event_id — ID of the event that triggered this decision
        suggestions — list of alternative actions considered
        timestamp   — decision timestamp ISO 8601
    """

    level: DecisionLevel
    action: str
    confidence: float
    reasoning: str
    severity: str = "info"
    context_score: int = 0
    history_score: int = 0
    total_score: int = 0
    trigger_event_id: str = ""
    source: str = "unknown"
    suggestions: List[str] = field(default_factory=list)
    timestamp: str = field(default_factory=lambda: __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat())

    def to_dict(self) -> Dict[str, Any]:
        return {
            "level": self.level.value,
            "action": self.action,
            "confidence": round(self.confidence, 3),
            "reasoning": self.reasoning,
            "total_score": self.total_score,
            "context_score": self.context_score,
            "history_score": self.history_score,
            "severity": self.severity,
            "source": self.source,
            "trigger_event_id": self.trigger_event_id,
            "suggestions": self.suggestions,
            "timestamp": self.timestamp,
        }

    @classmethod
    def ignore(cls, event: Event, reason: str = "") -> "Decision":
        return cls(
            level=DecisionLevel.IGNORE,
            action="none",
            confidence=1.0,
            reasoning=reason or "Score below threshold",
            severity=event.severity,
            source=event.source,
            trigger_event_id=event.event_id,
            total_score=0,
        )


# ─────────────────────────────────────────────────────────────────
# SEVERITY WEIGHTS (base score per event severity)
# ─────────────────────────────────────────────────────────────────

SEVERITY_BASE = {
    "info": 5,
    "warning": 20,
    "error": 60,
    "critical": 90,
}

# ── Event type bonuses (pattern recognition) ─────────────────────
EVENT_TYPE_BONUS = {
    "container.died": 25,
    "container.unhealthy": 15,
    "container.die": 25,
    "container.kill": 40,
    "health_status.unhealthy": 15,
    "resource.cpu_spike": 20,
    "network.failure": 35,
    "ai.queue.backlog": 15,
    "graph.ingestion.error": 20,
    "geoint.anomaly.detected": 25,
    "alert.critical": 30,
    "control_plane.action.executed": 5,
    "safety.action.denied": 10,
}

# ── Service criticality modifier ─────────────────────────────────
SERVICE_CRITICALITY = {
    "osiris-nginx-gateway": 30,
    "osiris-data-redis": 25,
    "osiris-data-postgres": 25,
    "osiris-cp-engine": 20,
    "osiris-gateway": 20,
    "osiris-backend": 15,
    "osiris-frontend": 10,
    "osiris-worker-ai": 10,
    "osiris-worker-graph": 10,
    "osiris-worker-threat": 10,
    "osiris-worker-geoint": 10,
}


# ─────────────────────────────────────────────────────────────────
# CONTEXT ANALYZER — evaluates system state
# ─────────────────────────────────────────────────────────────────

class ContextAnalyzer:
    """
    Evaluates current system state to inform decisions.

    Checks stream health, error rates, and service criticality.
    """

    def __init__(self, redis_url: str = "redis://osiris-data-redis:6379"):
        self.bus = OsirisEventBus(redis_url)
        self.client = self.bus.client

    def analyze(self, event: Event) -> Tuple[int, Dict[str, Any]]:
        """
        Return (context_score 0-60, context_data dict).

        Score components:
            - System health status (0-20)
            - Error rate in related stream (0-20)
            - Service criticality modifier (0-20)
        """
        context_data = {}
        score = 0

        # ── 1. System health check (0-20) ─────────────────────────
        try:
            self.client.ping()
            context_data["redis_healthy"] = True
        except Exception:
            score += 20
            context_data["redis_healthy"] = False

        # ── 2. Error rate window (0-20) ───────────────────────────
        stream_name = STREAMS.get(event.event_type.split(".")[0], STREAMS["system"])
        try:
            now_ms = int(time.time() * 1000)
            window_start = now_ms - 300_000  # last 5 minutes
            results = self.client.xrange(stream_name, f"{window_start}-0", f"{now_ms}-0", count=100)
            errors = 0
            total = 0
            for _, data in results:
                sev = data.get(b"severity")
                if sev:
                    sev_str = sev.decode() if isinstance(sev, bytes) else sev
                    total += 1
                    if sev_str in ("error", "critical"):
                        errors += 1
            error_rate = errors / max(total, 1)
            context_data["error_rate_5m"] = round(error_rate, 3)
            context_data["errors_5m"] = errors
            context_data["total_5m"] = total
            if error_rate > 0.3:
                score += 15
            elif error_rate > 0.1:
                score += 10
            elif error_rate > 0:
                score += 5
        except Exception:
            context_data["error_rate_5m"] = None

        # ── 3. Service criticality (0-20) ──────────────────────────
        criticality = SERVICE_CRITICALITY.get(event.source, 5)
        context_data["service_criticality"] = criticality
        score += min(20, criticality // 2)

        return min(60, score), context_data


# ─────────────────────────────────────────────────────────────────
# HISTORY ANALYZER — evaluates event patterns over time
# ─────────────────────────────────────────────────────────────────

class HistoryAnalyzer:
    """
    Detects event frequency patterns and burst behavior.

    Uses a sliding window to track how many times a given event type
    has occurred recently, indicating escalating problems.
    """

    def __init__(self, window_seconds: int = 300, max_tracked: int = 1000):
        self.window_seconds = window_seconds
        self._lock = __import__("threading").Lock()
        self._events: Dict[str, deque] = defaultdict(lambda: deque(maxlen=max_tracked))

    def record(self, event_type: str, source: str, timestamp_epoch: float) -> None:
        """Record an event for pattern analysis."""
        key = f"{source}:{event_type}"
        with self._lock:
            self._events[key].append(timestamp_epoch)

    def analyze(self, event: Event) -> Tuple[int, Dict[str, Any]]:
        """
        Return (history_score 0-40, history_data dict).

        Score components:
            - Burst detection: same event_type count in window (0-20)
            - Source repetition: same source count in window (0-20)
        """
        now = time.time()
        window_start = now - self.window_seconds

        # Record this event
        self.record(event.event_type, event.source, now)

        history_data = {}
        score = 0

        with self._lock:
            # ── Count same event_type from same source ─────────────
            type_key = f"{event.source}:{event.event_type}"
            type_timestamps = self._events.get(type_key, deque())
            recent_type = [t for t in type_timestamps if t > window_start]
            type_count = len(recent_type)
            history_data["event_type_count_5m"] = type_count

            if type_count >= 10:
                score += 20  # burst detected
            elif type_count >= 5:
                score += 15
            elif type_count >= 3:
                score += 10
            elif type_count >= 2:
                score += 5

            # ── Count same source across all event types ───────────
            source_total = 0
            for key, timestamps in self._events.items():
                if key.startswith(f"{event.source}:"):
                    recent = [t for t in timestamps if t > window_start]
                    source_total += len(recent)
            history_data["source_total_5m"] = source_total

            if source_total >= 20:
                score += 20
            elif source_total >= 10:
                score += 15
            elif source_total >= 5:
                score += 10
            elif source_total >= 2:
                score += 5

        return min(40, score), history_data


# ─────────────────────────────────────────────────────────────────
# DECISION ENGINE — core intelligence
# ─────────────────────────────────────────────────────────────────

class DecisionEngine:
    """
    Core decision engine for the Osiris autonomy layer.

    Combines context analysis, history analysis, and risk scoring
    to produce structured, deterministic decisions.

    Parameters:
        redis_url           — Redis connection string
        min_confidence      — minimum confidence to emit a decision
        context_weight      — weight of context score (0.0-1.0)
        history_weight      — weight of history score (0.0-1.0)
    """

    DECISION_STREAM = "osiris:decisions"

    def __init__(
        self,
        redis_url: str = "redis://osiris-data-redis:6379",
        min_confidence: float = 0.3,
        context_weight: float = 0.4,
        history_weight: float = 0.6,
    ):
        self.bus = OsirisEventBus(redis_url)
        self.client = self.bus.client
        self.context = ContextAnalyzer(redis_url)
        self.history = HistoryAnalyzer()
        self.min_confidence = min_confidence
        self.context_weight = context_weight
        self.history_weight = history_weight
        self._decisions_made = 0

    # ── Core evaluation ────────────────────────────────────────────

    def evaluate(self, event: Event) -> Decision:
        """
        Evaluate a single event and produce a decision.

        Args:
            event — an Event from Event SDK

        Returns:
            Decision object with level, action, confidence, reasoning
        """
        # ── 1. Context analysis ────────────────────────────────────
        context_score, context_data = self.context.analyze(event)

        # ── 2. History analysis ────────────────────────────────────
        history_score, history_data = self.history.analyze(event)

        # ── 3. Base score from event severity ──────────────────────
        base_score = SEVERITY_BASE.get(event.severity, 5)

        # ── 4. Event type bonus ────────────────────────────────────
        type_bonus = EVENT_TYPE_BONUS.get(event.event_type, 0)

        # ── 5. Total score (weighted combination) ──────────────────
        #  severity_base (max 90) + event_type_bonus (max 40) = 130
        #  context_score (max 60) + history_score (max 40) = 100
        #  total = weighted avg, capped at 100
        event_raw = min(100, base_score + type_bonus)
        context_raw = context_score
        history_raw = history_score

        total_score = int(
            event_raw * (1.0 - self.context_weight - self.history_weight) +
            context_raw * self.context_weight +
            history_raw * self.history_weight
        )
        total_score = min(100, total_score)

        # ── 6. Map to decision level ───────────────────────────────
        level = level_for_score(total_score)

        # ── 7. Determine action ────────────────────────────────────
        action = self._action_for_level(level, event)

        # ── 8. Confidence computation ──────────────────────────────
        confidence = self._compute_confidence(
            level, total_score, context_data, history_data
        )

        # ── 9. Reasoning ───────────────────────────────────────────
        reasoning = self._build_reasoning(
            level, event, base_score, type_bonus,
            context_score, context_data,
            history_score, history_data,
            total_score, confidence
        )

        # ── 10. Suggestions ────────────────────────────────────────
        suggestions = self._build_suggestions(level, event)

        decision = Decision(
            level=level,
            action=action,
            confidence=round(confidence, 3),
            reasoning=reasoning,
            severity=event.severity,
            source=event.source,
            context_score=context_score,
            history_score=history_score,
            total_score=total_score,
            trigger_event_id=event.event_id,
            suggestions=suggestions,
        )

        # ── 11. Emit decision event ────────────────────────────────
        if confidence >= self.min_confidence:
            self._emit_decision(decision)
            self._decisions_made += 1

        logger.info(
            "Decision: %s → %s (score=%d, confidence=%.2f, reason=%s)",
            event.event_type, level.value, total_score, confidence, decision.reasoning[:80]
        )

        return decision

    # ── Action mapping ─────────────────────────────────────────────

    def _action_for_level(self, level: DecisionLevel, event: Event) -> str:
        """Map a decision level to a concrete action string."""
        mapping = {
            DecisionLevel.IGNORE: "none",
            DecisionLevel.LOG: "log_incident",
            DecisionLevel.ALERT: "emit_alert",
            DecisionLevel.RESTART_SERVICE: "restart_container",
            DecisionLevel.SCALE_SERVICE: "scale_worker",
            DecisionLevel.TRIGGER_ANALYSIS: "trigger_ai_analysis",
        }
        return mapping.get(level, "none")

    # ── Confidence ─────────────────────────────────────────────────

    def _compute_confidence(
        self,
        level: DecisionLevel,
        total_score: int,
        context_data: Dict,
        history_data: Dict,
    ) -> float:
        """Compute confidence 0.0-1.0 based on signal quality."""
        if level == DecisionLevel.IGNORE:
            return 1.0  # high confidence in ignoring

        base_confidence = total_score / 100.0

        # Boost if both context and history agree
        type_count = history_data.get("event_type_count_5m", 0)
        source_total = history_data.get("source_total_5m", 0)

        # High frequency → higher confidence
        if type_count >= 10:
            base_confidence = min(1.0, base_confidence + 0.2)
        if source_total >= 20:
            base_confidence = min(1.0, base_confidence + 0.1)

        return base_confidence

    # ── Reasoning ──────────────────────────────────────────────────

    def _build_reasoning(
        self,
        level: DecisionLevel,
        event: Event,
        base_score: int,
        type_bonus: int,
        context_score: int,
        context_data: Dict,
        history_score: int,
        history_data: Dict,
        total_score: int,
        confidence: float,
    ) -> str:
        """Build a human-readable reasoning chain."""
        parts = []
        parts.append(f"Event '{event.event_type}' from '{event.source}'")
        parts.append(f"severity={event.severity} (base={base_score}, bonus=+{type_bonus})")
        parts.append(f"context={context_score}/60 (errors_5m={context_data.get('errors_5m',0)}, crit={context_data.get('service_criticality',0)})")
        parts.append(f"history={history_score}/40 (type_count={history_data.get('event_type_count_5m',0)}, src_total={history_data.get('source_total_5m',0)})")
        parts.append(f"total={total_score}/100 → {level.value}")
        parts.append(f"confidence={confidence:.2f}")
        return " | ".join(parts)

    # ── Suggestions ────────────────────────────────────────────────

    def _build_suggestions(self, level: DecisionLevel, event: Event) -> List[str]:
        """Generate alternative actions for operator review."""
        suggestions = []
        if level in (DecisionLevel.RESTART_SERVICE, DecisionLevel.SCALE_SERVICE):
            suggestions.append(f"Check container logs: {event.source}")
            suggestions.append(f"Verify health endpoint for {event.source}")
        if level == DecisionLevel.TRIGGER_ANALYSIS:
            suggestions.append(f"Send event payload to AI analysis pipeline")
            suggestions.append(f"Correlate with other streams (alerts, geoint)")
        if level == DecisionLevel.ALERT:
            suggestions.append(f"Escalate to on-call if repeats > 3 in 5min")
        if level == DecisionLevel.IGNORE:
            suggestions.append(f"Monitor for rate increase above threshold")
        return suggestions

    # ── Decision emission ──────────────────────────────────────────

    def _emit_decision(self, decision: Decision) -> str:
        """Emit a decision event into osiris:decisions stream."""
        try:
            msg_id = self.client.xadd(
                self.DECISION_STREAM,
                decision.to_dict(),
                maxlen=10_000,
                approximate=True,
            )
            return msg_id.decode() if isinstance(msg_id, bytes) else msg_id
        except redis.RedisError as exc:
            logger.warning("Failed to emit decision: %s", exc)
            return ""

    # ── Stats ──────────────────────────────────────────────────────

    @property
    def decisions_made(self) -> int:
        return self._decisions_made

    def stats(self) -> Dict:
        return {
            "decisions_made": self._decisions_made,
            "decision_stream": self.DECISION_STREAM,
            "min_confidence": self.min_confidence,
            "weights": {
                "context": self.context_weight,
                "history": self.history_weight,
            },
        }


# ─────────────────────────────────────────────────────────────────
# GLOBAL INSTANCE
# ─────────────────────────────────────────────────────────────────

_decision_engine: Optional[DecisionEngine] = None


def get_decision_engine(redis_url: str = "redis://osiris-data-redis:6379") -> DecisionEngine:
    """Return the global DecisionEngine singleton."""
    global _decision_engine
    if _decision_engine is None:
        _decision_engine = DecisionEngine(redis_url)
    return _decision_engine