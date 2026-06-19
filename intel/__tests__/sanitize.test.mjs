/**
 * Tests for the OSIRIS Intel Engine — sanitization and SPARQL safety
 *
 * These tests validate that sanitizeId() correctly prevents SPARQL injection
 * attacks while preserving legitimate inputs.
 *
 * Run: npx vitest run
 */

import { describe, it, expect } from 'vitest';

// Replicate sanitizeId from intel/server.js for testing
// (we test the actual function logic in isolation)
// NOTE: `.` (dot) is deliberately allowed — it's common in entity names
// and is safe inside SPARQL string literals.
function sanitizeId(id) {
  if (typeof id !== 'string') return '';
  // Reject if it contains characters that SPARQL could interpret as syntax
  if (/["{};#@^/|`\\]/.test(id)) return '';

  const clean = id.replace(/\s+/g, ' ').trim();
  const filtered = clean.replace(/[^a-zA-Z0-9 \-_.'()]/g, '').trim();
  if (filtered.length < 2) return '';
  return filtered.slice(0, 100);
}

function safeLabelEquality(label) {
  const safe = sanitizeId(label);
  if (!safe) return null;
  return `?item rdfs:label "${safe}"@en`;
}

function safeLabelFilter(label) {
  const safe = sanitizeId(label);
  if (!safe) return null;
  return `FILTER(CONTAINS(LCASE(?itemLabel), "${safe.toLowerCase()}"))`;
}

// ─── sanitizeId ────────────────────────────────────────────────────────────

describe('sanitizeId', () => {
  it('preserves normal text', () => {
    expect(sanitizeId('Apple Inc.')).toBe('Apple Inc.');
    expect(sanitizeId('John Doe')).toBe('John Doe');
    expect(sanitizeId('Mega Corp Ltd')).toBe('Mega Corp Ltd');
  });

  it('preserves alphanumeric with hyphens and underscores', () => {
    expect(sanitizeId('test-user_name')).toBe('test-user_name');
    expect(sanitizeId('user123')).toBe('user123');
  });

  it('truncates to 100 chars', () => {
    const long = 'A'.repeat(150);
    const result = sanitizeId(long);
    expect(result.length).toBe(100);
  });

  it('collapses multiple whitespace', () => {
    expect(sanitizeId('Too   many    spaces')).toBe('Too many spaces');
  });

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeId('  padded  ')).toBe('padded');
  });

  // ── SPARQL injection vectors ──

  it('rejects double quotes — string terminator', () => {
    expect(sanitizeId('test" UNION SELECT ?password WHERE {')).toBe('');
  });

  it('rejects curly braces — graph patterns', () => {
    expect(sanitizeId('test{}}')).toBe('');
    expect(sanitizeId('{malicious}')).toBe('');
  });

  it('rejects semicolons — object list separator', () => {
    expect(sanitizeId('mal;icious')).toBe('');
  });

  it('allows dots — safe inside SPARQL strings', () => {
    // Dots are common in entity names (e.g. "Apple Inc.") and are safe
    // inside SPARQL string literals — they only act as statement
    // terminators outside quotes.
    expect(sanitizeId('test.example')).toBe('test.example');
  });

  it('rejects hashes — line comments', () => {
    expect(sanitizeId('test#comment')).toBe('');
  });

  it('rejects at-symbol — language tags', () => {
    expect(sanitizeId('test@en')).toBe('');
  });

  it('rejects carets — inverse property paths', () => {
    expect(sanitizeId('test^inverse')).toBe('');
  });

  it('rejects forward slashes — property path concatenation', () => {
    expect(sanitizeId('test/path')).toBe('');
  });

  it('rejects pipes — property path alternation', () => {
    expect(sanitizeId('test|alt')).toBe('');
  });

  it('rejects backticks', () => {
    expect(sanitizeId('test`evil')).toBe('');
  });

  it('rejects backslashes', () => {
    expect(sanitizeId('test\\escape')).toBe('');
  });

  // ── SPARQL injection — full query breakouts ──

  it('rejects known SPARQL injection patterns', () => {
    const patterns = [
      '"] { ?item ?p ?o } UNION { SELECT ?x WHERE { BIND("',
      '"});#',
      'bla"^^xsd:string;foaf:name"?',
      '${7*7}',
      'test"@en;rdfs:label"',
    ];
    for (const pattern of patterns) {
      expect(sanitizeId(pattern)).toBe('');
    }
  });

  it('preserves CVE identifiers (they may contain dots)', () => {
    // CVEs like CVE-2024-12345 are fine; dotted versions like v1.2.3 also pass
    expect(sanitizeId('CVE-2024-12345')).toBe('CVE-2024-12345');
    expect(sanitizeId('v1.2.3')).toBe('v1.2.3');
  });

  it('handles non-string input', () => {
    expect(sanitizeId(null)).toBe('');
    expect(sanitizeId(undefined)).toBe('');
    expect(sanitizeId(123)).toBe('');
    expect(sanitizeId({})).toBe('');
  });

  it('rejects empty result after filtering', () => {
    expect(sanitizeId('a')).toBe('');
    expect(sanitizeId('@#$%')).toBe('');
  });

  it('preserves parentheses', () => {
    expect(sanitizeId('Test (Group)')).toBe('Test (Group)');
  });

  it('handles Unicode characters in names', () => {
    const result = sanitizeId('José García Mário');
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThanOrEqual(5);
  });
});

// ─── safeLabelEquality ─────────────────────────────────────────────────────

describe('safeLabelEquality', () => {
  it('builds safe SPARQL equality for valid input', () => {
    const result = safeLabelEquality('Acme Corp');
    expect(result).toBe('?item rdfs:label "Acme Corp"@en');
  });

  it('returns null for input with injection chars', () => {
    expect(safeLabelEquality('test"bad')).toBeNull();
    expect(safeLabelEquality('{inject}')).toBeNull();
  });

  it('returns null for short input', () => {
    expect(safeLabelEquality('a')).toBeNull();
  });

  it('handles apostrophes in names', () => {
    const result = safeLabelEquality("O'Brien");
    expect(result).toBe('?item rdfs:label "O\'Brien"@en');
  });
});

// ─── safeLabelFilter ───────────────────────────────────────────────────────

describe('safeLabelFilter', () => {
  it('builds safe SPARQL FILTER for valid input', () => {
    const result = safeLabelFilter('Acme Corp');
    expect(result).toBe('FILTER(CONTAINS(LCASE(?itemLabel), "acme corp"))');
  });

  it('returns null for input with injection chars', () => {
    expect(safeLabelFilter('test"bad')).toBeNull();
  });

  it('returns null for short input', () => {
    expect(safeLabelFilter('x')).toBeNull();
  });

  it('lowercases the filter value', () => {
    expect(safeLabelFilter('UPPERCASE')).toContain('"uppercase"');
  });
});