/**
 * VTID-04741 — the daily scheduled marketplace sync (`/sync/all`, called by
 * MARKETPLACE-SYNC-CRON.yml) also pays held recommendation commissions that
 * are due. Checkout orders have no network to confirm them, so without this
 * a held commission would stay pending until an admin ran the Awin order sync.
 */
import express from 'express';
import request from 'supertest';

const mockRunAll = jest.fn();
const mockRunSource = jest.fn();
jest.mock('../../src/services/marketplace-sync', () => ({
  runAllMarketplaceSync: (...a: unknown[]) => mockRunAll(...a),
  runMarketplaceSyncSource: (...a: unknown[]) => mockRunSource(...a),
}));
jest.mock('../../src/services/marketplace-sync/providers', () => ({
  providerKeys: () => ['shopify', 'cj', 'awin'],
}));
const mockConfirm = jest.fn();
jest.mock('../../src/services/recommendation-commissions/credit-recommender', () => ({
  confirmDueRecommendationCommissions: (...a: unknown[]) => mockConfirm(...a),
}));

import router from '../../src/routes/internal-marketplace-sync';

const app = express();
app.use(express.json());
app.use('/api/v1/internal/marketplace', router);
const post = (network: string) =>
  request(app).post(`/api/v1/internal/marketplace/sync/${network}`).set('X-Scheduler-Secret', 'sek').send({});

describe('internal marketplace sync — held commissions (VTID-04741)', () => {
  const saved = process.env.MARKETPLACE_SYNC_SECRET;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MARKETPLACE_SYNC_SECRET = 'sek';
    mockRunAll.mockResolvedValue({ providers: {} });
    mockRunSource.mockResolvedValue({ totals: {} });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env.MARKETPLACE_SYNC_SECRET = saved;
    jest.restoreAllMocks();
  });

  it('the daily all-networks run confirms due held commissions and reports them', async () => {
    const summary = { ok: true, examined: 2, credited: 1, reversed: 1, failed: 0 };
    mockConfirm.mockResolvedValue(summary);
    const res = await post('all');
    expect(res.status).toBe(200);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ ok: true, network: 'all', held_commissions: summary });
  });

  it('a failure confirming commissions does not fail the catalogue sync', async () => {
    mockConfirm.mockRejectedValue(new Error('db down'));
    const res = await post('all');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, held_commissions: { ok: false, error: 'db down' } });
  });

  it('a single-network run does not confirm commissions', async () => {
    const res = await post('shopify');
    expect(res.status).toBe(200);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('still rejects a request without the scheduler secret', async () => {
    const res = await request(app).post('/api/v1/internal/marketplace/sync/all').send({});
    expect(res.status).toBe(401);
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
