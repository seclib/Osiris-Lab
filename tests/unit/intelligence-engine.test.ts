import { describe, expect, it } from 'vitest';
import { generateIntelligenceReport, type OperationalData } from '@/lib/intelligence-engine';

describe('generateIntelligenceReport', () => {
  it('correlates an earthquake with nearby infrastructure into an actionable finding', () => {
    const data: OperationalData = {
      earthquakes: [
        {
          id: 'eq-1',
          magnitude: 6.8,
          depth: 12,
          place: 'Test offshore logistics corridor',
          lat: 35,
          lng: 140,
          tsunami: false,
        },
      ],
      maritime_ports: [
        {
          name: 'Test Port',
          lat: 35.2,
          lng: 140.1,
        },
      ],
    };

    const report = generateIntelligenceReport(data, new Date('2026-06-10T00:00:00Z'));
    const finding = report.findings.find(item => item.module === 'earthquakes');

    expect(finding).toBeDefined();
    expect(finding?.title).toContain('Earthquake impact risk');
    expect(finding?.correlations.some(item => item.includes('Test Port'))).toBe(true);
    expect(finding?.risk_score).toBeGreaterThanOrEqual(70);
  });

  it('turns a critical chokepoint with stopped vessels into maritime intelligence', () => {
    const data: OperationalData = {
      maritime_chokepoints: [
        {
          name: 'Test Strait',
          risk: 'CRITICAL',
          lat: 12,
          lng: 43,
          traffic: 'critical trade lane',
        },
      ],
      maritime_ships: Array.from({ length: 12 }, (_, index) => ({
        mmsi: 1000 + index,
        lat: 12 + index * 0.01,
        lng: 43 + index * 0.01,
        speed: index < 7 ? 0.1 : 10,
      })),
    };

    const report = generateIntelligenceReport(data, new Date('2026-06-10T00:00:00Z'));
    const finding = report.findings.find(item => item.module === 'maritime');

    expect(finding).toBeDefined();
    expect(finding?.title).toContain('Test Strait');
    expect(finding?.signals.stopped_or_slow_ships).toBe(7);
    expect(finding?.severity).toBe('CRITICAL');
  });
});
