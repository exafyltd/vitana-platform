/**
 * diary-streak-celebrator.ts — previously had zero genuine test coverage
 * (its only referencing test, save-diary-entry-shared.test.ts, mocks this
 * module wholesale). Added alongside the 2026-08-29 fix for the swallowed
 * credit_wallet error (AURORA-B3-RPC-PARITY-INVENTORY.md addendum): pins
 * that a Postgres-level RPC error is now logged loudly (console.error)
 * instead of being invisible, without changing the streak-event/
 * notification behavior, which fires regardless (documented, unchanged).
 */

const mockEmitOasisEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => mockEmitOasisEvent(...args),
}));

const mockNotifyUserAsync = jest.fn();
jest.mock('../src/services/notification-service', () => ({
  notifyUserAsync: (...args: unknown[]) => mockNotifyUserAsync(...args),
}));

const mockFetchUserDiaryStreak = jest.fn();
const mockFetchExistingStreakCelebrationEvent = jest.fn();
const mockCreditWallet = jest.fn();
jest.mock('../src/services/diary-streak-celebrator-repository', () => ({
  fetchUserDiaryStreak: (...args: unknown[]) => mockFetchUserDiaryStreak(...args),
  fetchExistingStreakCelebrationEvent: (...args: unknown[]) => mockFetchExistingStreakCelebrationEvent(...args),
  creditWallet: (...args: unknown[]) => mockCreditWallet(...args),
}));

import { celebrateDiaryStreak } from '../src/services/diary-streak-celebrator';

const ADMIN: any = {};

describe('celebrateDiaryStreak', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchExistingStreakCelebrationEvent.mockResolvedValue({ data: [] });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('returns null when the streak is not at a tier boundary', async () => {
    mockFetchUserDiaryStreak.mockResolvedValue({ data: { current_streak_days: 5 } });
    const result = await celebrateDiaryStreak(ADMIN, 'u1', 't1');
    expect(result).toBeNull();
    expect(mockCreditWallet).not.toHaveBeenCalled();
  });

  it('returns null when a celebration for this tier already fired today (idempotency)', async () => {
    mockFetchUserDiaryStreak.mockResolvedValue({ data: { current_streak_days: 3 } });
    mockFetchExistingStreakCelebrationEvent.mockResolvedValue({ data: [{ id: 'evt-1' }] });
    const result = await celebrateDiaryStreak(ADMIN, 'u1', 't1');
    expect(result).toBeNull();
    expect(mockCreditWallet).not.toHaveBeenCalled();
  });

  it('on the RPC returning {error} (the credit_wallet-does-not-exist shape): logs loudly via console.error, and the streak event + notification still fire', async () => {
    mockFetchUserDiaryStreak.mockResolvedValue({ data: { current_streak_days: 3 } });
    mockCreditWallet.mockResolvedValue({ data: null, error: { message: 'function credit_wallet(...) does not exist' } });

    const result = await celebrateDiaryStreak(ADMIN, 'u1', 't1');

    // The bug this fix closes: this failure used to be completely
    // invisible (the try/catch could never see it, since .rpc() resolves
    // rather than throws on a Postgres-level error). Now it must be logged.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('credit_wallet RPC returned an error'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('function credit_wallet(...) does not exist'));

    // Documented, unchanged behavior: the streak event and notification
    // still fire regardless of the credit outcome (a product decision,
    // not touched by this fix).
    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    expect(mockNotifyUserAsync).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      current_streak_days: 3,
      tier_days: 3,
      wallet_credit: 10,
      message: '3-day diary streak — keep it.',
    });
  });

  it('on a network-layer rejection (the only case .rpc() actually throws for): logs via console.warn, not console.error', async () => {
    mockFetchUserDiaryStreak.mockResolvedValue({ data: { current_streak_days: 7 } });
    mockCreditWallet.mockRejectedValue(new Error('fetch failed'));

    await celebrateDiaryStreak(ADMIN, 'u1', 't1');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('credit_wallet failed: fetch failed'));
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('credit_wallet RPC returned an error'));
    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
  });

  it('on a successful credit (no error field): logs nothing about credit_wallet failing', async () => {
    mockFetchUserDiaryStreak.mockResolvedValue({ data: { current_streak_days: 14 } });
    mockCreditWallet.mockResolvedValue({ data: { ok: true }, error: null });

    const result = await celebrateDiaryStreak(ADMIN, 'u1', 't1');

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(result?.tier_days).toBe(14);
  });
});
