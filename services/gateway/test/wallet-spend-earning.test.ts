/**
 * Wallet spend + earning service — VTID-03249
 *
 * The RPC owns transactional correctness (SELECT FOR UPDATE, ledger insert,
 * balance update). These tests verify the TS service:
 *   1. Calls the right RPC with the right shape
 *   2. Surfaces RPC error rows as ok:false objects
 *   3. Rejects out-of-band invalid amounts BEFORE calling the RPC
 *   4. Pass-through of the RPC's INSUFFICIENT_BALANCE / CURRENCY_MISMATCH /
 *      ACCOUNT_NOT_FOUND error codes
 *   5. duplicate=true reaches the caller intact (idempotent retry)
 */

const mockRpc = jest.fn();

const mockSupabase = {
  rpc: mockRpc,
};

jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));

import {
  debitWalletForSpend,
  creditWalletForEarning,
} from '../src/services/wallet/spend-earning-service';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

describe('wallet spend + earning service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('debitWalletForSpend', () => {
    it('rejects non-integer amount without hitting the RPC', async () => {
      const result = await debitWalletForSpend({
        account_id: ACCOUNT_ID,
        amount_minor: 1.5 as unknown as number,
        currency: 'EUR',
        reference_type: 'cart_checkout',
        reference_id: 'order-1',
      });
      expect(result.ok).toBe(false);
      expect((result as any).error).toBe('INVALID_AMOUNT');
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('rejects zero / negative amount without hitting the RPC', async () => {
      for (const amount of [0, -1, -1000]) {
        const result = await debitWalletForSpend({
          account_id: ACCOUNT_ID,
          amount_minor: amount,
          currency: 'EUR',
          reference_type: 'cart_checkout',
          reference_id: 'order-1',
        });
        expect(result.ok).toBe(false);
        expect((result as any).error).toBe('INVALID_AMOUNT');
      }
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('calls debit_wallet_for_spend with the right RPC params', async () => {
      mockRpc.mockResolvedValueOnce({
        data: { ok: true, duplicate: false, balance_minor: 4500, currency: 'EUR', ledger_entry_id: 'le-1' },
        error: null,
      });
      const result = await debitWalletForSpend({
        account_id: ACCOUNT_ID,
        amount_minor: 500,
        currency: 'EUR',
        reference_type: 'cart_checkout',
        reference_id: 'cart-123',
        description: 'Cart checkout #123',
        metadata: { items: 3 },
      });

      expect(mockRpc).toHaveBeenCalledWith('debit_wallet_for_spend', {
        p_account_id: ACCOUNT_ID,
        p_amount_minor: 500,
        p_currency: 'EUR',
        p_reference_type: 'cart_checkout',
        p_reference_id: 'cart-123',
        p_description: 'Cart checkout #123',
        p_metadata: { items: 3 },
      });
      expect(result.ok).toBe(true);
      expect((result as any).balance_minor).toBe(4500);
    });

    it('surfaces INSUFFICIENT_BALANCE from the RPC', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: false,
          error: 'INSUFFICIENT_BALANCE',
          balance_minor: 200,
          required_minor: 500,
          currency: 'EUR',
        },
        error: null,
      });
      const result = await debitWalletForSpend({
        account_id: ACCOUNT_ID,
        amount_minor: 500,
        currency: 'EUR',
        reference_type: 'cart_checkout',
        reference_id: 'cart-456',
      });
      expect(result.ok).toBe(false);
      expect((result as any).error).toBe('INSUFFICIENT_BALANCE');
      expect((result as any).balance_minor).toBe(200);
    });

    it('passes duplicate=true through on idempotent retry', async () => {
      mockRpc.mockResolvedValueOnce({
        data: { ok: true, duplicate: true, balance_minor: 4500, currency: 'EUR' },
        error: null,
      });
      const result = await debitWalletForSpend({
        account_id: ACCOUNT_ID,
        amount_minor: 500,
        currency: 'EUR',
        reference_type: 'cart_checkout',
        reference_id: 'cart-789',
      });
      expect(result.ok).toBe(true);
      expect((result as any).duplicate).toBe(true);
      expect((result as any).balance_minor).toBe(4500);
    });

    it('returns RPC_FAILED on Supabase error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'connection refused' } });
      const result = await debitWalletForSpend({
        account_id: ACCOUNT_ID,
        amount_minor: 500,
        currency: 'EUR',
        reference_type: 'cart_checkout',
        reference_id: 'cart-fail',
      });
      expect(result.ok).toBe(false);
      expect((result as any).error).toBe('RPC_FAILED');
      expect((result as any).message).toContain('connection refused');
    });
  });

  describe('creditWalletForEarning', () => {
    it('calls credit_wallet_for_earning with the right RPC params', async () => {
      mockRpc.mockResolvedValueOnce({
        data: { ok: true, duplicate: false, balance_minor: 12000, currency: 'EUR', ledger_entry_id: 'le-2' },
        error: null,
      });
      const result = await creditWalletForEarning({
        account_id: ACCOUNT_ID,
        amount_minor: 2500,
        currency: 'EUR',
        reference_type: 'marketplace_earning',
        reference_id: 'sale-42',
        description: 'Marketplace sale #42',
      });
      expect(mockRpc).toHaveBeenCalledWith('credit_wallet_for_earning', expect.objectContaining({
        p_account_id: ACCOUNT_ID,
        p_amount_minor: 2500,
        p_currency: 'EUR',
        p_reference_type: 'marketplace_earning',
        p_reference_id: 'sale-42',
      }));
      expect(result.ok).toBe(true);
      expect((result as any).balance_minor).toBe(12000);
    });

    it('surfaces CURRENCY_MISMATCH', async () => {
      mockRpc.mockResolvedValueOnce({
        data: {
          ok: false,
          error: 'CURRENCY_MISMATCH',
          account_currency: 'EUR',
          requested_currency: 'USD',
        },
        error: null,
      });
      const result = await creditWalletForEarning({
        account_id: ACCOUNT_ID,
        amount_minor: 1000,
        currency: 'USD',
        reference_type: 'marketplace_earning',
        reference_id: 'sale-mismatch',
      });
      expect(result.ok).toBe(false);
      expect((result as any).error).toBe('CURRENCY_MISMATCH');
    });

    it('surfaces ACCOUNT_NOT_FOUND', async () => {
      mockRpc.mockResolvedValueOnce({
        data: { ok: false, error: 'ACCOUNT_NOT_FOUND' },
        error: null,
      });
      const result = await creditWalletForEarning({
        account_id: 'does-not-exist',
        amount_minor: 1000,
        currency: 'EUR',
        reference_type: 'marketplace_earning',
        reference_id: 'sale-x',
      });
      expect(result.ok).toBe(false);
      expect((result as any).error).toBe('ACCOUNT_NOT_FOUND');
    });

    it('passes duplicate=true through on idempotent earning retry', async () => {
      mockRpc.mockResolvedValueOnce({
        data: { ok: true, duplicate: true, balance_minor: 12000, currency: 'EUR' },
        error: null,
      });
      const result = await creditWalletForEarning({
        account_id: ACCOUNT_ID,
        amount_minor: 2500,
        currency: 'EUR',
        reference_type: 'marketplace_earning',
        reference_id: 'sale-replay',
      });
      expect(result.ok).toBe(true);
      expect((result as any).duplicate).toBe(true);
    });
  });
});
