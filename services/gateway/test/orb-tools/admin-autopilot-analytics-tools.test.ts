/**
 * Admin Autopilot Admin (B13) + Analytics & Intent Engine (B14) voice tools
 * (Wave 4) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  ADMIN_AUTOPILOT_ANALYTICS_TOOL_HANDLERS,
  ADMIN_AUTOPILOT_ANALYTICS_TOOL_DECLARATIONS,
  admin_get_autopilot_settings,
  admin_update_autopilot_settings,
  admin_analytics_summary,
  admin_intent_engine_stats,
  admin_close_intent,
  admin_resolve_dispute,
  admin_archive_intent,
} from '../../src/services/orb-tools/admin-autopilot-analytics-tools';

const EXAFY_ID: OrbToolIdentity = { user_id: 'u-exafy', tenant_id: 't-1', role: 'exafy_admin', user_jwt: 'jwt-xyz' };
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
  const names = Object.keys(ADMIN_AUTOPILOT_ANALYTICS_TOOL_HANDLERS);

  it('exposes all 18 tools with matching declarations', () => {
    expect(names).toHaveLength(18);
    const declNames = ADMIN_AUTOPILOT_ANALYTICS_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const r = await ADMIN_AUTOPILOT_ANALYTICS_TOOL_HANDLERS[name](
      { automation_id: 'a1', binding_id: 'b1', wave_id: 'w1', intent_id: 'i1', dispute_id: 'd1', status: 'resolved', resolution: 'resolved cleanly' },
      COMMUNITY_ID,
      {} as SupabaseClient,
    );
    expect(r.ok).toBe(false);
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await ADMIN_AUTOPILOT_ANALYTICS_TOOL_HANDLERS[name]({}, ANON_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });
});

describe('admin_get_autopilot_settings / admin_update_autopilot_settings', () => {
  it('reports enabled state', async () => {
    mockFetch(200, { data: { enabled: true } });
    const r = await admin_get_autopilot_settings({}, ADMIN_ID, {} as SupabaseClient);
    expect(r.text).toContain('enabled');
  });

  it('update requires at least one field', async () => {
    const r = await admin_update_autopilot_settings({}, ADMIN_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('update requires confirmation first', async () => {
    const r = await admin_update_autopilot_settings({ enabled: false }, ADMIN_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});

describe('admin_analytics_summary', () => {
  it('is available to a plain admin (tenant-scoped)', async () => {
    mockFetch(200, { ok: true, days: 30 });
    const r = await admin_analytics_summary({}, ADMIN_ID, {} as SupabaseClient);
    expect(r.ok).toBe(true);
  });
});

describe('admin_intent_engine_stats (exafy_admin only)', () => {
  it('rejects a plain admin session', async () => {
    const r = await admin_intent_engine_stats({}, ADMIN_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('exafy_admin');
  });

  it('reports stats for exafy_admin', async () => {
    mockFetch(200, { stats: { open_intents: 5, total_matches: 20, stuck_open_24h: 1 } });
    const r = await admin_intent_engine_stats({}, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('5 open intents');
  });
});

describe('admin_close_intent', () => {
  it('requires confirmation first', async () => {
    const r = await admin_close_intent({ intent_id: 'i1' }, EXAFY_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});

describe('admin_resolve_dispute', () => {
  it('validates status and resolution length', async () => {
    const r = await admin_resolve_dispute({ dispute_id: 'd1', status: 'bogus', resolution: 'ok' }, EXAFY_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('requires confirmation for a valid request', async () => {
    const r = await admin_resolve_dispute({ dispute_id: 'd1', status: 'resolved', resolution: 'Verified with both parties' }, EXAFY_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});

describe('admin_archive_intent', () => {
  it('requires confirmation and describes it as a batch job', async () => {
    const r = await admin_archive_intent({}, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('batch job');
  });

  it('archives on confirm', async () => {
    mockFetch(200, { archived: 42, remaining: 3 });
    const r = await admin_archive_intent({ confirm: true }, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('42');
  });
});
