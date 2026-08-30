/**
 * Unit tests for the public VCAOP affiliate postback receiver.
 * Covers the security-critical bits: fail-closed key verification (auth) and
 * the network-status -> ledger-state mapping (happy + error paths).
 */
jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn(() => ({})) }));

const mockFetchSubidMap = jest.fn();
const mockInsertOasisEvent = jest.fn();
const mockUpsertCommissionEvent = jest.fn();
const mockUpsertRewardsLedgerEntry = jest.fn();
jest.mock('../../src/routes/vcaop-postback-repository', () => ({
  fetchSubidMap: (...args: unknown[]) => mockFetchSubidMap(...args),
  insertOasisEvent: (...args: unknown[]) => mockInsertOasisEvent(...args),
  upsertCommissionEvent: (...args: unknown[]) => mockUpsertCommissionEvent(...args),
  upsertRewardsLedgerEntry: (...args: unknown[]) => mockUpsertRewardsLedgerEntry(...args),
}));

import express from 'express';
import request from 'supertest';
import { keyOk, mapStatus } from '../../src/routes/vcaop-postback';
import vcaopPostbackRouter from '../../src/routes/vcaop-postback';

describe('vcaop-postback', () => {
  const ORIGINAL = process.env.ADMITAD_POSTBACK_KEY;
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.ADMITAD_POSTBACK_KEY;
    else process.env.ADMITAD_POSTBACK_KEY = ORIGINAL;
  });

  describe('keyOk — fail-closed auth', () => {
    test('rejects when no key is configured (fail closed)', () => {
      delete process.env.ADMITAD_POSTBACK_KEY;
      expect(keyOk('anything')).toBe(false);
    });
    test('rejects an empty provided key', () => {
      process.env.ADMITAD_POSTBACK_KEY = 'super-secret-postback-key';
      expect(keyOk('')).toBe(false);
    });
    test('rejects a wrong key', () => {
      process.env.ADMITAD_POSTBACK_KEY = 'super-secret-postback-key';
      expect(keyOk('not-the-key')).toBe(false);
    });
    test('accepts the exact key', () => {
      process.env.ADMITAD_POSTBACK_KEY = 'super-secret-postback-key';
      expect(keyOk('super-secret-postback-key')).toBe(true);
    });
    test('a length mismatch does not throw (timingSafeEqual guard)', () => {
      process.env.ADMITAD_POSTBACK_KEY = 'super-secret-postback-key';
      expect(() => keyOk('short')).not.toThrow();
      expect(keyOk('short')).toBe(false);
    });
  });

  describe('mapStatus — network status -> ledger state', () => {
    test.each(['approved', 'confirmed', 'paid', 'done', '1', 'APPROVED', ' Approved '])(
      'confirms %p', (s) => expect(mapStatus(s)).toBe('confirmed'),
    );
    test.each(['declined', 'rejected', 'cancelled', 'canceled', 'reversed', '2'])(
      'reverses %p', (s) => expect(mapStatus(s)).toBe('reversed'),
    );
    test.each(['pending', 'open', '', 'something-else'])(
      'defaults %p to pending', (s) => expect(mapStatus(s)).toBe('pending'),
    );
  });

  describe('GET /admitad — fetchSubidMap error handling', () => {
    const app = express();
    app.use(express.json());
    app.use('/admitad-route', vcaopPostbackRouter);

    beforeEach(() => {
      jest.clearAllMocks();
      process.env.ADMITAD_POSTBACK_KEY = 'super-secret-postback-key';
      mockInsertOasisEvent.mockResolvedValue({ error: null });
      mockUpsertCommissionEvent.mockResolvedValue({ error: null });
      mockUpsertRewardsLedgerEntry.mockResolvedValue({ error: null });
    });

    test('a real DB error responds 503 (never 202 — that would tell the network to stop retrying) and does NOT emit the misleading unattributed-warning event', async () => {
      mockFetchSubidMap.mockResolvedValue({ data: null, error: { message: 'connection terminated unexpectedly' } });

      const res = await request(app)
        .get('/admitad-route/admitad')
        .query({ key: 'super-secret-postback-key', subid: 'sub-1', order_id: 'order-1', status: 'approved' });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ ok: false, error: 'database unavailable' });
      expect(mockInsertOasisEvent).not.toHaveBeenCalled();
      expect(mockUpsertCommissionEvent).not.toHaveBeenCalled();
    });

    test('a genuinely unattributed subid (no error) still responds 202 and logs the warning event — unchanged', async () => {
      mockFetchSubidMap.mockResolvedValue({ data: null, error: null });

      const res = await request(app)
        .get('/admitad-route/admitad')
        .query({ key: 'super-secret-postback-key', subid: 'sub-1', order_id: 'order-1', status: 'approved' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ ok: true, attributed: false });
      expect(mockInsertOasisEvent).toHaveBeenCalledTimes(1);
      expect(mockInsertOasisEvent.mock.calls[0][1]).toMatchObject({ type: 'vcaop.postback.unattributed', status: 'warning' });
    });

    test('a resolved subid still attributes and upserts as before — unchanged', async () => {
      mockFetchSubidMap.mockResolvedValue({ data: { user_id: 'user-1', affiliate_program_id: 'prog-1', network: 'admitad' }, error: null });

      const res = await request(app)
        .get('/admitad-route/admitad')
        .query({ key: 'super-secret-postback-key', subid: 'sub-1', order_id: 'order-1', status: 'approved', commission: '10' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.attributed).toBe(true);
      expect(mockUpsertCommissionEvent).toHaveBeenCalledTimes(1);
      expect(mockUpsertRewardsLedgerEntry).toHaveBeenCalledTimes(1);
    });
  });
});
