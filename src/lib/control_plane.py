"""
Osiris Control Plane — Event-Driven Rule Engine + Action Executor
==================================================================

Lightweight, event-driven decision engine that reacts to Redis Stream
events and performs system actions (restart, scale, alert, trigger AI).

Architecture:
    Redis Streams → Rule Engine → Action Executor
                        │               │
                   Safety Layer ←────────┘
                        │
                   Control Plane Events (osiris:system)

Usage:
    from lib.control_plane import RuleEngine, Action, Rule

    engine = RuleEngine(redis_url="redis://osiris-data-redis:6379")
    engine.add_rule(Rule(
        name="restart-on-crash",
        condition=lambda e: e.event_type == "container.died",
        action=Action.RESTART_CONTAINER,
    ))
    engine.start()  # blocking, runs in its own thread
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set

import docker as dockerlib
import redis

from lib.events import OsirisEventBus, Event

logger = logging.getLogger("osiris.control-plane")


# ─────────────────────────────────────────────────────────────────
# ACTION ENUM — available actions the control plane can perform
# ─────────────────────────────────────────────────────────────────

class Action(str, Enum):
    RESTART_CONTAINER = "restart_container"
    STOP_CONTAINER = "stop_container"
    START_CONTAINER = "start_container"
    EMIT_ALERT = "emit_alert"
    TRIGGER_AI = "trigger_ai_analysis"
    LOG_INCIDENT = "log_incident"
    SCALE_WORKER = "scale_worker"


# ─────────────────────────────────────────────────────────────────
# RULE DEFINITION
# ─────────────────────────────────────────────────────────────────

@dataclass
class Rule:
    """
    A reactive rule evaluated against incoming events.

    Fields:
        name        — human-readable identifier
        condition   — callable(Event) → bool
        action      — Action enum value to execute
        params      — extra parameters passed to action executor
        cooldown_seconds — minimum interval between firings of this rule
        max_fires   — max lifetime fires (None = unlimited)
        enabled     — toggle without removing
    """

    name: str
    condition: Callable[[Event], bool]
    action: Action
    params: Dict[str, Any] = field(default_factory=dict)
    cooldown_seconds: int = 30
    max_fires: Optional[int] = None
    enabled: bool = True


# ─────────────────────────────────────────────────────────────────
# SAFETY LAYER — cooldown, rate-limits, loop detection
# ─────────────────────────────────────────────────────────────────

class SafetyLayer:
    """
    Prevents infinite action loops and enforces safety constraints.

    Tracks:
        - last fire timestamp per rule (cooldown)
        - total fire count per rule (max_fires)
        - recent action history per container (loop detection, max 3 restarts/5min)
    """

    def __init__(self, max_restarts_per_container: int = 3, loop_window_seconds: int = 300):
        self.max_restarts_per_container = max_restarts_per_container
        self.loop_window_seconds = loop_window_seconds
        self._lock = threading.Lock()
        self._last_fire: Dict[str, float] = {}        # rule_name → epoch
        self._fire_counts: Dict[str, int] = {}         # rule_name → count
        self._action_history: Dict[str, List[float]] = {}  # container_name → [timestamps]

    def check(self, rule: Rule, params: Optional[Dict] = None) -> bool:
        """Return True if the action is safe to execute."""
        now = time.time()
        params = params or {}

        with self._lock:
            # ── Check rule enabled ────────────────────────────────
            if not rule.enabled:
                logger.debug("Rule '%s' disabled — skipping", rule.name)
                return False

            # ── Check cooldown ────────────────────────────────────
            last = self._last_fire.get(rule.name, 0)
            if now - last < rule.cooldown_seconds:
                logger.debug("Rule '%s' on cooldown (%.1fs remaining)",
                             rule.name, rule.cooldown_seconds - (now - last))
                return False

            # ── Check max fires ───────────────────────────────────
            if rule.max_fires is not None:
                count = self._fire_counts.get(rule.name, 0)
                if count >= rule.max_fires:
                    logger.warning("Rule '%s' reached max fires (%d) — permanently disabled",
                                   rule.name, rule.max_fires)
                    rule.enabled = False
                    return False

            # ── Check loop detection (per container) ──────────────
            container = params.get("container_name")
            if container and rule.action in (Action.RESTART_CONTAINER, Action.STOP_CONTAINER):
                history = self._action_history.setdefault(container, [])
                # Purge old entries
                cutoff = now - self.loop_window_seconds
                history = [t for t in history if t > cutoff]
                self._action_history[container] = history
                if len(history) >= self.max_restarts_per_container:
                    logger.warning("Loop detected for container '%s': %d actions in %ds — BLOCKED",
                                   container, len(history), self.loop_window_seconds)
                    return False

            # ── All checks passed — record intent ─────────────────
            self._last_fire[rule.name] = now
            self._fire_counts[rule.name] = self._fire_counts.get(rule.name, 0) + 1
            if container:
                self._action_history.setdefault(container, []).append(now)

            return True

    def reset_rule(self, rule_name: str) -> None:
        """Reset safety counters for a specific rule."""
        with self._lock:
            self._last_fire.pop(rule_name, None)
            self._fire_counts.pop(rule_name, None)
            logger.info("Rule '%s' safety counters reset", rule_name)

    def stats(self) -> Dict:
        with self._lock:
            return {
                "active_rules": len(self._fire_counts),
                "total_fires": sum(self._fire_counts.values()),
                "loop_detected_containers": len(self._action_history),
            }


# ─────────────────────────────────────────────────────────────────
# ACTION EXECUTOR — performs the actual system actions
# ─────────────────────────────────────────────────────────────────

class ActionExecutor:
    """
    Executes control plane actions on the host system or via Docker API.

    Requires access to /var/run/docker.sock for container operations.
    """

    def __init__(self, event_bus: OsirisEventBus):
        self.bus = event_bus
        self._docker: Optional[dockerlib.DockerClient] = None
        self._init_docker()

    def _init_docker(self):
        try:
            self._docker = dockerlib.from_env()
            self._docker.ping()
            logger.info("Docker client connected")
        except Exception as exc:
            logger.warning("Docker unavailable — container actions disabled: %s", exc)
            self._docker = None

    def execute(self, action: Action, event: Event, params: Optional[Dict] = None) -> bool:
        """
        Execute the given action. Returns True on success.

        Emits a 'control_plane.action.executed' event on each execution.
        """
        params = params or {}
        method = getattr(self, f"_do_{action.value}", None)
        if method is None:
            logger.error("Unknown action: %s", action)
            return False

        container_name = params.get("container_name", event.source)

        try:
            success = method(container_name, params)
        except Exception as exc:
            logger.error("Action %s failed: %s", action, exc)
            success = False

        # Emit audit event
        self.bus.emit("system", "control_plane.action.executed", payload={
            "rule_event_type": event.event_type,
            "action": action.value,
            "target": container_name,
            "success": success,
            "source_event_id": event.event_id,
        }, source="control-plane", severity="info")

        return success

    # ── Action implementations ────────────────────────────────────

    def _do_restart_container(self, container_name: str, _params: Dict) -> bool:
        if self._docker is None:
            logger.warning("Docker unavailable — cannot restart %s", container_name)
            return False
        try:
            container = self._docker.containers.get(container_name)
            container.restart(timeout=30)
            logger.info("Restarted container: %s", container_name)
            return True
        except dockerlib.errors.NotFound:
            logger.warning("Container not found: %s", container_name)
            return False

    def _do_stop_container(self, container_name: str, _params: Dict) -> bool:
        if self._docker is None:
            return False
        try:
            container = self._docker.containers.get(container_name)
            container.stop(timeout=10)
            logger.info("Stopped container: %s", container_name)
            return True
        except dockerlib.errors.NotFound:
            return False

    def _do_start_container(self, container_name: str, _params: Dict) -> bool:
        if self._docker is None:
            return False
        try:
            container = self._docker.containers.get(container_name)
            container.start()
            logger.info("Started container: %s", container_name)
            return True
        except dockerlib.errors.NotFound:
            return False

    def _do_emit_alert(self, _container_name: str, params: Dict) -> bool:
        self.bus.emit("alerts", "alert.triggered", payload={
            "message": params.get("message", "Control plane alert"),
            "severity": params.get("severity", "warning"),
            "details": params.get("details", {}),
        }, source="control-plane", severity=params.get("severity", "warning"))
        logger.info("Alert emitted: %s", params.get("message", ""))
        return True

    def _do_trigger_ai_analysis(self, _container_name: str, params: Dict) -> bool:
        self.bus.emit("ai", "analysis.requested", payload={
            "reason": params.get("reason", "control-plane-trigger"),
            "context": params.get("context", {}),
            "model": params.get("model", "auto"),
        }, source="control-plane", severity="info")
        logger.info("AI analysis triggered")
        return True

    def _do_log_incident(self, container_name: str, params: Dict) -> bool:
        self.bus.emit("system", "incident.logged", payload={
            "container": container_name,
            "title": params.get("title", "Control plane incident"),
            "severity": params.get("severity", "info"),
            "description": params.get("description", ""),
        }, source="control-plane", severity=params.get("severity", "info"))
        logger.info("Incident logged: %s", params.get("title", ""))
        return True

    def _do_scale_worker(self, container_name: str, params: Dict) -> bool:
        # Lightweight scale: emit event for an orchestrator to handle
        self.bus.emit("system", "scale.requested", payload={
            "service": container_name,
            "desired_count": params.get("count", 2),
            "reason": params.get("reason", "control-plane-auto-scale"),
        }, source="control-plane", severity="info")
        logger.info("Scale requested for %s (count=%d)", container_name, params.get("count", 2))
        return True


# ─────────────────────────────────────────────────────────────────
# RULE ENGINE — evaluates events and triggers actions
# ─────────────────────────────────────────────────────────────────

class RuleEngine:
    """
    Core event-driven decision engine.

    Listens to Redis Streams, evaluates rules, and executes actions
    via the ActionExecutor with SafetyLayer checks.

    Usage:
        engine = RuleEngine("redis://osiris-data-redis:6379")
        engine.add_rule(Rule(name="restart-on-die", ...))
        engine.add_rule(Rule(name="alert-on-critical", ...))
        engine.start()  # blocking; run in a thread
    """

    def __init__(self, redis_url: str = "redis://osiris-data-redis:6379"):
        self.bus = OsirisEventBus(redis_url)
        self.safety = SafetyLayer()
        self.executor = ActionExecutor(self.bus)
        self._rules: List[Rule] = []
        self._lock = threading.Lock()
        self._running = False
        self._thread: Optional[threading.Thread] = None

    # ── Rule management ───────────────────────────────────────────

    def add_rule(self, rule: Rule) -> None:
        with self._lock:
            self._rules.append(rule)
            logger.info("Rule added: %s → %s (cooldown=%ds, max_fires=%s)",
                        rule.name, rule.action.value, rule.cooldown_seconds, rule.max_fires)

    def add_rules(self, rules: List[Rule]) -> None:
        for r in rules:
            self.add_rule(r)

    def remove_rule(self, name: str) -> None:
        with self._lock:
            self._rules = [r for r in self._rules if r.name != name]
            logger.info("Rule removed: %s", name)

    def list_rules(self) -> List[Dict]:
        with self._lock:
            return [{
                "name": r.name,
                "action": r.action.value,
                "enabled": r.enabled,
                "cooldown_seconds": r.cooldown_seconds,
                "max_fires": r.max_fires,
            } for r in self._rules]

    # ── Engine lifecycle ──────────────────────────────────────────

    def start(self) -> None:
        """Start consuming events (blocking). Run in a thread if needed."""
        self._running = True
        logger.info("Rule engine started — %d rules loaded", len(self._rules))

        # Listen to system and alerts streams
        for event in self.bus.listen(["system", "alerts"], count=10):
            if event is None:  # heartbeat / timeout
                continue
            if not self._running:
                break

            self._evaluate(event)

    def start_in_thread(self) -> threading.Thread:
        """Start the rule engine in a daemon thread."""
        self._thread = threading.Thread(target=self.start, daemon=True, name="control-plane-engine")
        self._thread.start()
        logger.info("Rule engine thread started")
        return self._thread

    def stop(self) -> None:
        self._running = False
        logger.info("Rule engine stopped")

    # ── Evaluation ────────────────────────────────────────────────

    def _evaluate(self, event: Event) -> None:
        with self._lock:
            rules = [r for r in self._rules if r.enabled]

        for rule in rules:
            try:
                matches = rule.condition(event)
            except Exception as exc:
                logger.error("Rule '%s' condition raised: %s", rule.name, exc)
                continue

            if not matches:
                continue

            # Safety check
            if not self.safety.check(rule, rule.params):
                continue

            # Execute
            logger.info("Rule '%s' matched → %s (event: %s / %s)",
                        rule.name, rule.action.value, event.event_type, event.source)
            self.executor.execute(rule.action, event, rule.params)

    # ── Stats ─────────────────────────────────────────────────────

    def stats(self) -> Dict:
        return {
            "rules": len(self._rules),
            "rules_enabled": sum(1 for r in self._rules if r.enabled),
            "safety": self.safety.stats(),
        }


# ─────────────────────────────────────────────────────────────────
# DEFAULT RULES — production defaults
# ─────────────────────────────────────────────────────────────────

DEFAULT_RULES = [
    # Container lifecycle
    Rule(
        name="restart-crashed-container",
        condition=lambda e: e.event_type in ("container.die", "container.unhealthy", "container.died"),
        action=Action.RESTART_CONTAINER,
        cooldown_seconds=60,
        max_fires=5,
    ),
    Rule(
        name="log-incident-on-crash",
        condition=lambda e: e.event_type in ("container.die", "container.died"),
        action=Action.LOG_INCIDENT,
        params={"title": "Container crash detected", "severity": "error"},
        cooldown_seconds=300,
    ),

    # Alerts
    Rule(
        name="critical-alert-to-system",
        condition=lambda e: e.event_type == "alert.critical" and e.severity == "critical",
        action=Action.TRIGGER_AI,
        params={"reason": "critical-alert-escalation", "model": "auto"},
        cooldown_seconds=120,
    ),

    # GEOINT anomalies
    Rule(
        name="geoint-anomaly-trigger-ai",
        condition=lambda e: e.event_type == "geoint.anomaly.detected",
        action=Action.TRIGGER_AI,
        params={"reason": "geoint-anomaly-analysis"},
        cooldown_seconds=300,
    ),

    # Graph ingestion errors
    Rule(
        name="graph-error-restart",
        condition=lambda e: e.event_type == "graph.ingestion.error" and e.severity in ("error", "critical"),
        action=Action.RESTART_CONTAINER,
        params={"container_name": "osiris-worker-graph"},
        cooldown_seconds=180,
        max_fires=3,
    ),

    # AI worker overload detection (emit scale request)
    Rule(
        name="ai-worker-overload-scale",
        condition=lambda e: e.event_type == "ai.queue.backlog" and e.payload.get("queue_depth", 0) > 100,
        action=Action.SCALE_WORKER,
        params={"count": 3, "reason": "high-queue-depth"},
        cooldown_seconds=600,
    ),
]