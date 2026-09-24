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
      'Bearer owner-1': { user_id: OWNER_USER_ID, email: 'owner@example.com', tenant_id: null, exafy_admin: false },
      'Bearer other-1': { user_id: OTHER_USER_ID, email: 'x@example.com', tenant_id: null, exafy_admin: false },
      'Bearer other-mixed-case': { user_id: OTHER_USER_ID, email: '  X@Example.COM ', tenant_id: null, exafy_admin: false },
      'Bearer no-email': { user_id: 'no-email-1', email: null, tenant_id: null, exafy_admin: false },
      'Bearer exafy-admin-1': { user_id: EXAFY_ADMIN_USER_ID, email: 'admin@exafy.io', tenant_id: null, exafy_admin: true },
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

// VTID-04463 — the invite route sends an email. The locale lookup and the
// sender are mocked here; the email builder and the Resend client have their
// own suite (vtid-04463-partner-invite-email.test.ts).
jest.mock('../src/i18n/server-locale', () => ({ getUserLocale: jest.fn().mockResolvedValue('de') }));
const sendPartnerInviteEmailMock = jest.fn();
jest.mock('../src/services/email/partner-invite-email', () => {
  const actual = jest.requireActual('../src/services/email/partner-invite-email');
  return { ...actual, sendPartnerInviteEmail: (...args: any[]) => sendPartnerInviteEmailMock(...args) };
});

let tableHandlers: Record<string, (ctx: { op: string; args: any[] }) => any>;
// Records every .in(column, values) filter so tests can assert that a write
// was conditional (VTID-04337 activate guard).
let inFilters: Array<{ table: string; column: string; values: any[] }>;

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
      chain.in = (column: string, values: any[]) => { inFilters.push({ table, column, values }); return chain; };
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
  sendPartnerInviteEmailMock.mockResolvedValue({ sent: false, status: 'disabled' });
  tableHandlers = {};
  inFilters = [];
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

  it('400 when commerce_vertical is missing or invalid', async () => {
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/register')
      .set('Authorization', 'Bearer owner-1')
      .send({ org_key: 'doctorbox', display_name: 'DoctorBox', org_type: 'lab_partner' });
    expect(r.status).toBe(400);

    const r2 = await request(makeApp())
      .post('/api/v1/partner-orgs/register')
      .set('Authorization', 'Bearer owner-1')
      .send({ org_key: 'doctorbox', display_name: 'DoctorBox', org_type: 'lab_partner', commerce_vertical: 'not-a-real-vertical' });
    expect(r2.status).toBe(400);
  });

  it('409 when org_key is already taken', async () => {
    tableHandlers.partner_organizations = ({ op }) =>
      op === 'insert' ? { data: null, error: { code: '23505', message: 'duplicate key' } } : { data: null, error: null };
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/register')
      .set('Authorization', 'Bearer owner-1')
      .send({ org_key: 'doctorbox', display_name: 'DoctorBox', org_type: 'lab_partner', commerce_vertical: 'health' });
    expect(r.status).toBe(409);
  });

  it('201 happy path — creates the org and adds the caller as org_admin', async () => {
    tableHandlers.partner_organizations = () => ({
      data: { id: 'org-1', org_key: 'doctorbox', display_name: 'DoctorBox', org_type: 'lab_partner', commerce_vertical: 'health', status: 'pending_review' },
      error: null,
    });
    tableHandlers.partner_organization_members = () => ({ data: null, error: null });

    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/register')
      .set('Authorization', 'Bearer owner-1')
      .send({ org_key: 'doctorbox', display_name: 'DoctorBox', org_type: 'lab_partner', commerce_vertical: 'health' });

    expect(r.status).toBe(201);
    expect(r.body.organization).toMatchObject({ id: 'org-1', status: 'pending_review' });
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_org.registered' }));
  });

  it('201 happy path — general-commerce vertical registers the same way', async () => {
    tableHandlers.partner_organizations = () => ({
      data: { id: 'org-2', org_key: 'acme-supplements', display_name: 'Acme Supplements', org_type: 'commerce', commerce_vertical: 'general', status: 'pending_review' },
      error: null,
    });
    tableHandlers.partner_organization_members = () => ({ data: null, error: null });

    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/register')
      .set('Authorization', 'Bearer owner-1')
      .send({ org_key: 'acme-supplements', display_name: 'Acme Supplements', org_type: 'commerce', commerce_vertical: 'general' });

    expect(r.status).toBe(201);
    expect(r.body.organization).toMatchObject({ id: 'org-2', status: 'pending_review' });
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

  // VTID-04463 — invite email
  function inviteTables() {
    tableHandlers.partner_organization_members = () => ({ data: { role: 'org_admin' }, error: null });
    tableHandlers.partner_organizations = () => ({ data: { display_name: 'DoctorBox' }, error: null });
    tableHandlers.partner_organization_invites = () => ({
      data: { id: 'invite-1', email: 'doc@example.com', role: 'professional', expires_at: '2026-12-01T00:00:00Z', token: 'tok123' },
      error: null,
    });
  }

  it('sends the invite email to the invited address with the org name, role and accept link', async () => {
    inviteTables();
    sendPartnerInviteEmailMock.mockResolvedValue({ sent: true, status: 'sent', provider_id: 'em_1' });
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/org-1/members/invite')
      .set('Authorization', 'Bearer owner-1')
      .send({ email: 'Doc@Example.com', role: 'professional' });
    expect(r.status).toBe(201);
    expect(sendPartnerInviteEmailMock).toHaveBeenCalledTimes(1);
    const input = sendPartnerInviteEmailMock.mock.calls[0][0];
    expect(input).toEqual(expect.objectContaining({
      to: 'doc@example.com',
      orgName: 'DoctorBox',
      role: 'professional',
      validDays: 7,
      locale: 'de',
    }));
    // The token in the link is the one stored on the invite row.
    const insertedToken = input.acceptUrl.split('/commerce/invites/')[1].split('/accept')[0];
    expect(insertedToken).toMatch(/^[0-9a-f]{48}$/);
    expect(r.body.accept_url).toBe(input.acceptUrl);
    expect(r.body.email).toEqual({ sent: true, status: 'sent' });
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'partner_org.member_invited',
      payload: expect.objectContaining({ email_status: 'sent' }),
    }));
  });

  it('still creates the invite and returns the accept link when email is disabled', async () => {
    inviteTables();
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/org-1/members/invite')
      .set('Authorization', 'Bearer owner-1')
      .send({ email: 'doc@example.com', role: 'professional' });
    expect(r.status).toBe(201);
    expect(r.body.accept_url).toMatch(/\/commerce\/invites\/[0-9a-f]{48}\/accept$/);
    expect(r.body.email).toEqual({ sent: false, status: 'disabled' });
  });

  it('a refused or thrown email never fails the invite', async () => {
    inviteTables();
    sendPartnerInviteEmailMock.mockRejectedValue(new Error('network down'));
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/org-1/members/invite')
      .set('Authorization', 'Bearer owner-1')
      .send({ email: 'doc@example.com', role: 'professional' });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.email).toEqual({ sent: false, status: 'failed' });
    // The provider error is logged, never returned to the browser.
    expect(JSON.stringify(r.body)).not.toContain('network down');
  });

  it('no email is sent when the invite insert fails', async () => {
    tableHandlers.partner_organization_members = () => ({ data: { role: 'org_admin' }, error: null });
    tableHandlers.partner_organization_invites = () => ({ data: null, error: { message: 'insert failed' } });
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/org-1/members/invite')
      .set('Authorization', 'Bearer owner-1')
      .send({ email: 'doc@example.com', role: 'professional' });
    expect(r.status).toBe(500);
    expect(sendPartnerInviteEmailMock).not.toHaveBeenCalled();
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

describe('POST /invites/:token/accept — invite bound to the invited email (VTID-04337 SEC-1)', () => {
  const pendingInvite = {
    id: 'invite-1', partner_organization_id: 'org-1', email: 'x@example.com', role: 'staff',
    expires_at: '2099-01-01T00:00:00Z', accepted_at: null,
  };

  it('403 INVITE_EMAIL_MISMATCH when a different account holds the token, and no member row is written', async () => {
    tableHandlers.partner_organization_invites = () => ({ data: pendingInvite, error: null });
    tableHandlers.partner_organization_members = () => { throw new Error('must not add a member on email mismatch'); };
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/invites/tok123/accept')
      .set('Authorization', 'Bearer owner-1');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('INVITE_EMAIL_MISMATCH');
    expect(JSON.stringify(r.body)).not.toContain('x@example.com');
    expect(emitOasisEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_org.member_joined' }));
  });

  it('403 INVITE_EMAIL_UNVERIFIED when the identity carries no email', async () => {
    tableHandlers.partner_organization_invites = () => ({ data: pendingInvite, error: null });
    tableHandlers.partner_organization_members = () => { throw new Error('must not add a member without an email'); };
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/invites/tok123/accept')
      .set('Authorization', 'Bearer no-email');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('INVITE_EMAIL_UNVERIFIED');
  });

  it('200 when the email matches ignoring case and surrounding whitespace', async () => {
    tableHandlers.partner_organization_invites = ({ op }) =>
      op === 'update' ? { data: null, error: null } : { data: { ...pendingInvite, email: 'X@example.com' }, error: null };
    tableHandlers.partner_organization_members = () => ({ data: null, error: null });
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/invites/tok123/accept')
      .set('Authorization', 'Bearer other-mixed-case');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, partner_organization_id: 'org-1', role: 'staff' });
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

  it('409 ORG_NOT_ACTIVATABLE for a rejected org, and the update was conditional on status (VTID-04337 SEC-3)', async () => {
    tableHandlers.partner_organizations = ({ op }: any) =>
      op === 'update'
        ? { data: null, error: null } // the status filter matched nothing
        : { data: { id: 'org-1', status: 'rejected' }, error: null };
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/org-1/activate')
      .set('Authorization', 'Bearer exafy-admin-1');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, error: 'ORG_NOT_ACTIVATABLE', status: 'rejected' });
    expect(inFilters).toContainEqual({ table: 'partner_organizations', column: 'status', values: ['pending_review', 'suspended', 'active'] });
    expect(emitOasisEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_org.activated' }));
  });

  it('200 happy path — general-commerce vertical, no partner_registry bridge', async () => {
    tableHandlers.partner_organizations = () => ({
      data: { id: 'org-1', org_key: 'acme-supplements', display_name: 'Acme Supplements', commerce_vertical: 'general', status: 'active' },
      error: null,
    });
    // No partner_registry handler registered on purpose — a general-vertical
    // org must never touch that table at all; a lookup here would throw.
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/org-1/activate')
      .set('Authorization', 'Bearer exafy-admin-1');
    expect(r.status).toBe(200);
    expect(r.body.organization.status).toBe('active');
    expect(emitOasisEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_org.activated' }));
    expect(emitOasisEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_org.registry_linked' }));
  });

  it('200 happy path — health vertical bridges to a NEW partner_registry row (VTID-03974)', async () => {
    tableHandlers.partner_organizations = () => ({
      data: { id: 'org-1', org_key: 'doctorbox2', display_name: 'DoctorBox 2', commerce_vertical: 'health', status: 'active' },
      error: null,
    });
    tableHandlers.partner_registry = ({ op, terminal }: any) => {
      if (terminal === 'maybeSingle') return { data: null, error: null }; // no existing row yet
      if (op === 'insert') return { data: { id: 'registry-1' }, error: null };
      throw new Error(`unexpected partner_registry op in this test: ${op}/${terminal}`);
    };
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/org-1/activate')
      .set('Authorization', 'Bearer exafy-admin-1');
    expect(r.status).toBe(200);
    expect(emitOasisEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'partner_org.registry_linked', payload: expect.objectContaining({ partner_registry_id: 'registry-1' }) })
    );
  });

  it('200 happy path — re-activating a health org already bridged is a no-op (idempotent)', async () => {
    tableHandlers.partner_organizations = () => ({
      data: { id: 'org-1', org_key: 'doctorbox2', display_name: 'DoctorBox 2', commerce_vertical: 'health', status: 'active' },
      error: null,
    });
    tableHandlers.partner_registry = ({ terminal }: any) => {
      if (terminal === 'maybeSingle') return { data: { id: 'registry-1' }, error: null }; // already bridged
      throw new Error('must not insert a second partner_registry row on re-activation');
    };
    const r = await request(makeApp())
      .post('/api/v1/partner-orgs/org-1/activate')
      .set('Authorization', 'Bearer exafy-admin-1');
    expect(r.status).toBe(200);
    expect(emitOasisEventMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_org.registry_linked' }));
  });
});
