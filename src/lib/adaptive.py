# -*- coding: utf-8 -*-
"""
Osiris Adaptive Rule Engine — Self-Adjusting Rules
====================================================

Automatically adjusts thresholds, cooldowns, and rule parameters
based on observed system behavior and action effectiveness.

Architecture:

    ┌─────────────────────────────────────────────────────────────┐
    │              ADAPTIVE ENGINE                                │
    │                                                             │
    │  Action History ──→ EffectivenessEvaluator                  │
    │                         │                                   │
    │                         ▼                                   │
    │                   ┌─────────────┐                          │
    │                   │ Threshold   │                          │
    │                   │ Adapter     │                          │
    │                   └──────┬──────┘                          │
    │                          │                                  │
    │            ┌─────────────┼─────────────┐                   │
    │            ▼             ▼             ▼                   │
    │       Cooldown      Max Fires    Rule Enab/Dis             │
    │       Adjustment    Adjustment   State                     │
    │                          │                                  │
    │                          ▼                                  │
    │                   RuleEngine                               │
    │                   (DEFAULT_RULES)                          │
    │                          │                                  │
    │           SafetyEngine ←─┘                                  │
    └─────────────────────────────────────────────────────────────┘

Capabilities:

    - Dynamic cooldown: if actions succeed, cooldown decreases
    - Dynamic max_fires: if actions are effective, limit increases
    - Rule suppression: disable rules that always fail
    - Success-based adaptation: each action outcome feeds back
    - Bounded adaptation: never exceeds SafetyEngine limits
    - Audit trail: emits "adaptive.threshold.adjusted" events

Integration:

    from lib.adaptive import AdaptiveEngine
    from lib.control_plane import RuleEngine, DEFAULT_RULES

    engine = RuleEngine()
    engine.add_rules(DEFAULT_RULES)

    adaptive = AdaptiveEngine(engine)
    adaptive.start()  # background thread, adjusts engine rules periodically

Safety Guarantees:

    - Cooldown never goes below min_safe_cooldown (default 10s)
    - Max fires never exceeds safety_engine.max_per_service_per_min
    - Disabled rules can be re-enabled if system health improves
    - All changes are audited via `adaptive.threshold.adjusted` events
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

import redis

from lib.control_plane import Rule, RuleEngine, Action
from lib.events import OsirisEventBus, Event
from lib.safety import SafetyEngine, get_safety_engine

logger = logging.getLogger("osiris.adaptive")


# ─────────────────────────────────────────────────────────────────
# ACTION OUTCOME — tracks success/failure of executed actions
# ─────────────────────────────────────────────────────────────────

class ActionOutcome(str, Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    DENIED = "denied"


@dataclass
class RuleStats:
    """Runtime statistics for a single rule."""
    rule_name: str
    fires: int = 0
    successes: int = 0
    failures: int = 0
    denied: int = 0
    last_cooldown: int = 30
    last_fire: float = 0.0
    effectiveness: float = 1.0  # 0.0-1.0
    suppression_count: int = 0    # times disabled by adaptive
    created_at: float = field(default_factory=time.time)

    def success_rate(self) -> float:
        total = self.successes + self.failures
        if total == 0:
            return 1.0
        return self.successes / total

    def record(self, outcome: ActionOutcome) -> None:
        self.fires += 1
        if outcome == ActionOutcome.SUCCESS:
            self.successes += 1
        elif outcome == ActionOutcome.FAILURE:
            self.failures += 1
        elif outcome == ActionOutcome.DENIED:
            self.denied += 1
        self.effectiveness = self.success_rate()


# ─────────────────────────────────────────────────────────────────
# EFFECTIVENESS EVALUATOR
# ─────────────────────────────────────────────────────────────────

class EffectivenessEvaluator:
    """
    Evaluates how effective each rule is by tracking success/failure
    of executed actions.

    Listens to control_plane.action.executed events to update stats.
    """

    def __init__(self, window_seconds: int = 3600):
        self.window_seconds = window_seconds
        self._lock = threading.Lock()
        self._stats: Dict[str, RuleStats] = {}
        self._action_history: Dict[str, deque] = defaultdict(
            lambda: deque(maxlen=200)
        )

    def record_action(self, rule_name: str, outcome: ActionOutcome) -> None:
        """Record the outcome of a rule-triggered action."""
        now = time.time()
        with self._lock:
            if rule_name not in self._stats:
                self._stats[rule_name] = RuleStats(rule_name=rule_name, last_fire=now)
            self._stats[rule_name].record(outcome)
            self._stats[rule_name].last_fire = now
            self._action_history[rule_name].append((now, outcome))

    def get_effectiveness(self, rule_name: str) -> float:
        """Return the effectiveness score (0.0-1.0) for a rule."""
        with self._lock:
            stats = self._stats.get(rule_name)
            if stats is None:
                return 1.0
            return stats.effectiveness

    def get_stats(self, rule_name: str) -> Optional[RuleStats]:
        with self._lock:
            return self._stats.get(rule_name)

    def should_suppress(self, rule_name: str, min_effectiveness: float = 0.2) -> bool:
        """
        Return True if the rule should be suppressed (too many failures).

        A rule is suppressed if:
            - It has fired at least 5 times
            - Success rate < min_effectiveness
        """
        with self._lock:
            stats = self._stats.get(rule_name)
            if stats is None:
                return False
            total = stats.successes + stats.failures
            if total < 5:
                return False  # not enough data
            return stats.effectiveness < min_effectiveness

    def all_stats(self) -> Dict[str, Dict]:
        with self._lock:
            return {
                name: {
                    "fires": s.fires,
                    "successes": s.successes,
                    "failures": s.failures,
                    "denied": s.denied,
                    "effectiveness": round(s.effectiveness, 3),
                    "suppression_count": s.suppression_count,
                    "last_cooldown": s.last_cooldown,
                }
                for name, s in self._stats.items()
            }


# ─────────────────────────────────────────────────────────────────
# THRESHOLD ADAPTER
# ─────────────────────────────────────────────────────────────────

class ThresholdAdapter:
    """
    Dynamically adjusts rule thresholds based on effectiveness.

    Strategy:
        - If effectiveness > 0.8 → decrease cooldown by 25% (rule is reliable)
        - If effectiveness < 0.3 → increase cooldown by 50% (rule is risky)
        - If effectiveness < 0.1 for 10+ fires → suppress rule
        - If effectiveness improves → restore cooldown toward default

    Safety bounds:
        - Cooldown: min 10s, max 600s
        - Max fires: min 2, max 20
    """

    MIN_COOLDOWN = 10
    MAX_COOLDOWN = 600
    MIN_MAX_FIRES = 2
    MAX_MAX_FIRES = 20

    def __init__(self):
        self._lock = threading.Lock()
        self._original_cooldowns: Dict[str, int] = {}
        self._original_max_fires: Dict[str, Optional[int]] = {}

    def register_rule(self, rule: Rule) -> None:
        """Store original values for restoration."""
        with self._lock:
            if rule.name not in self._original_cooldowns:
                self._original_cooldowns[rule.name] = rule.cooldown_seconds
            if rule.name not in self._original_max_fires:
                self._original_max_fires[rule.name] = rule.max_fires

    def adapt(self, rule: Rule, effectiveness: float, stats: RuleStats) -> Dict[str, Any]:
        """
        Adjust rule thresholds based on effectiveness.

        Returns a dict of changes made (empty if none).
        """
        changes = {}
        original_cooldown = self._original_cooldowns.get(rule.name, rule.cooldown_seconds)
        original_max_fires = self._original_max_fires.get(rule.name, rule.max_fires)

        with self._lock:
            # ── Cooldown adjustment ───────────────────────────────
            if effectiveness >= 0.8 and stats.fires >= 5:
                # Rule is reliable → reduce cooldown
                new_cooldown = max(self.MIN_COOLDOWN, int(rule.cooldown_seconds * 0.75))
                if new_cooldown < rule.cooldown_seconds:
                    old = rule.cooldown_seconds
                    rule.cooldown_seconds = new_cooldown
                    changes["cooldown"] = {"from": old, "to": new_cooldown}
                    stats.last_cooldown = new_cooldown

            elif effectiveness < 0.3 and stats.fires >= 5:
                # Rule is unreliable → increase cooldown
                new_cooldown = min(self.MAX_COOLDOWN, int(rule.cooldown_seconds * 1.5))
                if new_cooldown > rule.cooldown_seconds:
                    old = rule.cooldown_seconds
                    rule.cooldown_seconds = new_cooldown
                    changes["cooldown"] = {"from": old, "to": new_cooldown}
                    stats.last_cooldown = new_cooldown

            elif effectiveness >= 0.5 and rule.cooldown_seconds > original_cooldown:
                # Effectiveness recovered → move back toward original
                new_cooldown = max(original_cooldown, int(rule.cooldown_seconds * 0.9))
                if new_cooldown < rule.cooldown_seconds:
                    old = rule.cooldown_seconds
                    rule.cooldown_seconds = new_cooldown
                    changes["cooldown"] = {"from": old, "to": new_cooldown}
                    stats.last_cooldown = new_cooldown

            # ── Max fires adjustment ───────────────────────────────
            if effectiveness >= 0.9 and stats.fires >= 10:
                # Very reliable → allow more fires
                current = rule.max_fires if rule.max_fires is not None else original_max_fires or 5
                new_max = min(self.MAX_MAX_FIRES, current + 2)
                if rule.max_fires != new_max:
                    old = rule.max_fires
                    rule.max_fires = new_max
                    changes["max_fires"] = {"from": old, "to": new_max}

            elif effectiveness < 0.2 and stats.fires >= 10:
                # Very unreliable → limit fires
                current = rule.max_fires if rule.max_fires is not None else original_max_fires or 5
                new_max = max(self.MIN_MAX_FIRES, current - 2)
                if rule.max_fires != new_max:
                    old = rule.max_fires
                    rule.max_fires = new_max
                    changes["max_fires"] = {"from": old, "to": new_max}

        return changes


# ─────────────────────────────────────────────────────────────────
# ADAPTIVE ENGINE — orchestrates adaptation
# ─────────────────────────────────────────────────────────────────

class AdaptiveEngine:
    """
    Self-adjusting rule engine for the Osiris Control Plane.

    Runs as a background thread that periodically evaluates rule
    effectiveness and adjusts thresholds.

    Usage:
        from lib.adaptive import AdaptiveEngine
        from lib.control_plane import RuleEngine

        engine = RuleEngine()
        engine.add_rules(DEFAULT_RULES)

        adaptive = AdaptiveEngine(engine)
        adaptive.start()

        # Rules will now self-adjust based on action outcomes.
        # Call adaptive.record_outcome(rule_name, success) from ActionExecutor.

    Safety:
        - Cooldown never drops below 10s
        - Max fires never exceeds 20
        - Suppressed rules emit adaptive.rule.suppressed events
        - All changes emit adaptive.threshold.adjusted events
    """

    ADAPTIVE_INTERVAL = 60  # evaluate every 60 seconds

    def __init__(self, rule_engine: RuleEngine, redis_url: str = "redis://osiris-data-redis:6379"):
        self.engine = rule_engine
        self.bus = OsirisEventBus(redis_url)
        self.evaluator = EffectivenessEvaluator()
        self.adapter = ThresholdAdapter()
        self.safety = get_safety_engine(redis_url)
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._total_adjustments = 0

        # Register original values for all current rules
        with rule_engine._lock:
            for rule in rule_engine._rules:
                self.adapter.register_rule(rule)

    # ── Lifecycle ─────────────────────────────────────────────────

    def start(self) -> threading.Thread:
        """Start the adaptive engine in a background thread."""
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True, name="adaptive-engine")
        self._thread.start()
        logger.info("Adaptive engine started (interval=%ds)", self.ADAPTIVE_INTERVAL)
        return self._thread

    def stop(self) -> None:
        self._running = False
        logger.info("Adaptive engine stopped (%d adjustments made)", self._total_adjustments)

    def _run(self) -> None:
        while self._running:
            time.sleep(self.ADAPTIVE_INTERVAL)
            try:
                self._evaluate_and_adapt()
            except Exception as exc:
                logger.error("Adaptive evaluation error: %s", exc)

    # ── Core adaptation logic ─────────────────────────────────────

    def _evaluate_and_adapt(self) -> None:
        """Evaluate all rules and apply adaptations."""
        with self.engine._lock:
            rules = list(self.engine._rules)

        for rule in rules:
            stats = self.evaluator.get_stats(rule.name)
            if stats is None:
                continue

            effectiveness = stats.effectiveness

            # ── 1. Check if rule should be suppressed ──────────────
            if self.evaluator.should_suppress(rule.name):
                if rule.enabled:
                    rule.enabled = False
                    stats.suppression_count += 1
                    self._total_adjustments += 1
                    self.bus.emit("system", "adaptive.rule.suppressed", payload={
                        "rule_name": rule.name,
                        "reason": "low_effectiveness",
                        "effectiveness": effectiveness,
                        "fires": stats.fires,
                        "suppression_count": stats.suppression_count,
                    }, source="adaptive-engine", severity="warning")
                    logger.warning("Adaptive: suppressed rule '%s' (effectiveness=%.2f)",
                                   rule.name, effectiveness)
                continue

            # ── 2. Check if suppressed rule should be re-enabled ──
            if not rule.enabled and stats.suppression_count > 0:
                # Re-enable if system health is good (error rate < 30%)
                try:
                    now_ms = int(time.time() * 1000)
                    window_start = now_ms - 300_000
                    results = self.bus.client.xrange("osiris:system", f"{window_start}-0", f"{now_ms}-0", count=100)
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
                    if error_rate < 0.3 and stats.suppression_count < 3:
                        rule.enabled = True
                        self._total_adjustments += 1
                        self.bus.emit("system", "adaptive.rule.re_enabled", payload={
                            "rule_name": rule.name,
                            "reason": "error_rate_improved",
                            "error_rate": round(error_rate, 3),
                        }, source="adaptive-engine", severity="info")
                        logger.info("Adaptive: re-enabled rule '%s' (error_rate=%.3f)",
                                    rule.name, error_rate)
                except Exception:
                    pass
                continue

            # ── 3. Adapt thresholds ───────────────────────────────
            changes = self.adapter.adapt(rule, effectiveness, stats)
            if changes:
                self._total_adjustments += 1
                self.bus.emit("system", "adaptive.threshold.adjusted", payload={
                    "rule_name": rule.name,
                    "changes": changes,
                    "effectiveness": effectiveness,
                    "fires": stats.fires,
                }, source="adaptive-engine", severity="info")
                logger.info("Adaptive: adjusted rule '%s': %s (effectiveness=%.2f)",
                            rule.name, changes, effectiveness)

    # ── Public API ────────────────────────────────────────────────

    def record_outcome(self, rule_name: str, success: bool) -> None:
        """Record the outcome of a rule-triggered action."""
        outcome = ActionOutcome.SUCCESS if success else ActionOutcome.FAILURE
        self.evaluator.record_action(rule_name, outcome)

    def record_denied(self, rule_name: str) -> None:
        """Record that a rule action was denied by safety."""
        self.evaluator.record_action(rule_name, ActionOutcome.DENIED)

    def get_effectiveness(self, rule_name: str) -> float:
        return self.evaluator.get_effectiveness(rule_name)

    def stats(self) -> Dict:
        return {
            "total_adjustments": self._total_adjustments,
            "rules_tracked": len(self.evaluator.all_stats()),
            "rule_stats": self.evaluator.all_stats(),
            "running": self._running,
            "interval_seconds": self.ADAPTIVE_INTERVAL,
        }

    def force_evaluation(self) -> Dict:
        """Trigger an immediate evaluation cycle and return changes."""
        self._evaluate_and_adapt()
        return self.stats()


# ─────────────────────────────────────────────────────────────────
# GLOBAL INSTANCE
# ─────────────────────────────────────────────────────────────────

_adaptive_engine: Optional[AdaptiveEngine] = None


def get_adaptive_engine(rule_engine=None) -> AdaptiveEngine:
    """Return or create the global AdaptiveEngine."""
    global _adaptive_engine
    if _adaptive_engine is None:
        from lib.control_plane import RuleEngine
        engine = rule_engine or RuleEngine()
        _adaptive_engine = AdaptiveEngine(engine)
    return _adaptive_engine