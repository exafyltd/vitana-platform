/**
 * Tests for evaluateRecAlignment — the pure evaluator behind the activation-
 * time alignment-warning OASIS event (VTID-02935).
 *
 * Contract (docs/GOVERNANCE/ULTIMATE-GOAL.md):
 *   - "served"  = rec advances a pillar OR the economic axis.
 *   - "unclear" = rec advances neither.
 */

import { evaluateRecAlignment } from '../src/services/recommendation-engine/alignment-evaluator';

describe('evaluateRecAlignment', () => {
  test('returns unclear when both pillar and economic axis are absent', () => {
    const result = evaluateRecAlignment({
      contribution_vector: {},
      economic_axis: 'none',
      autonomy_level: 'manual',
    });
    expect(result.aligned).toBe(false);
    expect(result.topic).toBe('autopilot.alignment.unclear');
    expect(result.status).toBe('warning');
    expect(result.has_pillar).toBe(false);
    expect(result.has_economy).toBe(false);
  });

  test('returns served when only a pillar is advanced', () => {
    const result = evaluateRecAlignment({
      contribution_vector: { sleep: 0.6 },
      economic_axis: 'none',
      autonomy_level: 'manual',
    });
    expect(result.aligned).toBe(true);
    expect(result.topic).toBe('autopilot.alignment.served');
    expect(result.status).toBe('info');
    expect(result.has_pillar).toBe(true);
    expect(result.has_economy).toBe(false);
    expect(result.message).toContain('sleep');
  });

  test('returns served when only the economic axis is advanced', () => {
    const result = evaluateRecAlignment({
      contribution_vector: {},
      economic_axis: 'marketplace',
      autonomy_level: 'auto_approved',
    });
    expect(result.aligned).toBe(true);
    expect(result.topic).toBe('autopilot.alignment.served');
    expect(result.status).toBe('info');
    expect(result.has_pillar).toBe(false);
    expect(result.has_economy).toBe(true);
    expect(result.message).toContain('marketplace');
    expect(result.autonomy_level).toBe('auto_approved');
  });

  test('returns served when both pillar and economic axis are advanced', () => {
    const result = evaluateRecAlignment({
      contribution_vector: { mental: 0.5 },
      economic_axis: 'find_match',
      autonomy_level: 'assisted',
    });
    expect(result.aligned).toBe(true);
    expect(result.topic).toBe('autopilot.alignment.served');
    expect(result.has_pillar).toBe(true);
    expect(result.has_economy).toBe(true);
    expect(result.message).toMatch(/mental.*\+.*find_match/);
  });

  test('handles null / missing inputs by defaulting safely', () => {
    const result = evaluateRecAlignment({});
    expect(result.aligned).toBe(false);
    expect(result.economic_axis).toBe('none');
    expect(result.autonomy_level).toBe('manual');
    expect(result.topic).toBe('autopilot.alignment.unclear');
  });

  test('ignores below-band pillar weights (no false positives at low magnitudes)', () => {
    // max weight 0.04 → below 0.05 low band → magnitude 'none' → not a pillar advance
    const result = evaluateRecAlignment({
      contribution_vector: { nutrition: 0.04 },
      economic_axis: 'none',
    });
    expect(result.aligned).toBe(false);
    expect(result.has_pillar).toBe(false);
  });

  test('message contains the path to the contract on unclear', () => {
    const result = evaluateRecAlignment({ economic_axis: 'none' });
    expect(result.message).toContain('docs/GOVERNANCE/ULTIMATE-GOAL.md');
  });
});
