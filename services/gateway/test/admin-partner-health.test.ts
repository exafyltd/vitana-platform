// VTID-03885 — HTTP tests for the Partner Health Test Integration admin portal.
//
// Contract under test (mounted at /api/v1/admin/partner-health,
// requireTenantAdmin-gated):
//   - auth: 401 without an identity
//   - GET /orders: happy path
//   - PATCH /orders/:id: 400 on result_ready (derived-state guard), 404 not
//     found, happy path (delegates to recordStatusChange)
//   - GET /inbox: happy path
//   - GET /candidates/:inboxId: no-merchant-id note, happy path
//   - POST /inbox/:id/upload-result: 400 missing fields, happy path
//     (delegates to the adapter + ingestPartnerResult)
//   - POST /inbox/:id/confirm-match: 400 missing fields, 404 not found, 409
//     already resolved, happy path (the hard-stop step)

import express from 'express';
import request from 'supertest';

const ADMIN_USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_ID = 'tenant-1';

jest.mock('../src/middleware/require-tenant-admin', () => ({
  requireTenantAdmin: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer admin-1') {
      return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    }
    req.identity = { user_id: ADMIN_USER_ID, tenant_id: TENANT_ID };
    return next();
  },
}));

const recordStatusChangeMock = jest.fn();
const ingestPartnerResultMock = jest.fn();
jest.mock('../src/services/partner-health/ingestion', () => ({
  recordStatusChange: (...args: any[]) => recordStatusChangeMock(...args),
  ingestPartnerResult: (...args: any[]) => ingestPartnerResultMock(...args),
}));

const findClickCorrelationCandidatesMock = jest.fn();
jest.mock('../src/services/partner-health/id-matching', () => ({
  findClickCorrelationCandidates: (...args: any[]) => findClickCorrelationCandidatesMock(...args),
}));

const emitOasisEventMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => emitOasisEventMock(...args),
}));

const receiveResultMock = jest.fn();
const validateResultMock = jest.fn();
jest.mock('../src/services/partner-health/doctorbox-adapter', () => ({
  __esModule: true,
  default: {
    partnerKey: 'doctorbox',
    receiveResult: (...args: any[]) => receiveResultMock(...args),
    validateResult: (...args: any[]) => validateResultMock(...args),
  },
}));

let tableHandlers: Record<string, (ctx: { op: string; args: any[] }) => any>;

/** Same chainable fake shape as admin-community-marketplace.test.ts's harness. */
function makeFakeSupabase() {
  return {
    from(table: string) {
      const handler = tableHandlers[table];
      if (!handler) throw new Error(`Unexpected table in test: ${table}`);
      let op = 'select';
      let opArgs: any[] = [];
      const chain: any = {};
      for (const m of ['eq', 'order', 'limit']) {
        chain[m] = (...args: any[]) => chain;
      }
      chain.select = (...args: any[]) => { if (op === 'select') opArgs = args; return chain; };
      chain.insert = (...args: any[]) => { op = 'insert'; opArgs = args; return chain; };
      chain.update = (...args: any[]) => { op = 'update'; opArgs = args; return chain; };
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
const router = require('../src/routes/admin-partner-health').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/partner-health', router);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  emitOasisEventMock.mockResolvedValue({ ok: true });
  tableHandlers = {};
});

describe('admin-partner-health — auth', () => {
  it('401 without an admin token', async () => {
    const r = await request(makeApp()).get('/api/v1/admin/partner-health/orders');
    expect(r.status).toBe(401);
  });
});

describe('GET /orders', () => {
  it('returns orders', async () => {
    tableHandlers.partner_health_test_orders = () => ({
      data: [{ id: 'order-1', test_name: 'Cholesterol Panel', status: 'processing' }],
      error: null,
    });
    const r = await request(makeApp())
      .get('/api/v1/admin/partner-health/orders')
      .set('Authorization', 'Bearer admin-1');
    expect(r.status).toBe(200);
    expect(r.body.orders).toHaveLength(1);
  });
});

describe('PATCH /orders/:id', () => {
  it('400 when status is result_ready (derived state, not settable here)', async () => {
    const r = await request(makeApp())
      .patch('/api/v1/admin/partner-health/orders/order-1')
      .set('Authorization', 'Bearer admin-1')
      .send({ status: 'result_ready' });
    expect(r.status).toBe(400);
    expect(recordStatusChangeMock).not.toHaveBeenCalled();
  });

  it('404 when the order does not exist', async () => {
    tableHandlers.partner_health_test_orders = () => ({ data: null, error: null });
    const r = await request(makeApp())
      .patch('/api/v1/admin/partner-health/orders/order-1')
      .set('Authorization', 'Bearer admin-1')
      .send({ status: 'sample_received' });
    expect(r.status).toBe(404);
  });

  it('200 happy path — delegates to recordStatusChange', async () => {
    tableHandlers.partner_health_test_orders = () => ({
      data: { id: 'order-1', tenant_id: TENANT_ID, user_id: 'user-1', partner_id: 'partner-1', status: 'processing', test_name: 'Cholesterol Panel' },
      error: null,
    });
    recordStatusChangeMock.mockResolvedValue({ ok: true });

    const r = await request(makeApp())
      .patch('/api/v1/admin/partner-health/orders/order-1')
      .set('Authorization', 'Bearer admin-1')
      .send({ status: 'sample_received' });

    expect(r.status).toBe(200);
    expect(recordStatusChangeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to_status: 'sample_received', changed_by: 'portal_admin' }),
    );
  });
});

describe('GET /inbox', () => {
  it('returns unresolved inbox rows', async () => {
    tableHandlers.partner_health_result_inbox = () => ({
      data: [{ id: 'inbox-1', reason: 'no_match', resolved: false }],
      error: null,
    });
    const r = await request(makeApp())
      .get('/api/v1/admin/partner-health/inbox')
      .set('Authorization', 'Bearer admin-1');
    expect(r.status).toBe(200);
    expect(r.body.inbox).toHaveLength(1);
  });
});

describe('GET /candidates/:inboxId', () => {
  it('returns a note (no candidates) when the raw payload has no merchant_id', async () => {
    tableHandlers.partner_health_result_inbox = () => ({
      data: { id: 'inbox-1', partner_id: 'partner-1', raw_payload: {}, created_at: '2026-09-14T00:00:00Z' },
      error: null,
    });
    const r = await request(makeApp())
      .get('/api/v1/admin/partner-health/candidates/inbox-1')
      .set('Authorization', 'Bearer admin-1');
    expect(r.status).toBe(200);
    expect(r.body.candidates).toEqual([]);
    expect(r.body.note).toBeTruthy();
    expect(findClickCorrelationCandidatesMock).not.toHaveBeenCalled();
  });

  it('returns ranked candidates when a merchant_id is present', async () => {
    tableHandlers.partner_health_result_inbox = () => ({
      data: { id: 'inbox-1', partner_id: 'partner-1', raw_payload: { merchant_id: 'merchant-1' }, created_at: '2026-09-14T00:00:00Z' },
      error: null,
    });
    findClickCorrelationCandidatesMock.mockResolvedValue([{ user_id: 'user-1', click_id: 'c1', clicked_at: '2026-09-13T00:00:00Z', product_id: null }]);
    const r = await request(makeApp())
      .get('/api/v1/admin/partner-health/candidates/inbox-1')
      .set('Authorization', 'Bearer admin-1');
    expect(r.status).toBe(200);
    expect(r.body.candidates).toHaveLength(1);
  });
});

describe('POST /inbox/:id/upload-result', () => {
  it('400 when order_id is missing', async () => {
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/upload-result')
      .set('Authorization', 'Bearer admin-1')
      .send({ result: { biomarkers: [] } });
    expect(r.status).toBe(400);
  });

  it('200 happy path — delegates to the adapter + ingestPartnerResult', async () => {
    tableHandlers.partner_health_test_orders = () => ({
      data: { id: 'order-1', tenant_id: TENANT_ID, user_id: 'user-1', partner_id: 'partner-1', status: 'processing', test_name: 'Cholesterol Panel' },
      error: null,
    });
    receiveResultMock.mockResolvedValue({ external_order_ref: 'DB-1', biomarkers: [], raw: {} });
    ingestPartnerResultMock.mockResolvedValue({ ok: true, quarantined: false, result_id: 'result-1', biomarker_result_ids: [] });

    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/upload-result')
      .set('Authorization', 'Bearer admin-1')
      .send({ order_id: 'order-1', result: { biomarkers: [] } });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(ingestPartnerResultMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ partner_key: 'doctorbox', received_via: 'portal_manual_upload' }),
    );
  });
});

describe('POST /inbox/:id/confirm-match', () => {
  it('400 when matched_user_id/matched_tenant_id are missing', async () => {
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/confirm-match')
      .set('Authorization', 'Bearer admin-1')
      .send({ test_name: 'Cholesterol Panel' });
    expect(r.status).toBe(400);
  });

  it('404 when the inbox row does not exist', async () => {
    tableHandlers.partner_health_result_inbox = () => ({ data: null, error: null });
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/confirm-match')
      .set('Authorization', 'Bearer admin-1')
      .send({ matched_user_id: 'user-1', matched_tenant_id: TENANT_ID, test_name: 'Cholesterol Panel' });
    expect(r.status).toBe(404);
  });

  it('409 when the inbox row is already resolved', async () => {
    tableHandlers.partner_health_result_inbox = () => ({
      data: { id: 'inbox-1', partner_id: 'partner-1', raw_payload: {}, resolved: true },
      error: null,
    });
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/confirm-match')
      .set('Authorization', 'Bearer admin-1')
      .send({ matched_user_id: 'user-1', matched_tenant_id: TENANT_ID, test_name: 'Cholesterol Panel' });
    expect(r.status).toBe(409);
  });

  it('200 happy path — creates the link + order and marks the inbox row resolved', async () => {
    tableHandlers.partner_health_result_inbox = ({ op }: any) => {
      if (op === 'update') return { data: null, error: null };
      return { data: { id: 'inbox-1', partner_id: 'partner-1', raw_payload: {}, resolved: false }, error: null };
    };
    tableHandlers.partner_customer_links = () => ({ data: { id: 'link-1' }, error: null });
    tableHandlers.partner_health_test_orders = () => ({ data: { id: 'order-1' }, error: null });

    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/confirm-match')
      .set('Authorization', 'Bearer admin-1')
      .send({ matched_user_id: 'user-1', matched_tenant_id: TENANT_ID, test_name: 'Cholesterol Panel' });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, order_id: 'order-1', link_id: 'link-1' });
    expect(emitOasisEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'health_test.order_created', payload: expect.objectContaining({ order_id: 'order-1' }) }),
    );
  });
});
