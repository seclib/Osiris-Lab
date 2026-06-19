'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, Cpu, HardDrive, RefreshCw, Zap, Play, Pause, Globe, Database, Network, Server, Users, Shield } from 'lucide-react';

interface EntityState {
  id: string;
  type: string;
  status: string;
  health: number;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

interface AlertState {
  id: string;
  type: string;
  severity: string;
  message: string;
  timestamp: string;
  acknowledged: boolean;
}

interface ThreatIndicator {
  id: string;
  source: string;
  score: number;
  indicator: string;
  type: string;
  timestamp: string;
}

interface WorkerStatus {
  name: string;
  status: string;
  uptime: string;
  last_seen: string;
}

interface SystemSnapshot {
  as_of: string;
  entities: Record<string, EntityState>;
  alerts: AlertState[];
  metrics: Record<string, number>;
  threats: ThreatIndicator[];
  workers: Record<string, WorkerStatus>;
}

interface SimulationResult {
  id: string;
  action: string;
  scenario?: string;
  snapshot: SystemSnapshot;
  ticks: number;
  duration_ms: number;
}

// Types d'entités avec icônes et couleurs
const ENTITY_META: Record<string, { icon: React.ReactNode; color: string }> = {
  database: { icon: <Database size={12} />, color: '#4488ff' },
  cache:    { icon: <Zap size={12} />, color: '#ffaa00' },
  eventbus: { icon: <Network size={12} />, color: '#8844ff' },
  graphdb:  { icon: <Network size={12} />, color: '#00cc88' },
  analytics:{ icon: <Cpu size={12} />, color: '#ff6644' },
  ai:       { icon: <Cpu size={12} />, color: '#ff44ff' },
  search:   { icon: <Globe size={12} />, color: '#44aaff' },
  vector:   { icon: <Database size={12} />, color: '#44ffaa' },
  server:   { icon: <Server size={12} />, color: '#00ff88' },
  worker:   { icon: <Activity size={12} />, color: '#8888ff' },
};

// Scénarios de simulation détaillés
const SIMULATION_SCENARIOS = [
  {
    id: 'cascade_failure',
    label: '💥 Cascade Failure',
    description: 'PostgreSQL fails → services degrade → response time spikes',
    events: [
      { entities: [{ id: 'postgres', type: 'database', status: 'failed', health: 0 }] },
      { alerts: [{ id: 'c1', type: 'database_down', severity: 'critical', message: 'PostgreSQL connection lost — service degradation' }] },
      { metrics: { error_rate_pct: 45, avg_response_ms: 5200, active_users: 0 } },
      { entities: [{ id: 'memgraph', type: 'graphdb', status: 'degraded', health: 30 }] },
      { alerts: [{ id: 'c2', type: 'cascading', severity: 'high', message: 'Memgraph degraded — dependency chain' }] },
      { entities: [{ id: 'osiris-server', type: 'server', status: 'degraded', health: 25 }] },
    ],
  },
  {
    id: 'ddos_attack',
    label: '🌊 DDoS Attack',
    description: 'Traffic surge → CPU 98% → rate limiting → partial outage',
    events: [
      { metrics: { api_requests_min: 45000, cpu_usage: 98, memory_usage: 92, avg_response_ms: 8200, error_rate_pct: 35, data_throughput_mbps: 12 } },
      { threats: [{ id: 'ddos-1', source: 'external', score: 0.96, indicator: '5.188.62.0/24', type: 'amplification' }] },
      { threats: [{ id: 'ddos-2', source: 'external', score: 0.91, indicator: 'SYN flood on :8080', type: 'syn_flood' }] },
      { alerts: [{ id: 'd1', type: 'ddos', severity: 'critical', message: 'DDoS detected: 45k req/min — rate limiting engaged' }] },
      { alerts: [{ id: 'd2', type: 'throttle', severity: 'high', message: 'API rate limiting active for 23 source IPs' }] },
      { entities: [{ id: 'osiris-server', type: 'server', status: 'degraded', health: 35 }] },
      { entities: [{ id: 'kafka', type: 'eventbus', status: 'degraded', health: 60 }] },
    ],
  },
  {
    id: 'data_breach',
    label: '🔓 Data Breach',
    description: 'Unauthorized access → data exfiltration → containment',
    events: [
      { threats: [{ id: 'br-1', source: 'internal', score: 0.99, indicator: 'user:svc_bridge', type: 'credential_abuse' }] },
      { threats: [{ id: 'br-2', source: 'internal', score: 0.95, indicator: 'SELECT * FROM users', type: 'data_exfiltration' }] },
      { alerts: [{ id: 'br1', type: 'breach', severity: 'critical', message: 'Data breach detected — unauthorized access to postgres.users' }] },
      { alerts: [{ id: 'br2', type: 'containment', severity: 'high', message: 'Compromised credential revoked — access contained' }] },
      { entities: [{ id: 'postgres', type: 'database', status: 'compromised', health: 15 }] },
      { entities: [{ id: 'opensearch', type: 'search', status: 'degraded', health: 45 }] },
      { metrics: { error_rate_pct: 12, data_throughput_mbps: 320, kafka_lag: 15000 } },
    ],
  },
  {
    id: 'recovery',
    label: '🔄 Full Recovery',
    description: 'All services restored after incident',
    events: [
      { entities: [{ id: 'postgres', type: 'database', status: 'active', health: 98 }] },
      { entities: [{ id: 'osiris-server', type: 'server', status: 'active', health: 99 }] },
      { entities: [{ id: 'kafka', type: 'eventbus', status: 'active', health: 99 }] },
      { alerts: [{ id: 'r1', type: 'recovery', severity: 'low', message: 'All services operational — post-failover stable' }] },
      { metrics: { cpu_usage: 28, memory_usage: 42, avg_response_ms: 38, error_rate_pct: 0.1, kafka_lag: 0, api_requests_min: 95 } },
    ],
  },
  {
    id: 'user_surge',
    label: '👥 User Surge',
    description: 'Sudden 10x user spike → scale-out triggered',
    events: [
      { metrics: { active_users: 3500, api_requests_min: 28000, cpu_usage: 82, memory_usage: 78, avg_response_ms: 320, data_throughput_mbps: 180 } },
      { alerts: [{ id: 'us1', type: 'scaling', severity: 'info', message: 'Auto-scaling triggered: +2 worker replicas' }] },
      { entities: [{ id: 'redis', type: 'cache', status: 'active', health: 88 }] },
      { entities: [{ id: 'clickhouse', type: 'analytics', status: 'active', health: 82 }] },
    ],
  },
  {
    id: 'ransomware',
    label: '💰 Ransomware',
    description: 'Encryption detected → isolation → backup restore',
    events: [
      { threats: [{ id: 'rw-1', source: 'phishing', score: 0.98, indicator: 'file:*.encrypted', type: 'ransomware' }] },
      { threats: [{ id: 'rw-2', source: 'internal', score: 0.85, indicator: 'C2 45.33.32.156', type: 'command_and_control' }] },
      { alerts: [{ id: 'rw1', type: 'ransomware', severity: 'critical', message: 'Ransomware detected: file encryption in progress' }] },
      { alerts: [{ id: 'rw2', type: 'isolation', severity: 'high', message: 'Compromised segment isolated — restore from backup' }] },
      { entities: [{ id: 'postgres', type: 'database', status: 'compromised', health: 5 }] },
      { entities: [{ id: 'opensearch', type: 'search', status: 'failed', health: 0 }] },
      { entities: [{ id: 'osiris-server', type: 'server', status: 'degraded', health: 20 }] },
      { metrics: { error_rate_pct: 78, data_throughput_mbps: 2, kafka_lag: 89000 } },
    ],
  },
];

export default function DigitalTwinPanel() {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [wsStatus, setWsStatus] = useState<string>('connecting');
  const [selectedTab, setSelectedTab] = useState<'overview' | 'infrastructure' | 'threats' | 'simulate' | 'timeline'>('overview');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | undefined>(undefined);
  const [simResult, setSimResult] = useState<SimulationResult | null>(null);
  const [simLoading, setSimLoading] = useState<string | null>(null);
  const [simHistory, setSimHistory] = useState<SimulationResult[]>([]);

  useEffect(() => {
    let cancelled = false;

    function doConnect() {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws`;
      const ws = new WebSocket(url);

      ws.onopen = () => {
        if (cancelled) return;
        setWsStatus('connected');
        ws.send(JSON.stringify({ type: 'subscribe', channel: 'digitaltwin' }));
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse(event.data);
          const snap = msg.payload || msg.snapshot || msg;
          if (snap && snap.as_of) {
            setSnapshot(snap);
          }
          if (msg.type === 'digitaltwin.what_if' || msg.type === 'digitaltwin.result') {
            const res = msg as SimulationResult;
            setSimResult(res);
            setSimLoading(null);
            setSimHistory(prev => [res, ...prev].slice(0, 10));
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setWsStatus('reconnecting');
        wsRef.current = null;
        reconnectRef.current = window.setTimeout(doConnect, 3000);
      };

      ws.onerror = () => { if (!cancelled) setWsStatus('error'); };
      wsRef.current = ws;
    }

    doConnect();
    return () => {
      cancelled = true;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const runScenario = async (scenario: typeof SIMULATION_SCENARIOS[number]) => {
    setSimLoading(scenario.id);
    wsRef.current?.send(JSON.stringify({
      type: 'digitaltwin.simulate',
      action: 'what_if',
      scenario: scenario.id,
      events: scenario.events,
      duration_sec: 30,
    }));
  };

  const entities = Object.values(snapshot?.entities || {});
  const alerts = snapshot?.alerts || [];
  const threats = snapshot?.threats || [];
  const metrics = snapshot?.metrics || {};
  const workers = Object.values(snapshot?.workers || {});
  const entityStatus = (h: number) => h > 70 ? '#00ff88' : h > 30 ? '#ffaa00' : '#ff4444';

  return (
    <div style={{
      background: '#0a0a1a', color: '#e0e0ff', padding: '16px', borderRadius: '8px',
      fontFamily: 'monospace', height: '100%', overflow: 'auto',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: 0, fontSize: '16px' }}>
          <Activity size={18} color="#00ff88" /> Digital Twin
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: wsStatus === 'connected' ? '#00ff88' : wsStatus === 'connecting' ? '#ffaa00' : '#ff4444', display: 'inline-block' }} />
          {wsStatus}
          {snapshot && <span style={{ color: '#666' }}>· {snapshot.as_of.slice(11, 19)}Z</span>}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '2px', marginBottom: '10px', borderBottom: '1px solid #1a1a2a', paddingBottom: '6px' }}>
        {(['overview', 'infrastructure', 'threats', 'simulate'] as const).map((tab) => (
          <button key={tab} onClick={() => setSelectedTab(tab)} style={{
            background: 'transparent', border: 'none', color: selectedTab === tab ? '#00ff88' : '#666',
            padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
            borderBottom: selectedTab === tab ? '2px solid #00ff88' : '2px solid transparent',
          }}>
            {tab === 'overview' && 'Overview'}
            {tab === 'infrastructure' && `Infra (${entities.length})`}
            {tab === 'threats' && `Threats (${threats.length})`}
            {tab === 'simulate' && 'Simulate'}
          </button>
        ))}
      </div>

      {/* ════════ OVERVIEW ════════ */}
      {selectedTab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* KPI row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '6px' }}>
            <KpiBox label="Services" value={entities.filter(e => e.health > 70).length + '/' + entities.length} color="#00ff88" />
            <KpiBox label="Alerts" value={alerts.filter(a => a.severity === 'critical' || a.severity === 'high').length} color={alerts.length > 0 ? '#ff4444' : '#888'} />
            <KpiBox label="Threats" value={threats.length} color={threats.length > 0 ? '#ff8844' : '#888'} />
            <KpiBox label="CPU" value={metrics.cpu_usage?.toFixed(0) || '—'} suffix="%" color={metrics.cpu_usage > 80 ? '#ff4444' : metrics.cpu_usage > 50 ? '#ffaa00' : '#00ff88'} />
            <KpiBox label="Memory" value={metrics.memory_usage?.toFixed(0) || '—'} suffix="%" color={metrics.memory_usage > 80 ? '#ff4444' : '#00ff88'} />
            <KpiBox label="Response" value={metrics.avg_response_ms?.toFixed(0) || '—'} suffix="ms" color={metrics.avg_response_ms > 200 ? '#ff4444' : metrics.avg_response_ms > 100 ? '#ffaa00' : '#00ff88'} />
          </div>

          {/* Métriques avancées */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '11px' }}>
            <div style={{ background: '#0d0d1d', borderRadius: '4px', padding: '8px' }}>
              <div style={{ color: '#666', marginBottom: '4px' }}>Throughput</div>
              <div style={{ color: '#00ff88', fontSize: '14px' }}>{(metrics.data_throughput_mbps || 0).toFixed(1)} Mbps</div>
            </div>
            <div style={{ background: '#0d0d1d', borderRadius: '4px', padding: '8px' }}>
              <div style={{ color: '#666', marginBottom: '4px' }}>Requests/min</div>
              <div style={{ color: metrics.api_requests_min > 1000 ? '#ff8844' : '#00ff88', fontSize: '14px' }}>
                {(metrics.api_requests_min || 0).toFixed(0)}
              </div>
            </div>
            <div style={{ background: '#0d0d1d', borderRadius: '4px', padding: '8px' }}>
              <div style={{ color: '#666', marginBottom: '4px' }}>Error Rate</div>
              <div style={{ color: metrics.error_rate_pct > 5 ? '#ff4444' : metrics.error_rate_pct > 1 ? '#ffaa00' : '#00ff88', fontSize: '14px' }}>
                {(metrics.error_rate_pct || 0).toFixed(1)}%
              </div>
            </div>
            <div style={{ background: '#0d0d1d', borderRadius: '4px', padding: '8px' }}>
              <div style={{ color: '#666', marginBottom: '4px' }}>Kafka Lag</div>
              <div style={{ color: metrics.kafka_lag > 1000 ? '#ff4444' : '#00ff88', fontSize: '14px' }}>
                {(metrics.kafka_lag || 0).toFixed(0)}
              </div>
            </div>
          </div>

          {/* Workers */}
          <div>
            <div style={{ fontSize: '11px', color: '#666', marginBottom: '6px' }}>WORKERS</div>
            {workers.map(w => (
              <div key={w.name} style={{
                display: 'flex', justifyContent: 'space-between', padding: '4px 8px',
                background: '#0d0d1d', borderRadius: '3px', fontSize: '11px', marginBottom: '2px',
              }}>
                <span>{w.name}</span>
                <span style={{ color: w.status === 'active' ? '#00ff88' : '#ff8844' }}>
                  {w.status} · last {w.last_seen?.slice(11, 19)}
                </span>
              </div>
            ))}
          </div>

          {/* Recent alerts */}
          {alerts.slice(-5).reverse().map(a => (
            <div key={a.id} style={{
              display: 'flex', gap: '6px', padding: '4px 8px', fontSize: '11px',
              background: '#0d0d1d', borderRadius: '3px',
              borderLeft: `3px solid ${a.severity === 'critical' ? '#ff4444' : a.severity === 'high' ? '#ff8844' : '#ffaa00'}`,
            }}>
              <span style={{ color: '#666', whiteSpace: 'nowrap' }}>{a.timestamp?.slice(11, 19)}</span>
              <span style={{ fontWeight: 'bold', color: a.severity === 'critical' ? '#ff4444' : '#ff8844' }}>[{a.severity?.toUpperCase()}]</span>
              <span>{a.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* ════════ INFRASTRUCTURE ════════ */}
      {selectedTab === 'infrastructure' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          {entities.sort((a, b) => a.type.localeCompare(b.type)).map(e => {
            const meta = ENTITY_META[e.type] || { icon: <Server size={12} />, color: '#888' };
            return (
              <div key={e.id} style={{
                display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px',
                background: '#0d0d1d', borderRadius: '4px', fontSize: '11px',
                borderLeft: `3px solid ${entityStatus(e.health)}`,
              }}>
                <span style={{ color: meta.color }}>{meta.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 'bold', color: '#e0e0ff' }}>{e.id}</div>
                  <div style={{ color: '#666' }}>{e.type} · {e.status}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '14px', fontWeight: 'bold', color: entityStatus(e.health) }}>
                    {e.health.toFixed(0)}%
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ════════ THREATS ════════ */}
      {selectedTab === 'threats' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          {threats.length === 0 && <div style={{ color: '#666', textAlign: 'center', padding: '20px' }}>No active threats — system secure</div>}
          {threats.map(t => (
            <div key={t.id} style={{
              display: 'flex', gap: '8px', padding: '8px 10px', fontSize: '11px',
              background: '#0d0d1d', borderRadius: '4px',
              borderLeft: `3px solid ${t.score > 0.9 ? '#ff4444' : t.score > 0.7 ? '#ff8844' : '#ffaa00'}`,
            }}>
              <Shield size={14} style={{ color: t.score > 0.9 ? '#ff4444' : '#ff8844', marginTop: 2 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 'bold', color: '#e0e0ff' }}>{t.indicator}</div>
                <div style={{ color: '#666' }}>{t.source} · {t.type}</div>
              </div>
              <div style={{ fontSize: '16px', fontWeight: 'bold', color: t.score > 0.9 ? '#ff4444' : t.score > 0.7 ? '#ff8844' : '#ffaa00' }}>
                {(t.score * 100).toFixed(0)}
              </div>
            </div>
          ))}
          <div style={{ marginTop: '8px' }}>
            <div style={{ fontSize: '11px', color: '#666', marginBottom: '4px' }}>ALERTS ({alerts.length})</div>
            {alerts.map(a => (
              <div key={a.id} style={{
                display: 'flex', gap: '6px', padding: '4px 8px', fontSize: '11px',
                background: '#0d0d1d', borderRadius: '3px', marginBottom: '2px',
                borderLeft: `3px solid ${a.severity === 'critical' ? '#ff4444' : a.severity === 'high' ? '#ff8844' : '#ffaa00'}`,
              }}>
                <span style={{ color: '#666', whiteSpace: 'nowrap' }}>{a.timestamp?.slice(11, 19)}</span>
                <span style={{ fontWeight: 'bold', color: a.severity === 'critical' ? '#ff4444' : '#ff8844' }}>[{a.severity?.toUpperCase()}]</span>
                <span>{a.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ════════ SIMULATE ════════ */}
      {selectedTab === 'simulate' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ fontSize: '11px', color: '#888', marginBottom: '4px' }}>
            Click a scenario to simulate its impact on the system. Results show predicted state after simulation.
          </div>
          <div style={{ display: 'grid', gap: '6px' }}>
            {SIMULATION_SCENARIOS.map(s => (
              <button key={s.id} onClick={() => runScenario(s)} disabled={simLoading !== null}
                style={{
                  background: '#111122', border: '1px solid #1a1a3a', borderRadius: '6px',
                  padding: '10px 12px', cursor: 'pointer', textAlign: 'left',
                  color: '#e0e0ff', fontSize: '12px', opacity: simLoading === s.id ? 0.6 : 1,
                  transition: 'all 0.2s',
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ fontWeight: 'bold', color: '#00ff88' }}>{s.label}</span>
                  {simLoading === s.id && <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} />}
                </div>
                <div style={{ color: '#888', fontSize: '11px' }}>{s.description}</div>
              </button>
            ))}
          </div>

          {/* Résultat */}
          {simResult && simLoading === null && (
            <div style={{
              background: '#111122', borderRadius: '6px', padding: '10px',
              border: '1px solid #1a1a3a', marginTop: '4px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontWeight: 'bold', color: '#00ff88', fontSize: '12px' }}>
                  {SIMULATION_SCENARIOS.find(s => s.id === simResult.scenario)?.label || simResult.scenario}
                </div>
                <div style={{ fontSize: '10px', color: '#666' }}>
                  {simResult.ticks} ticks · {simResult.duration_ms}ms
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', fontSize: '11px', marginBottom: '8px' }}>
                <div><span style={{ color: '#666' }}>CPU </span><span style={{ color: simResult.snapshot.metrics?.cpu_usage > 80 ? '#ff4444' : '#00ff88' }}>{(simResult.snapshot.metrics?.cpu_usage || 0).toFixed(0)}%</span></div>
                <div><span style={{ color: '#666' }}>Memory </span><span style={{ color: simResult.snapshot.metrics?.memory_usage > 80 ? '#ff4444' : '#00ff88' }}>{(simResult.snapshot.metrics?.memory_usage || 0).toFixed(0)}%</span></div>
                <div><span style={{ color: '#666' }}>Errors </span><span style={{ color: simResult.snapshot.metrics?.error_rate_pct > 5 ? '#ff4444' : '#00ff88' }}>{(simResult.snapshot.metrics?.error_rate_pct || 0).toFixed(1)}%</span></div>
              </div>
              <div style={{ fontSize: '11px' }}>
                <div style={{ color: '#666', marginBottom: '3px' }}>Entities:</div>
                {Object.values(simResult.snapshot.entities).map(e => (
                  <div key={e.id} style={{
                    display: 'flex', justifyContent: 'space-between', padding: '2px 0',
                    fontSize: '10px', borderBottom: '1px solid #0d0d1d',
                  }}>
                    <span>{e.id}</span>
                    <span style={{ color: entityStatus(e.health) }}>{e.status} · {e.health.toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Historique */}
          {simHistory.length > 1 && (
            <div>
              <div style={{ fontSize: '11px', color: '#666', marginBottom: '4px', marginTop: '4px' }}>SIMULATION HISTORY</div>
              {simHistory.slice(0, 5).map((h, i) => (
                <div key={h.id} style={{
                  display: 'flex', justifyContent: 'space-between', padding: '3px 6px',
                  fontSize: '10px', background: i === 0 ? '#0d0d1d' : 'transparent',
                  borderRadius: '3px', marginBottom: '1px',
                }}>
                  <span style={{ color: '#888' }}>{h.scenario}</span>
                  <span style={{ color: '#666' }}>{h.ticks} ticks · {h.duration_ms}ms</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ───── Helper ─────

function KpiBox({ label, value, suffix, color }: { label: string; value: string | number; suffix?: string; color: string }) {
  return (
    <div style={{ background: '#111122', borderRadius: '6px', padding: '8px', border: '1px solid #1a1a3a' }}>
      <div style={{ fontSize: '10px', color: '#888', marginBottom: '2px' }}>{label}</div>
      <div style={{ fontSize: '16px', fontWeight: 'bold', color }}>{value}{suffix || ''}</div>
    </div>
  );
}