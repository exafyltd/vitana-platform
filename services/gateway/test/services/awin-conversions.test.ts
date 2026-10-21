/**
 * services/awin-conversions.ts — creditAwinConversions() previously had zero
 * test coverage (test/routes/awin-conversions.test.ts only exercises the
 * pure helpers). Added alongside the 2026-08-30 fix for the swallowed
 * fetchSubidMapEntry error: a Postgres-level failure resolved `map` to null,
 * indistinguishable from the documented "no subid mapping exists (organic/
 * other)" skip — silently and permanently counting a real affiliate
 * conversion as unattributed for that pull, with nothing logged.
 */

const mockFetchAwinProgramMerchants = jest.fn();
const mockFetchSubidMapEntry = jest.fn();
const mockFetchCommissionEventStatus = jest.fn();
const mockUpsertCommissionEvent = jest.fn();
const mockUpsertRewardsLedgerEntry = jest.fn();
const mockInsertOasisAuditEvent = jest.fn();

jest.mock('../../src/services/awin-conversions-repository', () => ({
  fetchAwinProgramMerchants: (...args: unknown[]) => mockFetchAwinProgramMerchants(...args),
  fetchSubidMapEntry: (...args: unknown[]) => mockFetchSubidMapEntry(...args),
  fetchCommissionEventStatus: (...args: unknown[]) => mockFetchCommissionEventStatus(...args),
  upsertCommissionEvent: (...args: unknown[]) => mockUpsertCommissionEvent(...args),
  upsertRewardsLedgerEntry: (...args: unknown[]) => mockUpsertRewardsLedgerEntry(...args),
  insertOasisAuditEvent: (...args: unknown[]) => mockInsertOasisAuditEvent(...args),
}));

import { creditAwinConversions, type AwinTxConfig } from '../../src/services/awin-conversions';

const SB: any = {};
const CFG: AwinTxConfig = {
  publisherId: 'pub-1',
  apiToken: 'tok',
  apiBase: 'https://api.awin.com',
  lookbackDays: 7,
  memberShare: 0.5,
};

function mockAwinTransactionsFetch(transactions: Array<Record<string, unknown>>) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ transactions }),
  }) as unknown as typeof fetch;
}

describe('creditAwinConversions — fetchSubidMapEntry error handling', () => {
  let errorSpy: jest.SpyInstance;
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchAwinProgramMerchants.mockResolvedValue({ data: [], error: null });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    global.fetch = realFetch;
  });

  it('on the lookup returning {error} (a transient DB blip): logs it loudly, and does NOT count it as unattributed (leaves it for a future pull)', async () => {
    mockAwinTransactionsFetch([{ id: 'tx-1', clickRef: 'sub_abc', commissionAmount: { amount: 10, currency: 'EUR' }, commissionStatus: 'approved' }]);
    mockFetchSubidMapEntry.mockResolvedValue({
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });

    const result = await creditAwinConversions(SB, CFG);

    // The bug this fix closes: this failure used to be indistinguishable
    // from a genuine "no subid mapping" (organic/other) skip.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('fetchSubidMapEntry error for subId=sub_abc tx=tx-1: connection terminated unexpectedly'),
    );
    // Not counted as unattributed (that bucket is reserved for genuine
    // no-mapping cases) and no commission/ledger write attempted.
    expect(result).toEqual(expect.objectContaining({ ok: true, fetched: 1, attributed: 0, unattributed: 0, credited: 0 }));
    expect(mockUpsertCommissionEvent).not.toHaveBeenCalled();
    expect(mockUpsertRewardsLedgerEntry).not.toHaveBeenCalled();
  });

  it('on a genuinely unmatched subId (no error): logs nothing, counted unattributed (unchanged)', async () => {
    mockAwinTransactionsFetch([{ id: 'tx-2', clickRef: 'sub_unknown', commissionAmount: { amount: 10, currency: 'EUR' }, commissionStatus: 'approved' }]);
    mockFetchSubidMapEntry.mockResolvedValue({ data: null, error: null });

    const result = await creditAwinConversions(SB, CFG);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ attributed: 0, unattributed: 1 }));
  });

  it('on a successful subid match: logs nothing, and the transaction is attributed + credited', async () => {
    mockAwinTransactionsFetch([{ id: 'tx-3', clickRef: 'sub_real', commissionAmount: { amount: 10, currency: 'EUR' }, commissionStatus: 'approved' }]);
    mockFetchSubidMapEntry.mockResolvedValue({
      data: { user_id: 'u1', affiliate_program_id: 'awin_1', network: 'awin' },
      error: null,
    });
    mockFetchCommissionEventStatus.mockResolvedValue({ data: null, error: null });
    mockUpsertCommissionEvent.mockResolvedValue({ data: null, error: null });
    mockUpsertRewardsLedgerEntry.mockResolvedValue({ data: null, error: null });
    mockInsertOasisAuditEvent.mockResolvedValue({ data: null, error: null });

    const result = await creditAwinConversions(SB, CFG);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(result.attributed).toBe(1);
    expect(result.credited).toBe(1);
  });
});
