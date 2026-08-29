/**
 * services/orb-tools/cart-checkout-tools.ts's tool_set_shopping_budget() —
 * previously had zero test coverage. Added alongside the 2026-08-29 fix
 * for the swallowed fetchUserLimitationsExists error: on the clear-budget
 * path, a Postgres-level failure resolved `existing` to falsy —
 * indistinguishable from "genuinely no budget set" — so a user who
 * explicitly has a monthly cap configured and asks Vitana (voice) to
 * clear it was confidently told "you don't have a monthly shopping
 * budget set," and the cap silently remained in effect unchanged.
 */

const mockFetchAppUserCurrencyPreference = jest.fn();
const mockFetchUserLimitationsExists = jest.fn();
const mockClearUserLimitationsBudgetCap = jest.fn();

jest.mock('../../src/services/orb-tools/cart-checkout-tools-repository', () => ({
  ...jest.requireActual('../../src/services/orb-tools/cart-checkout-tools-repository'),
  fetchAppUserCurrencyPreference: (...args: unknown[]) => mockFetchAppUserCurrencyPreference(...args),
  fetchUserLimitationsExists: (...args: unknown[]) => mockFetchUserLimitationsExists(...args),
  clearUserLimitationsBudgetCap: (...args: unknown[]) => mockClearUserLimitationsBudgetCap(...args),
}));

import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import { tool_set_shopping_budget } from '../../src/services/orb-tools/cart-checkout-tools';

const ID: OrbToolIdentity = { user_id: 'u1', tenant_id: 't1', role: 'community' };
const SB: any = {};

describe('tool_set_shopping_budget — clear path, fetchUserLimitationsExists error handling', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchAppUserCurrencyPreference.mockResolvedValue({ data: { currency_preference: 'EUR' }, error: null });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('on the RPC returning {error}: does NOT confidently claim "no budget set" — reports a distinct error, and never touches the cap', async () => {
    mockFetchUserLimitationsExists.mockResolvedValue({
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });

    const result = await tool_set_shopping_budget({ clear: true }, ID, SB);

    // The bug this fix closes: this failure used to be indistinguishable
    // from "you don't have a budget set," a confidently wrong claim about
    // the user's own configured state.
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).not.toContain("don't have a monthly shopping budget");
    expect((result as { error: string }).error).toContain('database error');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('fetchUserLimitationsExists error for user=u1'));
    expect(mockClearUserLimitationsBudgetCap).not.toHaveBeenCalled();
  });

  it('on a genuine no-budget-set (no error): still returns the honest "not set" response (unchanged)', async () => {
    mockFetchUserLimitationsExists.mockResolvedValue({ data: null, error: null });

    const result = await tool_set_shopping_budget({ clear: true }, ID, SB);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect((result.result as { cleared: boolean }).cleared).toBe(false);
  });

  it('on a real budget existing: clears it as before (unchanged)', async () => {
    mockFetchUserLimitationsExists.mockResolvedValue({ data: { user_id: 'u1' }, error: null });
    mockClearUserLimitationsBudgetCap.mockResolvedValue({ error: null });

    const result = await tool_set_shopping_budget({ clear: true }, ID, SB);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect((result.result as { cleared: boolean }).cleared).toBe(true);
  });
});
