# -*- coding: utf-8 -*-
"""
Osiris Safety & Guardrails Engine
===================================

Prevents the Control Plane from destabilizing the platform.

Architecture:

    Control Plane Action Request
              │
              ▼
    ┌─────────────────────────────────────────────┐
    │         SAFETY ENGINE                       │
    │                                              │
    │  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
    │  │ Rate     │  │ Cooldown │  │ Risk       │ │
    │  │ Limiter  │  │ Manager  │  │ Scorer     │ │
    │  └────┬─────┘  └────┬─────┘  └─────┬──────┘ │
    │       │              │              │         │
    │       └──────────────┼──────────────┘         │
    │                      ▼                        │
    │               Kill Switch                     │
    │              (global disable)                 │
    │                      │                        │
    │                      ▼                        │
    │              ALLOW / DENY / SIMULATE           │
    └─────────────────────────────────────────────┘

Capabilities:

    - Per-service action limits (max N restarts per minute)
    - Global rate limiter (max actions per second)
    - Cooldown per action type
    - Risk scoring based on event severity
    - Global kill switch (emergency stop)
    - Simulation / dry‑run mode
    - Full audit log of denied actions
    - Event‑driven: emits "safety.action.denied" on block

Integration with Control Plane (src/lib/control_plane.py):

    from lib.safety import SafetyEngine

    safety = SafetyEngine()
    safety.set_kill_switch(False)  # enabled

    # Inside RuleEngine._evaluate():
    if not safety.allow(rule.action, event, rule.params):
        continue  # block unsafe action
    executor.execute(rule.action, event, rule.params)

"""

from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from collections import defaultdict
from typing import Any, Callable, Dict, List, Optional, Set

import redis

from lib.events import OsirisEventBus, Event, STREAMS

logger = logging.getLogger("osiris.safety")


# ─────────────────────────────────────────────────────────────────
# VERDICT — allowed | denied | simulated
# ─────────────────────────────────────────────────────────────────

class Verdict(str, Enum):
    ALLOW = "allow"
    DENY = "deny"
    SIMULATE = "simulate"   # dry-run: log but don't execute


# ─────────────────────────────────────────────────────────────────
# RISK SCORING
# ─────────────────────────────────────────────────────────────────

class RiskLevel(str, Enum):
    SAFE = "safe"           # score 0-20
    LOW = "low"             # score 21-40
    MODERATE = "moderate"   # score 41-60
    HIGH = "high"           # score 61-80
    CRITICAL = "critical"   # score 81-100


SEVERITY_SCORES = {
    "info": 5,
    "warning": 20,
    "error": 60,
    "critical": 90,
}

ACTION_RISK_WEIGHTS = {
    "restart_container": 25,
    "stop_container": 40,
    "start_container": 10,
    "emit_alert": 5,
    "trigger_ai_analysis": 15,
    "log_incident": 5,
    "scale_worker": 20,
}

RISK_THRESHOLDS = {
    RiskLevel.SAFE: 20,
    RiskLevel.LOW: 40,
    RiskLevel.MODERATE: 60,
    RiskLevel.HIGH: 80,
    RiskLevel.CRITICAL: 100,
}


def compute_risk_score(event_severity: str, action: str) -> int:
    """
    Calculate a risk score 0-100 for a given action/event combination.

    Score = severity_base + action_weight, capped at 100.
    """
    sev_score = SEVERITY_SCORES.get(event_severity, 5)
    action_weight = ACTION_RISK_WEIGHTS.get(action, 10)
    return min(100, sev_score + action_weight)


def risk_level(score: int) -> RiskLevel:
    if score <= 20:
        return RiskLevel.SAFE
    elif score <= 40:
        return RiskLevel.LOW
    elif score <= 60:
        return RiskLevel.MODERATE
    elif score <= 80:
        return RiskLevel.HIGH
    return RiskLevel.CRITICAL


# ─────────────────────────────────────────────────────────────────
# RATE LIMITER
# ─────────────────────────────────────────────────────────────────

class RateLimiter:
    """
    Sliding-window rate limiter per service and globally.

    Parameters:
        max_per_service_per_min — max actions per service per minute
        max_global_per_sec — max actions globally per second
    """

    def __init__(self, max_per_service_per_min: int = 5, max_global_per_sec: int = 10):
        self.max_per_service_per_min = max_per_service_per_min
        self.max_global_per_sec = max_global_per_sec
        self._lock = threading.Lock()
        self._service_windows: Dict[str, List[float]] = defaultdict(list)
        self._global_window: List[float] = []

    def check(self, service_name: str) -> bool:
        """Return True if the action is within rate limits."""
        now = time.time()
        with self._lock:
            # Global check
            self._global_window = [t for t in self._global_window if now - t < 1.0]
            if len(self._global_window) >= self.max_global_per_sec:
                return False

            # Per-service check
            window = self._service_windows.setdefault(service_name, [])
            window[:] = [t for t in window if now - t < 60.0]
            if len(window) >= self.max_per_service_per_min:
                return False

            # Record
            self._global_window.append(now)
            window.append(now)
            return True

    def stats(self) -> Dict:
        with self._lock:
            now = time.time()
            return {
                "global_rate_1s": len([t for t in self._global_window if now - t < 1.0]),
                "services_tracked": len(self._service_windows),
                "max_per_service_per_min": self.max_per_service_per_min,
                "max_global_per_sec": self.max_global_per_sec,
            }


# ─────────────────────────────────────────────────────────────────
# COOLDOWN MANAGER
# ─────────────────────────────────────────────────────────────────

class CooldownManager:
    """
    Per-action cooldown mechanism to prevent repeated triggers.

    Tracks last execution time per (action, target) pair.
    """

    def __init__(self, default_cooldown_seconds: int = 30):
        self.default_cooldown = default_cooldown_seconds
        self._lock = threading.Lock()
        self._last_executed: Dict[tuple, float] = {}  # (action, target) → timestamp
        self._cooldowns: Dict[str, int] = {}          # action → seconds

    def set_cooldown(self, action: str, seconds: int) -> None:
        with self._lock:
            self._cooldowns[action] = seconds

    def check(self, action: str, target: str) -> bool:
        """Return True if the cooldown has elapsed for this action+target."""
        now = time.time()
        with self._lock:
            key = (action, target)
            last = self._last_executed.get(key, 0)
            cooldown = self._cooldowns.get(action, self.default_cooldown)
            if now - last < cooldown:
                return False
            self._last_executed[key] = now
            return True

    def reset(self, action: str, target: Optional[str] = None) -> None:
        with self._lock:
            if target:
                self._last_executed.pop((action, target), None)
            else:
                self._last_executed = {k: v for k, v in self._last_executed.items() if k[0] != action}


# ─────────────────────────────────────────────────────────────────
# KILL SWITCH
# ─────────────────────────────────────────────────────────────────

class KillSwitch:
    """
    Global emergency stop for all automated actions.

    When engaged, all actions are blocked regardless of other policies.
    Can be toggled via API or manually.
    """

    def __init__(self):
        self._engaged = False
        self._lock = threading.Lock()
        self._engaged_at: Optional[float] = None
        self._reason: str = ""

    @property
    def engaged(self) -> bool:
        """True if the kill switch is active."""
        with self._lock:
            return self._engaged

    def engage(self, reason: str = "manual") -> None:
        """Activate the kill switch — all automation stops."""
        with self._lock:
            if not self._engaged:
                self._engaged = True
                self._engaged_at = time.time()
                self._reason = reason
                logger.warning("🛑 KILL SWITCH ENGAGED — reason: %s", reason)

    def disengage(self) -> None:
        """Deactivate the kill switch — resume automation."""
        with self._lock:
            if self._engaged:
                self._engaged = False
                self._engaged_at = None
                self._reason = ""
                logger.info("✅ Kill switch disengaged — automation resumed")

    def status(self) -> Dict:
        with self._lock:
            return {
                "engaged": self._engaged,
                "engaged_at": self._engaged_at,
                "reason": self._reason,
                "elapsed": int(time.time() - self._engaged_at) if self._engaged_at else 0,
            }


# ─────────────────────────────────────────────────────────────────
# SAFETY ENGINE — unified guardrails
# ─────────────────────────────────────────────────────────────────

class SafetyEngine:
    """
    Unified safety and guardrails engine for the Osiris Control Plane.

    Orchestrates all safety mechanisms: rate limiting, cooldowns,
    risk scoring, kill switch, and simulation mode.

    Usage:
        safety = SafetyEngine(redis_url="redis://osiris-data-redis:6379")
        safety.set_kill_switch(False)

        verdict = safety.evaluate(
            action="restart_container",
            target="osiris-worker-ai",
            event_severity="error",
        )
        if verdict == Verdict.ALLOW:
            execute_action()

    Integration with RuleEngine:
        safety = SafetyEngine()
        engine = RuleEngine(safety_engine=safety)  # pass via constructor
        # In _evaluate():
        if safety.evaluate(rule.action, event.source, event.severity) != Verdict.ALLOW:
            continue
    """

    def __init__(self,
                 redis_url: str = "redis://osiris-data-redis:6379",
                 max_risk_level: RiskLevel = RiskLevel.HIGH,
                 max_per_service_per_min: int = 5,
                 max_global_per_sec: int = 10):
        self.bus = OsirisEventBus(redis_url)
        self.rate_limiter = RateLimiter(max_per_service_per_min, max_global_per_sec)
        self.cooldown = CooldownManager()
        self.kill_switch = KillSwitch()
        self.max_risk_level = max_risk_level  # actions above this level are denied
        self.simulation_mode = False          # True → all actions become Verdict.SIMULATE
        self._lock = threading.Lock()
        self._denied_count = 0

    # ── Core evaluation ────────────────────────────────────────────

    def evaluate(self, action: str, target: str = "",
                 event_severity: str = "info",
                 event_type: str = "",
                 dry_run: bool = False) -> Verdict:
        """
        Evaluate whether an action is safe to execute.

        Returns:
            Verdict.ALLOW     — execute
            Verdict.DENY      — blocked by safety rules
            Verdict.SIMULATE  — dry-run / simulation mode
        """
        # ── 1. Simulation mode override ────────────────────────────
        if self.simulation_mode or dry_run:
            logger.info("Simulation: %s on %s (dry_run=%s)", action, target, dry_run)
            return Verdict.SIMULATE

        # ── 2. Kill switch ─────────────────────────────────────────
        if self.kill_switch.engaged:
            self._log_denial(action, target, "kill_switch_engaged")
            return Verdict.DENY

        # ── 3. Risk scoring ────────────────────────────────────────
        score = compute_risk_score(event_severity, action)
        level = risk_level(score)
        max_score = RISK_THRESHOLDS.get(self.max_risk_level, 80)
        if score > max_score:
            self._log_denial(action, target, f"risk_too_high({level.value}, score={score})")
            return Verdict.DENY

        # ── 4. Rate limiter ────────────────────────────────────────
        if not self.rate_limiter.check(target):
            self._log_denial(action, target, "rate_limit")
            return Verdict.DENY

        # ── 5. Cooldown ────────────────────────────────────────────
        if not self.cooldown.check(action, target):
            self._log_denial(action, target, "cooldown")
            return Verdict.DENY

        return Verdict.ALLOW

    # ── Denial logging ─────────────────────────────────────────────

    def _log_denial(self, action: str, target: str, reason: str) -> None:
        self._denied_count += 1
        logger.warning("🚫 Safety: DENIED %s on %s (reason=%s, denied_total=%d)",
                       action, target, reason, self._denied_count)
        try:
            self.bus.emit("system", "safety.action.denied", payload={
                "action": action,
                "target": target,
                "reason": reason,
                "denied_total": self._denied_count,
            }, source="safety-engine", severity="warning")
        except Exception:
            pass  # bus may be unavailable

    # ── Kill switch API ────────────────────────────────────────────

    def engage_kill_switch(self, reason: str = "manual") -> None:
        self.kill_switch.engage(reason)
        self.bus.emit("system", "safety.kill_switch.engaged", payload={
            "reason": reason,
        }, source="safety-engine", severity="critical")

    def disengage_kill_switch(self) -> None:
        self.kill_switch.disengage()
        self.bus.emit("system", "safety.kill_switch.disengaged", payload={},
                      source="safety-engine", severity="info")

    # ── Simulation mode ────────────────────────────────────────────

    def enable_simulation(self) -> None:
        self.simulation_mode = True
        logger.info("Safety: simulation mode enabled")

    def disable_simulation(self) -> None:
        self.simulation_mode = False
        logger.info("Safety: simulation mode disabled")

    # ── Cooldown configuration ─────────────────────────────────────

    def set_action_cooldown(self, action: str, seconds: int) -> None:
        self.cooldown.set_cooldown(action, seconds)

    # ── Stats ──────────────────────────────────────────────────────

    def stats(self) -> Dict:
        return {
            "kill_switch": self.kill_switch.status(),
            "simulation_mode": self.simulation_mode,
            "max_risk_level": self.max_risk_level.value,
            "total_denied": self._denied_count,
            "rate_limiter": self.rate_limiter.stats(),
        }


# ─────────────────────────────────────────────────────────────────
# GLOBAL INSTANCE
# ─────────────────────────────────────────────────────────────────

_safety_engine: Optional[SafetyEngine] = None


def get_safety_engine(redis_url: str = "redis://osiris-data-redis:6379") -> SafetyEngine:
    """Return the global SafetyEngine singleton."""
    global _safety_engine
    if _safety_engine is None:
        _safety_engine = SafetyEngine(redis_url)
    return _safety_engine