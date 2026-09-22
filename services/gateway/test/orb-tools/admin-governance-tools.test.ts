/**
 * Admin Governance & Controls voice tools (Wave 3, plan section B12) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  ADMIN_GOVERNANCE_TOOL_HANDLERS,
  ADMIN_GOVERNANCE_TOOL_DECLARATIONS,
  admin_governance_status,
  admin_get_control_key,
  admin_set_control_key,
  admin_create_proposal,
} from '../../src/services/orb-tools/admin-governance-tools';

const ADMIN_ID: OrbToolIdentity = { user_id: 'u-adm', tenant_id: 't-1', role: 'admin' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'admin' };

function makeSb(): SupabaseClient {
  return {} as unknown as SupabaseClient;
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
});

function mockFetch(status: number, body: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('admin governance role gate', () => {
  const names = Object.keys(ADMIN_GOVERNANCE_TOOL_HANDLERS);

  it('exposes all 8 tools with matching declarations', () => {
    expect(names).toHaveLength(8);
    const declNames = ADMIN_GOVERNANCE_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const args = { key: 'x', enabled: true, reason: 'r', type: 'New Rule', proposed_rule: 'p', proposal_id: 'P1', status: 'Approved' };
    const r = await ADMIN_GOVERNANCE_TOOL_HANDLERS[name](args, COMMUNITY_ID, makeSb());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('admin_role_required');
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await ADMIN_GOVERNANCE_TOOL_HANDLERS[name]({}, ANON_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

describe('admin_set_control_key', () => {
  it('requires key and reason', async () => {
    const r = await admin_set_control_key({ key: 'x', enabled: true }, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation', async () => {
    const r = await admin_set_control_key({ key: 'x', enabled: true, reason: 'incident' }, ADMIN_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });

  it('sets the control after confirm=true', async () => {
    mockFetch(200, { ok: true });
    const r = await admin_set_control_key({ key: 'x', enabled: false, reason: 'incident', confirm: true }, ADMIN_ID, makeSb());
    expect(r.text).toContain('disabled');
  });
});

describe('admin_create_proposal', () => {
  it('validates type', async () => {
    const r = await admin_create_proposal({ type: 'bogus', proposed_rule: 'x' }, ADMIN_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VTID-04279: governance-controls.ts now requires a real exafy_admin
// bearer JWT (requireAdminAuth). Previously adminHeaders() sent
// x-user-id/x-user-role, which that route trusted with no signature
// verification at all — confirm the control-key tools now forward the
// caller's own user_jwt instead, and never the old spoofable headers.
// ---------------------------------------------------------------------------

describe('governance-controls self-call — real bearer auth (VTID-04279)', () => {
  const JWT_ID: OrbToolIdentity = { user_id: 'u-adm', tenant_id: 't-1', role: 'admin', user_jwt: 'signed.jwt.token' };

  it('admin_governance_status forwards Authorization: Bearer <user_jwt>, never x-user-role', async () => {
    const fetchFn = mockFetch(200, { ok: true, data: [] });
    await admin_governance_status({}, JWT_ID, makeSb());
    const headers = fetchFn.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer signed.jwt.token');
    expect(headers['x-user-role']).toBeUndefined();
    expect(headers['x-user-id']).toBeUndefined();
  });

  it('admin_get_control_key forwards Authorization: Bearer <user_jwt>', async () => {
    const fetchFn = mockFetch(200, { ok: true, data: { enabled: true } });
    await admin_get_control_key({ key: 'x' }, JWT_ID, makeSb());
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer signed.jwt.token');
  });

  it('admin_set_control_key forwards Authorization: Bearer <user_jwt> on the write call', async () => {
    const fetchFn = mockFetch(200, { ok: true });
    await admin_set_control_key({ key: 'x', enabled: true, reason: 'incident', confirm: true }, JWT_ID, makeSb());
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer signed.jwt.token');
  });

  it('sends no Authorization header (never x-user-role) when the identity has no user_jwt', async () => {
    const fetchFn = mockFetch(200, { ok: true, data: [] });
    await admin_governance_status({}, ADMIN_ID, makeSb());
    const headers = fetchFn.mock.calls[0][1].headers;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['x-user-role']).toBeUndefined();
  });
});
