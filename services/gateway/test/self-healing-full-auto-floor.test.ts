/**
 * Self-Healing FULL_AUTO auto-approval floor.
 *
 * Bug: AutonomyLevel.FULL_AUTO (Level 4) was defined in the enum but never
 * wired into the auto-approval decision. The injector hardcoded
 * `confidence >= 0.8`, so selecting "Level 4: FULL AUTO" in the Command Hub
 * had no effect — every sub-0.8 diagnosis stayed `spec_status='validated'`
 * (awaiting approval) and the reconciler later marked it `escalated`. Result:
 * the Self-Healing History showed 100% escalated / 0 fixed.
 *
 * Fix: autoApproveFloor(level) returns a per-level confidence floor —
 * FULL_AUTO relaxes it to 0.5 (matching the <0.5 escalation boundary), while
 * AUTO_FIX_SIMPLE keeps the historical 0.8 and the human-gated levels never
 * auto-approve on confidence alone.
 */

import { autoApproveFloor } from '../src/services/self-healing-injector-service';
import { AutonomyLevel } from '../src/types/self-healing';

describe('autoApproveFloor (self-healing auto-approval gate)', () => {
  it('FULL_AUTO (Level 4) auto-approves at >= 0.5 confidence', () => {
    expect(autoApproveFloor(AutonomyLevel.FULL_AUTO)).toBe(0.5);
  });

  it('AUTO_FIX_SIMPLE (Level 3) keeps the historical 0.8 floor', () => {
    expect(autoApproveFloor(AutonomyLevel.AUTO_FIX_SIMPLE)).toBe(0.8);
  });

  it('human-gated / observe levels never auto-approve on confidence alone', () => {
    expect(autoApproveFloor(AutonomyLevel.SPEC_AND_WAIT)).toBeGreaterThan(1.0);
    expect(autoApproveFloor(AutonomyLevel.DIAGNOSE_ONLY)).toBeGreaterThan(1.0);
    expect(autoApproveFloor(AutonomyLevel.OBSERVE_ONLY)).toBeGreaterThan(1.0);
  });

  describe('regression: a 0.6-confidence diagnosis', () => {
    const confidence = 0.6;

    it('auto-runs under FULL_AUTO (previously escalated)', () => {
      expect(confidence >= autoApproveFloor(AutonomyLevel.FULL_AUTO)).toBe(true);
    });

    it('still requires human approval under AUTO_FIX_SIMPLE', () => {
      expect(confidence >= autoApproveFloor(AutonomyLevel.AUTO_FIX_SIMPLE)).toBe(false);
    });
  });
});
