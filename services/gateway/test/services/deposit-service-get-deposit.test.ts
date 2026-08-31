/**
 * services/wallet/deposit-service.ts's getDepositForUser() — previously had
 * zero test coverage. Added alongside the 2026-08-29 fix: this function
 * destructured only `data` from fetchWalletDepositForUser(). A
 * Postgres-level failure resolved `data` to null, indistinguishable from
 * "this deposit doesn't exist" — the caller (GET /wallet/deposits/:id)
 * then told a user polling the status of their own just-paid Stripe
 * deposit "404 NOT_FOUND", misleading them about the state of their own
 * money. Pins the new {deposit, error?} shape.
 */

const mockGetSupabase = jest.fn();
jest.mock('../../src/lib/supabase', () => ({
  getSupabase: (...args: unknown[]) => mockGetSupabase(...args),
}));

const mockFetchWalletDepositForUser = jest.fn();
jest.mock('../../src/services/wallet/deposit-service-repository', () => ({
  ...jest.requireActual('../../src/services/wallet/deposit-service-repository'),
  fetchWalletDepositForUser: (...args: unknown[]) => mockFetchWalletDepositForUser(...args),
}));

import { getDepositForUser } from '../../src/services/wallet/deposit-service';

const SB: any = {};

describe('getDepositForUser', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSupabase.mockReturnValue(SB);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('on the RPC returning {error}: logs it, and returns {deposit:null, error:true} — distinct from a genuine not-found', async () => {
    mockFetchWalletDepositForUser.mockResolvedValue({
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });

    const result = await getDepositForUser('dep-1', 'u1');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('getDepositForUser query failed for deposit=dep-1 user=u1'),
      'connection terminated unexpectedly',
    );
    expect(result).toEqual({ deposit: null, error: true });
  });

  it('on a genuine not-found (no error): returns {deposit:null} with no error flag and no log', async () => {
    mockFetchWalletDepositForUser.mockResolvedValue({ data: null, error: null });

    const result = await getDepositForUser('dep-missing', 'u1');

    expect(errorSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ deposit: null });
  });

  it('on a successful fetch: returns the real deposit', async () => {
    const deposit = { id: 'dep-1', amount_minor: 500, currency: 'EUR', status: 'succeeded' };
    mockFetchWalletDepositForUser.mockResolvedValue({ data: deposit, error: null });

    const result = await getDepositForUser('dep-1', 'u1');

    expect(errorSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ deposit });
  });
});
