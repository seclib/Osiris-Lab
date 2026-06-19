"""
Osiris Simulation Mode — Full System Sandbox
==============================================

Mirrors production events into a sandbox environment for safe testing.
No real Docker actions are executed — all actions are logged and audited.

Architecture:

    Production Streams                  Sandbox Stream
    ─────────────────                  ──────────────
    osiris:system ──┐                  osiris:sandbox
    osiris:ai     ──┤                       │
    osiris:geoint ──┼─── EventMirror ───────┤
    osiris:graph  ──┤                       │
    osiris:alerts ──┘                       │
                                            ▼
                                    ScenarioEngine
                                    ┌──────┼──────┐
                                    │ CPU  │ Crash │
                                    │ Spike│ Test  │
                                    └──────┴───────┘
                                            │
                                    SandboxExecutor
                                    (log-only, no Docker)

Usage:
    from lib.simulation import SimulationMode, EventMirror, ScenarioEngine

    sim = SimulationMode()
    sim.start()    # begin mirroring all production events to osiris:sandbox
    sim.inject_crash("osiris-worker-ai")
    sim.inject_cpu_spike("osiris-backend", usage_pct=95)
    sim.stop()

CLI:
    python -m lib.simulation start
    python -m lib.simulation inject --crash osiris-worker-ai
    python -m lib.simulation inject --cpu osiris-backend --value 95
    python -m lib.simulation replay --stream system --start "-1h"
    python -m lib.simulation stop
    python -m lib.simulation status
"""

from __future__ import annotations

import json
import logging
import random
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Generator, List, Optional

import redis

from lib.events import OsirisEventBus, Event, STREAMS
from lib.replay import ReplayEngine

logger = logging.getLogger("osiris.simulation")


# ─────────────────────────────────────────────────────────────────
# SANDBOX STREAM
# ─────────────────────────────────────────────────────────────────

SANDBOX_STREAM = "osiris:sandbox"
SANDBOX_MAXLEN = 50_000


# ─────────────────────────────────────────────────────────────────
# EVENT MIRROR — duplicates production events to sandbox
# ─────────────────────────────────────────────────────────────────

class EventMirror:
    """
    Duplicates events from production streams into osiris:sandbox.

    Runs as a background thread, listening to all production streams
    and copying every event into the sandbox for safe replay/testing.

    Usage:
        mirror = EventMirror()
        mirror.start()
        # ... run tests ...
        mirror.stop()
    """

    def __init__(self, redis_url: str = "redis://osiris-data-redis:6379"):
        self.bus = OsirisEventBus(redis_url)
        self.client = self.bus.client
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._events_copied = 0

    def start(self) -> threading.Thread:
        """Begin mirroring production events to sandbox (daemon thread)."""
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True, name="event-mirror")
        self._thread.start()
        self.bus.emit("system", "simulation.mirror.started", payload={
            "target": SANDBOX_STREAM,
        }, source="simulation", severity="info")
        logger.info("Event mirror started → %s", SANDBOX_STREAM)
        return self._thread

    def stop(self) -> None:
        self._running = False
        self.bus.emit("system", "simulation.mirror.stopped", payload={
            "events_copied": self._events_copied,
        }, source="simulation", severity="info")
        logger.info("Event mirror stopped (%d events copied)", self._events_copied)

    def _run(self) -> None:
        production_streams = [STREAMS["system"], STREAMS["alerts"], STREAMS["ai"],
                              STREAMS["geoint"], STREAMS["graph"]]
        last_ids = {s: "0" for s in production_streams}

        while self._running:
            try:
                results = self.client.xread(last_ids, count=50, block=2000)
                if results:
                    for sname_enc, messages in results:
                        sname = sname_enc.decode() if isinstance(sname_enc, bytes) else sname_enc
                        for msg_id_enc, data in messages:
                            msg_id = msg_id_enc.decode() if isinstance(msg_id_enc, bytes) else msg_id_enc
                            last_ids[sname] = msg_id

                            # Add simulation metadata
                            sim_data = {k: v for k, v in data.items()}
                            sim_data[b"_simulated"] = b"true"
                            sim_data[b"_original_stream"] = sname.encode() if isinstance(sname, str) else sname

                            self.client.xadd(SANDBOX_STREAM, sim_data, maxlen=SANDBOX_MAXLEN, approximate=True)
                            self._events_copied += 1
            except (redis.RedisError, ConnectionError):
                time.sleep(1)

    @property
    def events_copied(self) -> int:
        return self._events_copied


# ─────────────────────────────────────────────────────────────────
# SCENARIO GENERATOR — synthetic events for testing
# ─────────────────────────────────────────────────────────────────

@dataclass
class Scenario:
    """A test scenario definition."""
    name: str
    event_type: str
    source: str
    severity: str = "error"
    payload: Dict[str, Any] = field(default_factory=dict)
    repeat: int = 1
    interval_seconds: float = 1.0


class ScenarioEngine:
    """
    Generates synthetic events in the sandbox for testing.

    Supports predefined scenarios and custom event injection.

    Usage:
        engine = ScenarioEngine()
        engine.inject_crash("osiris-worker-ai")
        engine.inject_cpu_spike("osiris-backend", 95)
        engine.inject_network_failure("osiris-nginx-gateway")
        engine.run_scenario(Scenario(name="test", ...))
    """

    def __init__(self, redis_url: str = "redis://osiris-data-redis:6379"):
        self.bus = OsirisEventBus(redis_url)
        self.client = self.bus.client
        self._simulated_count = 0

    # ── Predefined scenarios ──────────────────────────────────────

    def inject_crash(self, service: str, severity: str = "error") -> str:
        """Simulate a service crash."""
        return self._emit_sandbox(
            event_type="container.died",
            source=service,
            severity=severity,
            payload={
                "exit_code": 137,
                "signal": "SIGKILL",
                "oom_killed": False,
                "restart_policy": "unless-stopped",
            },
        )

    def inject_unhealthy(self, service: str) -> str:
        """Simulate a service becoming unhealthy."""
        return self._emit_sandbox(
            event_type="health_status.unhealthy",
            source=service,
            severity="warning",
            payload={"health_status": "unhealthy", "failed_checks": 3},
        )

    def inject_cpu_spike(self, service: str, usage_pct: int = 95) -> str:
        """Simulate a CPU spike on a service."""
        return self._emit_sandbox(
            event_type="resource.cpu_spike",
            source=service,
            severity="warning" if usage_pct < 90 else "error",
            payload={
                "cpu_usage_pct": usage_pct,
                "threshold_pct": 80,
                "duration_seconds": 30,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )

    def inject_network_failure(self, service: str) -> str:
        """Simulate a network partition/failure."""
        return self._emit_sandbox(
            event_type="network.failure",
            source=service,
            severity="critical",
            payload={
                "type": "partition",
                "affected_peers": [],
                "duration_estimate_seconds": 60,
            },
        )

    def inject_alert(self, title: str, severity: str = "warning", details: Optional[Dict] = None) -> str:
        """Inject a generic alert."""
        return self._emit_sandbox(
            event_type="alert.custom",
            source="simulation",
            severity=severity,
            payload={
                "title": title,
                "details": details or {},
            },
        )

    def inject_queue_backlog(self, service: str, depth: int = 500) -> str:
        """Simulate a queue backlog."""
        return self._emit_sandbox(
            event_type="ai.queue.backlog",
            source=service,
            severity="warning",
            payload={
                "queue_depth": depth,
                "threshold": 100,
                "oldest_message_age_seconds": 120,
            },
        )

    def inject_geoint_anomaly(self, lat: float = 0.0, lon: float = 0.0, confidence: float = 0.85) -> str:
        """Simulate a GEOINT anomaly detection."""
        return self._emit_sandbox(
            event_type="geoint.anomaly.detected",
            source="geoint-engine",
            severity="warning",
            payload={
                "location": {"lat": lat, "lon": lon},
                "confidence": confidence,
                "anomaly_type": "unexpected_movement",
                "radius_km": 50,
            },
        )

    def inject_graph_error(self, severity: str = "error") -> str:
        """Simulate a graph ingestion error."""
        return self._emit_sandbox(
            event_type="graph.ingestion.error",
            source="osiris-worker-graph",
            severity=severity,
            payload={
                "error": "ConnectionTimeout",
                "retries": 3,
                "batch_size": 100,
            },
        )

    # ── Generic injection ─────────────────────────────────────────

    def inject(self, event_type: str, source: str = "simulation",
               severity: str = "info", payload: Optional[Dict] = None) -> str:
        """Inject a custom synthetic event into the sandbox."""
        return self._emit_sandbox(event_type, source, severity, payload or {})

    def _emit_sandbox(self, event_type: str, source: str, severity: str, payload: Dict) -> str:
        """Emit an event to the sandbox stream with simulation markers."""
        self._simulated_count += 1

        event = Event(
            event_type=event_type,
            source=source,
            payload={
                **payload,
                "_simulated": True,
                "_sim_id": self._simulated_count,
            },
            severity=severity,
            correlation_id=f"sim-{uuid.uuid4().hex[:8]}",
        )

        data = event.to_dict()
        data["_simulated"] = "true"

        msg_id = self.client.xadd(SANDBOX_STREAM, data, maxlen=SANDBOX_MAXLEN, approximate=True)
        logger.info("Simulation: injected %s on %s (severity=%s)", event_type, source, severity)
        return msg_id.decode() if isinstance(msg_id, bytes) else msg_id

    # ── Scenario runner ───────────────────────────────────────────

    def run_scenario(self, scenario: Scenario) -> int:
        """Run a predefined scenario (repeat N times with interval)."""
        for i in range(scenario.repeat):
            self._emit_sandbox(
                scenario.event_type,
                scenario.source,
                scenario.severity,
                scenario.payload,
            )
            if i < scenario.repeat - 1:
                time.sleep(scenario.interval_seconds)
        logger.info("Scenario '%s' completed (%d events)", scenario.name, scenario.repeat)
        return scenario.repeat

    @property
    def simulated_count(self) -> int:
        return self._simulated_count


# ─────────────────────────────────────────────────────────────────
# SANDBOX EXECUTOR — log-only action executor
# ─────────────────────────────────────────────────────────────────

class SandboxExecutor:
    """
    Logs all control plane actions without executing them.

    Used in simulation mode to verify what actions WOULD be taken
    by the Control Plane without actually touching Docker.

    Usage:
        executor = SandboxExecutor(event_bus)
        executor.execute("restart_container", event, params)
        # → logs action, emits audit event, does NOT call Docker
    """

    def __init__(self, bus: OsirisEventBus):
        self.bus = bus
        self._actions_logged = 0
        self._action_log: List[Dict] = []

    def execute(self, action: str, event: Event, params: Optional[Dict] = None) -> bool:
        """
        Log the action instead of executing it.

        Returns True (success) always, since this is a simulation.
        """
        self._actions_logged += 1
        params = params or {}
        target = params.get("container_name", event.source)

        entry = {
            "action": action,
            "target": target,
            "event_type": event.event_type,
            "event_severity": event.severity,
            "params": params,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "simulated": True,
        }

        self._action_log.append(entry)
        logger.info("Sandbox: WOULD %s on %s (event: %s)", action, target, event.event_type)

        # Emit audit event
        self.bus.emit("system", "simulation.action.simulated", payload={
            "action": action,
            "target": target,
            "event_type": event.event_type,
            "severity": event.severity,
            "params": params,
        }, source="sandbox-executor", severity="info")

        return True

    def get_action_log(self, limit: int = 50) -> List[Dict]:
        """Return recent simulated actions."""
        return self._action_log[-limit:]

    def clear_log(self) -> None:
        self._action_log.clear()

    @property
    def actions_logged(self) -> int:
        return self._actions_logged


# ─────────────────────────────────────────────────────────────────
# SIMULATION MODE — unified sandbox controller
# ─────────────────────────────────────────────────────────────────

class SimulationMode:
    """
    Unified simulation controller for the Osiris platform.

    Orchestrates Event Mirror, Scenario Engine, Sandbox Executor,
    and replay integration.

    Usage:
        sim = SimulationMode()

        # Start mirroring production events
        sim.start()

        # Inject synthetic scenarios
        sim.inject_crash("osiris-worker-ai")
        sim.inject_cpu_spike("osiris-backend", 95)

        # Replay past events into sandbox
        sim.replay_history("system", start="-1h")

        # Check what actions WOULD have been taken
        sim.get_sandbox_actions()

        # Stop and get report
        sim.stop()
    """

    def __init__(self, redis_url: str = "redis://osiris-data-redis:6379"):
        self.redis_url = redis_url
        self.bus = OsirisEventBus(redis_url)
        self.mirror = EventMirror(redis_url)
        self.scenario = ScenarioEngine(redis_url)
        self.sandbox_executor = SandboxExecutor(self.bus)
        self.replay_engine = ReplayEngine(redis_url)
        self._active = False

    # ── Lifecycle ─────────────────────────────────────────────────

    def start(self) -> Dict:
        """Start simulation mode: mirroring + status event."""
        if self._active:
            return self.status()

        self._active = True
        self.mirror.start()

        # Emit UI notification event
        self.bus.emit("system", "simulation.mode.activated", payload={
            "started_at": datetime.now(timezone.utc).isoformat(),
        }, source="simulation", severity="info")

        logger.info("🔬 SIMULATION MODE ACTIVE")
        return self.status()

    def stop(self) -> Dict:
        """Stop simulation mode and return summary."""
        self.mirror.stop()
        self._active = False

        self.bus.emit("system", "simulation.mode.deactivated", payload={
            "events_copied": self.mirror.events_copied,
            "scenarios_injected": self.scenario.simulated_count,
            "actions_simulated": self.sandbox_executor.actions_logged,
        }, source="simulation", severity="info")

        logger.info("🔬 SIMULATION MODE DEACTIVATED")
        return self.status()

    def status(self) -> Dict:
        """Return current simulation status."""
        try:
            sandbox_len = self.bus.client.xlen(SANDBOX_STREAM)
        except Exception:
            sandbox_len = 0

        return {
            "active": self._active,
            "sandbox_stream": SANDBOX_STREAM,
            "sandbox_events": sandbox_len,
            "events_copied": self.mirror.events_copied if self._active else 0,
            "scenarios_injected": self.scenario.simulated_count,
            "actions_simulated": self.sandbox_executor.actions_logged,
        }

    # ── Scenario injection shortcuts ──────────────────────────────

    def inject_crash(self, service: str, severity: str = "error") -> str:
        return self.scenario.inject_crash(service, severity)

    def inject_unhealthy(self, service: str) -> str:
        return self.scenario.inject_unhealthy(service)

    def inject_cpu_spike(self, service: str, usage_pct: int = 95) -> str:
        return self.scenario.inject_cpu_spike(service, usage_pct)

    def inject_network_failure(self, service: str) -> str:
        return self.scenario.inject_network_failure(service)

    def inject_alert(self, title: str, severity: str = "warning", details: Optional[Dict] = None) -> str:
        return self.scenario.inject_alert(title, severity, details)

    def inject_queue_backlog(self, service: str, depth: int = 500) -> str:
        return self.scenario.inject_queue_backlog(service, depth)

    def inject_graph_error(self, severity: str = "error") -> str:
        return self.scenario.inject_graph_error(severity)

    def inject_geoint_anomaly(self, lat: float = 0.0, lon: float = 0.0, confidence: float = 0.85) -> str:
        return self.scenario.inject_geoint_anomaly(lat, lon, confidence)

    # ── Replay integration ────────────────────────────────────────

    def replay_history(self, stream: str = "system", start: Optional[str] = None,
                       end: Optional[str] = None, max_events: int = 500) -> int:
        """
        Replay historical production events into the sandbox.

        Uses the ReplayEngine to read from osiris:archive and inject
        each event into osiris:sandbox for testing.
        """
        count = 0
        for event in self.replay_engine.replay(
            stream, start=start, end=end, max_events=max_events, from_archive=True
        ):
            self.scenario.inject(
                event_type=event.event_type,
                source=event.source,
                severity=event.severity,
                payload=event.payload,
            )
            count += 1

        logger.info("Replayed %d historical events into sandbox", count)
        return count

    # ── Sandbox actions ───────────────────────────────────────────

    def get_sandbox_actions(self, limit: int = 50) -> List[Dict]:
        """Get the log of simulated actions."""
        return self.sandbox_executor.get_action_log(limit)

    # ── Safety integration ────────────────────────────────────────

    def enable_dry_run(self, safety_engine=None) -> None:
        """
        Enable dry-run mode on the SafetyEngine.

        All Control Plane actions become Verdict.SIMULATE.
        """
        from lib.safety import get_safety_engine

        eng = safety_engine or get_safety_engine()
        eng.enable_simulation()
        logger.info("SafetyEngine: dry-run mode enabled for simulation")

    def disable_dry_run(self, safety_engine=None) -> None:
        """Disable dry-run mode on the SafetyEngine."""
        from lib.safety import get_safety_engine

        eng = safety_engine or get_safety_engine()
        eng.disable_simulation()
        logger.info("SafetyEngine: dry-run mode disabled")


# ─────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Osiris Simulation Mode CLI")
    sub = parser.add_subparsers(dest="command")

    # start
    sub.add_parser("start", help="Start simulation mode")

    # stop
    sub.add_parser("stop", help="Stop simulation mode")

    # status
    sub.add_parser("status", help="Show simulation status")

    # inject
    inj = sub.add_parser("inject", help="Inject synthetic events")
    inj.add_argument("--crash", help="Service name to simulate crash")
    inj.add_argument("--unhealthy", help="Service name to simulate unhealthy")
    inj.add_argument("--cpu", help="Service name for CPU spike")
    inj.add_argument("--value", type=int, default=95, help="CPU usage percentage")
    inj.add_argument("--network", help="Service name for network failure")
    inj.add_argument("--alert", help="Alert title")
    inj.add_argument("--backlog", help="Service name for queue backlog")
    inj.add_argument("--depth", type=int, default=500, help="Queue depth")
    inj.add_argument("--graph-error", action="store_true", help="Inject graph error")
    inj.add_argument("--geoint", action="store_true", help="Inject geoint anomaly")
    inj.add_argument("--event", help="Custom event type")
    inj.add_argument("--source", default="simulation-cli", help="Event source")
    inj.add_argument("--severity", default="info", help="Event severity")
    inj.add_argument("--payload", default="{}", help="JSON payload")

    # replay
    rep = sub.add_parser("replay", help="Replay historical events into sandbox")
    rep.add_argument("--stream", default="system", help="Source stream")
    rep.add_argument("--start", default=None, help="Start time (-1h, ISO)")
    rep.add_argument("--end", default=None, help="End time")
    rep.add_argument("--max", type=int, default=500, help="Max events")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    sim = SimulationMode()

    if args.command == "start":
        result = sim.start()
        print(json.dumps(result, indent=2))

    elif args.command == "stop":
        result = sim.stop()
        print(json.dumps(result, indent=2))

    elif args.command == "status":
        result = sim.status()
        print(json.dumps(result, indent=2))

    elif args.command == "inject":
        count = 0
        if args.crash:
            sim.inject_crash(args.crash)
            count += 1
            print(f"Injected crash on {args.crash}")
        if args.unhealthy:
            sim.inject_unhealthy(args.unhealthy)
            count += 1
            print(f"Injected unhealthy on {args.unhealthy}")
        if args.cpu:
            sim.inject_cpu_spike(args.cpu, args.value)
            count += 1
            print(f"Injected CPU spike {args.value}% on {args.cpu}")
        if args.network:
            sim.inject_network_failure(args.network)
            count += 1
            print(f"Injected network failure on {args.network}")
        if args.alert:
            sim.inject_alert(args.alert)
            count += 1
            print(f"Injected alert: {args.alert}")
        if args.backlog:
            sim.inject_queue_backlog(args.backlog, args.depth)
            count += 1
            print(f"Injected queue backlog depth={args.depth} on {args.backlog}")
        if args.graph_error:
            sim.inject_graph_error()
            count += 1
            print("Injected graph error")
        if args.geoint:
            sim.inject_geoint_anomaly()
            count += 1
            print("Injected GEOINT anomaly")
        if args.event:
            payload = json.loads(args.payload)
            sim.scenario.inject(args.event, args.source, args.severity, payload)
            count += 1
            print(f"Injected custom event: {args.event}")
        if count == 0:
            print("No injection target specified. Use --crash, --cpu, --alert, etc.")
        print(f"Total injected: {count}")

    elif args.command == "replay":
        count = sim.replay_history(args.stream, args.start, args.end, args.max)
        print(f"Replayed {count} events into sandbox")