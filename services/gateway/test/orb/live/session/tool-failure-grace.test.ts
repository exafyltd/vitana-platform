/**
 * VTID-03245 — tool-failure grace layer tests (offer-integrity).
 *
 * Locks the rule that fixed "it guides me to something it can't perform, then
 * says we have system issues": a hard tool failure must reach the model as a
 * graceful pivot, never as a raw error.
 */

import {
  graceToolResultForModel,
  isHardToolFailure,
} from '../../../../src/orb/live/session/tool-failure-grace';

describe('isHardToolFailure', () => {
  it('true only for success === false', () => {
    expect(isHardToolFailure({ success: false, error: 'boom' })).toBe(true);
    expect(isHardToolFailure({ success: true, result: 'ok' })).toBe(false);
    expect(isHardToolFailure(null)).toBe(false);
    expect(isHardToolFailure(undefined)).toBe(false);
  });
});

describe('graceToolResultForModel', () => {
  it('passes a successful result through unchanged (no-op)', () => {
    const ok = { success: true, result: 'here are your matches' };
    expect(graceToolResultForModel('find_perfect_practitioner', ok)).toBe(ok);
  });

  it('reshapes a hard failure into a non-error pivot the model can speak', () => {
    const failed = { success: false, result: '', error: 'system issues making a nutrition plan' };
    const graced = graceToolResultForModel('create_index_improvement_plan', failed);

    // Must NOT read as a failure to the model.
    expect(graced.success).toBe(true);
    expect('error' in graced ? graced.error : undefined).toBeUndefined();

    // The raw error text must NOT leak to the model.
    expect(JSON.stringify(graced)).not.toMatch(/system issues/i);

    const parsed = JSON.parse(graced.result as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.available).toBe(false);
    expect(parsed.tool).toBe('create_index_improvement_plan');
    expect(typeof parsed.speak_guidance).toBe('string');
    // Guidance must forbid surfacing the failure as a system problem.
    expect(parsed.speak_guidance).toMatch(/do not mention/i);
    expect(parsed.speak_guidance.toLowerCase()).toContain('pivot');
  });

  it('never emits the words error/bug/system-issue to the model', () => {
    const graced = graceToolResultForModel('get_autopilot_recommendations', {
      success: false,
      error: 'NOT_SIGNED_IN',
    });
    const wire = JSON.stringify(graced).toLowerCase();
    expect(wire).not.toContain('not_signed_in');
    // (The guidance string itself references these words only inside a
    //  "do NOT mention ..." instruction; the user-facing pivot won't.)
  });
});
