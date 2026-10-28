/**
 * VTID-04817: Jev P3 gate C4 — voice opener / next-step outcome learning.
 * Openers joined to their sessions, grouped, judged over 7 days. Shadow only.
 */
const rows: any[] = [];
const seen = new Set<string>();
let greetings: any = { data: [], error: null };
let finals: any = { data: [], error: null };
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}` });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
  fetchVoiceDiagEvents: jest.fn(async () => greetings),
  fetchFinalizedSessions: jest.fn(async () => finals),
  fetchRecentShadowBySubject: jest.fn(async (_sb: unknown, _gate: string, ref: string) => ({ data: seen.has(ref) ? { id: 'old' } : null, error: null })),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import * as repo from '../src/services/jev/jev-repository';
import {
  MIN_SESSIONS, groupOpeners, isOpenerOutcomesOn, openerKey, ruleUnderperforming, runOpenerOutcomesDay,
  startOpenerOutcomesScheduler, stopOpenerOutcomesSchedulerForTest,
} from '../src/services/jev/gates/opener-outcome-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_VOICE_OPENER_OUTCOMES_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;
const DAY = '2026-09-30';

/** n sessions of one opener, `engaged` of them with ≥ 2 member turns. */
function cohort(prefix: string, wake_opener: string, candidate_kind: string | null, n: number, engaged: number, env = 'staging') {
  const g: any[] = [];
  const f: any[] = [];
  for (let i = 0; i < n; i++) {
    const sid = `live-${prefix}-${i}`;
    g.push({ metadata: { stage: 'greeting_sent', env, session_id: sid, wake_opener, candidate_kind, user_id: 'u-secret', lang: 'de' } });
    f.push({ metadata: { session_id: sid, user_turns: i < engaged ? 3 : 1, duration_ms: 60_000 } });
  }
  return { g, f };
}
const BRIEF = cohort('a', 'conv_resume', 'wake_brief', 20, 2);
const THREAD = cohort('b', 'resume_thread', 'wake_brief', 12, 8);
const FEW = cohort('c', 'newday_overview', null, 4, 0);
const PROD = cohort('d', 'conv_resume', 'wake_brief', 30, 30, 'production');

function load() {
  greetings = { data: [...BRIEF.g, ...THREAD.g, ...FEW.g, ...PROD.g, BRIEF.g[0]], error: null };
  finals = { data: [...BRIEF.f, ...THREAD.f, ...FEW.f, ...PROD.f], error: null };
}
function answer(working: number, step = 'reword') {
  return {
    ok: true, model: 'jev-1.13.0',
    answers: { working: { type: 'noul', noul: working }, next_step: { type: 'choice', choice: step, probabilities: { [step]: 0.8 }, confidence: 0.8 } },
    usage: { input_tokens: 150, output_tokens: 2 }, latency_ms: 20, attempts: 1,
  };
}

beforeEach(() => {
  rows.length = 0;
  seen.clear();
  load();
  (repo.fetchVoiceDiagEvents as jest.Mock).mockClear();
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterEach(() => stopOpenerOutcomesSchedulerForTest());
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04817 decision and grouping', () => {
  test('opener_effectiveness: telemetry, no PII, working + next step', () => {
    const d = getJevDecision('opener_effectiveness')!;
    expect(d.pii).toBe('forbid');
    expect(d.data).toBe('telemetry');
    expect(Object.keys(d.questions)).toEqual(['working', 'next_step']);
  });
  test('openers joined to finalized sessions, this environment only, one per session, biggest first', () => {
    const { groups, overall_engaged_pct } = groupOpeners(greetings.data, finals.data, 'staging');
    expect(groups).toEqual([
      { wake_opener: 'conv_resume', candidate_kind: 'wake_brief', sessions: 20, finalized: 20, engaged: 2, engaged_pct: 10, avg_user_turns: 1.2, avg_duration_s: 60 },
      { wake_opener: 'resume_thread', candidate_kind: 'wake_brief', sessions: 12, finalized: 12, engaged: 8, engaged_pct: 66.7, avg_user_turns: 2.3, avg_duration_s: 60 },
      { wake_opener: 'newday_overview', candidate_kind: 'none', sessions: 4, finalized: 4, engaged: 0, engaged_pct: 0, avg_user_turns: 1, avg_duration_s: 60 },
    ]);
    expect(overall_engaged_pct).toBe(27.8);
    expect(JSON.stringify(groups)).not.toContain('u-secret');
  });
  test('the rule: below 70% of overall engagement is under-performing; too few finalized → null', () => {
    const { groups, overall_engaged_pct } = groupOpeners(greetings.data, finals.data, 'staging');
    expect(ruleUnderperforming(groups[0], overall_engaged_pct)).toBe(true);
    expect(ruleUnderperforming(groups[1], overall_engaged_pct)).toBe(false);
    expect(ruleUnderperforming(groups[2], overall_engaged_pct)).toBeNull();
    expect(openerKey('staging', DAY, groups[0])).toBe('staging:2026-09-30:conv_resume:wake_brief');
  });
});

describe('VTID-04817 gate', () => {
  test('off (default, typo): nothing read, asked or written; scheduler does not start', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_VOICE_OPENER_OUTCOMES_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      expect(isOpenerOutcomesOn(env)).toBe(false);
      expect(await runOpenerOutcomesDay(DAY, { env, sb, vitanaEnv: 'staging', decideOptions: { call } })).toBe(0);
      expect(startOpenerOutcomesScheduler(env)).toBe(false);
    }
    expect(repo.fetchVoiceDiagEvents).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  test(`groups with ≥ ${MIN_SESSIONS} sessions over the 7 days to the day's end are judged, agreement against the rule`, async () => {
    const call = jest.fn().mockResolvedValueOnce(answer(0.1, 'reword')).mockResolvedValueOnce(answer(0.2, 'drop'));
    expect(await runOpenerOutcomesDay(DAY, { env: SHADOW, sb, vitanaEnv: 'staging', decideOptions: { call } })).toBe(2);
    const [, stages, since, until] = (repo.fetchVoiceDiagEvents as jest.Mock).mock.calls[0];
    expect(stages).toEqual(['greeting_sent']);
    expect([since, until]).toEqual(['2026-09-24T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
    expect(call.mock.calls[0][0].state.opener).toMatchObject({ wake_opener: 'conv_resume', candidate_kind: 'wake_brief', sessions: 20, engaged_pct: 10, overall_engaged_pct: 27.8, window_days: 7 });
    expect(rows[0]).toMatchObject({
      gate: 'voice_opener_outcomes', decision: 'opener_effectiveness', mode: 'shadow', tenant_id: null, subject_type: 'voice_opener',
      subject_ref: 'staging:2026-09-30:conv_resume:wake_brief', system_action: 'opener_unchanged',
      jev_verdict: { working: false, next_step: 'reword', rule_underperforming: true }, agreed: true, outcome: 'compared_with_engagement_rule',
    });
    expect(rows[1]).toMatchObject({ subject_ref: 'staging:2026-09-30:resume_thread:wake_brief', jev_verdict: { working: false, rule_underperforming: false }, agreed: false });
  });

  test('a group already judged that day is skipped; Jev down → fallback row; read errors → 0; never throws', async () => {
    seen.add('staging:2026-09-30:conv_resume:wake_brief');
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    expect(await runOpenerOutcomesDay(DAY, { env: SHADOW, sb, vitanaEnv: 'staging', decideOptions: { call: failing } })).toBe(1);
    expect(rows[0]).toMatchObject({ subject_ref: 'staging:2026-09-30:resume_thread:wake_brief', jev_outcome: 'fallback', agreed: null, cost_usd: 0 });
    finals = { data: null, error: { message: 'timeout' } };
    expect(await runOpenerOutcomesDay(DAY, { env: SHADOW, sb, vitanaEnv: 'staging' })).toBe(0);
    (repo.fetchVoiceDiagEvents as jest.Mock).mockImplementationOnce(async () => { throw new Error('db'); });
    await expect(runOpenerOutcomesDay(DAY, { env: SHADOW, sb, vitanaEnv: 'staging' })).resolves.toBe(0);
    expect(await runOpenerOutcomesDay(DAY, { env: SHADOW, sb: null, vitanaEnv: 'staging' })).toBe(0);
  });
});

describe('VTID-04817 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  test('the scheduler starts from index.ts, guarded, non-fatal', () => {
    const idx = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
    expect(idx).toContain("require('./services/jev/gates/opener-outcome-gate')");
    expect(idx).toContain('if (startOpenerOutcomesScheduler())');
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_VOICE_OPENER_OUTCOMES_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_VOICE_OPENER_OUTCOMES_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_VOICE_OPENER_OUTCOMES_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
