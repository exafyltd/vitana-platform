/**
 * Developer Testing & QA voice tools (Wave 5, plan section C10) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  TESTING_QA_TOOL_HANDLERS,
  TESTING_QA_TOOL_DECLARATIONS,
  dev_run_test_suite,
  dev_run_e2e,
  dev_get_test_run,
  dev_list_test_contracts,
  dev_run_orb_selfcheck,
  dev_voice_lab_probe,
} from '../../src/services/orb-tools/testing-qa-tools';

const EXAFY_ID: OrbToolIdentity = { user_id: 'u-exafy', tenant_id: 't-1', role: 'exafy_admin', user_jwt: 'jwt-xyz' };
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
  const names = Object.keys(TESTING_QA_TOOL_HANDLERS);

  it('exposes all 10 tools with matching declarations', () => {
    expect(names).toHaveLength(10);
    const declNames = TESTING_QA_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const r = await TESTING_QA_TOOL_HANDLERS[name](
      { projects: ['all'], run_id: 'r1', user_id: 'u1' },
      COMMUNITY_ID,
      {} as SupabaseClient,
    );
    expect(r.ok).toBe(false);
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await TESTING_QA_TOOL_HANDLERS[name]({}, ANON_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });
});

describe('dev_run_test_suite / dev_run_e2e', () => {
  it('dev_run_test_suite requires confirmation first', async () => {
    const r = await dev_run_test_suite({ projects: ['desktop-suite'] }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });

  it('dev_run_e2e defaults to "all" projects', async () => {
    const r = await dev_run_e2e({}, DEV_ID, {} as SupabaseClient);
    expect((r.result as { projects: string[] }).projects).toEqual(['all']);
  });

  it('starts the run on confirm', async () => {
    mockFetch(200, { run_id: 'run-1', status: 'running' });
    const r = await dev_run_test_suite({ projects: ['desktop-suite'], confirm: true }, DEV_ID, {} as SupabaseClient);
    expect(r.text).toContain('run-1');
  });
});

describe('dev_get_test_run', () => {
  it('requires run_id', async () => {
    const r = await dev_get_test_run({}, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('reports honestly on 404', async () => {
    mockFetch(404, { error: 'not_found' });
    const r = await dev_get_test_run({ run_id: 'r1' }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { found: boolean }).found).toBe(false);
  });
});

describe('exafy_admin-only tools', () => {
  it('dev_list_test_contracts rejects a plain developer session', async () => {
    const r = await dev_list_test_contracts({}, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('exafy_admin');
  });

  it('dev_run_orb_selfcheck requires confirmation first for exafy_admin', async () => {
    const r = await dev_run_orb_selfcheck({ user_id: 'u1' }, EXAFY_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});

describe('dev_voice_lab_probe', () => {
  it('needs a session JWT', async () => {
    const r = await dev_voice_lab_probe({}, { ...DEV_ID, user_jwt: undefined }, {} as SupabaseClient);
    expect((r.result as { reason: string }).reason).toBe('no_dev_session');
  });

  it('reports probe failure honestly', async () => {
    mockFetch(200, { ok: false, failure_mode_code: 'timeout' });
    const r = await dev_voice_lab_probe({}, DEV_ID, {} as SupabaseClient);
    expect(r.text).toContain('timeout');
  });
});
