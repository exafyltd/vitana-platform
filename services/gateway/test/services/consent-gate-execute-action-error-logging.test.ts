/**
 * services/consent-gate.ts — executeAction() previously had zero test
 * coverage.
 *
 * approvePendingAction() flips a pending_connector_actions row to
 * 'approved' and then immediately calls executeAction(), which re-fetches
 * the full row via fetchFullPendingAction(). That call's `error` was
 * discarded entirely (only `{ data: action }` destructured) — on a real
 * DB error right after approval, `action` is `undefined`, indistinguishable
 * from "row doesn't exist," and the function returned a generic "Action
 * not found" while the row was left sitting in 'approved' state forever:
 * never executed, never marked 'failed', no audit trail of what happened
 * to an action the user just explicitly consented to.
 *
 * This pins that a real fetch error is now logged loudly and the action
 * is explicitly marked 'failed' (via the same markActionFailed() path the
 * pre-existing "no executor" branch already used) instead of being
 * silently stranded in 'approved' limbo.
 */

const mockGetSupabase = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

const mockFetchPendingActionForApproval = jest.fn();
const mockMarkActionApproved = jest.fn();
const mockFetchFullPendingAction = jest.fn();
const mockMarkActionFailed = jest.fn();
const mockMarkActionExecuting = jest.fn();
const mockInsertActionLedgerEntry = jest.fn();

jest.mock('../../src/services/consent-gate-repository', () => ({
  fetchPendingActionForApproval: (...args: unknown[]) => mockFetchPendingActionForApproval(...args),
  markActionApproved: (...args: unknown[]) => mockMarkActionApproved(...args),
  markActionExpired: jest.fn(),
  fetchFullPendingAction: (...args: unknown[]) => mockFetchFullPendingAction(...args),
  markActionFailed: (...args: unknown[]) => mockMarkActionFailed(...args),
  markActionExecuting: (...args: unknown[]) => mockMarkActionExecuting(...args),
  insertActionLedgerEntry: (...args: unknown[]) => mockInsertActionLedgerEntry(...args),
}));

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

import { approvePendingAction } from '../../src/services/consent-gate';

describe('approvePendingAction -> executeAction — fetchFullPendingAction error handling', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue({});
    mockFetchPendingActionForApproval.mockResolvedValue({
      data: {
        state: 'pending',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        tenant_id: 't1',
      },
      error: null,
    });
    mockMarkActionApproved.mockResolvedValue({});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('on a real DB error, marks the action failed and logs loudly instead of stranding it in "approved"', async () => {
    mockFetchFullPendingAction.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    });

    const result = await approvePendingAction('action-1', 'user-1');

    expect(result.ok).toBe(false);
    expect(mockMarkActionFailed).toHaveBeenCalledWith(
      expect.anything(),
      'action-1',
      expect.objectContaining({ error: expect.stringContaining('connection reset') }),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchFullPendingAction failed'));
  });

  it('on a genuinely missing row (no error, no data), still returns "Action not found" without marking it failed', async () => {
    mockFetchFullPendingAction.mockResolvedValue({ data: null, error: null });

    const result = await approvePendingAction('action-1', 'user-1');

    expect(result).toEqual({ ok: false, error: 'Action not found' });
    expect(mockMarkActionFailed).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
