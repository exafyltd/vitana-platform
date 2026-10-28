/**
 * Unit tests for Awin conversion crediting (the pure logic behind
 * POST /api/v1/vcaop/awin/conversions/sync and the background worker).
 */
import {
  mapAwinTxStatus,
  mapAwinTransaction,
  resolveAwinTxConfig,
  awinDateParam,
  awinCreditIds,
  type AwinTransaction,
} from '../../src/services/awin-conversions';

describe('mapAwinTxStatus', () => {
  test('approved/paid -> confirmed', () => {
    expect(mapAwinTxStatus('approved')).toBe('confirmed');
    expect(mapAwinTxStatus('PAID')).toBe('confirmed');
  });
  test('declined/deleted -> reversed', () => {
    expect(mapAwinTxStatus('declined')).toBe('reversed');
    expect(mapAwinTxStatus('deleted')).toBe('reversed');
  });
  test('pending / unknown -> pending', () => {
    expect(mapAwinTxStatus('pending')).toBe('pending');
    expect(mapAwinTxStatus('')).toBe('pending');
    expect(mapAwinTxStatus('whatever')).toBe('pending');
  });
});

describe('mapAwinTransaction', () => {
  const tx: AwinTransaction = {
    id: 998877,
    advertiserId: 122456,
    commissionStatus: 'approved',
    clickRef: 'sub_abc123def456',
    commissionAmount: { amount: 4.0, currency: 'eur' },
    saleAmount: { amount: 40, currency: 'EUR' },
  };

  test('normalizes a transaction into a credit intent', () => {
    const c = mapAwinTransaction(tx)!;
    expect(c.txId).toBe('998877');
    expect(c.subId).toBe('sub_abc123def456');
    expect(c.advertiserId).toBe('122456');
    expect(c.gross).toBe(4.0);
    expect(c.currency).toBe('EUR'); // upper-cased
    expect(c.state).toBe('confirmed');
  });

  test('returns null when there is no clickRef (cannot attribute)', () => {
    expect(mapAwinTransaction({ ...tx, clickRef: '' })).toBeNull();
    expect(mapAwinTransaction({ ...tx, clickRef: undefined })).toBeNull();
  });

  test('returns null for a transaction with no id', () => {
    expect(mapAwinTransaction({ id: undefined as any, clickRef: 'sub_x' })).toBeNull();
  });

  test('falls back to EUR and zero gross when amounts are missing', () => {
    const c = mapAwinTransaction({ id: 1, clickRef: 'sub_x', commissionStatus: 'pending' })!;
    expect(c.gross).toBe(0);
    expect(c.currency).toBe('EUR');
    expect(c.state).toBe('pending');
  });
});

describe('awinCreditIds', () => {
  test('deterministic + prefixed ids, stable across calls', () => {
    const a = awinCreditIds('998877', 'sub_abc');
    const b = awinCreditIds('998877', 'sub_abc');
    expect(a.commissionId).toBe(b.commissionId);
    expect(a.rewardId).toBe(b.rewardId);
    expect(a.commissionId.startsWith('cm_')).toBe(true);
    expect(a.rewardId.startsWith('rw_')).toBe(true);
  });
  test('different tx/sub combos produce different ids', () => {
    expect(awinCreditIds('1', 'sub_a').commissionId).not.toBe(awinCreditIds('2', 'sub_a').commissionId);
    expect(awinCreditIds('1', 'sub_a').commissionId).not.toBe(awinCreditIds('1', 'sub_b').commissionId);
  });
});

describe('awinDateParam', () => {
  test('formats as YYYY-MM-DDTHH:mm:ss (no ms / Z)', () => {
    expect(awinDateParam(new Date('2026-06-25T08:28:17.588Z'))).toBe('2026-06-25T08:28:17');
  });
});

describe('resolveAwinTxConfig', () => {
  const OLD = {
    id: process.env.AWIN_PUBLISHER_ID, tok: process.env.AWIN_API_TOKEN,
    look: process.env.AWIN_CONVERSIONS_LOOKBACK_DAYS, share: process.env.AWIN_MEMBER_SHARE,
  };
  afterAll(() => {
    process.env.AWIN_PUBLISHER_ID = OLD.id ?? '';
    process.env.AWIN_API_TOKEN = OLD.tok ?? '';
    if (OLD.look === undefined) delete process.env.AWIN_CONVERSIONS_LOOKBACK_DAYS; else process.env.AWIN_CONVERSIONS_LOOKBACK_DAYS = OLD.look;
    if (OLD.share === undefined) delete process.env.AWIN_MEMBER_SHARE; else process.env.AWIN_MEMBER_SHARE = OLD.share;
    if (OLD.id === undefined) delete process.env.AWIN_PUBLISHER_ID;
    if (OLD.tok === undefined) delete process.env.AWIN_API_TOKEN;
  });

  test('null when Awin credentials are missing', () => {
    delete process.env.AWIN_PUBLISHER_ID;
    delete process.env.AWIN_API_TOKEN;
    expect(resolveAwinTxConfig()).toBeNull();
  });

  test('builds config with defaults', () => {
    process.env.AWIN_PUBLISHER_ID = '2938137';
    process.env.AWIN_API_TOKEN = 'tok';
    delete process.env.AWIN_CONVERSIONS_LOOKBACK_DAYS;
    delete process.env.AWIN_MEMBER_SHARE;
    const c = resolveAwinTxConfig()!;
    expect(c.publisherId).toBe('2938137');
    expect(c.lookbackDays).toBe(30);
    expect(c.memberShare).toBe(0.5);
  });

  test('caps lookback at 31 days and clamps an invalid member share to the default', () => {
    process.env.AWIN_PUBLISHER_ID = '2938137';
    process.env.AWIN_API_TOKEN = 'tok';
    process.env.AWIN_CONVERSIONS_LOOKBACK_DAYS = '90';
    process.env.AWIN_MEMBER_SHARE = '5';
    const c = resolveAwinTxConfig()!;
    expect(c.lookbackDays).toBe(31);
    expect(c.memberShare).toBe(0.5);
  });
});
