/**
 * VTID-04657: Command Hub "Activate" must reach Dev Autopilot execution.
 *
 * `activate_autopilot_recommendation` sets status='activated' before the
 * route bridges the finding, and approveAutoExecute refused every finding
 * that was not 'new' — so every Activate click, and every activation-reaper
 * retry, ended with "finding status is 'activated' — only 'new' findings can
 * be approved" and no execution. Measured live: the last 6 Activate clicks
 * (VTID-04250, VTID-04566..04570) created zero executions. Every prior test
 * mocked bridgeActivationToExecution, so none ran the real guard.
 *
 * These tests run the REAL bridge against a fake PostgREST holding the row
 * as the RPC leaves it.
 */
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

import { bridgeActivationToExecution, approveAutoExecute } from '../src/services/dev-autopilot-execute';
import { bridgeActivationWithBudget } from '../src/routes/autopilot-recommendations';
import { emitOasisEvent } from '../src/services/oasis-event-service';

const FINDING = '14281af7-c2c5-42fe-bc55-1ac2c3ffb546';
const USER = '6b1c1e2a-1111-4222-8333-444444444444';
let calls: string[] = [];

type Fake = { recStatus: string; sourceType?: string; inflight?: boolean; allowScope?: string[] };

function install(f: Fake) {
  calls = [];
  (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
    const u = String(url);
    const m = (init.method || 'GET').toUpperCase();
    calls.push(`${m} ${u.replace('https://supa.test', '')}`);
    const json = (b: unknown, status = 200) => ({ ok: status < 300, status, json: async () => b, text: async () => JSON.stringify(b) });
    if (u.includes('/autopilot_recommendations')) {
      return json([{ id: FINDING, source_type: f.sourceType ?? 'dev_autopilot', status: f.recStatus, risk_class: 'low',
        source_ref: null, spec_snapshot: {} }]);
    }
    if (u.includes('/dev_autopilot_executions') && m === 'GET') {
      if (f.inflight && u.includes('status=in.')) return json([{ id: 'live-exec-0000', status: 'running' }]);
      return json([]);
    }
    if (u.includes('/dev_autopilot_plan_versions')) {
      return json([{ version: 1, files_referenced: [],
        plan_markdown: '## Files to modify\n- `services/gateway/src/routes/x.ts`\n- `services/gateway/test/x.test.ts`\n' }]);
    }
    if (u.includes('/dev_autopilot_config')) {
      return json([{ kill_switch: false, daily_budget: 50, concurrency_cap: 5, max_auto_fix_depth: 2, cooldown_minutes: 5,
        allow_scope: f.allowScope ?? ['services/gateway/src/**', 'services/gateway/test/**'], deny_scope: [] }]);
    }
    if (u.includes('/dev_autopilot_executions') && m === 'POST') return json([{ id: 'exec-new-0001', status: 'cooling' }], 201);
    return json([]);
  });
}

const created = () => calls.some((c) => c.startsWith('POST /rest/v1/dev_autopilot_executions'));

beforeAll(() => {
  process.env.SUPABASE_URL = 'https://supa.test';
  process.env.SUPABASE_SERVICE_ROLE = 'k';
});
beforeEach(() => (emitOasisEvent as jest.Mock).mockClear());

describe('VTID-04657 bridge accepts the status the activate RPC leaves behind', () => {
  it("status='activated' → an execution row is created", async () => {
    install({ recStatus: 'activated' });
    const r = await bridgeActivationToExecution(FINDING, USER);
    expect(r).toEqual(expect.objectContaining({ ok: true }));
    expect(created()).toBe(true);
  });

  it("status='new' still works (feedback bridge / self-healing callers)", async () => {
    install({ recStatus: 'new' });
    expect((await bridgeActivationToExecution(FINDING, USER)).ok).toBe(true);
    expect(created()).toBe(true);
  });

  it.each(['completed', 'rejected', 'snoozed'])("status='%s' is still refused", async (st) => {
    install({ recStatus: st });
    const r = await bridgeActivationToExecution(FINDING, USER);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/only 'new' findings/);
    expect(created()).toBe(false);
  });

  it('autonomous approvals (no flag) still refuse an activated finding', async () => {
    install({ recStatus: 'activated' });
    const r = await approveAutoExecute({ finding_id: FINDING });
    expect(r.ok).toBe(false);
    expect(created()).toBe(false);
  });

  it('an in-flight execution is reused, never duplicated', async () => {
    install({ recStatus: 'activated', inflight: true });
    const r = await bridgeActivationToExecution(FINDING, USER);
    expect(r).toEqual(expect.objectContaining({ ok: true, execution_id: 'live-exec-0000' }));
    expect(created()).toBe(false);
  });
});

describe('VTID-04657 Activate reports the real execution outcome', () => {
  it('queued → state queued with the execution id', async () => {
    install({ recStatus: 'activated' });
    const r = await bridgeActivationWithBudget(FINDING, USER, 'VTID-09999', 5000);
    expect(r).toEqual({ state: 'queued', execution_id: expect.any(String) });
    expect(created()).toBe(true);
  });

  it('safety gate refusal → state failed with the violated rule, and an OASIS error event', async () => {
    install({ recStatus: 'activated', allowScope: ['supabase/**'] });
    const r = await bridgeActivationWithBudget(FINDING, USER, 'VTID-09999', 5000);
    expect(r.state).toBe('failed');
    if (r.state !== 'failed') return;
    expect(r.violations && r.violations.length).toBeGreaterThan(0);
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'autopilot.recommendation.activation_bridge_failed', status: 'error', vtid: 'VTID-09999',
    }));
  });

  it('a source type with no executor (oasis, roadmap, behavior) says so instead of claiming success', async () => {
    for (const t of ['oasis', 'roadmap', 'behavior']) {
      install({ recStatus: 'activated', sourceType: t });
      const r = await bridgeActivationWithBudget(FINDING, USER, 'VTID-09999', 5000);
      expect(r).toEqual(expect.objectContaining({ state: 'not_executable', source_type: t }));
      expect(created()).toBe(false);
    }
  });

  it('a slow bridge answers pending within the budget', async () => {
    install({ recStatus: 'activated' });
    const orig = (global as any).fetch;
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      if (String(url).includes('/dev_autopilot_executions')) await new Promise((res) => setTimeout(res, 300));
      return orig(url, init);
    });
    const t0 = Date.now();
    const r = await bridgeActivationWithBudget(FINDING, USER, 'VTID-09999', 50);
    expect(r.state).toBe('pending');
    expect(Date.now() - t0).toBeLessThan(250);
  });
});

describe('VTID-04657 activate RPC keeps the producer spec_snapshot', () => {
  it('the migration merges into spec_snapshot instead of replacing it', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const sql: string = fs.readFileSync(path.resolve(__dirname,
      '../../../supabase/migrations/20260926120000_vtid_04657_activate_keeps_spec_snapshot.sql'), 'utf8');
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION activate_autopilot_recommendation\(/);
    const merge = sql.indexOf("v_spec_snapshot := COALESCE(v_rec.spec_snapshot, '{}'::jsonb) || v_spec_snapshot;");
    const checksum = sql.indexOf('v_checksum := encode(sha256(convert_to(v_spec_snapshot::text');
    const update = sql.indexOf('spec_snapshot = v_spec_snapshot');
    expect(merge).toBeGreaterThan(-1);
    expect(checksum).toBeGreaterThan(merge);
    expect(update).toBeGreaterThan(checksum);
  });
});
