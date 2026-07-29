// BOOTSTRAP-COMMUNITY-MARKETPLACE — HTTP tests for the tenant-scoped
// seller/buyer API for peer-to-peer classifieds.
//
// Contract under test (mounted at /api/v1/community-marketplace):
//   - auth: 401 without an identity (requireAuthWithTenant runs first)
//   - GET /categories, /listings, /listings/:id: happy path + not-found
//   - POST /listings: validation error, moderation-blocked category,
//     happy path (draft-pending-review vs active)
//   - PATCH /listings/:id: not-found, not-editable (terminal status)
//   - POST /listings/:id/status: invalid transition, happy path
//   - POST /listings/:id/reports: cannot report own listing, duplicate, happy path
//   - POST /seller-blocks + DELETE /seller-blocks/:id: cannot block self, happy path

import express from 'express';
import request from 'supertest';

const emitOasisEventMock = jest.fn().mockResolvedValue({ ok: true });

const SELLER_ID = '11111111-1111-1111-1111-111111111111';
const BUYER_ID = '22222222-2222-2222-2222-222222222222';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuthWithTenant: (req: any, res: any, next: any) => {
    const h = req.headers.authorization;
    if (h === 'Bearer seller-1') {
      req.identity = { user_id: '11111111-1111-1111-1111-111111111111', tenant_id: 'tenant-1' };
      return next();
    }
    if (h === 'Bearer buyer-1') {
      req.identity = { user_id: '22222222-2222-2222-2222-222222222222', tenant_id: 'tenant-1' };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  },
}));

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => emitOasisEventMock(...args),
}));

let tableHandlers: Record<string, (ctx: { op: string; args: any[] }) => any>;

/**
 * Generic chainable fake covering every supabase-js query shape this route
 * file uses (select/insert/update/upsert/delete + eq/in/not/gte/lte/order/
 * range/textSearch + maybeSingle/single/awaited-list). Each test configures
 * `tableHandlers[table]` to return the { data, error, count? } for whatever
 * operation the handler performs against that table.
 */
function makeFakeSupabase() {
  return {
    from(table: string) {
      const handler = tableHandlers[table];
      if (!handler) throw new Error(`Unexpected table in test: ${table}`);
      let op = 'select';
      let opArgs: any[] = [];
      const chain: any = {};
      for (const m of ['eq', 'neq', 'gte', 'lte', 'in', 'not', 'order', 'range', 'textSearch']) {
        chain[m] = (...args: any[]) => chain;
      }
      chain.select = (...args: any[]) => { if (op === 'select') opArgs = args; return chain; };
      chain.insert = (...args: any[]) => { op = 'insert'; opArgs = args; return chain; };
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
const router = require('../src/routes/community-marketplace').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/community-marketplace', router);
  return app;
}

const ACTIVE_CATEGORY = {
  key: 'electronics',
  listing_kind: 'product',
  is_prohibited: false,
  requires_verified_provider: false,
  requires_admin_review_always: false,
  is_active: true,
};

const PROHIBITED_CATEGORY = { ...ACTIVE_CATEGORY, key: 'weapons', is_prohibited: true };

const VALID_LISTING_BODY = {
  listing_kind: 'product',
  category: 'electronics',
  title: 'Barely used laptop',
  description: 'A perfectly fine laptop, selling because I upgraded.',
  images: [],
  price_cents: 50000,
  currency: 'EUR',
};

beforeEach(() => {
  emitOasisEventMock.mockClear();
  tableHandlers = {};
});

describe('community-marketplace — auth', () => {
  it('401 without token', async () => {
    const r = await request(makeApp()).get('/api/v1/community-marketplace/categories');
    expect(r.status).toBe(401);
  });
});

describe('GET /categories', () => {
  it('returns active, non-prohibited categories', async () => {
    tableHandlers.community_listing_categories = () => ({ data: [ACTIVE_CATEGORY], error: null });

    const r = await request(makeApp())
      .get('/api/v1/community-marketplace/categories')
      .set('Authorization', 'Bearer buyer-1');

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, categories: [ACTIVE_CATEGORY] });
  });
});

describe('GET /listings', () => {
  it('browses active listings for the tenant', async () => {
    tableHandlers.community_listing_seller_blocks = () => ({ data: [], error: null });
    tableHandlers.community_listings = () => ({
      data: [{ id: 'listing-1', seller_user_id: 'seller-1', status: 'active', images: [] }],
      error: null,
      count: 1,
    });

    const r = await request(makeApp())
      .get('/api/v1/community-marketplace/listings')
      .set('Authorization', 'Bearer buyer-1');

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.listings).toHaveLength(1);
    expect(r.body.meta.total_count).toBe(1);
  });
});

describe('GET /listings/:id', () => {
  it('404 when the listing does not exist', async () => {
    tableHandlers.community_listings = () => ({ data: null, error: null });

    const r = await request(makeApp())
      .get('/api/v1/community-marketplace/listings/missing-id')
      .set('Authorization', 'Bearer buyer-1');

    expect(r.status).toBe(404);
    expect(r.body.ok).toBe(false);
  });

  it('200 for a visible listing, including seller info', async () => {
    tableHandlers.community_listings = ({ op }: any) =>
      op === 'update'
        ? { data: null, error: null }
        : { data: { id: 'listing-1', seller_user_id: 'seller-1', status: 'active', view_count: 0, images: [] }, error: null };
    tableHandlers.community_listing_seller_blocks = () => ({ data: null, error: null });
    tableHandlers.profiles = () => ({ data: { user_id: 'seller-1', display_name: 'Seller One' }, error: null });

    const r = await request(makeApp())
      .get('/api/v1/community-marketplace/listings/listing-1')
      .set('Authorization', 'Bearer buyer-1');

    expect(r.status).toBe(200);
    expect(r.body.listing).toMatchObject({ id: 'listing-1', seller: { user_id: 'seller-1', display_name: 'Seller One' } });
  });
});

describe('POST /listings', () => {
  it('400 on validation error', async () => {
    const r = await request(makeApp())
      .post('/api/v1/community-marketplace/listings')
      .set('Authorization', 'Bearer seller-1')
      .send({ listing_kind: 'product' }); // missing title/description/category

    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  });

  it('403 when the seller is suspended (BOOTSTRAP-COMMUNITY-MARKETPLACE Chunk 7)', async () => {
    tableHandlers.community_listing_categories = () => ({ data: ACTIVE_CATEGORY, error: null });
    tableHandlers.community_marketplace_seller_suspensions = () => ({ data: { seller_user_id: 'seller-1' }, error: null });

    const r = await request(makeApp())
      .post('/api/v1/community-marketplace/listings')
      .set('Authorization', 'Bearer seller-1')
      .send(VALID_LISTING_BODY);

    expect(r.status).toBe(403);
    expect(r.body.error).toBe('seller_suspended');
  });

  it('400 when the category is prohibited', async () => {
    tableHandlers.community_listing_categories = () => ({ data: PROHIBITED_CATEGORY, error: null });
    tableHandlers.community_marketplace_seller_suspensions = () => ({ data: null, error: null });
    tableHandlers.profiles = () => ({ data: { verification_status: 'verified' }, error: null });

    const r = await request(makeApp())
      .post('/api/v1/community-marketplace/listings')
      .set('Authorization', 'Bearer seller-1')
      .send({ ...VALID_LISTING_BODY, category: 'weapons' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('category_prohibited');
  });

  it('201 happy path — creates an active listing and emits an OASIS event', async () => {
    tableHandlers.community_listing_categories = () => ({ data: ACTIVE_CATEGORY, error: null });
    tableHandlers.community_marketplace_seller_suspensions = () => ({ data: null, error: null });
    tableHandlers.profiles = () => ({ data: { verification_status: 'verified' }, error: null });
    tableHandlers.community_listings = ({ op }: any) =>
      op === 'insert'
        ? { data: { id: 'listing-1', status: 'active', images: [], seller_user_id: 'seller-1' }, error: null }
        : { data: null, error: null };
    tableHandlers.listing_status_history = () => ({ data: null, error: null });

    const r = await request(makeApp())
      .post('/api/v1/community-marketplace/listings')
      .set('Authorization', 'Bearer seller-1')
      .send(VALID_LISTING_BODY);

    expect(r.status).toBe(201);
    expect(r.body.listing).toMatchObject({ id: 'listing-1', status: 'active' });
    expect(emitOasisEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'community_marketplace.listing.created' })
    );
  });
});

describe('PATCH /listings/:id', () => {
  it('404 when the caller does not own the listing', async () => {
    tableHandlers.community_listings = () => ({ data: null, error: null });

    const r = await request(makeApp())
      .patch('/api/v1/community-marketplace/listings/listing-1')
      .set('Authorization', 'Bearer seller-1')
      .send({ title: 'New title for a listing I do not own' });

    expect(r.status).toBe(404);
  });

  it('409 when the listing is already sold', async () => {
    tableHandlers.community_listings = () => ({ data: { id: 'listing-1', status: 'sold' }, error: null });

    const r = await request(makeApp())
      .patch('/api/v1/community-marketplace/listings/listing-1')
      .set('Authorization', 'Bearer seller-1')
      .send({ title: 'Trying to edit a sold listing' });

    expect(r.status).toBe(409);
    expect(r.body.error).toBe('listing_not_editable');
  });
});

describe('POST /listings/:id/status', () => {
  it('409 on an invalid transition (already sold, trying to pause)', async () => {
    tableHandlers.community_listings = () => ({ data: { id: 'listing-1', status: 'sold', seller_user_id: 'seller-1' }, error: null });

    const r = await request(makeApp())
      .post('/api/v1/community-marketplace/listings/listing-1/status')
      .set('Authorization', 'Bearer seller-1')
      .send({ action: 'pause' });

    expect(r.status).toBe(409);
    expect(r.body.error).toBe('invalid_status_transition');
  });

  it('200 happy path — pausing an active listing emits an OASIS event', async () => {
    tableHandlers.community_listings = ({ op }: any) =>
      op === 'update'
        ? { data: { id: 'listing-1', status: 'paused', images: [] }, error: null }
        : { data: { id: 'listing-1', status: 'active', seller_user_id: 'seller-1' }, error: null };
    tableHandlers.listing_status_history = () => ({ data: null, error: null });

    const r = await request(makeApp())
      .post('/api/v1/community-marketplace/listings/listing-1/status')
      .set('Authorization', 'Bearer seller-1')
      .send({ action: 'pause' });

    expect(r.status).toBe(200);
    expect(r.body.listing.status).toBe('paused');
    expect(emitOasisEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'community_marketplace.listing.status_changed' })
    );
  });
});

describe('POST /listings/:id/reports', () => {
  it('400 when reporting your own listing', async () => {
    tableHandlers.community_listings = () => ({ data: { id: 'listing-1', seller_user_id: SELLER_ID }, error: null });

    const r = await request(makeApp())
      .post('/api/v1/community-marketplace/listings/listing-1/reports')
      .set('Authorization', 'Bearer seller-1')
      .send({ report_reason: 'spam' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('cannot_report_own_listing');
  });

  it('409 on a duplicate report', async () => {
    tableHandlers.community_listings = () => ({ data: { id: 'listing-1', seller_user_id: 'seller-1' }, error: null });
    tableHandlers.community_listing_reports = () => ({ data: null, error: { code: '23505', message: 'duplicate' } });

    const r = await request(makeApp())
      .post('/api/v1/community-marketplace/listings/listing-1/reports')
      .set('Authorization', 'Bearer buyer-1')
      .send({ report_reason: 'spam' });

    expect(r.status).toBe(409);
    expect(r.body.error).toBe('already_reported');
  });

  it('201 happy path', async () => {
    tableHandlers.community_listings = () => ({ data: { id: 'listing-1', seller_user_id: 'seller-1', status: 'active', requires_admin_review: false }, error: null });
    tableHandlers.community_listing_reports = ({ op }: any) =>
      op === 'insert' ? { data: { id: 'report-1' }, error: null } : { data: null, error: null, count: 1 };

    const r = await request(makeApp())
      .post('/api/v1/community-marketplace/listings/listing-1/reports')
      .set('Authorization', 'Bearer buyer-1')
      .send({ report_reason: 'spam' });

    expect(r.status).toBe(201);
    expect(r.body.report_id).toBe('report-1');
  });
});

describe('seller-blocks', () => {
  it('400 when trying to block yourself', async () => {
    const r = await request(makeApp())
      .post('/api/v1/community-marketplace/seller-blocks')
      .set('Authorization', 'Bearer buyer-1')
      .send({ blocked_seller_id: BUYER_ID });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('cannot_block_self');
  });

  it('201 happy path — blocking another seller', async () => {
    tableHandlers.community_listing_seller_blocks = () => ({ data: { id: 'block-1' }, error: null });

    const r = await request(makeApp())
      .post('/api/v1/community-marketplace/seller-blocks')
      .set('Authorization', 'Bearer buyer-1')
      .send({ blocked_seller_id: SELLER_ID });

    expect(r.status).toBe(201);
    expect(r.body.block_id).toBe('block-1');
  });

  it('200 happy path — unblocking', async () => {
    tableHandlers.community_listing_seller_blocks = () => ({ data: null, error: null });

    const r = await request(makeApp())
      .delete('/api/v1/community-marketplace/seller-blocks/seller-1')
      .set('Authorization', 'Bearer buyer-1');

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});
