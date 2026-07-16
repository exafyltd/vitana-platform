/**
 * Developer Dev-Autopilot Scanners & Findings voice tools (Wave 5, plan
 * section C7) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  DEV_AUTOPILOT_SCANNERS_TOOL_HANDLERS,
  DEV_AUTOPILOT_SCANNERS_TOOL_DECLARATIONS,
  dev_list_scanners,
  dev_findings_queue,
  dev_generate_finding_plan,
  dev_snooze_finding,
  dev_approve_auto_execute,
} from '../../src/services/orb-tools/dev-autopilot-scanners-tools';

const EXAFY_ID: OrbToolIdentity = { user_id: 'u-exafy', tenant_id: 't-1', role: 'exafy_admin', user_jwt: 'jwt-xyz' };
const DEV_ID: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer', user_jwt: 'jwt-dev' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'exafy_admin' };

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
  const names = Object.keys(DEV_AUTOPILOT_SCANNERS_TOOL_HANDLERS);

  it('exposes 14 tools (dev_trigger_scan intentionally skipped)', () => {
    expect(names).toHaveLength(14);
    const declNames = DEV_AUTOPILOT_SCANNERS_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const r = await DEV_AUTOPILOT_SCANNERS_TOOL_HANDLERS[name](
      { finding_id: 'f1', run_id: 'r1', execution_id: 'e1' },
      COMMUNITY_ID,
      {} as SupabaseClient,
    );
    expect(r.ok).toBe(false);
  });

  it.each(names)('%s rejects a plain developer session (exafy_admin only)', async (name) => {
    const r = await DEV_AUTOPILOT_SCANNERS_TOOL_HANDLERS[name]({ finding_id: 'f1', run_id: 'r1', execution_id: 'e1' }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('exafy_admin');
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await DEV_AUTOPILOT_SCANNERS_TOOL_HANDLERS[name]({}, ANON_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });
});

describe('dev_list_scanners', () => {
  it('needs a session JWT', async () => {
    const r = await dev_list_scanners({}, { ...EXAFY_ID, user_jwt: undefined }, {} as SupabaseClient);
    expect((r.result as { reason: string }).reason).toBe('no_dev_session');
  });

  it('reports scanner count', async () => {
    mockFetch(200, { scanners: [{ id: 's1' }, { id: 's2' }] });
    const r = await dev_list_scanners({}, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('2 scanners');
  });
});

describe('dev_findings_queue', () => {
  it('reports queue count', async () => {
    mockFetch(200, { findings: [{ id: 'f1' }] });
    const r = await dev_findings_queue({}, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('1 findings');
  });
});

describe('dev_generate_finding_plan / dev_approve_auto_execute', () => {
  it('generate_finding_plan requires confirmation first', async () => {
    const r = await dev_generate_finding_plan({ finding_id: 'f1' }, EXAFY_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('approve_auto_execute requires confirmation first', async () => {
    const r = await dev_approve_auto_execute({ finding_id: 'f1' }, EXAFY_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});

describe('dev_snooze_finding', () => {
  it('is not confirm-gated (low-risk toggle)', async () => {
    mockFetch(200, { ok: true });
    const r = await dev_snooze_finding({ finding_id: 'f1', hours: 48 }, EXAFY_ID, {} as SupabaseClient);
    expect(r.text).toContain('48 hours');
  });
});
