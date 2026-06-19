/**
 * Plugin Engine — Manifest Validator
 *
 * Validates plugin manifests against the schema, including SemVer engine
 * constraint checking and dependency graph validation.
 */

import type { PluginManifest } from './types';

/* ------------------------------------------------------------------ */
/*  Manifest validation result                                         */
/* ------------------------------------------------------------------ */

export interface ManifestValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/*  Required fields & their types                                      */
/* ------------------------------------------------------------------ */

const REQUIRED_FIELDS: [keyof PluginManifest, string][] = [
  ['id', 'string'],
  ['name', 'string'],
  ['engineVersion', 'string'],
  ['version', 'string'],
  ['entry', 'string'],
];

/* ------------------------------------------------------------------ */
/*  ID format constraint                                               */
/* ------------------------------------------------------------------ */

const ID_PATTERN = /^@?[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)?$/;

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Validate a plugin manifest.
 */
export function validateManifest(
  raw: unknown,
  engineVersion?: string,
): ManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Manifest must be a non-null object'], warnings };
  }

  const manifest = raw as Record<string, unknown>;

  /* -- Required fields ------------------------------------------------- */

  for (const [field, expectedType] of REQUIRED_FIELDS) {
    const value = manifest[field];
    if (value === undefined || value === null) {
      errors.push(`Missing required field: "${field}"`);
    } else if (typeof value !== expectedType) {
      errors.push(`Field "${field}" must be of type "${expectedType}", got "${typeof value}"`);
    }
  }

  /* -- ID format ------------------------------------------------------- */

  if (typeof manifest.id === 'string' && !ID_PATTERN.test(manifest.id)) {
    errors.push(
      `Invalid plugin ID "${manifest.id}". Must match pattern: ${ID_PATTERN}`,
    );
  }

  /* -- Version format -------------------------------------------------- */

  if (typeof manifest.version === 'string' && !isValidSemVer(manifest.version)) {
    errors.push(`Invalid version "${manifest.version}". Must be valid SemVer (e.g. "1.2.3").`);
  }

  /* -- Engine version constraint --------------------------------------- */

  if (
    typeof manifest.engineVersion === 'string' &&
    typeof engineVersion === 'string'
  ) {
    const constraintOk = satisfiesSemVer(engineVersion, manifest.engineVersion);
    if (!constraintOk) {
      errors.push(
        `Engine version "${engineVersion}" does not satisfy plugin requirement "${manifest.engineVersion}".`,
      );
    }
  }

  /* -- Capabilities ---------------------------------------------------- */

  if (manifest.capabilities !== undefined) {
    if (!Array.isArray(manifest.capabilities)) {
      errors.push('"capabilities" must be an array of strings');
    } else {
      const validCaps = new Set([
        'network:fetch', 'network:websocket',
        'storage:local', 'storage:redis',
        'process:spawn', 'fs:read', 'fs:write',
        'event:emit', 'event:listen', 'api:expose',
      ]);
      for (const cap of manifest.capabilities) {
        if (!validCaps.has(cap as string)) {
          warnings.push(`Unknown capability "${String(cap)}".`);
        }
      }
    }
  }

  /* -- Dependencies ---------------------------------------------------- */

  if (manifest.dependencies !== undefined) {
    if (typeof manifest.dependencies !== 'object' || manifest.dependencies === null) {
      errors.push('"dependencies" must be an object mapping plugin IDs to SemVer constraints');
    } else {
      for (const [depId, constraint] of Object.entries(manifest.dependencies)) {
        if (typeof constraint !== 'string') {
          errors.push(
            `Dependency "${depId}" must have a string SemVer constraint, got "${typeof constraint}"`,
          );
        } else if (!isValidSemVerConstraint(constraint)) {
          warnings.push(
            `Dependency "${depId}" constraint "${constraint}" may not be valid SemVer range syntax.`,
          );
        }
      }
    }
  }

  /* -- Entry field special checks -------------------------------------- */

  if (typeof manifest.entry === 'string' && manifest.entry.length === 0) {
    errors.push('"entry" must be a non-empty string path or URL');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Check plugin dependency graph for consistency.
 */
export function checkDependencies(
  manifest: PluginManifest,
  registry: Map<string, PluginManifest>,
): string[] {
  const errors: string[] = [];

  if (!manifest.dependencies) return errors;

  for (const [depId, constraint] of Object.entries(manifest.dependencies)) {
    const depManifest = registry.get(depId);
    if (!depManifest) {
      errors.push(`Missing dependency: "${depId}" required by "${manifest.id}"`);
      continue;
    }

    if (!satisfiesSemVer(depManifest.version, constraint)) {
      errors.push(
        `Dependency "${depId}" version "${depManifest.version}" ` +
        `does not satisfy constraint "${constraint}" required by "${manifest.id}".`,
      );
    }
  }

  // Check for circular dependencies
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function detectCycle(id: string, chain: string[]): string | null {
    if (visiting.has(id)) {
      return [...chain.slice(chain.indexOf(id)), id].join(' → ');
    }
    if (visited.has(id)) return null;

    const depManifest = registry.get(id);
    if (!depManifest?.dependencies) return null;

    visiting.add(id);
    chain.push(id);

    for (const depId of Object.keys(depManifest.dependencies)) {
      const cycle = detectCycle(depId, chain);
      if (cycle) return cycle;
    }

    visiting.delete(id);
    visited.add(id);
    chain.pop();
    return null;
  }

  const cycle = detectCycle(manifest.id, []);
  if (cycle) {
    errors.push(`Circular dependency detected: ${cycle}`);
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/*  SemVer helpers (lightweight, no external dep)                      */
/* ------------------------------------------------------------------ */

function isValidSemVer(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.]+)?$/.test(version);
}

function isValidSemVerConstraint(constraint: string): boolean {
  if (constraint === '*' || constraint === 'x') return true;
  return /^(\^|~|>=?|<=?|=)?\d+\.\d+\.\d+/.test(constraint);
}

/**
 * Very simple SemVer satisfier.
 * Supports: `^1.2.3`, `~1.2.3`, `>=1.2.3`, `<=1.2.3`, `>1.2.3`, `<1.2.3`, `1.2.3`, `*`
 */
function satisfiesSemVer(version: string, constraint: string): boolean {
  if (constraint === '*' || constraint === 'x') return true;

  const parts = version.split('.').map(Number);
  const match = constraint.match(
    /^(\^|~|>=?|<=?|=)?(\d+)\.(\d+)\.(\d+)/,
  );

  if (!match) return false;

  const [, op, majStr, minStr, patStr] = match;
  const [vMajor, vMinor, vPatch] = parts;
  const cMajor = Number(majStr);
  const cMinor = Number(minStr);
  const cPatch = Number(patStr);
  const operator = op || '=';

  const cmp = (a: number, b: number): number => a - b;

  switch (operator) {
    case '^': // Compatible
      if (vMajor !== cMajor) return vMajor > cMajor;
      if (cMajor === 0) {
        // For 0.x.y, only patch updates are compatible
        if (cMinor === 0) return vMinor === 0 && vPatch >= cPatch;
        return vMinor >= cMinor;
      }
      return vMajor === cMajor && (vMinor > cMinor || (vMinor === cMinor && vPatch >= cPatch));
    case '~': // Approximately equivalent
      return vMajor === cMajor && vMinor === cMinor && vPatch >= cPatch;
    case '>=':
      return vMajor >= cMajor && vMinor >= cMinor && vPatch >= cPatch;
    case '<=':
      return vMajor <= cMajor && vMinor <= cMinor && vPatch <= cPatch;
    case '>':
      return vMajor > cMajor || (vMajor === cMajor && (vMinor > cMinor || (vMinor === cMinor && vPatch > cPatch)));
    case '<':
      return vMajor < cMajor || (vMajor === cMajor && (vMinor < cMinor || (vMinor === cMinor && vPatch < cPatch)));
    case '=':
    default:
      return vMajor === cMajor && vMinor === cMinor && vPatch === cPatch;
  }
}