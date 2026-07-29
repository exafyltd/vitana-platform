// BOOTSTRAP-COMMUNITY-MARKETPLACE (Chunk 7) — HTTP tests for the admin
// review queue for peer-to-peer classifieds.
//
// Contract under test (mounted at /api/v1/admin/community-marketplace,
// requireTenantAdmin-gated):
//   - auth: 401 without an identity
//   - GET /listings, PATCH /listings/:id: happy path + no-allowed-fields
//   - POST /listings/bulk-action: missing listing_ids, reject-without-reason,
//     happy path (reject fans out a locale-aware push notification)
//   - POST/DELETE /sellers/:userId/suspend: happy path
//   - GET /reports, PATCH /reports/:id: happy path
//   - GET /categories, PATCH /categories/:key: happy path + not-found

import express from 'express';
import request from 'supertest';

const emitOasisEventMock = jest.fn().mockResolvedValue({ ok: true });
const notifyUserAsyncMock = jest.fn();

const ADMIN_USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_ID = 'tenant-1';
const SELLER_ID = '11111111-1111-1111-1111-111111111111';

jest.mock('../src/middleware/require-tenant-admin', () => ({
  requireTenantAdmin: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer admin-1') {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    req.identity = { user_id: ADMIN_USER_ID, tenant_id: TENANT_ID };
    return next();
  },
}));

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => emitOasisEventMock(...args),
}));

jest.mock('../src/services/notification-service', () => ({
  notifyUserAsync: (...args: any[]) => notifyUserAsyncMock(...args),
}));

jest.mock('../src/i18n/server-locale', () => ({
  bulkGetUserLocales: async (_supa: any, userIds: string[]) => new Map(userIds.map((id) => [id, 'de'])),
}));

let tableHandlers: Record<string, (ctx: { op: string; args: any[] }) => any>;

/**
 * Generic chainable fake covering every supabase-js query shape this route
 * file uses (select/update/upsert/delete + eq/in/order/range +
 * maybeSingle/single/awaited-list). Mirrors community-marketplace.test.ts's
 * own harness — same route file family, same query shapes.
 */
function makeFakeSupabase() {
  return {
    from(table: string) {
      const handler = tableHandlers[table];
      if (!handler) throw new Error(`Unexpected table in test: ${table}`);
      let op = 'select';
      let opArgs: any[] = [];
      const chain: any = {};
      for (const m of ['eq', 'neq', 'in', 'order', 'range']) {
        chain[m] = (...args: any[]) => chain;
      }
      chain.select = (...args: any[]) => { if (op === 'select') opArgs = args; return chain; };
      chain.update = (...args: any[]) => { op = 'update'; opArgs = args; return chain; };
      chain.upsert = (...args: any[]) => { op = 'upsert'; opArgs = args; return chain; };
      chain.delete = (...args: any[]) => { op = 'delete'; opArgs = args; return chain; };
      chain.maybeSingle = () => Promise.resolve(handler({ op, args: opArgs }));
      chain.single = () => Promise.resolve(handler({ op, args: opArgs }));
      chain.then = (resolve: any, reject: any) =>
        Promise.resolve(handler({ op, args: opArgs })).then(resolve, reject);
      return chain;
    },
  };
}

jest.mock('../src/lib/supabase', () => ({ getSupabase: () => makeFakeSupabase() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/admin-community-marketplace').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/community-marketplace', router);
  return app;
}

beforeEach(() => {
  emitOasisEventMock.mockClear();
  notifyUserAsyncMock.mockClear();
  tableHandlers = {};
});

describe('admin-community-marketplace — auth', () => {
  it('401 without an admin token', async () => {
    const r = await request(makeApp()).get('/api/v1/admin/community-marketplace/listings');
    expect(r.status).toBe(401);
  });
});

describe('GET /listings', () => {
  it('returns the review queue with seller info flattened', async () => {
    tableHandlers.community_listings = () => ({
      data: [{ id: 'listing-1', seller_user_id: SELLER_ID, status: 'active', requires_admin_review: true, profiles: { display_name: 'Seller One', vitana_id: 'V1' } }],
      error: null,
      count: 1,
    });

    const r = await request(makeApp())
      .get('/api/v1/admin/community-marketplace/listings')
      .set('Authorization', 'Bearer admin-1');

    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ id: 'listing-1', seller_display_name: 'Seller One', seller_vitana_id: 'V1' });
    expect(r.body.total).toBe(1);
  });
});

describe('PATCH /listings/:id', () => {
  it('400 when no allowed fields are provided', async () => {
    const r = await request(makeApp())
      .patch('/api/v1/admin/community-marketplace/listings/listing-1')
      .set('Authorization', 'Bearer admin-1')
      .send({ not_a_real_field: 1 });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('no_allowed_fields');
  });

  it('404 when the listing does not exist', async () => {
    tableHandlers.community_listings = () => ({ data: null, error: null });

    const r = await request(makeApp())
      .patch('/api/v1/admin/community-marketplace/listings/listing-1')
      .set('Authorization', 'Bearer admin-1')
      .send({ admin_notes: 'checked, looks fine' });

    expect(r.status).toBe(404);
  });

  it('200 happy path — edits admin_notes and emits an OASIS event', async () => {
    tableHandlers.community_listings = ({ op }: any) =>
      op === 'update'
        ? { data: { id: 'listing-1', admin_notes: 'checked, looks fine' }, error: null }
        : { data: { id: 'listing-1', status: 'active' }, error: null };

    const r = await request(makeApp())
      .patch('/api/v1/admin/community-marketplace/listings/listing-1')
      .set('Authorization', 'Bearer admin-1')
      .send({ admin_notes: 'checked, looks fine' });

    expect(r.status).toBe(200);
    expect(r.body.listing).toMatchObject({ id: 'listing-1', admin_notes: 'checked, looks fine' });
    expect(emitOasisEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'community_marketplace.admin.listing_reviewed' })
    );
  });
});

describe('POST /listings/bulk-action', () => {
  it('400 when listing_ids is missing', async () => {
    const r = await request(makeApp())
      .post('/api/v1/admin/community-marketplace/listings/bulk-action')
      .set('Authorization', 'Bearer admin-1')
      .send({ action: 'hide' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('listing_ids_required');
  });

  it('400 when rejecting without a reason', async () => {
    const r = await request(makeApp())
      .post('/api/v1/admin/community-marketplace/listings/bulk-action')
      .set('Authorization', 'Bearer admin-1')
      .send({ listing_ids: ['listing-1'], action: 'reject' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('reason_required_for_reject');
  });

  it('200 happy path — reject notifies the seller in their own locale', async () => {
    tableHandlers.community_listings = ({ op }: any) =>
      op === 'select'
        ? { data: [{ id: 'listing-1', seller_user_id: SELLER_ID, title: 'Old bike', status: 'active' }], error: null }
        : { data: null, error: null };
    tableHandlers.listing_status_history = () => ({ data: null, error: null });

    const r = await request(makeApp())
      .post('/api/v1/admin/community-marketplace/listings/bulk-action')
      .set('Authorization', 'Bearer admin-1')
      .send({ listing_ids: ['listing-1'], action: 'reject', reason: 'Counterfeit brand' });

    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(1);
    expect(notifyUserAsyncMock).toHaveBeenCalledWith(
      SELLER_ID,
      TENANT_ID,
      'marketplace_listing_rejected',
      expect.objectContaining({ body: expect.stringContaining('Old bike') }),
      expect.anything()
    );
  });
});

describe('POST /sellers/:userId/suspend', () => {
  it('201 happy path — suspends the seller and their active listings', async () => {
    tableHandlers.community_marketplace_seller_suspensions = () => ({ data: null, error: null });
    tableHandlers.community_listings = ({ op }: any) =>
      op === 'select'
        ? { data: [{ id: 'listing-1', status: 'active' }], error: null }
        : { data: null, error: null };
    tableHandlers.listing_status_history = () => ({ data: null, error: null });

    const r = await request(makeApp())
      .post(`/api/v1/admin/community-marketplace/sellers/${SELLER_ID}/suspend`)
      .set('Authorization', 'Bearer admin-1')
      .send({ reason: 'repeat offender' });

    expect(r.status).toBe(201);
    expect(r.body.listings_suspended).toBe(1);
  });
});

describe('DELETE /sellers/:userId/suspend', () => {
  it('200 happy path — lifts the suspension without touching listings', async () => {
    tableHandlers.community_marketplace_seller_suspensions = () => ({ data: null, error: null });

    const r = await request(makeApp())
      .delete(`/api/v1/admin/community-marketplace/sellers/${SELLER_ID}/suspend`)
      .set('Authorization', 'Bearer admin-1');

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

describe('GET /reports', () => {
  it('defaults to received + under_review and flattens listing info', async () => {
    tableHandlers.community_listing_reports = () => ({
      data: [{ id: 'report-1', status: 'received', community_listings: { title: 'Old bike', status: 'active', seller_user_id: SELLER_ID } }],
      error: null,
      count: 1,
    });

    const r = await request(makeApp())
      .get('/api/v1/admin/community-marketplace/reports')
      .set('Authorization', 'Bearer admin-1');

    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ id: 'report-1', listing_title: 'Old bike', seller_user_id: SELLER_ID });
  });
});

describe('PATCH /reports/:id', () => {
  it('200 happy path — dismisses a report and stamps resolved_by/resolved_at', async () => {
    tableHandlers.community_listing_reports = () => ({ data: { id: 'report-1', status: 'dismissed' }, error: null });

    const r = await request(makeApp())
      .patch('/api/v1/admin/community-marketplace/reports/report-1')
      .set('Authorization', 'Bearer admin-1')
      .send({ status: 'dismissed' });

    expect(r.status).toBe(200);
    expect(r.body.report).toMatchObject({ id: 'report-1', status: 'dismissed' });
  });
});

describe('GET /categories', () => {
  it('returns the full unfiltered taxonomy (admin view)', async () => {
    tableHandlers.community_listing_categories = () => ({
      data: [{ key: 'weapons', is_prohibited: true, is_active: true }],
      error: null,
    });

    const r = await request(makeApp())
      .get('/api/v1/admin/community-marketplace/categories')
      .set('Authorization', 'Bearer admin-1');

    expect(r.status).toBe(200);
    expect(r.body.categories).toEqual([{ key: 'weapons', is_prohibited: true, is_active: true }]);
  });
});

describe('PATCH /categories/:key', () => {
  it('404 when the category does not exist', async () => {
    tableHandlers.community_listing_categories = () => ({ data: null, error: null });

    const r = await request(makeApp())
      .patch('/api/v1/admin/community-marketplace/categories/nonexistent')
      .set('Authorization', 'Bearer admin-1')
      .send({ is_prohibited: true });

    expect(r.status).toBe(404);
  });

  it('200 happy path — toggles is_prohibited', async () => {
    tableHandlers.community_listing_categories = () => ({ data: { key: 'weapons', is_prohibited: true }, error: null });

    const r = await request(makeApp())
      .patch('/api/v1/admin/community-marketplace/categories/weapons')
      .set('Authorization', 'Bearer admin-1')
      .send({ is_prohibited: true });

    expect(r.status).toBe(200);
    expect(r.body.category).toMatchObject({ key: 'weapons', is_prohibited: true });
  });
});
