import { describe, expect, it } from 'vitest';
import {
  assessRisk,
  calculateSubnetStart,
  classifyDevice,
  ipToNumber,
  isPrivateOrReserved,
  numberToIp,
  parseIPv4,
} from '../../src/lib/osint-utils';

describe('osint-utils', () => {
  it('parses valid IPv4 and rejects malformed or out-of-range values', () => {
    expect(parseIPv4('8.8.8.8')).toEqual([8, 8, 8, 8]);
    expect(parseIPv4('8.8.8')).toBeNull();
    expect(parseIPv4('8.8.8.999')).toBeNull();
    expect(parseIPv4('metadata.google.internal')).toBeNull();
  });

  it('identifies private and reserved IPv4 ranges', () => {
    expect(isPrivateOrReserved([10, 1, 2, 3])).toBe(true);
    expect(isPrivateOrReserved([172, 20, 2, 3])).toBe(true);
    expect(isPrivateOrReserved([192, 168, 2, 3])).toBe(true);
    expect(isPrivateOrReserved([169, 254, 169, 254])).toBe(true);
    expect(isPrivateOrReserved([8, 8, 8, 8])).toBe(false);
  });

  it('round-trips IPv4 numbers and calculates subnet start', () => {
    const ip = parseIPv4('203.0.113.42');
    expect(ip).not.toBeNull();
    if (!ip) return;

    const numeric = ipToNumber(ip);
    expect(numberToIp(numeric)).toBe('203.0.113.42');
    expect(numberToIp(calculateSubnetStart(numeric, 24))).toBe('203.0.113.0');
  });

  it('classifies risky exposed services before generic web hosts', () => {
    expect(classifyDevice([554, 80], [], []).device_type).toBe('Camera/DVR');
    expect(classifyDevice([3306], [], []).device_type).toBe('Database');
    expect(classifyDevice([80, 443], [], []).device_type).toBe('Web Server');
  });

  it('assesses vulnerabilities and dangerous service exposure as higher risk', () => {
    expect(assessRisk({ vulns: ['a', 'b', 'c', 'd', 'e', 'f'] })).toBe('CRITICAL');
    expect(assessRisk({ vulns: ['CVE-2024-0001'] })).toBe('HIGH');
    expect(assessRisk({ ports: [23] })).toBe('MEDIUM');
    expect(assessRisk({ ports: [80, 443, 8080, 8443, 22, 25] })).toBe('LOW');
    expect(assessRisk({ ports: [443] })).toBe('INFO');
  });
});
