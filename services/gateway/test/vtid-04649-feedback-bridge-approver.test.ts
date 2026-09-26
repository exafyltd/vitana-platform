/**
 * VTID-04649: the feedback bridge hands only a real user id to the Dev
 * Autopilot bridge as the approver. approveAutoExecute refuses any non-UUID
 * approver (dev_autopilot_executions.approved_by is uuid, VTID-03839), and
 * auto-dispatch passed its actor label 'auto-dispatch' — every automatic
 * dispatch was refused on staging (2026-09-24).
 */
import { bridgeApprover, AUTO_DISPATCH_ACTOR } from '../src/services/feedback-execution-bridge';

describe('VTID-04649 bridgeApprover', () => {
  it('drops the auto-dispatch actor label', () => {
    expect(bridgeApprover(AUTO_DISPATCH_ACTOR)).toBeNull();
  });

  it('drops any other non-user label', () => {
    expect(bridgeApprover('operator-chat:abc')).toBeNull();
    expect(bridgeApprover('')).toBeNull();
  });

  it('passes null and undefined through as null', () => {
    expect(bridgeApprover(null)).toBeNull();
    expect(bridgeApprover(undefined)).toBeNull();
  });

  it('keeps a real user id (a human Approve & Fix click)', () => {
    const uid = '3f1c2b4a-9d8e-4c7b-a6f5-0e1d2c3b4a59';
    expect(bridgeApprover(uid)).toBe(uid);
  });
});
