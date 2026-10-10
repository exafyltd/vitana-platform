/**
 * VTID-05048 (Track S / S4, PR-B — S-I): caller identity + header hardening.
 *
 * Before this change:
 *   - POST /api/v1/governance/controls/:key took the actor and role from
 *     x-user-id / x-user-role, the role defaulted to 'operator' (allowed), so
 *     an unauthenticated POST with no headers flipped a system control.
 *   - POST /api/v1/specs/:vtid/approve had no auth and took the actor from
 *     the same headers, writing spec_status='approved'.
 *   - governance reads, reminders and automations member routes took the
 *     tenant from caller-supplied headers / body / DEFAULT_TENANT_ID.
 *   - the ORB control tools sent a spoofed x-user-role:'admin'.
 *
 * This suite pins the new contract: service token or exafy_admin JWT for the
 * two writes (actor from the credential only), tenant from the verified
 * identity only, and the ORB tools on the service header + caller label.
 */

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';

const SERVICE_TOKEN = 'svc-token-05048';
const ADMIN_UID = '0b9c1f6e-1111-4222-8333-944445555666';
const TENANT_ADMIN_UID = '7d1e2f3a-aaaa-4bbb-8ccc-ddddeeeeffff';

process.env.GATEWAY_SERVICE_TOKEN = SERVICE_TOKEN;
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'supabase-svc';

// ---------------------------------------------------------------------------
// Auth stand-in: bearer 'exafy' → exafy_admin; 'tenant-admin' → signed-in,
// not exafy; 'member-notenant' → signed-in, no tenant in the JWT; anything
// else → no identity. requireTenant stays the real one.
// ---------------------------------------------------------------------------
function identityFor(auth: string | undefined): any {
  if (auth === 'Bearer exafy') return { user_id: ADMIN_UID, tenant_id: 't-admin', exafy_admin: true };
  if (auth === 'Bearer tenant-admin') return { user_id: TENANT_ADMIN_UID, tenant_id: 't-jwt', exafy_admin: false };
  if (auth === 'Bearer member-notenant') return { user_id: 'member-1', tenant_id: null, exafy_admin: false };
  return null;
}

jest.mock('../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../src/middleware/auth-supabase-jwt');
  return {
    ...actual,
    optionalAuth: (req: any, _res: any, next: any) => {
      const id = identityFor(req.get('Authorization'));
      if (id) req.identity = id;
      next();
    },
    requireAuth: (req: any, res: any, next: any) => {
      const id = identityFor(req.get('Authorization'));
      if (!id) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      req.identity = id;
      return next();
    },
  };
});

const mockFetchPrimaryTenant = jest.fn();
jest.mock('../src/middleware/auth-supabase-jwt-repository', () => ({
  fetchPrimaryTenantForUser: (...a: any[]) => mockFetchPrimaryTenant(...a),
  fetchVitanaIdForUser: async () => ({ data: null, error: null }),
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({}) }));

const mockUpdateSystemControl = jest.fn();
jest.mock('../src/services/system-controls-service', () => ({
  getAllSystemControls: async () => [{ key: 'k', enabled: true }],
  getSystemControl: async () => null,
  updateSystemControl: (...a: any[]) => mockUpdateSystemControl(...a),
  getControlAuditHistory: async () => [],
}));

jest.mock('../src/services/oasis-event-service', () => ({
  ...jest.requireActual('../src/services/oasis-event-service'),
  emitOasisEvent: jest.fn(async () => ({ ok: true })),
}));

const mockCreateReminder = jest.fn();
jest.mock('../src/services/reminders-service', () => ({
  ...jest.requireActual('../src/services/reminders-service'),
  createReminder: (...a: any[]) => mockCreateReminder(...a),
}));

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({})) }));
const mockInsertSharingLink = jest.fn();
jest.mock('../src/routes/automations-repository', () => ({
  ...jest.requireActual('../src/routes/automations-repository'),
  insertSharingLink: (...a: any[]) => mockInsertSharingLink(...a),
}));

import governanceControlsRouter, { resolveControlActor } from '../src/routes/governance-controls';
import { specsRouter } from '../src/routes/specs';
import remindersRouter from '../src/routes/reminders';
import automationsRouter from '../src/routes/automations';
import { GovernanceController } from '../src/controllers/governance-controller';
import { admin_set_control_key, admin_governance_status } from '../src/services/orb-tools/admin-governance-tools';
import { dev_set_control } from '../src/services/orb-tools/governance-tools';

function app(mount: string, router: any) {
  const a = express();
  a.use(express.json());
  a.use(mount, router);
  return a;
}

const realFetch = global.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock = jest.fn();
  (global as any).fetch = fetchMock;
  mockUpdateSystemControl.mockResolvedValue({ ok: true, control: { key: 'k', enabled: false }, audit_id: 'a1' });
});
afterAll(() => {
  (global as any).fetch = realFetch;
});

// ===========================================================================
// I3 — POST /api/v1/governance/controls/:key
// ===========================================================================
describe('I3 governance controls write', () => {
  const ctl = () => app('/api/v1/governance/controls', governanceControlsRouter);
  const body = { enabled: false, reason: 'test' };

  it('401 with no auth and no headers (old code: role defaulted to operator and the write went through)', async () => {
    const res = await request(ctl()).post('/api/v1/governance/controls/__s4_probe_nonexistent__');
    expect(res.status).toBe(401);
    expect(mockUpdateSystemControl).not.toHaveBeenCalled();
  });

  it('401 with spoofed x-user-id / x-user-role:admin headers', async () => {
    const res = await request(ctl())
      .post('/api/v1/governance/controls/k')
      .set('x-user-id', ADMIN_UID)
      .set('x-user-role', 'admin')
      .send(body);
    expect(res.status).toBe(401);
    expect(mockUpdateSystemControl).not.toHaveBeenCalled();
  });

  it('403 for a signed-in tenant admin (not exafy_admin)', async () => {
    const res = await request(ctl()).post('/api/v1/governance/controls/k').set('Authorization', 'Bearer tenant-admin').send(body);
    expect(res.status).toBe(403);
    expect(mockUpdateSystemControl).not.toHaveBeenCalled();
  });

  it('200 for an exafy_admin JWT; actor admin:<uid>, spoofed headers ignored', async () => {
    const res = await request(ctl())
      .post('/api/v1/governance/controls/k')
      .set('Authorization', 'Bearer exafy')
      .set('x-user-id', 'someone-else')
      .set('x-user-role', 'operator')
      .set('x-orb-caller-user-id', 'not-a-service-call')
      .send({ enabled: true, reason: 'arm' });
    expect(res.status).toBe(200);
    expect(mockUpdateSystemControl).toHaveBeenCalledWith('k', expect.objectContaining({
      enabled: true,
      updated_by: `admin:${ADMIN_UID}`,
      updated_by_role: 'exafy_admin',
      duration_minutes: null,
    }));
  });

  it('200 for the service token; actor service:internal', async () => {
    const res = await request(ctl()).post('/api/v1/governance/controls/k').set('Authorization', `Bearer ${SERVICE_TOKEN}`).send(body);
    expect(res.status).toBe(200);
    expect(mockUpdateSystemControl).toHaveBeenCalledWith('k', expect.objectContaining({
      updated_by: 'service:internal',
      updated_by_role: 'service',
    }));
  });

  it('service token + x-orb-caller-user-id records service:internal/orb:<user_id>', async () => {
    await request(ctl())
      .post('/api/v1/governance/controls/k')
      .set('Authorization', `Bearer ${SERVICE_TOKEN}`)
      .set('x-orb-caller-user-id', ADMIN_UID)
      .send(body);
    expect(mockUpdateSystemControl).toHaveBeenCalledWith('k', expect.objectContaining({
      updated_by: `service:internal/orb:${ADMIN_UID}`,
    }));
  });

  it('a malformed ORB caller label is dropped, not recorded', () => {
    const req: any = { __control_plane_actor: 'service:internal', get: () => 'x; drop table' };
    expect(resolveControlActor(req)).toEqual({ userId: 'service:internal', role: 'service' });
  });

  it('GET list stays open (Command Hub reads without a token)', async () => {
    const res = await request(ctl()).get('/api/v1/governance/controls');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ===========================================================================
// I4 — POST /api/v1/specs/:vtid/approve
// ===========================================================================
describe('I4 spec approval', () => {
  const specs = () => app('/api/v1/specs', specsRouter);

  function mockLedger() {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (!init?.method && url.includes('/vtid_ledger?')) {
        return { ok: true, json: async () => [{ vtid: 'VTID-00001', spec_status: 'quality_checked', spec_current_id: 'spec-1', spec_current_hash: 'h1' }] };
      }
      if (init?.method === 'POST' && url.includes('oasis_spec_approvals')) {
        return { ok: true, json: async () => [{ id: 'appr-1' }] };
      }
      return { ok: true, json: async () => ({}) };
    });
  }
  const approvalBody = () => {
    const call = fetchMock.mock.calls.find(([u, i]: any[]) => i?.method === 'POST' && String(u).includes('oasis_spec_approvals'));
    return call ? JSON.parse(call[1].body) : null;
  };
  const ledgerPatch = () => {
    const call = fetchMock.mock.calls.find(([u, i]: any[]) => i?.method === 'PATCH' && String(u).includes('vtid_ledger'));
    return call ? JSON.parse(call[1].body) : null;
  };

  it('401 with no auth (old code: 404/200 with no gate) and no DB call', async () => {
    const res = await request(specs()).post('/api/v1/specs/VTID-00000/approve');
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('401 with spoofed x-user-id / x-user-role headers', async () => {
    const res = await request(specs()).post('/api/v1/specs/VTID-00001/approve').set('x-user-id', ADMIN_UID).set('x-user-role', 'admin');
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('403 for a tenant admin JWT', async () => {
    const res = await request(specs()).post('/api/v1/specs/VTID-00001/approve').set('Authorization', 'Bearer tenant-admin');
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('200 for exafy_admin; actor admin:<uid> / exafy_admin, headers ignored', async () => {
    mockLedger();
    const res = await request(specs())
      .post('/api/v1/specs/VTID-00001/approve')
      .set('Authorization', 'Bearer exafy')
      .set('x-user-id', 'spoofed')
      .set('x-user-role', 'operator');
    expect(res.status).toBe(200);
    expect(approvalBody()).toMatchObject({ approved_by: `admin:${ADMIN_UID}`, approved_role: 'exafy_admin' });
    expect(ledgerPatch()).toMatchObject({ spec_status: 'approved', spec_approved_by: `admin:${ADMIN_UID}` });
  });

  it('200 for the service token; actor service:<approved_by>', async () => {
    mockLedger();
    const res = await request(specs())
      .post('/api/v1/specs/VTID-00001/approve')
      .set('Authorization', `Bearer ${SERVICE_TOKEN}`)
      .send({ approved_by: 'developer_assistant' });
    expect(res.status).toBe(200);
    expect(approvalBody()).toMatchObject({ approved_by: 'service:developer_assistant', approved_role: 'service' });
  });

  it('service token with no / malformed approved_by records service:internal', async () => {
    mockLedger();
    await request(specs())
      .post('/api/v1/specs/VTID-00001/approve')
      .set('Authorization', `Bearer ${SERVICE_TOKEN}`)
      .send({ approved_by: '<script>' });
    expect(approvalBody()).toMatchObject({ approved_by: 'service:internal', approved_role: 'service' });
  });
});

// ===========================================================================
// I2 — governance tenant from x-tenant-id / ?tenantId
// ===========================================================================
describe('I2 governance tenant', () => {
  const c = new GovernanceController();
  const req = (headers: Record<string, string>, identity?: any): any => ({
    headers,
    query: {},
    identity,
    header: (n: string) => headers[n.toLowerCase()],
  });

  it('anonymous caller: x-tenant-id ignored → SYSTEM', () => {
    expect(c.getTenantId(req({ 'x-tenant-id': 'evil' }))).toBe('SYSTEM');
  });
  it('signed-in non-exafy caller: x-tenant-id ignored → SYSTEM', () => {
    expect(c.getTenantId(req({ 'x-tenant-id': 'evil', authorization: 'Bearer tenant-admin' }, identityFor('Bearer tenant-admin')))).toBe('SYSTEM');
  });
  it('exafy_admin may name the tenant', () => {
    expect(c.getTenantId(req({ 'x-tenant-id': 't-x' }, identityFor('Bearer exafy')))).toBe('t-x');
  });
  it('service token may name the tenant', () => {
    expect(c.getTenantId(req({ 'x-tenant-id': 't-x', authorization: `Bearer ${SERVICE_TOKEN}` }))).toBe('t-x');
  });
});

// ===========================================================================
// I5 — reminders tenant
// ===========================================================================
describe('I5 reminders tenant', () => {
  const rem = () => app('/api/v1/reminders', remindersRouter);
  const payload = { action_text: 'drink water', scheduled_for_iso: '2030-01-01T10:00:00Z' };

  beforeEach(() => mockCreateReminder.mockResolvedValue({ id: 'r1' }));

  it('JWT without tenant: X-Tenant-ID / X-Vitana-Tenant ignored, primary user_tenants row used', async () => {
    mockFetchPrimaryTenant.mockResolvedValue({ data: { tenant_id: 'tenant-primary' }, error: null });
    await request(rem())
      .post('/api/v1/reminders')
      .set('Authorization', 'Bearer member-notenant')
      .set('X-Tenant-ID', 'evil')
      .set('X-Vitana-Tenant', 'evil2')
      .send(payload);
    expect(mockCreateReminder).toHaveBeenCalledTimes(1);
    expect(mockCreateReminder.mock.calls[0][1]).toMatchObject({ user_id: 'member-1', tenant_id: 'tenant-primary' });
  });

  it('no tenant anywhere → 400 TENANT_REQUIRED, never DEFAULT_TENANT_ID', async () => {
    process.env.DEFAULT_TENANT_ID = 'default-tenant';
    mockFetchPrimaryTenant.mockResolvedValue({ data: null, error: null });
    const res = await request(rem())
      .post('/api/v1/reminders')
      .set('Authorization', 'Bearer member-notenant')
      .set('X-Tenant-ID', 'evil')
      .send(payload);
    delete process.env.DEFAULT_TENANT_ID;
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TENANT_REQUIRED');
    expect(mockCreateReminder).not.toHaveBeenCalled();
  });

  it('JWT tenant wins over the header', async () => {
    await request(rem()).post('/api/v1/reminders').set('Authorization', 'Bearer tenant-admin').set('X-Tenant-ID', 'evil').send(payload);
    expect(mockCreateReminder.mock.calls[0][1]).toMatchObject({ tenant_id: 't-jwt' });
  });
});

// ===========================================================================
// I6 / F3 — automations member routes
// ===========================================================================
describe('I6 automations member routes', () => {
  const auto = () => app('/api/v1/automations', automationsRouter);

  it('anonymous → 401 on every member route (explicit requireAuth)', async () => {
    for (const [m, u] of [
      ['get', '/wallet/balance'], ['get', '/wallet/transactions'], ['post', '/sharing/generate-link'],
      ['get', '/sharing/links'], ['get', '/referrals'],
    ] as const) {
      const res = await (request(auto()) as any)[m](`/api/v1/automations${u}`).send({ tenant_id: 'evil' });
      expect(res.status).toBe(401);
    }
  });

  it('body tenant_id is ignored for members — the JWT tenant is used', async () => {
    process.env.SUPABASE_SERVICE_ROLE = 'supabase-svc';
    mockInsertSharingLink.mockResolvedValue({ data: { id: 'l1' }, error: null });
    const res = await request(auto())
      .post('/api/v1/automations/sharing/generate-link')
      .set('Authorization', 'Bearer tenant-admin')
      .send({ tenant_id: 'evil', target_type: 'event', target_id: 'e1' });
    expect(res.status).toBe(200);
    expect(mockInsertSharingLink.mock.calls[0][1]).toMatchObject({ tenant_id: 't-jwt', user_id: TENANT_ADMIN_UID });
  });

  it('member without a JWT tenant: body tenant_id and DEFAULT_TENANT_ID are NOT used', async () => {
    process.env.DEFAULT_TENANT_ID = 'default-tenant';
    const res = await request(auto())
      .post('/api/v1/automations/sharing/generate-link')
      .set('Authorization', 'Bearer member-notenant')
      .send({ tenant_id: 'evil', target_type: 'event', target_id: 'e1' });
    delete process.env.DEFAULT_TENANT_ID;
    expect(res.status).toBe(401);
    expect(mockInsertSharingLink).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// ORB tools — admin_set_control_key / dev_set_control
// ===========================================================================
describe('ORB control tools', () => {
  const exafyId = { user_id: ADMIN_UID, tenant_id: 't', role: 'exafy_admin' };
  const tenantAdminId = { user_id: TENANT_ADMIN_UID, tenant_id: 't', role: 'admin' };
  const args = { key: 'k', enabled: false, reason: 'r', confirm: true };

  beforeEach(() => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
  });

  for (const [name, tool] of [['admin_set_control_key', admin_set_control_key], ['dev_set_control', dev_set_control]] as const) {
    it(`${name}: sends the service bearer + x-orb-caller-user-id, never x-user-id / x-user-role`, async () => {
      const r = await (tool as any)(args, exafyId, {});
      expect(r.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
      expect(headers['x-orb-caller-user-id']).toBe(ADMIN_UID);
      expect(headers).not.toHaveProperty('x-user-role');
      expect(headers).not.toHaveProperty('x-user-id');
    });

    it(`${name}: a tenant admin is refused before any gateway call`, async () => {
      const r = await (tool as any)(args, tenantAdminId, {});
      expect(r.ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('admin_governance_status reads with no spoofed role header', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, data: [] }) });
    await admin_governance_status({}, exafyId as any, {} as any);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty('x-user-role');
  });
});

// ===========================================================================
// Source guards — callers that cannot be exercised in-process here
// ===========================================================================
describe('source guards', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

  it('dev_approve_spec (gemini-operator) sends the gateway service token, not the Supabase key', () => {
    const src = read('services/gateway/src/services/gemini-operator.ts');
    const fn = src.slice(src.indexOf('async function executeDevApproveSpec'), src.indexOf('async function executeDevApproveSpec') + 1500);
    expect(fn).toContain('gatewayServiceAuthHeader()');
    expect(fn).not.toMatch(/Authorization:\s*`Bearer \$\{SUPABASE_SERVICE_ROLE\}`/);
  });

  it('no gateway route reads x-user-role for governance controls or spec approval', () => {
    expect(read('services/gateway/src/routes/governance-controls.ts')).not.toMatch(/headers\['x-user-(id|role)'\]/);
    const specs = read('services/gateway/src/routes/specs.ts');
    const approve = specs.slice(specs.indexOf("router.post('/:vtid/approve'"), specs.indexOf("router.post('/:vtid/approve'") + 600);
    expect(approve).toContain('requireServiceOrAdmin');
    expect(approve).not.toMatch(/x-user-(id|role)/);
  });

  it('OPS-TOGGLE-FLOW-V3-STAGING.yml authenticates with the service bearer, not header spoofing', () => {
    const wf = read('.github/workflows/OPS-TOGGLE-FLOW-V3-STAGING.yml');
    expect(wf).toContain('Authorization: Bearer ${GATEWAY_SERVICE_TOKEN}');
    expect(wf).toContain('secrets.GATEWAY_SERVICE_TOKEN');
    expect(wf).not.toMatch(/-H '?x-user-(id|role)/i);
  });

  it('autopilot-prompts no longer reads x-tenant-id or the 1111… default', () => {
    const src = read('services/gateway/src/routes/autopilot-prompts.ts');
    expect(src).not.toContain("headers['x-tenant-id']");
    expect(src).not.toContain('11111111-1111-1111-1111-111111111111');
  });
});
