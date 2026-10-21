/**
 * Developer Autopilot Controller & Loop voice tools (Wave 5, plan section
 * C6) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  AUTOPILOT_CONTROLLER_TOOL_HANDLERS,
  AUTOPILOT_CONTROLLER_TOOL_DECLARATIONS,
  dev_autopilot_loop_status,
  dev_start_autopilot_loop,
  dev_reset_loop_cursor,
  dev_get_controller_run,
  dev_validate_task,
  dev_get_task_spec,
  dev_autopilot_pipeline_health,
} from '../../src/services/orb-tools/autopilot-controller-tools';

const DEV_ID: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer' };
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
  const names = Object.keys(AUTOPILOT_CONTROLLER_TOOL_HANDLERS);

  it('exposes 12 tools (dev_plan_task/dev_start_task_work/dev_complete_task_work intentionally skipped)', () => {
    expect(names).toHaveLength(12);
    const declNames = AUTOPILOT_CONTROLLER_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const r = await AUTOPILOT_CONTROLLER_TOOL_HANDLERS[name]({ vtid: 'VTID-0001' }, COMMUNITY_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await AUTOPILOT_CONTROLLER_TOOL_HANDLERS[name]({}, ANON_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });
});

describe('dev_autopilot_loop_status', () => {
  it('reports running state', async () => {
    mockFetch(200, { is_running: true, errors_1h: 0 });
    const r = await dev_autopilot_loop_status({}, DEV_ID, {} as SupabaseClient);
    expect(r.text).toContain('running');
  });
});

describe('dev_start_autopilot_loop', () => {
  it('requires confirmation first', async () => {
    const r = await dev_start_autopilot_loop({}, DEV_ID, {} as SupabaseClient);
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});

describe('dev_reset_loop_cursor', () => {
  it('defaults to "now" and requires confirmation first', async () => {
    const r = await dev_reset_loop_cursor({}, DEV_ID, {} as SupabaseClient);
    expect((r.result as { timestamp: string }).timestamp).toBe('now');
    expect((r.result as { requires_confirmation: boolean }).requires_confirmation).toBe(true);
  });
});

describe('dev_get_controller_run / dev_get_task_spec', () => {
  it('dev_get_controller_run validates vtid format', async () => {
    const r = await dev_get_controller_run({ vtid: 'bad' }, DEV_ID, {} as SupabaseClient);
    expect(r.ok).toBe(false);
  });

  it('dev_get_controller_run reports honestly on 404', async () => {
    mockFetch(404, { error: 'not_found' });
    const r = await dev_get_controller_run({ vtid: 'VTID-0001' }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { found: boolean }).found).toBe(false);
  });

  it('dev_get_task_spec reports honestly on 404', async () => {
    mockFetch(404, { error: 'not_found' });
    const r = await dev_get_task_spec({ vtid: 'VTID-0001' }, DEV_ID, {} as SupabaseClient);
    expect((r.result as { found: boolean }).found).toBe(false);
  });
});

describe('dev_validate_task', () => {
  it('reports the validation status', async () => {
    mockFetch(200, { validation: { final_status: 'passed' } });
    const r = await dev_validate_task({ vtid: 'VTID-0001' }, DEV_ID, {} as SupabaseClient);
    expect(r.text).toContain('passed');
  });
});

describe('dev_autopilot_pipeline_health', () => {
  it('summarizes loop + execution + stuck tasks', async () => {
    mockFetch(200, { loop_running: true, execution_armed: false, stuck_count: 2, workers_active: 1 });
    const r = await dev_autopilot_pipeline_health({}, DEV_ID, {} as SupabaseClient);
    expect(r.text).toContain('disarmed');
    expect(r.text).toContain('2 stuck tasks');
  });
});
