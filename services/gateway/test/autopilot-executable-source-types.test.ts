/**
 * VTID-02984 (PR-M1.x): unit tests for the shared executor-source-type
 * allowlist. The whole point of this module is to be a single answer
 * to "is this source_type allowed to enter the executor lane?" — these
 * tests pin that answer down before any caller relies on it.
 */

import {
  EXECUTABLE_RECOMMENDATION_SOURCE_TYPES,
  isExecutableSourceType,
  executableSourceTypesPostgrestIn,
} from '../src/services/autopilot-executable-source-types';

describe('isExecutableSourceType — the executor gate', () => {
  it('accepts dev_autopilot (legacy baseline scan source) — backward compat preserved', () => {
    expect(isExecutableSourceType('dev_autopilot')).toBe(true);
  });

  it('accepts dev_autopilot_impact (impact-rule findings) — backward compat preserved', () => {
    expect(isExecutableSourceType('dev_autopilot_impact')).toBe(true);
  });

  it('accepts test-contract-failure-scanner (PR-L3 recurring contract failures)', () => {
    expect(isExecutableSourceType('test-contract-failure-scanner')).toBe(true);
  });

  it('accepts missing-test-scanner (PR-L2 capabilities without contracts)', () => {
    expect(isExecutableSourceType('missing-test-scanner')).toBe(true);
  });

  it('REJECTS unrelated source types so misrouted rows stay out of the executor', () => {
    expect(isExecutableSourceType('community-recommendation')).toBe(false);
    expect(isExecutableSourceType('orb-voice-scanner')).toBe(false);
    expect(isExecutableSourceType('voice-experience-scanner-v1')).toBe(false);
    expect(isExecutableSourceType('system')).toBe(false);
  });

  it('REJECTS empty / null / undefined / whitespace inputs', () => {
    expect(isExecutableSourceType('')).toBe(false);
    expect(isExecutableSourceType(null)).toBe(false);
    expect(isExecutableSourceType(undefined)).toBe(false);
    expect(isExecutableSourceType(' dev_autopilot ')).toBe(false); // whitespace must not slip through
  });

  it('is case-sensitive — typos like DEV_AUTOPILOT must not be accepted', () => {
    expect(isExecutableSourceType('DEV_AUTOPILOT')).toBe(false);
    expect(isExecutableSourceType('Test-Contract-Failure-Scanner')).toBe(false);
  });

  it('exports the canonical list with exactly the four current entries (lock in scope)', () => {
    const sorted = [...EXECUTABLE_RECOMMENDATION_SOURCE_TYPES].sort();
    expect(sorted).toEqual([
      'dev_autopilot',
      'dev_autopilot_impact',
      'missing-test-scanner',
      'test-contract-failure-scanner',
    ]);
  });
});

describe('executableSourceTypesPostgrestIn — PostgREST in.() value renderer', () => {
  it('produces a comma-separated list of double-quoted, URL-encoded values', () => {
    const rendered = executableSourceTypesPostgrestIn();
    // Every member of the allowlist must appear (encoded if needed)
    for (const t of EXECUTABLE_RECOMMENDATION_SOURCE_TYPES) {
      expect(rendered).toContain(`"${encodeURIComponent(t)}"`);
    }
    // Comma-separated structure: one fewer comma than there are entries
    const commaCount = (rendered.match(/,/g) || []).length;
    expect(commaCount).toBe(EXECUTABLE_RECOMMENDATION_SOURCE_TYPES.length - 1);
  });

  it('URL-encodes hyphenated source types (test-contract-failure-scanner) without breaking the in.() syntax', () => {
    const rendered = executableSourceTypesPostgrestIn();
    // Hyphen is safe in URLs so no actual encoding needed, but
    // encodeURIComponent must still leave the value intact
    expect(rendered).toContain('"test-contract-failure-scanner"');
    expect(rendered).toContain('"missing-test-scanner"');
  });

  it('is deterministic (same call → same output) so PostgREST filter stays cacheable', () => {
    expect(executableSourceTypesPostgrestIn()).toEqual(executableSourceTypesPostgrestIn());
  });
});
