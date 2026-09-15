// VTID-03932 — HTTP tests for the self-service Commerce Partner Onboarding
// routes (mounted at /api/v1/partner-orgs).
//
// Contract under test:
//   - POST /register: 400 on missing fields, 409 on duplicate org_key, 201
//     happy path (caller becomes org_admin)
//   - GET /:orgId/members: org_admin-or-exafy_admin only
//   - POST /:orgId/members/invite: org_admin-only, 400 on bad role
//   - POST /invites/:token/accept: 404 unknown token, 409 already accepted,
//     410 expired, 200 happy path
//   - POST /:orgId/activate: exafy_admin-only

import express from 'express';
import request from 'supertest';

const OWNER_USER_ID = 'owner-1';
const OTHER_USER_ID = 'other-1';
const EXAFY_ADMIN_USER_ID = 'exafy-admin-1';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const token = req.headers.authorization;
    const byToken: Record<string, any> = {
      'Bearer owner-1': { user_id: OWNER_USER_ID, tenant_id: null, exafy_admin: false },
      'Bearer other-1': { user_id: OTHER_USER_ID, tenant_id: null, exafy_admin: false },
      'Bearer exafy-admin-1': { user_id: EXAFY_ADMIN_USER_ID, tenant_id: null, exafy_admin: true },
    };
    if (!token || !byToken[token]) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = byToken[token];
    return next();
  },
}));

const emitOasisEventMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => emitOasisEventMock(...args),
}));

let tableHandlers: Record<string, (ctx: { op: string; args: any[] }) => any>;

function makeFakeSupabase() {
  return {
    from(table: string) {
      const handler = tableHandlers[table];
      if (!handler) throw new Error(`Unexpected table in test: ${table}`);
      let op = 'select';
      let opArgs: any[] = [];
      const chain: any = {};
      for (const m of ['eq', 'in', 'order', 'limit']) {
        chain[m] = (...args: any[]) => chain;
      }
      chain.select = (...args: any[]) => { if (op === 'select') opArgs = args; return chain; };
      chain.insert = (...args: any[]) => { op = 'insert'; opArgs = args; return chain; };
      chain.update = (...args: any[]) => { op = 'update'; opArgs = args; return chain; };
      chain.upsert = (...args: any[]) => { op = 'upsert'; opArgs = args; return chain; };
      chain.maybeSingle = () => Promise.resolve(handler({ op, args: opArgs, terminal: 'maybeSingle' } as any));
      chain.single = () => Promise.resolve(handler({ op, args: opArgs, terminal: 'single' } as any));
      chain.then = (resolve: any, reject: any) =>
        Promise.resolve(handler({ op, args: opArgs, terminal: 'then' } as any)).then(resolve, reject);
      return chain;
    },
  };
}

jest.mock('../src/lib/supabase', () => ({ getSupabase: () => makeFakeSupabase() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/partner-orgs').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/partner-orgs', router);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  emitOasisEventMock.mockResolvedValue({ ok: true });
  tableHandlers = {};
});

describe('partner-orgs — auth (mount proof)', () => {
  it('401 without any token', async () => {
    const r = await request(makeApp()).post('/api/v1/partner-orgs/register').send({});
    expect(r.status).toBe(401);
    expect(r.type).toBe('application/json');
  });
});

describe('POST /register', () => {
  it('400 when a required field is missing', async () => {
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/register')
      .set('Authorization', 'Bearer owner-1')
      .send({ display_name: 'DoctorBox' });
    expect(r.status).toBe(400);
  });

  it('409 when org_key is already taken', async () => {
    tableHandlers.partner_organizations = ({ op }) =>
      op === 'insert' ? { data: null, error: { code: '23505', message: 'duplicate key' } } : { data: null, error: null };
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/register')
      .set('Authorization', 'Bearer owner-1')
      .send({ org_key: 'doctorbox', display_name: 'DoctorBox', org_type: 'lab_partner' });
    expect(r.status).toBe(409);
  });

  it('201 happy path — creates the org and adds the caller as org_admin', async () => {
    tableHandlers.partner_organizations = () => ({
      data: { id: 'org-1', org_key: 'doctorbox', display_name: 'DoctorBox', org_type: 'lab_partner', status: 'pending_review' },
      error: null,
    });
    tableHandlers.partner_organization_members = () => ({ data: null, error: null });

    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/register')
      .set('Authorization', 'Bearer owner-1')
      .send({ org_key: 'doctorbox', display_name: 'DoctorBox', org_type: 'lab_partner' });

    expect(r.status).toBe(201);
    expect(r.body.organization).toMatchObject({ id: 'org-1', status: 'pending_review' });
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_org.registered' }));
  });
});

describe('GET /mine', () => {
  it('returns the orgs the caller belongs to, with role, via the embedded join', async () => {
    tableHandlers.partner_organization_members = () => ({
      data: [
        { role: 'org_admin', partner_organizations: { id: 'org-1', org_key: 'doctorbox', display_name: 'DoctorBox', org_type: 'lab_partner', status: 'pending_review' } },
        { role: 'professional', partner_organizations: { id: 'org-2', org_key: 'wellco', display_name: 'WellCo', org_type: 'wellness_partner', status: 'active' } },
      ],
      error: null,
    });
    const r = await request(makeApp())
      .get('/api/v1/partner-orgs/mine')
      .set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(200);
    expect(r.body.organizations).toEqual([
      { id: 'org-1', org_key: 'doctorbox', display_name: 'DoctorBox', org_type: 'lab_partner', status: 'pending_review', role: 'org_admin' },
      { id: 'org-2', org_key: 'wellco', display_name: 'WellCo', org_type: 'wellness_partner', status: 'active', role: 'professional' },
    ]);
  });

  it('returns an empty list for a caller with no memberships', async () => {
    tableHandlers.partner_organization_members = () => ({ data: [], error: null });
    const r = await request(makeApp())
      .get('/api/v1/partner-orgs/mine')
      .set('Authorization', 'Bearer other-1');
    expect(r.status).toBe(200);
    expect(r.body.organizations).toEqual([]);
  });
});

describe('GET /:orgId/members', () => {
  it('403 for a caller who is not an org_admin for this org', async () => {
    tableHandlers.partner_organization_members = () => ({ data: null, error: null });
    const r = await request(makeApp())
      .get('/api/v1/partner-orgs/org-1/members')
      .set('Authorization', 'Bearer other-1');
    expect(r.status).toBe(403);
  });

  it("200 for the org's own org_admin", async () => {
    tableHandlers.partner_organization_members = ({ terminal }: any) => {
      // requireOrgAdmin()'s own check terminates with maybeSingle(); the
      // route handler's list query terminates via the implicit `then()`.
      if (terminal === 'maybeSingle') return { data: { role: 'org_admin' }, error: null };
      return { data: [{ id: 'm1', user_id: OWNER_USER_ID, role: 'org_admin' }], error: null };
    };
    const r = await request(makeApp())
      .get('/api/v1/partner-orgs/org-1/members')
      .set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(200);
    expect(r.body.members).toHaveLength(1);
  });

  it('200 for exafy_admin regardless of membership', async () => {
    // No partner_organization_members handler registered on purpose —
    // exafy_admin must short-circuit requireOrgAdmin() before any
    // membership lookup runs (a lookup here would throw in this fake).
    tableHandlers.partner_organization_members = () => ({ data: [{ id: 'm1', user_id: 'someone', role: 'staff' }], error: null });
    const r = await request(makeApp())
      .get('/api/v1/partner-orgs/org-1/members')
      .set('Authorization', 'Bearer exafy-admin-1');
    expect(r.status).toBe(200);
  });
});

describe('POST /:orgId/members/invite', () => {
  it('400 on an invalid role', async () => {
    tableHandlers.partner_organization_members = () => ({ data: { role: 'org_admin' }, error: null });
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/org-1/members/invite')
      .set('Authorization', 'Bearer owner-1')
      .send({ email: 'doc@example.com', role: 'ceo' });
    expect(r.status).toBe(400);
  });

  it('201 happy path — creates the invite', async () => {
    tableHandlers.partner_organization_members = () => ({ data: { role: 'org_admin' }, error: null });
    tableHandlers.partner_organization_invites = () => ({
      data: { id: 'invite-1', email: 'doc@example.com', role: 'professional', expires_at: '2026-12-01T00:00:00Z', token: 'tok123' },
      error: null,
    });
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/org-1/members/invite')
      .set('Authorization', 'Bearer owner-1')
      .send({ email: 'doc@example.com', role: 'professional' });
    expect(r.status).toBe(201);
    expect(r.body.invite.role).toBe('professional');
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_org.member_invited' }));
  });
});

describe('GET /:orgId/invites', () => {
  it('403 for a caller who is not an org_admin for this org', async () => {
    tableHandlers.partner_organization_members = () => ({ data: null, error: null });
    const r = await request(makeApp())
      .get('/api/v1/partner-orgs/org-1/invites')
      .set('Authorization', 'Bearer other-1');
    expect(r.status).toBe(403);
  });

  it("200 for the org's own org_admin, listing pending invites", async () => {
    tableHandlers.partner_organization_members = ({ terminal }: any) =>
      terminal === 'maybeSingle' ? { data: { role: 'org_admin' }, error: null } : { data: [], error: null };
    tableHandlers.partner_organization_invites = () => ({
      data: [{ id: 'invite-1', email: 'doc@example.com', role: 'professional', token: 'tok-abc', expires_at: '2026-12-01T00:00:00Z', accepted_at: null }],
      error: null,
    });
    const r = await request(makeApp())
      .get('/api/v1/partner-orgs/org-1/invites')
      .set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(200);
    expect(r.body.invites).toHaveLength(1);
    expect(r.body.invites[0].email).toBe('doc@example.com');
    expect(r.body.invites[0].token).toBe('tok-abc');
  });
});

describe('POST /invites/:token/accept', () => {
  it('404 for an unknown token', async () => {
    tableHandlers.partner_organization_invites = () => ({ data: null, error: null });
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/invites/does-not-exist/accept')
      .set('Authorization', 'Bearer other-1');
    expect(r.status).toBe(404);
  });

  it('409 when already accepted', async () => {
    tableHandlers.partner_organization_invites = () => ({
      data: { id: 'invite-1', partner_organization_id: 'org-1', email: 'x@example.com', role: 'staff', expires_at: '2099-01-01T00:00:00Z', accepted_at: '2026-01-01T00:00:00Z' },
      error: null,
    });
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/invites/tok123/accept')
      .set('Authorization', 'Bearer other-1');
    expect(r.status).toBe(409);
  });

  it('410 when expired', async () => {
    tableHandlers.partner_organization_invites = () => ({
      data: { id: 'invite-1', partner_organization_id: 'org-1', email: 'x@example.com', role: 'staff', expires_at: '2000-01-01T00:00:00Z', accepted_at: null },
      error: null,
    });
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/invites/tok123/accept')
      .set('Authorization', 'Bearer other-1');
    expect(r.status).toBe(410);
  });

  it('200 happy path — adds the member and marks the invite accepted', async () => {
    tableHandlers.partner_organization_invites = ({ op }) => {
      if (op === 'update') return { data: null, error: null };
      return {
        data: { id: 'invite-1', partner_organization_id: 'org-1', email: 'x@example.com', role: 'professional', expires_at: '2099-01-01T00:00:00Z', accepted_at: null },
        error: null,
      };
    };
    tableHandlers.partner_organization_members = () => ({ data: null, error: null });

    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/invites/tok123/accept')
      .set('Authorization', 'Bearer other-1');

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, partner_organization_id: 'org-1', role: 'professional' });
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_org.member_joined' }));
  });
});

describe('POST /:orgId/activate', () => {
  it('403 for a non-exafy_admin caller', async () => {
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/org-1/activate')
      .set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(403);
  });

  it('404 when the organization does not exist', async () => {
    tableHandlers.partner_organizations = () => ({ data: null, error: null });
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/org-1/activate')
      .set('Authorization', 'Bearer exafy-admin-1');
    expect(r.status).toBe(404);
  });

  it('200 happy path', async () => {
    tableHandlers.partner_organizations = () => ({
      data: { id: 'org-1', org_key: 'doctorbox', display_name: 'DoctorBox', status: 'active' },
      error: null,
    });
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/org-1/activate')
      .set('Authorization', 'Bearer exafy-admin-1');
    expect(r.status).toBe(200);
    expect(r.body.organization.status).toBe('active');
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_org.activated' }));
  });
});
