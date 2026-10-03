/**
 * VTID-04816: Jev P3 gate A10 — Operator Console turn router. Jev names the
 * lane beside the turn; the tools the turn called are the outcome. Shadow only.
 */
const rows: any[] = [];
const outcomes: any[] = [];
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}` });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
  updateShadowOutcome: jest.fn(async (_sb: unknown, id: string, patch: any) => {
    outcomes.push({ id, ...patch });
    return { data: null, error: null };
  }),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import { TOOL_LANES, isOperatorRouteOn, observedLane, recordOperatorRouteOutcome, runOperatorRoute } from '../src/services/jev/gates/operator-route-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_OPERATOR_ROUTE_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;

function answer(lane: string, conf = 0.85) {
  return { ok: true, model: 'jev-1.13.0', answers: { lane: { type: 'choice', choice: lane, probabilities: { [lane]: conf }, confidence: conf } }, usage: { input_tokens: 100, output_tokens: 1 }, latency_ms: 20, attempts: 1 };
}

beforeEach(() => {
  rows.length = 0;
  outcomes.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04816 decision and lanes', () => {
  test('operator_route: internal plane, redacted, six lanes', () => {
    const d = getJevDecision('operator_route')!;
    expect(d.pii).toBe('redact');
    expect(d.planes).toEqual(['internal']);
    expect(Object.keys((d.questions.lane as any).criteria)).toEqual(['answer_only', 'task_management', 'code_lookup', 'ops_diagnostics', 'delivery', 'community']);
  });
  test('every operator tool has a lane that the decision knows', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/gemini-operator.ts'), 'utf8');
    const start = src.indexOf('export async function executeTool(');
    const end = src.indexOf('export async function operatorDeveloperKnowledge(');
    const names = [...new Set([...src.slice(start, end).matchAll(/case '([a-z_]+)'/g)].map((m) => m[1]))];
    expect(names.length).toBeGreaterThan(40);
    expect(names.filter((n) => !TOOL_LANES[n])).toEqual([]);
    const lanes = Object.keys((getJevDecision('operator_route')!.questions.lane as any).criteria);
    for (const l of new Set(Object.values(TOOL_LANES))) expect(lanes).toContain(l);
  });
  test('the lane a turn took: none → answer only; most frequent; tie → first; unknown only → null', () => {
    expect(observedLane([])).toBe('answer_only');
    expect(observedLane(['dev_search_codebase', 'dev_cloudwatch_logs', 'dev_read_file'])).toBe('code_lookup');
    expect(observedLane(['autopilot_run_task', 'dev_create_pr'])).toBe('task_management');
    expect(observedLane(['not_a_tool'])).toBeNull();
  });
});

describe('VTID-04816 gate', () => {
  test('off (default, typo): nothing asked or written', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_OPERATOR_ROUTE_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      expect(isOperatorRouteOn(env)).toBe(false);
      expect(await runOperatorRoute({ threadId: 't1', message: 'why did the gateway deploy fail?', developerTools: true, env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(call).not.toHaveBeenCalled();
  });

  test.each([
    ['ops_diagnostics', ['dev_cicd_health', 'dev_cloudwatch_logs'], true],
    ['ops_diagnostics', [], false],
    ['answer_only', [], true],
    ['code_lookup', ['autopilot_run_task'], false],
  ])('Jev %s, tools %j → agreed %s', async (lane, tools, agreed) => {
    const check = runOperatorRoute({ threadId: 't2', message: 'why did the gateway deploy fail?', developerTools: true, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer(lane as string)) } });
    await recordOperatorRouteOutcome(check, tools as string[], sb);
    expect(rows[0]).toMatchObject({ gate: 'operator_route', decision: 'operator_route', subject_type: 'operator_thread', subject_ref: 't2', system_action: 'full_tool_catalog', jev_verdict: { lane, developer_tools: true } });
    expect(outcomes[0]).toMatchObject({ id: 's1', outcome: `turn_lane:${observedLane(tools as string[])}`, agreed });
  });

  test('abstained, unavailable, unknown tools → agreed null; off → no outcome; never throws', async () => {
    await recordOperatorRouteOutcome(runOperatorRoute({ threadId: 't3', message: 'hm', developerTools: false, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer('answer_only', 0.3)) } }), [], sb);
    expect(outcomes[0]).toMatchObject({ agreed: null });
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await recordOperatorRouteOutcome(runOperatorRoute({ threadId: 't4', message: 'x', developerTools: false, env: SHADOW, sb, decideOptions: { call: failing } }), ['x'], sb);
    expect(rows[1]).toMatchObject({ jev_outcome: 'fallback', cost_usd: 0 });
    expect(outcomes[1]).toMatchObject({ outcome: 'turn_lane:unknown', agreed: null });
    await recordOperatorRouteOutcome(null, [], sb);
    await expect(recordOperatorRouteOutcome(Promise.reject(new Error('x')), [], sb)).resolves.toBeUndefined();
    expect(outcomes).toHaveLength(2);
  });
});

describe('VTID-04816 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  test('started before the turn, never awaited; outcome after the (possibly retried) turn', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/operator.ts'), 'utf8');
    const start = src.indexOf("const routeCheck = isOperatorRouteOn() ? runOperatorRoute({ threadId, message, developerTools: geminiUserRole === 'admin' }) : null;");
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(src.indexOf('let geminiResult = await processWithGemini({'));
    const out = src.indexOf('if (routeCheck) void recordOperatorRouteOutcome(routeCheck, (geminiResult.toolResults || []).map((tr) => tr.name));');
    expect(out).toBeGreaterThan(src.indexOf('[VTID-04172] retry itself threw'));
    expect(src).not.toContain('await routeCheck');
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_OPERATOR_ROUTE_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_OPERATOR_ROUTE_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_OPERATOR_ROUTE_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
