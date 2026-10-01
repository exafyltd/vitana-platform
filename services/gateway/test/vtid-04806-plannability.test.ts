/**
 * VTID-04806: Jev P2 gate A3 — is a Dev Autopilot finding plannable?
 * Asked beside the planner, compared with what the planner produced. Shadow only.
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
import {
  INFRA_ERROR, findingFiles, isPlannabilityOn, recordPlannabilityOutcome, runPlannabilityCheck, type PlannableFinding,
} from '../src/services/jev/gates/plannability-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_PLANNABILITY_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;

const FINDING: PlannableFinding = {
  id: 'f1',
  title: 'Missing tests for diary-service.ts',
  summary: 'createEntry has no unit test covering the empty-body path.',
  domain: 'gateway',
  risk_class: 'low',
  spec_snapshot: { signal_type: 'missing_tests', file_path: 'services/gateway/src/services/diary-service.ts', proposed_files: ['services/gateway/test/diary.test.ts', 'no-slash'] },
};

function answer(plannable: number, blocker = 'none') {
  return {
    ok: true, model: 'jev-1.13.0',
    answers: { plannable: { type: 'noul', noul: plannable }, blocker: { type: 'choice', choice: blocker, probabilities: { [blocker]: 0.8 }, confidence: 0.8 } },
    usage: { input_tokens: 300, output_tokens: 2 }, latency_ms: 20, attempts: 1,
  };
}

beforeEach(() => {
  rows.length = 0;
  outcomes.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04806 decision', () => {
  test('finding_plannable: internal planes, redacted, plannable + blocker', () => {
    const d = getJevDecision('finding_plannable')!;
    expect(d.pii).toBe('redact');
    expect(d.planes).toEqual(['internal', 'system_autopilot']);
    expect(Object.keys(d.questions)).toEqual(['plannable', 'blocker']);
    expect(Object.keys((d.questions.blocker as any).criteria)).toEqual(['none', 'too_vague', 'too_broad', 'needs_human_decision', 'missing_location']);
  });
  test('file hints: the finding path plus proposed files with a path, deduped', () => {
    expect(findingFiles(FINDING)).toEqual(['services/gateway/src/services/diary-service.ts', 'services/gateway/test/diary.test.ts']);
    expect(findingFiles({ id: 'x', title: 't', summary: 's' })).toEqual([]);
  });
});

describe('VTID-04806 gate', () => {
  test('off (default, typo): nothing asked or written', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_PLANNABILITY_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      expect(isPlannabilityOn(env)).toBe(false);
      expect(await runPlannabilityCheck({ finding: FINDING, env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(call).not.toHaveBeenCalled();
    await recordPlannabilityOutcome(null, { ok: true, files: 2 }, sb);
    expect(outcomes).toEqual([]);
  });

  test('shadow: one row per first-time plan with Jev\'s call and the blocker', async () => {
    const call = jest.fn().mockResolvedValue(answer(0.2, 'too_vague'));
    const c = await runPlannabilityCheck({ finding: FINDING, env: SHADOW, sb, decideOptions: { call } });
    expect(c).toEqual({ shadow_id: 's1', plannable: false });
    expect(call.mock.calls[0][0].state.finding).toMatchObject({ title: FINDING.title, signal_type: 'missing_tests', files: findingFiles(FINDING) });
    expect(rows[0]).toMatchObject({
      gate: 'plannability', decision: 'finding_plannable', mode: 'shadow', subject_type: 'dev_autopilot_finding', subject_ref: 'f1',
      system_action: 'planner_ran', jev_outcome: 'decided', jev_verdict: { plannable: false, probability: 0.2, blocker: 'too_vague', files: 2 },
    });
  });

  test.each([
    [0.9, { ok: true, files: 3 }, 'plan_with_files', true],
    [0.9, { ok: true, files: 0 }, 'plan_without_files', false],
    [0.1, { ok: false, error: 'plan has no usable sections' }, 'plan_failed', true],
    [0.9, { ok: false, error: 'Plan generation failed after 34s: unknown error' }, 'plan_infra_error', null],
    [0.9, { ok: false, error: 'both providers failed: primary=Bedrock' }, 'plan_infra_error', null],
  ])('Jev p=%s, planner %j → %s, agreed %s', async (p, result, outcome, agreed) => {
    const check = runPlannabilityCheck({ finding: FINDING, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer(p as number)) } });
    await recordPlannabilityOutcome(check, result as any, sb);
    expect(outcomes[0]).toMatchObject({ id: 's1', outcome, agreed });
  });

  test('abstained or unavailable → agreed null; a throwing call → nothing; never throws', async () => {
    await recordPlannabilityOutcome(runPlannabilityCheck({ finding: FINDING, env: SHADOW, sb, decideOptions: { call: jest.fn().mockResolvedValue(answer(0.5)) } }), { ok: true, files: 2 }, sb);
    expect(outcomes[0]).toMatchObject({ agreed: null });
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await recordPlannabilityOutcome(runPlannabilityCheck({ finding: FINDING, env: SHADOW, sb, decideOptions: { call: failing } }), { ok: true, files: 2 }, sb);
    expect(rows[1]).toMatchObject({ jev_outcome: 'fallback', cost_usd: 0 });
    expect(outcomes[1]).toMatchObject({ agreed: null });
    await expect(recordPlannabilityOutcome(Promise.reject(new Error('x')), { ok: true }, sb)).resolves.toBeUndefined();
    expect(INFRA_ERROR.test('upstream HTTP 503')).toBe(true);
    expect(INFRA_ERROR.test('finding is vague')).toBe(false);
  });
});

describe('VTID-04806 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  const src = fs.readFileSync(path.join(__dirname, '../src/services/dev-autopilot-planning.ts'), 'utf8');
  test('first-time plans only, started before the planner, never awaited; outcome on every exit', () => {
    const start = src.indexOf('const plannability = !opts.feedback_note && isPlannabilityOn() ? runPlannabilityCheck({ finding }) : null;');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(src.indexOf('const initialSession = await runPlanningSession('));
    expect(src).not.toContain('await plannability');
    expect((src.match(/void recordPlannabilityOutcome\(plannability, /g) || []).length).toBe(3);
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_PLANNABILITY_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_PLANNABILITY_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_PLANNABILITY_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
