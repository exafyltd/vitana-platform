// VTID-03885 — HTTP tests for the Partner Health Test Integration admin portal.
// VTID-03932 — generalized so a partner org's own staff/professional can use
// the same routes; auth mock now stands in for requireAuth +
// requirePartnerHealthAccess (admin-partner-health.ts's own combined gate)
// instead of the retired requireTenantAdmin.
//
// Contract under test (mounted at /api/v1/admin/partner-health):
//   - auth: 401 without an identity, 403 for a caller with no admin/org access
//   - GET /orders: happy path (admin); org-scoped filtering (staff/professional)
//   - PATCH /orders/:id: 400 on result_ready (derived-state guard), 404 not
//     found, 403 for an out-of-scope order, happy path (delegates to
//     recordStatusChange)
//   - GET /inbox: happy path (admin); org-scoped (staff/professional-excluded)
//   - GET /candidates/:inboxId: no-merchant-id note, happy path
//   - POST /inbox/:id/upload-result: 400 missing fields, happy path
//     (delegates to the adapter + ingestPartnerResult)
//   - POST /inbox/:id/confirm-match: 400 missing fields, 404 not found, 409
//     already resolved, happy path (the hard-stop step)
//
// VTID-05055 (Health Hub Phase 0 / D8):
//   - confirm-match is a PROPOSAL: 202, no partner_customer_links /
//     partner_health_test_orders insert, proposal columns written, member
//     notified with tt() keys; 400 USER_NOT_IN_TENANT; 409 already pending;
//     409 MEMBER_DECLINED; 503 MEMBER_CONFIRMATION_UNAVAILABLE without the
//     migration (and still no link insert)
//   - GET /orders, /inbox, /candidates/:inboxId emit health_test.staff_read
//     (ids/counts only, no raw_payload) and answer 503 AUDIT_UNAVAILABLE when
//     the emit fails; 401/403 emit nothing
//   - upload-result derives partner_key from the order's partner_registry row;
//     a body 'doctorbox' is ignored; no default when the join is missing;
//     portal_manual partners use MANUAL_UPLOAD_FORMAT; others without an
//     adapter get 400

import express from 'express';
import request from 'supertest';

const ADMIN_USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STAFF_USER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PROFESSIONAL_USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OUTSIDER_USER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const TENANT_ID = 'tenant-1';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const token = req.headers.authorization;
    const byToken: Record<string, any> = {
      'Bearer admin-1': { user_id: ADMIN_USER_ID, tenant_id: TENANT_ID, exafy_admin: true },
      'Bearer staff-1': { user_id: STAFF_USER_ID, tenant_id: null, exafy_admin: false },
      'Bearer professional-1': { user_id: PROFESSIONAL_USER_ID, tenant_id: null, exafy_admin: false },
      'Bearer outsider-1': { user_id: OUTSIDER_USER_ID, tenant_id: null, exafy_admin: false },
    };
    if (!token || !byToken[token]) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    req.identity = byToken[token];
    return next();
  },
}));

const recordStatusChangeMock = jest.fn();
const ingestPartnerResultMock = jest.fn();
const quarantineUnmatchedResultMock = jest.fn();
jest.mock('../src/services/partner-health/ingestion', () => ({
  recordStatusChange: (...args: any[]) => recordStatusChangeMock(...args),
  ingestPartnerResult: (...args: any[]) => ingestPartnerResultMock(...args),
  quarantineUnmatchedResult: (...args: any[]) => quarantineUnmatchedResultMock(...args),
}));

const findClickCorrelationCandidatesMock = jest.fn();
jest.mock('../src/services/partner-health/id-matching', () => ({
  findClickCorrelationCandidates: (...args: any[]) => findClickCorrelationCandidatesMock(...args),
}));

const emitOasisEventMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => emitOasisEventMock(...args),
}));

const notifyUserAsyncMock = jest.fn();
jest.mock('../src/services/notification-service', () => ({
  notifyUserAsync: (...args: any[]) => notifyUserAsyncMock(...args),
}));

jest.mock('../src/i18n/server-locale', () => ({
  getUserLocale: jest.fn().mockResolvedValue('de'),
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

type Ctx = { op: string; args: any[]; filters: Array<[string, ...any[]]> };
let tableHandlers: Record<string, (ctx: Ctx) => any>;
/** Every query the route ran: table, op, op args and filters (VTID-05055). */
let calls: Array<{ table: string } & Ctx>;

/** Same chainable fake shape as admin-community-marketplace.test.ts's harness. */
function makeFakeSupabase() {
  return {
    from(table: string) {
      const handler = tableHandlers[table];
      if (!handler) throw new Error(`Unexpected table in test: ${table}`);
      let op = 'select';
      let opArgs: any[] = [];
      const filters: Array<[string, ...any[]]> = [];
      const chain: any = {};
      for (const m of ['eq', 'in', 'or', 'is', 'order', 'limit']) {
        chain[m] = (...args: any[]) => { filters.push([m, ...args]); return chain; };
      }
      const run = () => {
        const ctx = { op, args: opArgs, filters };
        calls.push({ table, ...ctx });
        return handler(ctx);
      };
      chain.select = (...args: any[]) => { if (op === 'select') opArgs = args; return chain; };
      chain.insert = (...args: any[]) => { op = 'insert'; opArgs = args; return chain; };
      chain.update = (...args: any[]) => { op = 'update'; opArgs = args; return chain; };
      chain.maybeSingle = () => Promise.resolve(run());
      chain.single = () => Promise.resolve(run());
      chain.then = (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject);
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
  calls = [];
});

describe('admin-partner-health — auth', () => {
  it('401 without any token', async () => {
    const r = await request(makeApp()).get('/api/v1/admin/partner-health/orders');
    expect(r.status).toBe(401);
  });

  it('403 for an authenticated caller with no admin/partner-org access at all (VTID-03932)', async () => {
    tableHandlers.partner_organization_members = () => ({ data: [], error: null });
    const r = await request(makeApp())
      .get('/api/v1/admin/partner-health/orders')
      .set('Authorization', 'Bearer outsider-1');
    expect(r.status).toBe(403);
  });
});

describe('GET /orders', () => {
  it('returns orders (admin scope, no partner_id filter)', async () => {
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

describe('GET /orders — org-scoped access (VTID-03932)', () => {
  it("staff sees any order for their org's linked partner", async () => {
    tableHandlers.partner_organization_members = () => ({
      data: [{ partner_organization_id: 'org-a', role: 'staff' }],
      error: null,
    });
    tableHandlers.partner_registry = () => ({
      data: [{ id: 'partner-a', partner_organization_id: 'org-a' }],
      error: null,
    });
    tableHandlers.partner_health_test_orders = () => ({
      data: [{ id: 'order-1', partner_id: 'partner-a', assigned_professional_user_id: null, test_name: 'A', status: 'processing' }],
      error: null,
    });
    const r = await request(makeApp())
      .get('/api/v1/admin/partner-health/orders')
      .set('Authorization', 'Bearer staff-1');
    expect(r.status).toBe(200);
    expect(r.body.orders).toHaveLength(1);
  });

  it('professional sees only orders assigned to them', async () => {
    tableHandlers.partner_organization_members = () => ({
      data: [{ partner_organization_id: 'org-a', role: 'professional' }],
      error: null,
    });
    tableHandlers.partner_registry = () => ({
      data: [{ id: 'partner-a', partner_organization_id: 'org-a' }],
      error: null,
    });
    tableHandlers.partner_health_test_orders = () => ({
      data: [
        { id: 'order-1', partner_id: 'partner-a', assigned_professional_user_id: PROFESSIONAL_USER_ID, test_name: 'A', status: 'processing' },
        { id: 'order-2', partner_id: 'partner-a', assigned_professional_user_id: 'someone-else', test_name: 'B', status: 'processing' },
      ],
      error: null,
    });
    const r = await request(makeApp())
      .get('/api/v1/admin/partner-health/orders')
      .set('Authorization', 'Bearer professional-1');
    expect(r.status).toBe(200);
    expect(r.body.orders.map((o: any) => o.id)).toEqual(['order-1']);
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

  it('403 when a professional attempts to PATCH an order not assigned to them (VTID-03932)', async () => {
    tableHandlers.partner_organization_members = () => ({
      data: [{ partner_organization_id: 'org-a', role: 'professional' }],
      error: null,
    });
    tableHandlers.partner_registry = () => ({
      data: [{ id: 'partner-a', partner_organization_id: 'org-a' }],
      error: null,
    });
    tableHandlers.partner_health_test_orders = () => ({
      data: { id: 'order-1', tenant_id: TENANT_ID, user_id: 'user-1', partner_id: 'partner-a', assigned_professional_user_id: 'someone-else', status: 'processing', test_name: 'Cholesterol Panel' },
      error: null,
    });
    const r = await request(makeApp())
      .patch('/api/v1/admin/partner-health/orders/order-1')
      .set('Authorization', 'Bearer professional-1')
      .send({ status: 'sample_received' });
    expect(r.status).toBe(403);
    expect(recordStatusChangeMock).not.toHaveBeenCalled();
  });

  it('200 when a professional PATCHes an order assigned to them', async () => {
    tableHandlers.partner_organization_members = () => ({
      data: [{ partner_organization_id: 'org-a', role: 'professional' }],
      error: null,
    });
    tableHandlers.partner_registry = () => ({
      data: [{ id: 'partner-a', partner_organization_id: 'org-a' }],
      error: null,
    });
    tableHandlers.partner_health_test_orders = () => ({
      data: { id: 'order-1', tenant_id: TENANT_ID, user_id: 'user-1', partner_id: 'partner-a', assigned_professional_user_id: PROFESSIONAL_USER_ID, status: 'processing', test_name: 'Cholesterol Panel' },
      error: null,
    });
    recordStatusChangeMock.mockResolvedValue({ ok: true });
    const r = await request(makeApp())
      .patch('/api/v1/admin/partner-health/orders/order-1')
      .set('Authorization', 'Bearer professional-1')
      .send({ status: 'sample_received' });
    expect(r.status).toBe(200);
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
      data: {
        id: 'order-1', tenant_id: TENANT_ID, user_id: 'user-1', partner_id: 'partner-1', status: 'processing', test_name: 'Cholesterol Panel',
        partner_registry: { partner_key: 'doctorbox', display_name: 'DoctorBox', integration_mode: 'mock' },
      },
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
});

// VTID-05055 — confirm-match proposes; the member confirms in the app.
describe('POST /inbox/:id/confirm-match — member proposal (VTID-05055)', () => {
  const body = { matched_user_id: 'user-1', matched_tenant_id: TENANT_ID, test_name: 'Cholesterol Panel', external_order_ref: 'DB-77' };

  function proposalHandlers(row: Record<string, unknown> = {}, opts: { inTenant?: boolean; updatedRows?: any[] } = {}) {
    tableHandlers.partner_health_result_inbox = ({ op }: Ctx) => {
      if (op === 'update') return { data: opts.updatedRows ?? [{ id: 'inbox-1' }], error: null };
      return {
        data: {
          id: 'inbox-1', partner_id: 'partner-1', resolved: false, member_link_status: null, member_declined_user_ids: [],
          partner_registry: { display_name: 'DoctorBox' }, ...row,
        },
        error: null,
      };
    };
    tableHandlers.user_tenants = () => ({ data: opts.inTenant === false ? null : { tenant_id: TENANT_ID }, error: null });
    tableHandlers.partner_customer_links = () => { throw new Error('confirm-match must never insert partner_customer_links'); };
    tableHandlers.partner_health_test_orders = () => { throw new Error('confirm-match must never insert partner_health_test_orders'); };
  }

  it('202 — writes the proposal, notifies the member with tt() keys, creates NO link and NO order', async () => {
    proposalHandlers();
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/confirm-match')
      .set('Authorization', 'Bearer admin-1')
      .send(body);

    expect(r.status).toBe(202);
    expect(r.body).toEqual({ ok: true, status: 'pending_member', inbox_id: 'inbox-1' });
    expect(calls.some((c) => c.table === 'partner_customer_links' || c.table === 'partner_health_test_orders')).toBe(false);

    const update = calls.find((c) => c.table === 'partner_health_result_inbox' && c.op === 'update');
    expect(update?.args[0]).toMatchObject({
      member_link_status: 'pending_member',
      proposed_user_id: 'user-1',
      proposed_tenant_id: TENANT_ID,
      proposed_test_name: 'Cholesterol Panel',
      proposed_external_order_ref: 'DB-77',
      proposed_by_admin_id: ADMIN_USER_ID,
    });
    expect(update?.args[0]).not.toHaveProperty('resolved');
    // Compare-and-set: only from "no proposal" or "declined".
    expect(update?.filters).toEqual(expect.arrayContaining([['eq', 'resolved', false], ['or', 'member_link_status.is.null,member_link_status.eq.declined']]));

    expect(notifyUserAsyncMock).toHaveBeenCalledTimes(1);
    const [uid, tid, type, payload] = notifyUserAsyncMock.mock.calls[0];
    expect([uid, tid, type]).toEqual(['user-1', TENANT_ID, 'partner_link_request']);
    // German catalog text (getUserLocale mocked to 'de'), never a raw key or English literal.
    expect(payload.title).toBe('Ist das dein Test?');
    expect(payload.body).toContain('DoctorBox');
    expect(payload.body).toContain('Cholesterol Panel');
    expect(payload.data).toEqual({ inbox_id: 'inbox-1', url: '/patient/results' });

    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({
      vtid: 'VTID-05055', type: 'health_test.link_proposed', actor_id: ADMIN_USER_ID,
      payload: expect.objectContaining({ inbox_id: 'inbox-1', proposed_user_id: 'user-1' }),
    }));
    expect(emitOasisEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'health_test.order_created' }));
  });

  it('400 USER_NOT_IN_TENANT when the named user is not a member of the named tenant', async () => {
    proposalHandlers({}, { inTenant: false });
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/confirm-match')
      .set('Authorization', 'Bearer admin-1')
      .send(body);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('USER_NOT_IN_TENANT');
    expect(calls.some((c) => c.op === 'update')).toBe(false);
    expect(notifyUserAsyncMock).not.toHaveBeenCalled();
  });

  it('409 when the row is already waiting for a member', async () => {
    proposalHandlers({ member_link_status: 'pending_member' });
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/confirm-match')
      .set('Authorization', 'Bearer admin-1')
      .send(body);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('PENDING_MEMBER');
    expect(notifyUserAsyncMock).not.toHaveBeenCalled();
  });

  it('409 MEMBER_DECLINED when the same member already declined this row', async () => {
    proposalHandlers({ member_link_status: 'declined', member_declined_user_ids: ['user-1'] });
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/confirm-match')
      .set('Authorization', 'Bearer admin-1')
      .send(body);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('MEMBER_DECLINED');
  });

  it('202 for a DIFFERENT member after someone else declined', async () => {
    proposalHandlers({ member_link_status: 'declined', member_declined_user_ids: ['user-9'] });
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/confirm-match')
      .set('Authorization', 'Bearer admin-1')
      .send(body);
    expect(r.status).toBe(202);
  });

  it('409 when the compare-and-set updates no row (changed concurrently)', async () => {
    proposalHandlers({}, { updatedRows: [] });
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/confirm-match')
      .set('Authorization', 'Bearer admin-1')
      .send(body);
    expect(r.status).toBe(409);
    expect(notifyUserAsyncMock).not.toHaveBeenCalled();
  });

  it('503 MEMBER_CONFIRMATION_UNAVAILABLE without the migration — and never the old direct link', async () => {
    tableHandlers.partner_health_result_inbox = () => ({
      data: null,
      error: { code: '42703', message: 'column partner_health_result_inbox.member_link_status does not exist' },
    });
    tableHandlers.partner_customer_links = () => ({ data: { id: 'link-1' }, error: null });
    tableHandlers.partner_health_test_orders = () => ({ data: { id: 'order-1' }, error: null });
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/confirm-match')
      .set('Authorization', 'Bearer admin-1')
      .send(body);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('MEMBER_CONFIRMATION_UNAVAILABLE');
    expect(calls.some((c) => c.table === 'partner_customer_links' || c.table === 'partner_health_test_orders')).toBe(false);
    expect(notifyUserAsyncMock).not.toHaveBeenCalled();
  });

  it('403 for a professional-only org member (full partner access required)', async () => {
    tableHandlers.partner_organization_members = () => ({ data: [{ partner_organization_id: 'org-a', role: 'professional' }], error: null });
    tableHandlers.partner_registry = () => ({ data: [{ id: 'partner-1', partner_organization_id: 'org-a' }], error: null });
    proposalHandlers();
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/confirm-match')
      .set('Authorization', 'Bearer professional-1')
      .send(body);
    expect(r.status).toBe(403);
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });
});

// VTID-05055 — every staff read of member health data is audited, fail closed.
describe('audited staff reads (VTID-05055)', () => {
  function staffReadEvents() {
    return emitOasisEventMock.mock.calls.map((c) => c[0]).filter((e) => e.type === 'health_test.staff_read');
  }

  it('GET /orders emits health_test.staff_read with the actor and ids only', async () => {
    tableHandlers.partner_health_test_orders = () => ({
      data: [{ id: 'order-1', user_id: 'user-1', partner_id: 'partner-1', assigned_professional_user_id: null, test_name: 'Cholesterol Panel', status: 'processing' }],
      error: null,
    });
    const r = await request(makeApp())
      .get('/api/v1/admin/partner-health/orders?status=processing')
      .set('Authorization', 'Bearer admin-1');
    expect(r.status).toBe(200);
    const [ev] = staffReadEvents();
    expect(ev).toMatchObject({
      vtid: 'VTID-05055', source: 'admin-partner-health', actor_id: ADMIN_USER_ID,
      payload: {
        route: 'GET /orders', access_scope: 'admin', partner_ids: ['partner-1'], row_count: 1,
        subject_user_ids: ['user-1'], order_ids: ['order-1'], status_filter: 'processing',
      },
    });
    expect(JSON.stringify(ev.payload)).not.toContain('Cholesterol');
  });

  it('GET /inbox emits health_test.staff_read without raw_payload and selects the proposal columns', async () => {
    tableHandlers.partner_health_result_inbox = () => ({
      data: [{ id: 'inbox-1', partner_id: 'partner-1', raw_payload: { secret_marker: 'XYZ' }, candidate_user_ids: ['user-2'], proposed_user_id: 'user-3', reason: 'no_match', resolved: false, member_link_status: 'pending_member' }],
      error: null,
    });
    const r = await request(makeApp())
      .get('/api/v1/admin/partner-health/inbox')
      .set('Authorization', 'Bearer admin-1');
    expect(r.status).toBe(200);
    expect(r.body.inbox[0].member_link_status).toBe('pending_member');
    expect(calls[0].args[0]).toContain('member_link_status');
    const [ev] = staffReadEvents();
    expect(ev.payload).toMatchObject({ route: 'GET /inbox', inbox_ids: ['inbox-1'], row_count: 1 });
    expect(ev.payload.subject_user_ids.sort()).toEqual(['user-2', 'user-3']);
    expect(JSON.stringify(ev.payload)).not.toContain('raw_payload');
    expect(JSON.stringify(ev.payload)).not.toContain('XYZ');
  });

  it('GET /inbox falls back to the legacy column list when the migration is missing', async () => {
    tableHandlers.partner_health_result_inbox = ({ args }: Ctx) => {
      if (String(args[0]).includes('member_link_status')) {
        return { data: null, error: { code: 'PGRST204', message: "Could not find the 'member_link_status' column of 'partner_health_result_inbox' in the schema cache" } };
      }
      return { data: [{ id: 'inbox-1', partner_id: 'partner-1', reason: 'no_match', resolved: false }], error: null };
    };
    const r = await request(makeApp())
      .get('/api/v1/admin/partner-health/inbox')
      .set('Authorization', 'Bearer admin-1');
    expect(r.status).toBe(200);
    expect(r.body.inbox).toHaveLength(1);
    expect(staffReadEvents()).toHaveLength(1);
  });

  it('GET /candidates/:inboxId emits health_test.staff_read with the candidate user ids', async () => {
    tableHandlers.partner_health_result_inbox = () => ({
      data: { id: 'inbox-1', partner_id: 'partner-1', raw_payload: { merchant_id: 'merchant-1' }, created_at: '2026-09-14T00:00:00Z' },
      error: null,
    });
    findClickCorrelationCandidatesMock.mockResolvedValue([{ user_id: 'user-1', click_id: 'c1', clicked_at: '2026-09-13T00:00:00Z', product_id: null }]);
    const r = await request(makeApp())
      .get('/api/v1/admin/partner-health/candidates/inbox-1')
      .set('Authorization', 'Bearer admin-1');
    expect(r.status).toBe(200);
    const [ev] = staffReadEvents();
    expect(ev.payload).toMatchObject({ route: 'GET /candidates/:inboxId', inbox_id: 'inbox-1', subject_user_ids: ['user-1'], row_count: 1, partner_ids: ['partner-1'] });
    expect(JSON.stringify(ev.payload)).not.toContain('merchant-1');
  });

  it.each([
    ['/orders', () => { tableHandlers.partner_health_test_orders = () => ({ data: [], error: null }); }],
    ['/inbox', () => { tableHandlers.partner_health_result_inbox = () => ({ data: [], error: null }); }],
    ['/candidates/inbox-1', () => {
      tableHandlers.partner_health_result_inbox = () => ({ data: { id: 'inbox-1', partner_id: 'partner-1', raw_payload: { merchant_id: 'm' }, created_at: '2026-09-14T00:00:00Z' }, error: null });
      findClickCorrelationCandidatesMock.mockResolvedValue([{ user_id: 'user-1' }]);
    }],
  ])('GET %s fails closed with 503 AUDIT_UNAVAILABLE when the audit event is not written', async (path, setup) => {
    (setup as () => void)();
    emitOasisEventMock.mockResolvedValue({ ok: false, error: 'insert failed' });
    const r = await request(makeApp())
      .get(`/api/v1/admin/partner-health${path}`)
      .set('Authorization', 'Bearer admin-1');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ ok: false, error: 'AUDIT_UNAVAILABLE' });
    expect(r.body).not.toHaveProperty('orders');
    expect(r.body).not.toHaveProperty('inbox');
    expect(r.body).not.toHaveProperty('candidates');
  });

  it('fails closed when the audit emit throws', async () => {
    tableHandlers.partner_health_test_orders = () => ({ data: [], error: null });
    emitOasisEventMock.mockRejectedValue(new Error('network'));
    const r = await request(makeApp())
      .get('/api/v1/admin/partner-health/orders')
      .set('Authorization', 'Bearer admin-1');
    expect(r.status).toBe(503);
  });

  it('401 and 403 paths emit nothing', async () => {
    const r401 = await request(makeApp()).get('/api/v1/admin/partner-health/inbox');
    expect(r401.status).toBe(401);
    tableHandlers.partner_organization_members = () => ({ data: [], error: null });
    const r403 = await request(makeApp())
      .get('/api/v1/admin/partner-health/orders')
      .set('Authorization', 'Bearer outsider-1');
    expect(r403.status).toBe(403);
    tableHandlers.partner_organization_members = () => ({ data: [{ partner_organization_id: 'org-a', role: 'staff' }], error: null });
    tableHandlers.partner_registry = () => ({ data: [{ id: 'partner-a', partner_organization_id: 'org-a' }], error: null });
    tableHandlers.partner_health_result_inbox = () => ({ data: { id: 'inbox-1', partner_id: 'partner-other', raw_payload: {}, created_at: '2026-09-14T00:00:00Z' }, error: null });
    const rCand403 = await request(makeApp())
      .get('/api/v1/admin/partner-health/candidates/inbox-1')
      .set('Authorization', 'Bearer staff-1');
    expect(rCand403.status).toBe(403);
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });
});

// VTID-05055 — partner_key comes from the order, never from the body or a default.
describe('POST /inbox/:id/upload-result — partner_key from the order (VTID-05055)', () => {
  function orderWith(registry: unknown) {
    tableHandlers.partner_health_test_orders = () => ({
      data: { id: 'order-1', tenant_id: TENANT_ID, user_id: 'user-1', partner_id: 'partner-x', status: 'processing', test_name: 'Vitamin D', partner_registry: registry },
      error: null,
    });
  }

  beforeEach(() => {
    receiveResultMock.mockImplementation(async (raw: any) => ({ external_order_ref: 'X-1', biomarkers: [], raw }));
    ingestPartnerResultMock.mockResolvedValue({ ok: true, quarantined: true, reason: 'consent_missing' });
  });

  it("a body 'doctorbox' on a self-registered partner's order → ingestion runs with the org's own key and the manual format", async () => {
    orderWith({ partner_key: 'acme-labs', display_name: 'Acme Labs', integration_mode: 'portal_manual' });
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/upload-result')
      .set('Authorization', 'Bearer admin-1')
      .send({ order_id: 'order-1', partner_key: 'doctorbox', result: { external_order_ref: 'X-1', biomarkers: [] } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ partner_key: 'acme-labs', upload_format: 'vitana_manual_json_v1' });
    const input = ingestPartnerResultMock.mock.calls[0][1];
    expect(input.partner_key).toBe('acme-labs');
    expect(input.payload.raw._upload_format).toBe('vitana_manual_json_v1');
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'health_test.partner_key_mismatch', status: 'warning',
      payload: expect.objectContaining({ partner_key_mismatch: true, partner_key: 'acme-labs', body_partner_key: 'doctorbox' }),
    }));
  });

  it('derives doctorbox from the order (no body key needed) and records no manual format', async () => {
    orderWith([{ partner_key: 'doctorbox', display_name: 'DoctorBox', integration_mode: 'mock' }]);
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/upload-result')
      .set('Authorization', 'Bearer admin-1')
      .send({ order_id: 'order-1', result: { external_order_ref: 'X-1', biomarkers: [] } });
    expect(r.status).toBe(200);
    expect(r.body.upload_format).toBe('doctorbox');
    const input = ingestPartnerResultMock.mock.calls[0][1];
    expect(input.partner_key).toBe('doctorbox');
    expect(input.payload.raw._upload_format).toBeUndefined();
    expect(emitOasisEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'health_test.partner_key_mismatch' }));
  });

  it("500 PARTNER_NOT_REGISTERED when the order has no partner_registry row — never a 'doctorbox' default", async () => {
    orderWith(null);
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/upload-result')
      .set('Authorization', 'Bearer admin-1')
      .send({ order_id: 'order-1', partner_key: 'doctorbox', result: { biomarkers: [] } });
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('PARTNER_NOT_REGISTERED');
    expect(ingestPartnerResultMock).not.toHaveBeenCalled();
  });

  it('400 NO_ADAPTER for a non-manual partner without an adapter', async () => {
    orderWith({ partner_key: 'labcorp-api', display_name: 'LabCorp', integration_mode: 'api' });
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/inbox-1/upload-result')
      .set('Authorization', 'Bearer admin-1')
      .send({ order_id: 'order-1', partner_key: 'doctorbox', result: { biomarkers: [] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('NO_ADAPTER');
    expect(ingestPartnerResultMock).not.toHaveBeenCalled();
  });
});

// VTID-03974 — the manual inbox-entry endpoint that lets a self-registered
// partner's own staff get their first result into the inbox at all, reusing
// quarantineUnmatchedResult() rather than a new write path.
describe('POST /inbox/manual', () => {
  it('400 when partner_id or raw_payload is missing', async () => {
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/manual')
      .set('Authorization', 'Bearer admin-1')
      .send({ raw_payload: { foo: 'bar' } });
    expect(r.status).toBe(400);

    const r2 = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/manual')
      .set('Authorization', 'Bearer admin-1')
      .send({ partner_id: 'partner-a' });
    expect(r2.status).toBe(400);
  });

  it('403 for a professional-only org member (assigned-order-only, not full access)', async () => {
    tableHandlers.partner_organization_members = () => ({
      data: [{ partner_organization_id: 'org-a', role: 'professional' }],
      error: null,
    });
    tableHandlers.partner_registry = () => ({
      data: [{ id: 'partner-a', partner_organization_id: 'org-a' }],
      error: null,
    });
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/manual')
      .set('Authorization', 'Bearer professional-1')
      .send({ partner_id: 'partner-a', raw_payload: { external_customer_ref: 'x1' } });
    expect(r.status).toBe(403);
    expect(quarantineUnmatchedResultMock).not.toHaveBeenCalled();
  });

  it('201 happy path for admin — no candidates given, reason=no_match', async () => {
    quarantineUnmatchedResultMock.mockResolvedValue({ ok: true, inbox_id: 'inbox-9' });
    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/manual')
      .set('Authorization', 'Bearer admin-1')
      .send({ partner_id: 'partner-a', raw_payload: { external_customer_ref: 'x1' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, inbox_id: 'inbox-9' });
    expect(quarantineUnmatchedResultMock).toHaveBeenCalledWith(
      expect.anything(),
      'partner-a',
      { external_customer_ref: 'x1' },
      [],
      'no_match',
    );
  });

  it("201 happy path for the org's own staff — candidate user ids given, reason=ambiguous_match", async () => {
    tableHandlers.partner_organization_members = () => ({
      data: [{ partner_organization_id: 'org-a', role: 'staff' }],
      error: null,
    });
    tableHandlers.partner_registry = () => ({
      data: [{ id: 'partner-a', partner_organization_id: 'org-a' }],
      error: null,
    });
    quarantineUnmatchedResultMock.mockResolvedValue({ ok: true, inbox_id: 'inbox-10' });

    const r = await request(makeApp())
      .post('/api/v1/admin/partner-health/inbox/manual')
      .set('Authorization', 'Bearer staff-1')
      .send({ partner_id: 'partner-a', raw_payload: { external_customer_ref: 'x2' }, candidate_user_ids: ['user-1', 'user-2'] });

    expect(r.status).toBe(201);
    expect(quarantineUnmatchedResultMock).toHaveBeenCalledWith(
      expect.anything(),
      'partner-a',
      { external_customer_ref: 'x2' },
      ['user-1', 'user-2'],
      'ambiguous_match',
    );
  });
});
