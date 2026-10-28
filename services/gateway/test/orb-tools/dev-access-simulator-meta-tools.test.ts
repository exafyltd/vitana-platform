/**
 * Developer Dev Access, Simulator & Meta voice tools (Wave 6, plan
 * section C12, final wave) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity, OrbToolResult } from '../../src/services/orb-tools-shared';
import {
  DEV_ACCESS_SIMULATOR_META_TOOL_HANDLERS,
  DEV_ACCESS_SIMULATOR_META_TOOL_DECLARATIONS,
  dev_list_dev_users,
  dev_grant_access,
  dev_revoke_access,
  dev_mint_token,
  dev_open_hub_panel,
  dev_run_simulator,
  dev_journey_context,
  dev_voice_catalog_stats,
  dev_get_voice_tool_detail,
  dev_system_briefing,
} from '../../src/services/orb-tools/dev-access-simulator-meta-tools';

const EXAFY_ID: OrbToolIdentity = { user_id: 'u-exafy', tenant_id: 't-1', role: 'exafy_admin', user_jwt: 'jwt-xyz' };
const DEV_ID: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer', user_jwt: 'jwt-dev' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'developer' };

const realFetch = global.fetch;
const realEnv = { ...process.env };
afterEach(() => {
  global.fetch = realFetch;
  process.env = { ...realEnv };
  jest.clearAllMocks();
});

function mockFetch(status: number, body: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('catalogue', () => {
  const names = Object.keys(DEV_ACCESS_SIMULATOR_META_TOOL_HANDLERS);

  it('exposes all 10 tools with matching declarations', () => {
    expect(names).toHaveLength(10);
    const declNames = DEV_ACCESS_SIMULATOR_META_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await DEV_ACCESS_SIMULATOR_META_TOOL_HANDLERS[name](
      { email: 'a@b.com', role: 'developer', user_id: 'u1', name: 'dev_list_dev_users', screen_id: 'DEVHUB.OVERVIEW.SYSTEM_OVERVIEW' },
      ANON_ID,
      {} as SupabaseClient,
    );
    expect(r.ok).toBe(false);
  });
});

describe('exafy_admin-only tools reject a plain developer', () => {
  it.each(['dev_list_dev_users', 'dev_grant_access', 'dev_revoke_access', 'dev_mint_token', 'dev_run_simulator', 'dev_journey_context'])('%s', async (name) => {
    const r = await DEV_ACCESS_SIMULATOR_META_TOOL_HANDLERS[name](
      { email: 'a@b.com', role: 'developer', user_id: 'u1' },
      DEV_ID,
      {} as SupabaseClient,
    );
    expect(r.ok).toBe(false);
  });
});

describe('dev_list_dev_users', () => {
  it('lists users', async () => {
    mockFetch(200, { users: [{ email: 'a@b.com' }] });
    const r = await dev_list_dev_users({}, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('a@b.com');
  });
});

describe('dev_grant_access / dev_revoke_access', () => {
  it('grant requires confirmation first', async () => {
    const r = await dev_grant_access({ email: 'a@b.com' }, EXAFY_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('revoke surfaces SELF_REVOKE_FORBIDDEN honestly', async () => {
    mockFetch(400, { error: 'SELF_REVOKE_FORBIDDEN' });
    const r = await dev_revoke_access({ email: 'a@b.com', confirm: true }, EXAFY_ID, {} as SupabaseClient);
    expect((r.result as { reason: string }).reason).toBe('self_revoke_forbidden');
  });
});

describe('dev_mint_token', () => {
  it('validates role', async () => {
    const r = await dev_mint_token({ email: 'a@b.com', role: 'bogus' }, EXAFY_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('requires confirmation first', async () => {
    const r = await dev_mint_token({ email: 'a@b.com', role: 'developer' }, EXAFY_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('reports no_dev_secret honestly when unconfigured', async () => {
    delete process.env.DEV_AUTH_SECRET;
    const r = await dev_mint_token({ email: 'a@b.com', role: 'developer', confirm: true }, EXAFY_ID, {} as SupabaseClient);
    expect((r.result as { reason: string }).reason).toBe('no_dev_secret');
  });

  it('surfaces DEV_AUTH_DISABLED honestly outside dev-sandbox', async () => {
    process.env.DEV_AUTH_SECRET = 'shh';
    mockFetch(403, { error: 'DEV_AUTH_DISABLED' });
    const r = await dev_mint_token({ email: 'a@b.com', role: 'developer', confirm: true }, EXAFY_ID, {} as SupabaseClient);
    expect((r.result as { reason: string }).reason).toBe('not_dev_sandbox');
  });
});

describe('dev_open_hub_panel', () => {
  it('requires screen_id', async () => {
    const r = await dev_open_hub_panel({}, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('delegates to navigation (not an unknown-screen error) for a real screen_id', async () => {
    const r = await dev_open_hub_panel({ screen_id: 'DEVHUB.OVERVIEW.SYSTEM_OVERVIEW' }, DEV_ID, {} as SupabaseClient);
    if (!r.ok) expect(r.error).not.toContain('Unknown screen_id');
  });
});

describe('dev_run_simulator', () => {
  it('requires user_id', async () => {
    const r = await dev_run_simulator({}, EXAFY_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('reports the simulated register', async () => {
    mockFetch(200, { data: { register: 'continue', chosen_nba: null } });
    const r = await dev_run_simulator({ user_id: 'u1' }, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('continue');
  });
});

describe('dev_journey_context', () => {
  it('requires user_id', async () => {
    const r = await dev_journey_context({}, EXAFY_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('handles no stored signals', async () => {
    mockFetch(200, { rows: [] });
    const r = await dev_journey_context({ user_id: 'u1' }, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('No durable assistant-state signals');
  });
});

describe('dev_voice_catalog_stats / dev_get_voice_tool_detail', () => {
  it('reports catalog stats', async () => {
    mockFetch(200, { total: 594, by_status: { live: 300, planned: 294 } });
    const r = await dev_voice_catalog_stats({}, DEV_ID, {} as SupabaseClient);
    expect(r.text).toContain('594 voice tools');
  });

  it('reports 404 honestly for an unknown tool name', async () => {
    mockFetch(404, { error: 'tool_not_found' });
    const r = await dev_get_voice_tool_detail({ name: 'ghost_tool' }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { found: boolean }).found).toBe(false);
  });
});

describe('dev_system_briefing', () => {
  it('composites all 5 sub-tool texts', async () => {
    mockFetch(200, { status: 'green' });
    const r = await dev_system_briefing({}, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(true);
    expect(typeof (r as Extract<OrbToolResult, { ok: true }>).text).toBe('string');
  });
});
