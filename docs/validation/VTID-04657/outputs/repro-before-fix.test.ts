/**
 * Reproduction: Command Hub "Activate" on a dev_autopilot recommendation.
 * Runs the REAL bridgeActivationToExecution / approveAutoExecute against a
 * fake PostgREST that holds the row exactly as activate_autopilot_recommendation
 * leaves it (status='activated', activated_vtid set).
 */
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

import { bridgeActivationToExecution } from '../src/services/dev-autopilot-execute';

const FINDING = '14281af7-c2c5-42fe-bc55-1ac2c3ffb546';
const calls: string[] = [];

function install(recStatus: string) {
  calls.length = 0;
  (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
    const u = String(url);
    const m = (init.method || 'GET').toUpperCase();
    calls.push(`${m} ${u.replace('https://supa.test', '')}`);
    const json = (b: unknown, status = 200) => ({ ok: status < 300, status, json: async () => b, text: async () => JSON.stringify(b) });
    if (u.includes('/autopilot_recommendations')) {
      return json([{ id: FINDING, source_type: 'dev_autopilot', status: recStatus, risk_class: 'low',
        source_ref: 'feedback_ticket:x', spec_snapshot: {} }]);
    }
    if (u.includes('/dev_autopilot_executions') && m === 'GET') return json([]);
    if (u.includes('/dev_autopilot_plan_versions')) {
      return json([{ version: 1, files_referenced: ['services/gateway/src/routes/x.ts', 'services/gateway/test/x.test.ts'], plan_markdown: '# plan' }]);
    }
    if (u.includes('/dev_autopilot_config')) {
      return json([{ kill_switch: false, daily_budget: 50, concurrency_cap: 5, max_auto_fix_depth: 2,
        allow_scope: ['services/gateway/src/**', 'services/gateway/test/**'], deny_scope: [] }]);
    }
    if (u.includes('/dev_autopilot_executions') && m === 'POST') return json([{ id: 'exec-1', status: 'cooling' }], 201);
    return json([]);
  });
}

beforeAll(() => {
  process.env.SUPABASE_URL = 'https://supa.test';
  process.env.SUPABASE_SERVICE_ROLE = 'k';
});

it('status the RPC leaves behind ("activated") — does Activate reach an execution?', async () => {
  install('activated');
  const r = await bridgeActivationToExecution(FINDING, '6b1c1e2a-1111-4222-8333-444444444444');
  // eslint-disable-next-line no-console
  console.log('ACTIVATED ->', JSON.stringify(r), '\n', calls.join('\n'));
  expect(calls.some((c) => c.startsWith('POST /rest/v1/dev_autopilot_executions'))).toBe(true);
});

it('control: same finding still status=new', async () => {
  install('new');
  const r = await bridgeActivationToExecution(FINDING, '6b1c1e2a-1111-4222-8333-444444444444');
  // eslint-disable-next-line no-console
  console.log('NEW ->', JSON.stringify(r));
  expect(calls.some((c) => c.startsWith('POST /rest/v1/dev_autopilot_executions'))).toBe(true);
});
