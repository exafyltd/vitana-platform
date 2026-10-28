/**
 * Developer Self-Healing voice tools (Wave 5, plan section C8) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  SELF_HEALING_TOOL_HANDLERS,
  SELF_HEALING_TOOL_DECLARATIONS,
  dev_report_incident,
  dev_set_healing_mode,
  dev_healing_kill_switch,
  dev_verify_heal,
  dev_rollback_heal,
  dev_list_quarantine,
} from '../../src/services/orb-tools/self-healing-tools';

const DEV_ID: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer', user_jwt: 'jwt-dev' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'developer' };

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
  const names = Object.keys(SELF_HEALING_TOOL_HANDLERS);

  it('exposes all 13 tools with matching declarations', () => {
    expect(names).toHaveLength(13);
    const declNames = SELF_HEALING_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const r = await SELF_HEALING_TOOL_HANDLERS[name](
      { service: 's', summary: 'x', autonomy_level: 2, action: 'activate', heal_id: 'h1', vtid: 'VTID-0001', failure_class: 'fc', signature: 'sig' },
      COMMUNITY_ID,
      {} as SupabaseClient,
    );
    expect(r.ok).toBe(false);
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await SELF_HEALING_TOOL_HANDLERS[name]({}, ANON_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });
});

describe('dev_report_incident', () => {
  it('requires service and summary', async () => {
    const r = await dev_report_incident({}, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('requires confirmation first', async () => {
    const r = await dev_report_incident({ service: 'gateway', summary: 'high latency' }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('files using the routine-incident:// convention on confirm', async () => {
    const fn = mockFetch(200, { total: 1, live: 0, details: [{ vtid: 'VTID-9999' }] });
    const r = await dev_report_incident({ service: 'gateway', summary: 'high latency', confirm: true }, DEV_ID, {} as SupabaseClient);
    expect(r.text).toContain('VTID-9999');
    const call = fn.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.services[0].endpoint).toMatch(/^routine-incident:\/\//);
  });
});

describe('dev_set_healing_mode', () => {
  it('validates autonomy_level range', async () => {
    const r = await dev_set_healing_mode({ autonomy_level: 9 }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('requires confirmation first', async () => {
    const r = await dev_set_healing_mode({ autonomy_level: 2 }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});

describe('dev_healing_kill_switch', () => {
  it('validates action', async () => {
    const r = await dev_healing_kill_switch({ action: 'bogus' }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });
});

describe('dev_verify_heal', () => {
  it('is not confirm-gated (verification only)', async () => {
    mockFetch(200, { result: { verified: true } });
    const r = await dev_verify_heal({ vtid: 'VTID-0001' }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('VTID-0001');
  });
});

describe('dev_rollback_heal', () => {
  it('requires confirmation first', async () => {
    const r = await dev_rollback_heal({ vtid: 'VTID-0001' }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('reports honestly when no snapshot exists', async () => {
    mockFetch(404, { error: 'not_found' });
    const r = await dev_rollback_heal({ vtid: 'VTID-0001', confirm: true }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { reason: string }).reason).toBe('no_snapshot');
  });
});

describe('dev_list_quarantine', () => {
  it('requires both failure_class and signature', async () => {
    const r = await dev_list_quarantine({ failure_class: 'fc' }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('needs a session JWT', async () => {
    const r = await dev_list_quarantine({ failure_class: 'fc', signature: 'sig' }, { ...DEV_ID, user_jwt: undefined }, {} as SupabaseClient);
    expect((r.result as { reason: string }).reason).toBe('no_dev_session');
  });
});
