/**
 * Tests for deriveEconomicAxis — the source_type/source_ref → economic_axis
 * mapping used at autopilot recommendation insert time.
 */

import {
  deriveEconomicAxis,
  FIND_MATCH_SOURCE_REFS,
} from '../src/services/recommendation-engine/economic-axis';

describe('deriveEconomicAxis', () => {
  test("returns 'marketplace' for marketplace source_type", () => {
    expect(deriveEconomicAxis('marketplace', null)).toBe('marketplace');
    expect(deriveEconomicAxis('marketplace', 'anything')).toBe('marketplace');
  });

  test('returns "find_match" for known match-related source_refs', () => {
    for (const ref of FIND_MATCH_SOURCE_REFS) {
      expect(deriveEconomicAxis('community', ref)).toBe('find_match');
    }
  });

  test('marketplace source_type wins over a find_match source_ref', () => {
    // If both signals are present (unlikely but possible), marketplace dominates.
    expect(deriveEconomicAxis('marketplace', 'engage_matches')).toBe('marketplace');
  });

  test('returns "none" for unrelated source types', () => {
    for (const sourceType of ['codebase', 'oasis', 'health', 'roadmap', 'llm', 'wearable', 'behavior', 'user-behavior']) {
      expect(deriveEconomicAxis(sourceType, null)).toBe('none');
    }
  });

  test('returns "none" for community source with unmapped source_ref', () => {
    expect(deriveEconomicAxis('community', 'engage_health')).toBe('none');
    expect(deriveEconomicAxis('community', 'start_streak')).toBe('none');
    expect(deriveEconomicAxis('community', 'weakness_movement')).toBe('none');
  });

  test('returns "none" for null/undefined inputs', () => {
    expect(deriveEconomicAxis(null, null)).toBe('none');
    expect(deriveEconomicAxis(undefined, undefined)).toBe('none');
    expect(deriveEconomicAxis(null, undefined)).toBe('none');
  });

  test('returns "none" for empty strings', () => {
    expect(deriveEconomicAxis('', '')).toBe('none');
  });
});
