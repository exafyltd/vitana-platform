/**
 * services/journey-foundation/session-summary-writer.ts — previously had
 * zero test coverage. Added alongside the 2026-08-30 fix for the swallowed
 * fetchLatestJourneySessionUpdate error: a Postgres-level failure resolved
 * `last` to null, indistinguishable from "no prior summary exists" — making
 * `newlyCompleted` become the user's ENTIRE journey history and writing a
 * wrong "you just completed: [everything]" summary from a corrupted
 * baseline. This is fire-and-forget from a `void` call site with no
 * `.catch()`, but the whole function body is already wrapped in its own
 * try/catch, so an early return is safe without changing that contract.
 */

const mockBuildJourneyFoundationSnapshot = jest.fn();
jest.mock('../../src/services/journey-foundation/journey-foundation-state', () => ({
  buildJourneyFoundationSnapshot: (...args: unknown[]) => mockBuildJourneyFoundationSnapshot(...args),
}));

jest.mock('../../src/services/journey-foundation/foundation-steps', () => ({
  getStepDef: (key: string) => ({ title: `Title for ${key}` }),
}));

const mockFetchLatestJourneySessionUpdate = jest.fn();
const mockInsertJourneySessionUpdate = jest.fn();
jest.mock('../../src/services/journey-foundation/session-summary-writer-repository', () => ({
  fetchLatestJourneySessionUpdate: (...args: unknown[]) => mockFetchLatestJourneySessionUpdate(...args),
  insertJourneySessionUpdate: (...args: unknown[]) => mockInsertJourneySessionUpdate(...args),
}));

import { recordJourneySessionSummary } from '../../src/services/journey-foundation/session-summary-writer';

const CLIENT: any = {};
const SNAPSHOT = {
  foundation_steps: [
    { key: 'step_a', status: 'done' },
    { key: 'step_b', status: 'done' },
    { key: 'step_c', status: 'active' },
  ],
  current_next_step: { key: 'step_d' },
};

describe('recordJourneySessionSummary — fetchLatestJourneySessionUpdate error handling', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildJourneyFoundationSnapshot.mockResolvedValue(SNAPSHOT);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('on the lookup returning {error}: logs it, returns early, and does NOT write a summary from a corrupted (empty) baseline', async () => {
    mockFetchLatestJourneySessionUpdate.mockResolvedValue({
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });

    await recordJourneySessionSummary(CLIENT, 'user-1', 'session-1');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('fetchLatestJourneySessionUpdate error for user=user-1: connection terminated unexpectedly'),
    );
    // The bug this fix closes: a DB error must not be indistinguishable
    // from "no prior summary" — which would report ALL of step_a/b/c as
    // "newly completed" this session.
    expect(mockInsertJourneySessionUpdate).not.toHaveBeenCalled();
  });

  it('on a genuine first-session baseline (no prior row, no error): writes all currently-done steps as newly completed (unchanged)', async () => {
    mockFetchLatestJourneySessionUpdate.mockResolvedValue({ data: null, error: null });
    mockInsertJourneySessionUpdate.mockResolvedValue({ error: null });

    await recordJourneySessionSummary(CLIENT, 'user-1', 'session-1');

    expect(errorSpy).not.toHaveBeenCalled();
    expect(mockInsertJourneySessionUpdate).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({
        user_id: 'user-1',
        session_id: 'session-1',
        completed_steps: ['step_a', 'step_b', 'step_c'],
      }),
    );
  });

  it('on a real diff against a prior baseline (no error): writes only the newly completed steps (unchanged)', async () => {
    mockFetchLatestJourneySessionUpdate.mockResolvedValue({ data: { completed_steps: ['step_a'] }, error: null });
    mockInsertJourneySessionUpdate.mockResolvedValue({ error: null });

    await recordJourneySessionSummary(CLIENT, 'user-1', 'session-1');

    expect(errorSpy).not.toHaveBeenCalled();
    expect(mockInsertJourneySessionUpdate).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ completed_steps: ['step_b', 'step_c'] }),
    );
  });
});
