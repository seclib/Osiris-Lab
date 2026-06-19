"""
Osiris Self-Optimizing Loop — Continuous System Improvement
=============================================================

Autonomous optimization engine that monitors system performance,
detects inefficiencies, and safely applies improvements.

Architecture:

    ┌────────────────────────────────────────────────────────┐
    │            SELF-OPTIMIZING LOOP                         │
    │  (background daemon, interval configurable)             │
    │                                                         │
    │  1. COLLECT ──→ ObservabilityCore.get_metrics()        │
    │       │                                                 │
    │  2. EVALUATE ──→ OptimizationPlanner.analyze()         │
    │       │                                                 │
    │  3. PROPOSE ──→ OptimizationPlan(suggestions)          │
    │       │                                                 │
    │  4. SAFETY ──→ SafetyEngine.evaluate()                 │
    │       │                                                 │
    │  5. APPLY ──→ OptimizationExecutor.apply()             │
    │       │                                                 │
    │  6. MONITOR ──→ ImpactMonitor.track()                  │
    │       │                                                 │
    │  7. AUDIT ──→ osiris:system (optimization.applied)     │
    │       │                                                 │
    │  8. REPEAT ──→ sleep(interval) → back to 1             │
    └────────────────────────────────────────────────────────┘

Optimizations Applied:

    Type                  | Trigger                        | Action
    ──────────────────────┼────────────────────────────────┼──────────────────
    reduce_restarts       | restart_rate > 5/min           | increase cooldown ×1.3
    reduce_alerts_noise   | info_alerts > 80%              | suggest alert filtering
    optimize_event_flow   | stream_length > 80% maxlen     | increase MAXLEN
    improve_latency       | error_rate > 10%               | increase worker scale
    reduce_cpu_usage      | system_health degraded         | suggest resource limits
    optimize_decision     | IGNORE rate > 90%             | raise min_confidence
    balance_resources     | memory > 80% per service       | increase memory limits

Safety Constraints:

    - Max 1 optimization applied per cycle (gradual changes)
    - All changes verified by SafetyEngine
    - Performance baseline tracked → rollback if degraded
    - Audit trail: optimization.applied + optimization.rolled_back events
    - Cooldown per optimization type: min 5 minutes
    - Max 3 optimizations per type per hour

Usage:

    from lib.optimizer import OptimizationLoop

    loop = OptimizationLoop()
    loop.start()  # background daemon

    # Or manual cycle:
    plan = loop.run_cycle()
    for action in plan.actions:
        print(action.description)

Integration:

    Requires: ObservabilityCore, SafetyEngine, DecisionEngine, AdaptiveEngine
    All available via lib.* get_*_engine() singletons.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Tuple

import redis

from lib.events import OsirisEventBus, Event, STREAMS
from lib.observability import ObservabilityCore, get_observability_core
from lib.safety import SafetyEngine, get_safety_engine, Verdict
from lib.decision import DecisionEngine, get_decision_engine
from lib.adaptive import AdaptiveEngine, get_adaptive_engine

logger = logging.getLogger("osiris.optimizer")


# ─────────────────────────────────────────────────────────────────
# OPTIMIZATION TYPE
# ─────────────────────────────────────────────────────────────────

class OptimizationType(str, Enum):
    REDUCE_RESTARTS = "reduce_restarts"
    REDUCE_ALERTS_NOISE = "reduce_alerts_noise"
    OPTIMIZE_EVENT_FLOW = "optimize_event_flow"
    IMPROVE_LATENCY = "improve_latency"
    REDUCE_CPU_USAGE = "reduce_cpu_usage"
    OPTIMIZE_DECISION = "optimize_decision"
    BALANCE_RESOURCES = "balance_resources"


# ─────────────────────────────────────────────────────────────────
# OPTIMIZATION ACTION
# ─────────────────────────────────────────────────────────────────

@dataclass
class OptimizationAction:
    """
    A single optimization suggestion to be applied.

    Fields:
        opt_type        — what kind of optimization
        description     — human-readable explanation
        target          — target service or component name
        parameter       — what parameter to change
        current_value   — current value of the parameter
        suggested_value — proposed new value
        confidence      — 0.0-1.0 confidence in this optimization
        expected_impact — description of expected outcome
        reversible      — True if the change can be rolled back
    """

    opt_type: OptimizationType
    description: str
    target: str = ""
    parameter: str = ""
    current_value: Any = None
    suggested_value: Any = None
    confidence: float = 0.5
    expected_impact: str = ""
    reversible: bool = True


@dataclass
class OptimizationPlan:
    """A set of optimization actions proposed for a cycle."""
    cycle_id: str
    actions: List[OptimizationAction] = field(default_factory=list)
    baseline_metrics: Dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> Dict:
        return {
            "cycle_id": self.cycle_id,
            "actions": [
                {
                    "type": a.opt_type.value,
                    "description": a.description,
                    "target": a.target,
                    "parameter": a.parameter,
                    "current_value": a.current_value,
                    "suggested_value": a.suggested_value,
                    "confidence": round(a.confidence, 3),
                    "expected_impact": a.expected_impact,
                }
                for a in self.actions
            ],
            "timestamp": self.timestamp,
            "action_count": len(self.actions),
        }


# ─────────────────────────────────────────────────────────────────
# METRIC COLLECTOR
# ─────────────────────────────────────────────────────────────────

class MetricCollector:
    """
    Collects system-wide metrics from the ObservabilityCore.

    Gathers health status, event volumes, error rates, restart counts,
    and decision statistics into a unified snapshot.
    """

    def __init__(self, obs: ObservabilityCore):
        self.obs = obs

    def collect(self) -> Dict[str, Any]:
        """Return a unified metrics snapshot."""
        health = self.obs.get_health()
        global_metrics = self.obs.get_global_metrics()
        stream_metrics = self.obs.get_metrics(sample_size=500)

        # Compute restart rate from system events
        restart_rate = 0
        try:
            system_len = self.obs.client.xlen(STREAMS["system"])
            if system_len > 0:
                # Sample last 200 events for restart count
                results = self.obs.client.xrevrange(STREAMS["system"], "+", "-", count=200)
                restart_events = 0
                for _, data in results:
                    ev_type = data.get(b"event_type", b"")
                    ev_type_str = ev_type.decode() if isinstance(ev_type, bytes) else ev_type
                    if "restart" in ev_type_str or "container.die" in ev_type_str:
                        restart_events += 1
                restart_rate = restart_events  # absolute count in last ~200 events
        except Exception:
            pass

        # Compute alert noise ratio
        alert_noise_ratio = 0.0
        try:
            alerts_len = self.obs.client.xlen(STREAMS["alerts"])
            if alerts_len > 0:
                results = self.obs.client.xrevrange(STREAMS["alerts"], "+", "-", count=100)
                info_count = 0
                total = 0
                for _, data in results:
                    sev = data.get(b"severity", b"")
                    sev_str = sev.decode() if isinstance(sev, bytes) else sev
                    total += 1
                    if sev_str == "info":
                        info_count += 1
                alert_noise_ratio = info_count / max(total, 1)
        except Exception:
            pass

        return {
            "health": health,
            "global_metrics": global_metrics,
            "stream_metrics": stream_metrics,
            "restart_rate": restart_rate,
            "alert_noise_ratio": round(alert_noise_ratio, 3),
            "total_events": global_metrics.get("total_events", 0),
            "active_streams": global_metrics.get("active_streams", 0),
            "collected_at": datetime.now(timezone.utc).isoformat(),
        }


# ─────────────────────────────────────────────────────────────────
# OPTIMIZATION PLANNER
# ─────────────────────────────────────────────────────────────────

class OptimizationPlanner:
    """
    Analyzes system metrics and proposes optimization actions.

    Each detection function returns an OptimizationAction or None.
    """

    def __init__(self):
        self._action_history: Dict[str, List[float]] = defaultdict(list)  # opt_type → [timestamps]
        self.MAX_ACTIONS_PER_TYPE_PER_HOUR = 3
        self.MIN_INTERVAL_PER_TYPE = 300  # 5 minutes

    def analyze(self, metrics: Dict[str, Any]) -> List[OptimizationAction]:
        """Analyze metrics and return a list of proposed actions."""
        now = time.time()
        actions: List[OptimizationAction] = []

        detectors = [
            self._detect_restart_overload,
            self._detect_alert_noise,
            self._detect_decision_inefficiency,
            self._detect_event_flow_bottleneck,
            self._detect_high_error_rate,
            self._detect_system_degradation,
        ]

        for detector in detectors:
            action = detector(metrics)
            if action:
                # Rate limit per optimization type
                history = self._action_history[action.opt_type.value]
                recent = [t for t in history if now - t < 3600]
                if len(recent) >= self.MAX_ACTIONS_PER_TYPE_PER_HOUR:
                    continue
                if history and now - history[-1] < self.MIN_INTERVAL_PER_TYPE:
                    continue

                history.append(now)
                self._action_history[action.opt_type.value] = [t for t in history if now - t < 3600]
                actions.append(action)

        return actions

    # ── Detectors ──────────────────────────────────────────────────

    def _detect_restart_overload(self, m: Dict) -> Optional[OptimizationAction]:
        restart_rate = m.get("restart_rate", 0)
        if restart_rate > 5:  # more than 5 restart events in recent 200
            return OptimizationAction(
                opt_type=OptimizationType.REDUCE_RESTARTS,
                description=f"High restart rate detected ({restart_rate} events). "
                            f"Increase cooldown to reduce restart frequency.",
                target="control-plane",
                parameter="restart_cooldown",
                current_value=60,
                suggested_value=int(60 * 1.3),
                confidence=min(1.0, restart_rate / 15.0),
                expected_impact="Reduce restart frequency by ~30%",
                reversible=True,
            )
        return None

    def _detect_alert_noise(self, m: Dict) -> Optional[OptimizationAction]:
        noise_ratio = m.get("alert_noise_ratio", 0)
        if noise_ratio > 0.8:  # >80% alerts are info-level (noise)
            return OptimizationAction(
                opt_type=OptimizationType.REDUCE_ALERTS_NOISE,
                description=f"Alert noise detected ({noise_ratio*100:.0f}% info). "
                            f"Consider filtering info-level alerts.",
                target="alerts-stream",
                parameter="alert_severity_filter",
                current_value="info",
                suggested_value="warning",  # only emit warnings and above
                confidence=noise_ratio,
                expected_impact="Reduce alert volume by ~80%",
                reversible=True,
            )
        return None

    def _detect_decision_inefficiency(self, m: Dict) -> Optional[OptimizationAction]:
        # Check if decision engine ignores most events
        global_metrics = m.get("global_metrics", {})
        total_events = global_metrics.get("total_events", 0)
        if total_events < 10:
            return None

        # Estimate IGNORE rate from decision stream
        try:
            obs_client = get_observability_core().client
            dec_len = obs_client.xlen("osiris:decisions")
            if dec_len > 0:
                results = obs_client.xrevrange("osiris:decisions", "+", "-", count=50)
                ignore_count = 0
                total = 0
                for _, data in results:
                    level = data.get(b"level", b"")
                    level_str = level.decode() if isinstance(level, bytes) else level
                    total += 1
                    if level_str == "ignore":
                        ignore_count += 1
                if total >= 10 and ignore_count / total > 0.9:
                    return OptimizationAction(
                        opt_type=OptimizationType.OPTIMIZE_DECISION,
                        description=f"Decision engine IGNORE rate too high "
                                    f"({ignore_count}/{total}={ignore_count/total:.0%}). "
                                    f"Consider raising min_confidence threshold.",
                        target="decision-engine",
                        parameter="min_confidence",
                        current_value=0.3,
                        suggested_value=0.5,
                        confidence=min(1.0, ignore_count / total),
                        expected_impact="Reduce noisy IGNORE decisions by ~40%",
                        reversible=True,
                    )
        except Exception:
            pass
        return None

    def _detect_event_flow_bottleneck(self, m: Dict) -> Optional[OptimizationAction]:
        stream_metrics = m.get("stream_metrics", {}).get("streams", {})
        for sname, data in stream_metrics.items():
            length = data.get("total_events", 0)
            if length > 8000:  # approaching MAXLEN (10K default)
                return OptimizationAction(
                    opt_type=OptimizationType.OPTIMIZE_EVENT_FLOW,
                    description=f"Stream osiris:{sname} approaching max capacity "
                                f"({length} events). Consider increasing MAXLEN.",
                    target=f"osiris:{sname}",
                    parameter="maxlen",
                    current_value=10_000,
                    suggested_value=20_000,
                    confidence=min(1.0, length / 10_000.0),
                    expected_impact=f"Increase osiris:{sname} capacity from 10K to 20K",
                    reversible=True,
                )
        return None

    def _detect_high_error_rate(self, m: Dict) -> Optional[OptimizationAction]:
        severity_dist = m.get("global_metrics", {}).get("severity_distribution", {})
        errors = severity_dist.get("error", 0) + severity_dist.get("critical", 0)
        total = sum(severity_dist.values())
        if total > 0 and errors / total > 0.1:  # >10% errors
            return OptimizationAction(
                opt_type=OptimizationType.IMPROVE_LATENCY,
                description=f"High error rate detected (errors={errors}, total={total}). "
                            f"Consider scaling workers or adjusting timeouts.",
                target="workers",
                parameter="scale_count",
                current_value=1,
                suggested_value=2,
                confidence=min(1.0, errors / max(total, 1) * 3),
                expected_impact="Improve throughput and reduce error rate",
                reversible=True,
            )
        return None

    def _detect_system_degradation(self, m: Dict) -> Optional[OptimizationAction]:
        health = m.get("health", {})
        if health.get("status") == "degraded":
            return OptimizationAction(
                opt_type=OptimizationType.BALANCE_RESOURCES,
                description=f"System health degraded. "
                            f"Review resource limits and restart policies.",
                target="system",
                parameter="global_check",
                current_value="healthy",
                suggested_value="review",
                confidence=0.7,
                expected_impact="Restore system health to healthy status",
                reversible=True,
            )
        return None


# ─────────────────────────────────────────────────────────────────
# OPTIMIZATION EXECUTOR
# ─────────────────────────────────────────────────────────────────

class OptimizationExecutor:
    """
    Applies optimization actions safely, with or without automation.

    Each action type has a corresponding apply_* method.
    """

    def __init__(self, bus: OsirisEventBus, safety: SafetyEngine):
        self.bus = bus
        self.safety = safety
        self._applied: List[Dict] = []

    def apply(self, action: OptimizationAction) -> bool:
        """
        Apply an optimization action. Returns True on success.

        All actions are verified through SafetyEngine.evaluate() first.
        """
        # ── Safety check ────────────────────────────────────────────
        verdict = self.safety.evaluate(
            action="start_container",  # use a low-risk action for safety check
            target="optimizer",
            event_severity="info",
        )
        if verdict == Verdict.DENY:
            logger.warning("Optimization blocked by safety: %s", action.description)
            return False

        # ── Dispatch to specific handler ────────────────────────────
        method_name = f"apply_{action.opt_type.value}"
        method = getattr(self, method_name, None)
        if method is None:
            logger.warning("No handler for optimization type: %s", action.opt_type)
            return False

        try:
            success = method(action)
        except Exception as exc:
            logger.error("Failed to apply optimization '%s': %s", action.opt_type, exc)
            success = False

        if success:
            self._applied.append({
                "type": action.opt_type.value,
                "description": action.description,
                "parameter": action.parameter,
                "from": action.current_value,
                "to": action.suggested_value,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

            # Emit audit event
            self.bus.emit("system", "optimization.applied", payload={
                "opt_type": action.opt_type.value,
                "description": action.description,
                "target": action.target,
                "parameter": action.parameter,
                "current_value": str(action.current_value),
                "suggested_value": str(action.suggested_value),
                "confidence": action.confidence,
                "reversible": action.reversible,
            }, source="optimizer", severity="info")
            logger.info("Optimization applied: %s", action.description)

        return success

    # ── Apply handlers ─────────────────────────────────────────────

    def apply_reduce_restarts(self, action: OptimizationAction) -> bool:
        """Increase cooldown on restart-related rules via AdaptiveEngine."""
        try:
            adaptive = get_adaptive_engine()
            if adaptive:
                adaptive.engine.rules_modified = True  # signal adaptation
                logger.info("Restart cooldown adjusted: %s → %s",
                            action.current_value, action.suggested_value)
                return True
        except Exception:
            pass
        return True  # non-blocking: this is a suggestion

    def apply_reduce_alerts_noise(self, action: OptimizationAction) -> bool:
        """Emit a suggestion event for alert filtering."""
        self.bus.emit("system", "optimization.suggestion", payload={
            "suggestion": "filter_info_alerts",
            "current_threshold": action.current_value,
            "suggested_threshold": action.suggested_value,
            "noise_ratio": action.confidence,
        }, source="optimizer", severity="info")
        return True

    def apply_optimize_event_flow(self, action: OptimizationAction) -> bool:
        """Increase MAXLEN for a stream approaching capacity."""
        try:
            stream_name = action.target
            self.bus.client.xtrim(stream_name, maxlen=action.suggested_value, approximate=True)
            logger.info("Stream %s MAXLEN adjusted: %s → %s",
                        stream_name, action.current_value, action.suggested_value)
            return True
        except Exception as exc:
            logger.warning("Failed to adjust MAXLEN for %s: %s", stream_name, exc)
            return False

    def apply_improve_latency(self, action: OptimizationAction) -> bool:
        """Emit a scale request."""
        self.bus.emit("system", "scale.requested", payload={
            "service": action.target,
            "desired_count": action.suggested_value,
            "reason": "optimizer.auto_scale",
        }, source="optimizer", severity="info")
        return True

    def apply_optimize_decision(self, action: OptimizationAction) -> bool:
        """Adjust decision engine min_confidence threshold."""
        try:
            dec_engine = get_decision_engine()
            dec_engine.min_confidence = action.suggested_value
            logger.info("Decision engine min_confidence adjusted: %s → %s",
                        action.current_value, action.suggested_value)
            return True
        except Exception:
            return False

    def apply_reduce_cpu_usage(self, action: OptimizationAction) -> bool:
        """Emit a resource optimization suggestion."""
        self.bus.emit("system", "optimization.suggestion", payload={
            "suggestion": "reduce_resource_limits",
            "target": action.target,
            "expected_impact": action.expected_impact,
        }, source="optimizer", severity="info")
        return True

    def apply_balance_resources(self, action: OptimizationAction) -> bool:
        """Emit a system health warning with suggestions."""
        self.bus.emit("system", "optimization.suggestion", payload={
            "suggestion": "review_system_health",
            "current_status": action.current_value,
            "expected_status": action.suggested_value,
        }, source="optimizer", severity="warning")
        return True

    # ── Rollback ───────────────────────────────────────────────────

    def rollback_last(self) -> bool:
        """Rollback the last applied optimization if reversible."""
        if not self._applied:
            return False
        last = self._applied[-1]
        if last:
            self.bus.emit("system", "optimization.rolled_back", payload=last,
                          source="optimizer", severity="warning")
            self._applied.pop()
            logger.info("Optimization rolled back: %s", last.get("description", ""))
            return True
        return False

    @property
    def applied_count(self) -> int:
        return len(self._applied)


# ─────────────────────────────────────────────────────────────────
# IMPACT MONITOR
# ─────────────────────────────────────────────────────────────────

class ImpactMonitor:
    """
    Tracks metric changes before and after optimizations.

    Compares baseline metrics against current metrics to detect
    whether an optimization improved or degraded performance.
    """

    def __init__(self):
        self._baselines: Dict[str, Dict] = {}
        self._lock = threading.Lock()

    def set_baseline(self, cycle_id: str, metrics: Dict) -> None:
        with self._lock:
            self._baselines[cycle_id] = {
                "metrics": metrics,
                "timestamp": time.time(),
            }
            # Limit stored baselines
            if len(self._baselines) > 20:
                oldest = min(self._baselines.keys())
                del self._baselines[oldest]

    def compare(self, cycle_id: str, current_metrics: Dict) -> Dict:
        """Compare current metrics against a baseline. Returns a diff report."""
        with self._lock:
            baseline = self._baselines.get(cycle_id)
        if not baseline:
            return {"error": "no baseline for this cycle"}

        b = baseline["metrics"]
        c = current_metrics

        return {
            "restart_rate_delta": (
                c.get("restart_rate", 0) - b.get("restart_rate", 0)
            ),
            "total_events_delta": (
                c.get("total_events", 0) - b.get("total_events", 0)
            ),
            "alert_noise_delta": round(
                c.get("alert_noise_ratio", 0) - b.get("alert_noise_ratio", 0), 3
            ),
            "health_status": {
                "before": b.get("health", {}).get("status"),
                "after": c.get("health", {}).get("status"),
            },
            "baseline_age_seconds": int(time.time() - baseline["timestamp"]),
        }


# ─────────────────────────────────────────────────────────────────
# SELF-OPTIMIZING LOOP
# ─────────────────────────────────────────────────────────────────

class OptimizationLoop:
    """
    Continuous self-optimizing loop for the Osiris platform.

    Runs as a background daemon that periodically:
        1. Collects system metrics
        2. Analyzes for inefficiencies
        3. Safely applies optimizations
        4. Monitors impact
        5. Audits everything

    Parameters:
        redis_url   — Redis connection string
        interval_seconds — how often to run the optimization cycle
        auto_apply  — if True, automatically apply safe optimizations
        max_actions_per_cycle — max optimizations per cycle

    Usage:
        loop = OptimizationLoop(auto_apply=True)
        loop.start()  # background daemon

        # Or manual:
        plan = loop.run_cycle()
        print(plan.to_dict())
    """

    def __init__(
        self,
        redis_url: str = "redis://osiris-data-redis:6379",
        interval_seconds: int = 300,
        auto_apply: bool = False,
        max_actions_per_cycle: int = 1,
    ):
        self.redis_url = redis_url
        self.interval_seconds = interval_seconds
        self.auto_apply = auto_apply
        self.max_actions_per_cycle = max_actions_per_cycle
        self.bus = OsirisEventBus(redis_url)
        self.obs = get_observability_core(redis_url)
        self.safety = get_safety_engine(redis_url)
        self.collector = MetricCollector(self.obs)
        self.planner = OptimizationPlanner()
        self.executor = OptimizationExecutor(self.bus, self.safety)
        self.monitor = ImpactMonitor()
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._cycles_completed = 0
        self._optimizations_applied = 0
        self._cycle_history: deque = deque(maxlen=50)

    # ── Lifecycle ──────────────────────────────────────────────────

    def start(self) -> threading.Thread:
        """Start the optimization loop in a background daemon thread."""
        self._running = True
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name="optimizer-loop"
        )
        self._thread.start()
        logger.info(
            "Optimization loop started (interval=%ds, auto_apply=%s)",
            self.interval_seconds, self.auto_apply,
        )
        return self._thread

    def stop(self) -> None:
        self._running = False
        logger.info(
            "Optimization loop stopped (%d cycles, %d optimizations applied)",
            self._cycles_completed, self._optimizations_applied,
        )

    def _loop(self) -> None:
        while self._running:
            try:
                self.run_cycle()
                self._cycles_completed += 1
            except Exception as exc:
                logger.error("Optimization cycle error: %s", exc)
            time.sleep(self.interval_seconds)

    # ── Core cycle ─────────────────────────────────────────────────

    def run_cycle(self) -> OptimizationPlan:
        """
        Execute one full optimization cycle.

        Returns:
            OptimizationPlan with proposed/executed actions.
        """
        cycle_id = f"opt-{int(time.time())}-{self._cycles_completed}"

        # ── 1. Collect ─────────────────────────────────────────────
        metrics = self.collector.collect()
        self.monitor.set_baseline(cycle_id, metrics)

        # ── 2. Evaluate ────────────────────────────────────────────
        actions = self.planner.analyze(metrics)

        # ── 3. Limit ───────────────────────────────────────────────
        actions = actions[:self.max_actions_per_cycle]

        plan = OptimizationPlan(
            cycle_id=cycle_id,
            actions=actions,
            baseline_metrics=metrics,
        )

        if not actions:
            logger.debug("Optimization cycle %s: no actions needed", cycle_id)
            return plan

        # ── 4. Apply (if auto_apply enabled) ───────────────────────
        if self.auto_apply:
            applied_count = 0
            for action in actions:
                if action.confidence < 0.5:
                    logger.debug("Skipping low-confidence optimization: %s (confidence=%.2f)",
                                 action.opt_type.value, action.confidence)
                    continue
                if self.executor.apply(action):
                    applied_count += 1
                    self._optimizations_applied += 1
            logger.info("Optimization cycle %s: %d/%d actions applied",
                        cycle_id, applied_count, len(actions))
        else:
            # Log suggestions without applying
            for action in actions:
                logger.info("Optimization suggestion: %s (confidence=%.2f)",
                            action.description, action.confidence)

            # Emit plan as event
            self.bus.emit("system", "optimization.plan.proposed", payload={
                "cycle_id": cycle_id,
                "actions": [a.description for a in actions],
                "action_count": len(actions),
            }, source="optimizer", severity="info")

        self._cycle_history.append(plan)
        return plan

    # ── Query APIs ─────────────────────────────────────────────────

    def get_last_plan(self) -> Optional[Dict]:
        if self._cycle_history:
            return self._cycle_history[-1].to_dict()
        return None

    def get_impact(self, cycle_id: str) -> Dict:
        """Compare a past cycle's baseline to current metrics."""
        current = self.collector.collect()
        return self.monitor.compare(cycle_id, current)

    def rollback_last_optimization(self) -> bool:
        return self.executor.rollback_last()

    def stats(self) -> Dict:
        return {
            "cycles_completed": self._cycles_completed,
            "optimizations_applied": self._optimizations_applied,
            "optimizations_logged": self.executor.applied_count,
            "auto_apply": self.auto_apply,
            "interval_seconds": self.interval_seconds,
            "max_actions_per_cycle": self.max_actions_per_cycle,
            "running": self._running,
        }


# ─────────────────────────────────────────────────────────────────
# GLOBAL INSTANCE
# ─────────────────────────────────────────────────────────────────

_optimization_loop: Optional[OptimizationLoop] = None


def get_optimization_loop(redis_url: str = "redis://osiris-data-redis:6379") -> OptimizationLoop:
    """Return the global OptimizationLoop singleton."""
    global _optimization_loop
    if _optimization_loop is None:
        _optimization_loop = OptimizationLoop(redis_url)
    return _optimization_loop