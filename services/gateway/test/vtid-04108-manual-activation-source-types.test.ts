/**
 * VTID-04108 — Part 1 of the recommendation activation bridge reactivation
 * request (VTID-04105): a SEPARATE, wider source_type allowlist for the
 * HUMAN-TRIGGERED `POST /:id/activate` -> `bridgeActivationToExecution()`
 * path only, never for the autonomous `autoApproveTick()` polling loop.
 *
 * Two governance-critical invariants this file exists to pin:
 *
 * 1. `isManuallyBridgeableSourceType()` accepts everything
 *    `isExecutableSourceType()` does, PLUS `community`/`health` — but
 *    `EXECUTABLE_RECOMMENDATION_SOURCE_TYPES` (and everything derived from
 *    it: `isExecutableSourceType`, `executableSourceTypesPostgrestIn`) is
 *    completely UNCHANGED. `autoApproveTick()`'s own poll query still
 *    reads the narrow list — widening what a human can manually activate
 *    must never also widen what the autonomous loop auto-approves with
 *    no human in the loop and no code review gate.
 *
 * 2. `approveAutoExecute()` only applies the wider check when its caller
 *    explicitly passes `allowManualSourceTypes: true` — and the only
 *    caller that does is `bridgeActivationToExecution()`. Every other
 *    existing caller (the two inside `autoApproveTick()`, the operator
 *    on-ramp, the two REST approve routes) is unmodified and gets the
 *    exact same narrow behavior as before this VTID.
 */

import {
  EXECUTABLE_RECOMMENDATION_SOURCE_TYPES,
  MANUALLY_BRIDGEABLE_SOURCE_TYPES,
  isExecutableSourceType,
  isManuallyBridgeableSourceType,
  executableSourceTypesPostgrestIn,
} from '../src/services/autopilot-executable-source-types';

describe('isManuallyBridgeableSourceType — the human-activation gate (VTID-04108)', () => {
  it('accepts every source_type isExecutableSourceType accepts (superset, not a replacement)', () => {
    for (const t of EXECUTABLE_RECOMMENDATION_SOURCE_TYPES) {
      expect(isManuallyBridgeableSourceType(t)).toBe(true);
    }
  });

  it('additionally accepts community and health (the two AC-named types)', () => {
    expect(isManuallyBridgeableSourceType('community')).toBe(true);
    expect(isManuallyBridgeableSourceType('health')).toBe(true);
  });

  it('still REJECTS source types outside both lists — this is not a wildcard', () => {
    expect(isManuallyBridgeableSourceType('behavior')).toBe(false);
    expect(isManuallyBridgeableSourceType('oasis')).toBe(false);
    expect(isManuallyBridgeableSourceType('roadmap')).toBe(false);
    expect(isManuallyBridgeableSourceType('codebase')).toBe(false);
  });

  it('REJECTS empty / null / undefined inputs, same as isExecutableSourceType', () => {
    expect(isManuallyBridgeableSourceType('')).toBe(false);
    expect(isManuallyBridgeableSourceType(null)).toBe(false);
    expect(isManuallyBridgeableSourceType(undefined)).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isManuallyBridgeableSourceType('Community')).toBe(false);
    expect(isManuallyBridgeableSourceType('HEALTH')).toBe(false);
  });

  it('exports MANUALLY_BRIDGEABLE_SOURCE_TYPES as exactly the executable set plus community/health (lock scope)', () => {
    const sorted = [...MANUALLY_BRIDGEABLE_SOURCE_TYPES].sort();
    expect(sorted).toEqual(
      [...EXECUTABLE_RECOMMENDATION_SOURCE_TYPES, 'community', 'health'].sort(),
    );
  });
});

describe('the narrow allowlist is untouched by this VTID (autonomous-loop regression guard)', () => {
  it('EXECUTABLE_RECOMMENDATION_SOURCE_TYPES still has exactly its original five entries', () => {
    const sorted = [...EXECUTABLE_RECOMMENDATION_SOURCE_TYPES].sort();
    expect(sorted).toEqual([
      'dev_autopilot',
      'dev_autopilot_impact',
      'missing-test-scanner',
      'operator_onramp',
      'test-contract-failure-scanner',
    ]);
  });

  it('isExecutableSourceType still rejects community/health (autoApproveTick must never pick these up)', () => {
    expect(isExecutableSourceType('community')).toBe(false);
    expect(isExecutableSourceType('health')).toBe(false);
  });

  it('executableSourceTypesPostgrestIn (what autoApproveTick polls) never includes community/health', () => {
    const rendered = executableSourceTypesPostgrestIn();
    expect(rendered).not.toContain('"community"');
    expect(rendered).not.toContain('"health"');
  });
});
