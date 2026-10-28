/**
 * Admin Tenants & Settings (B2) + Signups & Invitations (B3) voice tools
 * (Wave 4) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  ADMIN_TENANTS_SIGNUPS_TOOL_HANDLERS,
  ADMIN_TENANTS_SIGNUPS_TOOL_DECLARATIONS,
  admin_list_tenants,
  admin_get_tenant,
  admin_set_feature_flag,
  admin_list_signups,
  admin_create_invitation,
  admin_revoke_invitation,
} from '../../src/services/orb-tools/admin-tenants-signups-tools';

const ADMIN_ID: OrbToolIdentity = { user_id: 'u-adm', tenant_id: 't-1', role: 'admin', user_jwt: 'jwt-abc' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'admin' };

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

describe('catalogue', () => {
  const names = Object.keys(ADMIN_TENANTS_SIGNUPS_TOOL_HANDLERS);

  it('exposes all 14 tools with matching declarations', () => {
    expect(names).toHaveLength(14);
    const declNames = ADMIN_TENANTS_SIGNUPS_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const r = await ADMIN_TENANTS_SIGNUPS_TOOL_HANDLERS[name](
      { tenant_id: 't-1', profile: {}, branding: {}, key: 'k', value: 'v', email: 'a@b.com', attempt_id: 'a1', invitation_id: 'i1' },
      COMMUNITY_ID,
      {} as SupabaseClient,
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('admin_role_required');
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await ADMIN_TENANTS_SIGNUPS_TOOL_HANDLERS[name]({}, ANON_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });
});

describe('admin_list_tenants / admin_get_tenant', () => {
  it('lists tenants', async () => {
    mockFetch(200, { tenants: [{ name: 'Acme' }] });
    const r = await admin_list_tenants({}, ADMIN_ID, {} as SupabaseClient);
    expect(r.text).toContain('Acme');
  });

  it('reports a missing tenant honestly', async () => {
    mockFetch(404, { error: 'NOT_FOUND' });
    const r = await admin_get_tenant({ tenant_id: 't-x' }, ADMIN_ID, {} as SupabaseClient);
    expect((r.result as { found: boolean }).found).toBe(false);
  });
});

describe('admin_set_feature_flag', () => {
  it('requires confirmation first', async () => {
    const r = await admin_set_feature_flag({ tenant_id: 't-1', key: 'beta', value: true }, ADMIN_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('reads-then-writes the merged feature_flags object', async () => {
    const fn = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ feature_flags: { existing: true } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    global.fetch = fn as unknown as typeof fetch;
    const r = await admin_set_feature_flag({ tenant_id: 't-1', key: 'beta', value: true, confirm: true }, ADMIN_ID, {} as SupabaseClient);
    expect(r.ok).toBe(true);
    const putCall = fn.mock.calls[1];
    const putBody = JSON.parse(putCall[1].body);
    expect(putBody.feature_flags).toEqual({ existing: true, beta: true });
  });
});

describe('admin_list_signups', () => {
  it('reports recent signups', async () => {
    mockFetch(200, { signups: [{ stage: 'completed' }] });
    const r = await admin_list_signups({}, ADMIN_ID, {} as SupabaseClient);
    expect(r.text).toContain('1 recent signups');
  });
});

describe('admin_create_invitation / admin_revoke_invitation', () => {
  it('admin_create_invitation requires confirmation first', async () => {
    const r = await admin_create_invitation({ tenant_id: 't-1', email: 'x@y.com' }, ADMIN_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('admin_create_invitation reports an already-invited conflict honestly', async () => {
    mockFetch(409, { error: 'ALREADY_INVITED' });
    const r = await admin_create_invitation({ tenant_id: 't-1', email: 'x@y.com', confirm: true }, ADMIN_ID, {} as SupabaseClient);
    expect((r.result as { reason: string }).reason).toBe('already_invited');
  });

  it('admin_revoke_invitation requires confirmation first', async () => {
    const r = await admin_revoke_invitation({ tenant_id: 't-1', invitation_id: 'i1' }, ADMIN_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});
