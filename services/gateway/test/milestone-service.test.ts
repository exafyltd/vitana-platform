/**
 * milestone-service.ts — previously had zero test coverage at all. Added
 * alongside the 2026-08-29 fix for the swallowed credit_wallet error
 * (AURORA-B3-RPC-PARITY-INVENTORY.md addendum): pins that a Postgres-level
 * RPC error is now logged loudly (console.error) instead of being
 * unreachable inside an empty `catch {}`, without changing whether the
 * milestone itself gets recorded (that fires regardless, unchanged).
 *
 * Exercises checkMilestonesForAction('profile_updated') — the smallest
 * checker (checkProfileComplete) with the fewest repo calls to mock.
 */

const mockFetchAchievedMilestoneRefs = jest.fn();
const mockFetchAppUserForProfileCheck = jest.fn();
const mockCountUserTopicProfileRows = jest.fn();
const mockInsertAchievedMilestone = jest.fn();
const mockCreditWalletForMilestone = jest.fn();

jest.mock('../src/services/milestone-service-repository', () => ({
  fetchAchievedMilestoneRefs: (...args: unknown[]) => mockFetchAchievedMilestoneRefs(...args),
  fetchAppUserForProfileCheck: (...args: unknown[]) => mockFetchAppUserForProfileCheck(...args),
  countUserTopicProfileRows: (...args: unknown[]) => mockCountUserTopicProfileRows(...args),
  insertAchievedMilestone: (...args: unknown[]) => mockInsertAchievedMilestone(...args),
  creditWalletForMilestone: (...args: unknown[]) => mockCreditWalletForMilestone(...args),
}));

import { checkMilestonesForAction } from '../src/services/milestone-service';

const SB: any = {};

describe('checkMilestonesForAction("profile_updated") — wallet credit error handling', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchAchievedMilestoneRefs.mockResolvedValue({ data: [] });
    mockFetchAppUserForProfileCheck.mockResolvedValue({ data: { display_name: 'Alex', avatar_url: 'https://x/y.png' } });
    mockCountUserTopicProfileRows.mockResolvedValue({ count: 3 });
    mockInsertAchievedMilestone.mockResolvedValue({});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('on the RPC returning {error} (the credit_wallet-does-not-exist shape): logs loudly via console.error, and the milestone is still recorded', async () => {
    mockCreditWalletForMilestone.mockResolvedValue({
      data: null,
      error: { message: 'function credit_wallet(...) does not exist' },
    });

    const result = await checkMilestonesForAction(SB, 'u1', 't1', 'profile_updated');

    expect(result).toEqual(['profile_complete']);
    // The bug this fix closes: this failure used to be completely
    // invisible (an empty catch {} that could never fire for this shape).
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('credit_wallet RPC returned an error for profile_complete'),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('function credit_wallet(...) does not exist'));
    // Documented, unchanged behavior: the achievement record still writes
    // regardless of the credit outcome (a product decision, not touched).
    expect(mockInsertAchievedMilestone).toHaveBeenCalledTimes(1);
  });

  it('on a network-layer rejection (the only case .rpc() actually throws for): logs via console.warn, not console.error', async () => {
    mockCreditWalletForMilestone.mockRejectedValue(new Error('fetch failed'));

    await checkMilestonesForAction(SB, 'u1', 't1', 'profile_updated');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('credit_wallet failed for profile_complete: fetch failed'),
    );
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('credit_wallet RPC returned an error'));
  });

  it('on a successful credit (no error field): logs nothing about credit_wallet failing', async () => {
    mockCreditWalletForMilestone.mockResolvedValue({ data: { ok: true }, error: null });

    const result = await checkMilestonesForAction(SB, 'u1', 't1', 'profile_updated');

    expect(result).toEqual(['profile_complete']);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not call creditWalletForMilestone at all when no milestone was newly achieved', async () => {
    mockFetchAchievedMilestoneRefs.mockResolvedValue({ data: [{ source_ref: 'profile_complete' }] });

    const result = await checkMilestonesForAction(SB, 'u1', 't1', 'profile_updated');

    expect(result).toEqual([]);
    expect(mockCreditWalletForMilestone).not.toHaveBeenCalled();
  });

  it('on countUserTopicProfileRows returning {error} (the user_topic_profile-does-not-exist shape, docs/AURORA-B2-DEAD-CALLSITE-AUDIT.md Addendum 5): logs via console.warn instead of silently treating the count as zero', async () => {
    mockCountUserTopicProfileRows.mockResolvedValue({
      count: null,
      error: { message: 'relation "user_topic_profile" does not exist' },
    });

    const result = await checkMilestonesForAction(SB, 'u1', 't1', 'profile_updated');

    // Documented, unchanged behavior: an errored/zero count still means the
    // milestone is not (yet) newly achieved this call — this fix only adds
    // visibility, it does not fabricate a count.
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('countUserTopicProfileRows failed'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('relation "user_topic_profile" does not exist'),
    );
  });
});
