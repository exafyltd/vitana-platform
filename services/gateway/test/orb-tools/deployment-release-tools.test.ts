/**
 * Deployment & Release voice tools (Wave 2, plan section C4) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  DEPLOYMENT_RELEASE_TOOL_HANDLERS,
  DEPLOYMENT_RELEASE_TOOL_DECLARATIONS,
  dev_deploy_service,
  dev_publish_to_prod,
  dev_list_revisions,
  dev_list_deployments,
  dev_promote_canary,
  dev_compare_staging_prod,
} from '../../src/services/orb-tools/deployment-release-tools';

const DEV_ID: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer', user_jwt: 'jwt-abc' };
const DEV_ID_NO_JWT: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'developer' };

function makeSb(): SupabaseClient {
  return {} as unknown as SupabaseClient;
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
});

function mockFetch(status: number, body: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('deployment-release role gate', () => {
  const names = Object.keys(DEPLOYMENT_RELEASE_TOOL_HANDLERS);

  it('exposes all 13 tools with matching declarations', () => {
    expect(names).toHaveLength(13);
    const declNames = DEPLOYMENT_RELEASE_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const args = {
      vtid: 'VTID-0001', service: 'gateway', reason: 'incident fix', target_revision: 'gateway-00001-abc',
    };
    const r = await DEPLOYMENT_RELEASE_TOOL_HANDLERS[name](args, COMMUNITY_ID, makeSb());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('developer_role_required');
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await DEPLOYMENT_RELEASE_TOOL_HANDLERS[name]({}, ANON_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

describe('dev_deploy_service', () => {
  it('refuses production (must use dev_publish_to_prod)', async () => {
    const r = await dev_deploy_service({ vtid: 'VTID-1', service: 'gateway', environment: 'production' }, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('dev_publish_to_prod');
  });

  it('requires confirmation for staging', async () => {
    const r = await dev_deploy_service({ vtid: 'VTID-1', service: 'gateway' }, DEV_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });
});

describe('dev_publish_to_prod', () => {
  it('requires a reason', async () => {
    const r = await dev_publish_to_prod({}, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires the first confirmation', async () => {
    const r = await dev_publish_to_prod({ reason: 'hotfix' }, DEV_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean; step: number } }).result.step).toBe(1);
  });

  it('requires the second confirmation', async () => {
    const r = await dev_publish_to_prod({ reason: 'hotfix', confirm: true }, DEV_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean; step: number } }).result.step).toBe(2);
  });

  it('refuses without an admin session even after double confirm', async () => {
    const r = await dev_publish_to_prod({ reason: 'hotfix', confirm: true, confirm_again: true }, DEV_ID_NO_JWT, makeSb());
    expect((r.result as { reason: string }).reason).toBe('no_admin_session');
  });

  it('publishes after both confirms with an admin session', async () => {
    mockFetch(200, { ok: true });
    const r = await dev_publish_to_prod({ reason: 'hotfix', confirm: true, confirm_again: true }, DEV_ID, makeSb());
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Published to production');
    const calls = (global.fetch as jest.Mock).mock.calls;
    const publishCall = calls.find((c) => String(c[0]).includes('/operator/publish'));
    expect(publishCall).toBeDefined();
    expect((publishCall![1].headers as Record<string, string>).Authorization).toBe('Bearer jwt-abc');
  });
});

describe('dev_list_revisions', () => {
  it('refuses without an admin session', async () => {
    const r = await dev_list_revisions({}, DEV_ID_NO_JWT, makeSb());
    expect((r.result as { reason: string }).reason).toBe('no_admin_session');
  });

  it('rejects an unknown service', async () => {
    const r = await dev_list_revisions({ service: 'nonsense' }, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('speaks revisions with an admin session', async () => {
    mockFetch(200, { ok: true, revisions: [{ name: 'gateway-00001-abc', is_active: true }] });
    const r = await dev_list_revisions({ service: 'gateway' }, DEV_ID, makeSb());
    expect(r.text).toContain('gateway-00001-abc');
  });
});

describe('dev_list_deployments', () => {
  it('reports no deployments honestly', async () => {
    mockFetch(200, { ok: true, deployments: [] });
    const r = await dev_list_deployments({}, DEV_ID, makeSb());
    expect(r.text).toContain('No deployments');
  });
});

describe('dev_promote_canary', () => {
  it('requires confirmation', async () => {
    const r = await dev_promote_canary({}, DEV_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });

  it('refuses without an admin session', async () => {
    const r = await dev_promote_canary({ confirm: true }, DEV_ID_NO_JWT, makeSb());
    expect((r.result as { reason: string }).reason).toBe('no_admin_session');
  });
});

describe('dev_compare_staging_prod', () => {
  it('reports the same commit as matching', async () => {
    mockFetch(200, { ok: true, deployments: [{ commit_sha: 'abc1234', created_at: new Date().toISOString() }] });
    const r = await dev_compare_staging_prod({}, DEV_ID, makeSb());
    expect(r.ok).toBe(true);
    expect(r.text).toContain('same commit');
  });
});
