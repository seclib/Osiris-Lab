'use client';

import { useEffect, useRef, useState } from 'react';

interface MapPoint {
  id: string; lat: number; lon: number; type: string; severity: string;
  label: string; timestamp: string; source: string
}

const SEED_POINTS: MapPoint[] = [
  { id: 'G1', lat: 48.8566, lon: 2.3522, type: 'anomaly.movement', severity: 'warning', label: 'Paris — unexpected vehicle cluster', timestamp: '12:34', source: 'geoint-sensor-1' },
  { id: 'G2', lat: 35.6762, lon: 139.6503, type: 'signal.intercept', severity: 'info', label: 'Tokyo — signal spike', timestamp: '12:28', source: 'geoint-sensor-2' },
  { id: 'G3', lat: -33.8688, lon: 151.2093, type: 'asset.tracking', severity: 'info', label: 'Sydney — vessel detected', timestamp: '12:15', source: 'geoint-sensor-3' },
  { id: 'G4', lat: 51.5074, lon: -0.1278, type: 'anomaly.movement', severity: 'error', label: 'London — pattern deviation', timestamp: '11:50', source: 'geoint-engine' },
  { id: 'G5', lat: 19.0760, lon: 72.8777, type: 'satellite.overpass', severity: 'info', label: 'Mumbai — satellite pass complete', timestamp: '11:22', source: 'geoint-sat-1' },
];

function lonToX(lon: number, w: number) { return ((lon + 180) / 360) * w; }
function latToY(lat: number, h: number) { return ((90 - lat) / 180) * h; }

interface GeointIntelligencePanelProps {
  onClose?: () => void;
  onInspect?: (id: string, data: any) => void;
}

export default function GeointIntelligencePanel({ onClose, onInspect }: GeointIntelligencePanelProps) {
  const [points] = useState(SEED_POINTS);
  const [hovered, setHovered] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 450 });

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setDims({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sevColor = (s: string) =>
    s === 'critical' ? '#f85149' : s === 'error' ? '#d29922' : s === 'warning' ? '#ff9100' : '#58a6ff';

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#0d1117]">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[#21262d] flex-shrink-0 text-[10px] font-mono text-[#8b949e]">
        <span className="text-[#58a6ff] font-bold">⊙ GEOINT SPATIAL</span>
        <span className="text-[#484f58]">[ {points.length} contacts ]</span>
        <span className="text-[#3fb950] font-bold ml-1">_</span>
        <div className="flex-1" />
        {['anomaly', 'signal', 'asset', 'satellite'].map(t => (
          <span key={t} className="px-1 py-0.5 rounded bg-[#1c2128] text-[8px]">{t}</span>
        ))}
        {onClose && <button onClick={onClose} className="text-[#f85149] text-[9px] px-1">✕</button>}
      </div>

      {/* SVG Map */}
      <div className="flex-1 overflow-hidden relative">
        <svg ref={svgRef} width={dims.w} height={dims.h} className="block" style={{ background: '#0d1117' }}>
          {/* Grid lines */}
          {Array.from({ length: 12 }).map((_, i) => {
            const x = (i + 1) * dims.w / 13;
            return <line key={`vg${i}`} x1={x} y1={0} x2={x} y2={dims.h} stroke="#21262d" strokeWidth={0.5} />;
          })}
          {Array.from({ length: 6 }).map((_, i) => {
            const y = (i + 1) * dims.h / 7;
            return <line key={`hg${i}`} x1={0} y1={y} x2={dims.w} y2={y} stroke="#21262d" strokeWidth={0.5} />;
          })}

          {/* Continents (simplified) */}
          {[
            { points: [[10, 55], [30, 60], [40, 55], [50, 50], [100, 50], [120, 40], [140, 35], [130, 20], [100, 0], [80, 10], [40, 5], [10, 0], [0, 10], [-10, 20], [-10, 40], [0, 50], [10, 55]] },
            { points: [[-130, 50], [-100, 50], [-80, 40], [-80, 20], [-90, 10], [-100, 0], [-80, -10], [-60, -20], [-50, -30], [-70, -40], [-80, -50], [-120, -50], [-130, -40], [-140, -30], [-130, 10], [-130, 30], [-130, 50]] },
            { points: [[110, -20], [130, -10], [150, -20], [155, -30], [150, -40], [130, -40], [110, -30], [110, -20]] },
          ].map((cont, i) => (
            <polygon key={i}
              points={cont.points.map(([lon, lat]) => `${lonToX(lon, dims.w)},${latToY(lat, dims.h)}`).join(' ')}
              fill="#161b22" stroke="#30363d" strokeWidth={0.5} />
          ))}

          {/* Event points */}
          {points.map(p => {
            const cx = lonToX(p.lon, dims.w);
            const cy = latToY(p.lat, dims.h);
            const isHovered = hovered === p.id;
            const r = isHovered ? 10 : 6;
            return (
              <g key={p.id}
                onClick={() => onInspect?.(p.id, p)}
                onMouseEnter={() => setHovered(p.id)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: 'pointer' }}>
                <circle cx={cx} cy={cy} r={r + 4} fill="none" stroke={sevColor(p.severity)} strokeWidth={1} opacity={isHovered ? 0.8 : 0.3} />
                <circle cx={cx} cy={cy} r={r} fill={sevColor(p.severity)} opacity={0.9} />
                {isHovered && (
                  <g>
                    <rect x={cx - 60} y={cy - r - 32} width={120} height={24} rx={4} fill="#1c2128" stroke="#30363d" />
                    <text x={cx} y={cy - r - 16} textAnchor="middle" fill="#e6edf3" fontSize={9} fontFamily="monospace">{p.label}</text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Event List */}
      <div className="h-24 border-t border-[#30363d] overflow-auto flex-shrink-0 text-[9px] font-mono">
        <div className="grid grid-cols-[50px_100px_1fr_50px] gap-1 px-2 py-1 text-[#484f58] font-bold text-[8px] border-b border-[#21262d]">
          <span>TIME</span><span>TYPE</span><span>LABEL</span><span>SEV</span>
        </div>
        {points.map(p => (
          <div key={p.id} onClick={() => onInspect?.(p.id, p)} className="grid grid-cols-[50px_100px_1fr_50px] gap-1 px-2 py-0.5 cursor-pointer border-b border-[#21262d] items-center">
            <span className="text-[#484f58] text-[8px]">{p.timestamp}</span>
            <span className="text-[#58a6ff]">{p.type}</span>
            <span className="text-[#e6edf3] truncate">{p.label}</span>
            <span className="font-bold text-right" style={{ color: sevColor(p.severity) }}>{p.severity}</span>
          </div>
        ))}
      </div>
    </div>
  );
}