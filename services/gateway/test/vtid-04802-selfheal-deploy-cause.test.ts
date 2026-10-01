/**
 * VTID-04802: Jev P2 gates B5 (no deploy seen) + B4 (likely-cause commit
 * ranking) for self-healing incidents. Shadow only.
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
import { componentInFiles, isDeployCauseOn, recordDeployCauseOutcome, runDeployCauseCheck, type DeployCauseDeps } from '../src/services/jev/gates/deploy-cause-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_SELFHEAL_DEPLOY_CAUSE_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const now = () => NOW;

const INCIDENT = { vtid: 'VTID-09100', mode: 'pre_fix', endpoint: '/api/v1/diary/entries', failure: { endpoint: '/api/v1/diary/entries', error: "TypeError: Cannot read properties of undefined (reading 'user_id') at diary-service.ts:88" } };

const COMMITS = [
  { sha: 'aaaa1111aaaa1111', message: 'Voice: tighten greeting cadence (VTID-1)', files: ['services/gateway/src/orb/live/greeting.ts'] },
  { sha: 'bbbb2222bbbb2222', message: 'Diary: new entry shape (VTID-2)', files: ['services/gateway/src/services/diary-service.ts', 'services/gateway/test/diary.test.ts'] },
];

function deps(deploys: Array<{ git_commit: string; at: string }>, commits = COMMITS): DeployCauseDeps & { commitsBetween: jest.Mock } {
  return { recentDeploys: jest.fn(async () => deploys), commitsBetween: jest.fn(async (_b: string, _h: string, n: number) => commits.slice(0, n)) } as any;
}
function score(level: number, conf = 0.8) {
  const probs = [0.05, 0.05, 0.05, 0.05];
  probs[level] = conf;
  return { ok: true, model: 'jev-1.13.0', answers: { likelihood: { type: 'score', score: level, probabilities: probs, confidence: conf } }, usage: { input_tokens: 300, output_tokens: 1 }, latency_ms: 20, attempts: 1 };
}

const RECENT = [{ git_commit: 'head0000', at: '2026-10-01T10:00:00Z' }, { git_commit: 'base0000', at: '2026-09-30T08:00:00Z' }];

beforeEach(() => {
  rows.length = 0;
  outcomes.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04802 decision', () => {
  test('commit_cause_score: telemetry, internal planes, four levels', () => {
    const d = getJevDecision('commit_cause_score')!;
    expect(d.data).toBe('telemetry');
    expect(d.planes).toEqual(['internal', 'system_autopilot']);
    expect((d.questions.likelihood as any).criteria).toHaveLength(4);
  });
});

describe('VTID-04802 gate', () => {
  test('off (default, typo): nothing read, asked or written', async () => {
    const d = deps(RECENT);
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_SELFHEAL_DEPLOY_CAUSE_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      expect(isDeployCauseOn(env)).toBe(false);
      expect(await runDeployCauseCheck(INCIDENT, d, { env, sb, now, decideOptions: { call } })).toEqual({ shadow_id: null, top: null });
    }
    expect(d.recentDeploys).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  test('B5: no deploy in the last 24 h → a rules row, no Jev call, no GitHub call', async () => {
    const d = deps([{ git_commit: 'old', at: '2026-09-29T08:00:00Z' }]);
    const call = jest.fn();
    const r = await runDeployCauseCheck(INCIDENT, d, { env: SHADOW, sb, now, decideOptions: { call } });
    expect(r.shadow_id).toBe('s1');
    expect(call).not.toHaveBeenCalled();
    expect(d.commitsBetween).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({
      gate: 'selfheal_deploy_cause', decision: 'rules:no_deploy_seen', subject_type: 'triage', subject_ref: 'VTID-09100',
      jev_verdict: { source: 'rules', deploy_seen: false, last_deploy_at: '2026-09-29T08:00:00Z' }, cost_usd: 0,
    });
  });

  test('B5: no deploy at all → no deploy seen', async () => {
    await runDeployCauseCheck(INCIDENT, deps([]), { env: SHADOW, sb, now });
    expect(rows[0]).toMatchObject({ decision: 'rules:no_deploy_seen', jev_verdict: { last_deploy_at: null } });
  });

  test('B4: a deploy in the window → each commit scored from subject + paths, the top recorded', async () => {
    const d = deps(RECENT);
    const call = jest.fn().mockResolvedValueOnce(score(0)).mockResolvedValueOnce(score(3));
    const r = await runDeployCauseCheck(INCIDENT, d, { env: SHADOW, sb, now, decideOptions: { call } });
    expect(d.commitsBetween).toHaveBeenCalledWith('base0000', 'head0000', 5);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0].state.commit).toEqual({ subject: 'Diary: new entry shape (VTID-2)', files: COMMITS[1].files });
    expect(r.top).toMatchObject({ sha: 'bbbb2222bbbb2222', level: 3 });
    expect(rows[0]).toMatchObject({
      decision: 'commit_cause_score', jev_outcome: 'decided',
      jev_verdict: { deploy_seen: true, deploy_commit: 'head0000', previous_commit: 'base0000', top_sha: 'bbbb2222bbbb2222', top_level: 3 },
    });
  });

  test('a deploy with no previous deploy or no commits → a rules row', async () => {
    await runDeployCauseCheck(INCIDENT, deps([RECENT[0]]), { env: SHADOW, sb, now });
    expect(rows[0]).toMatchObject({ decision: 'rules:deploy_without_commits', jev_verdict: { commits: 0 } });
  });

  test('Jev unavailable for every commit → a fallback row; a throwing dep → nothing; never throws', async () => {
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await runDeployCauseCheck(INCIDENT, deps(RECENT), { env: SHADOW, sb, now, decideOptions: { call: failing } });
    expect(rows[0]).toMatchObject({ jev_outcome: 'fallback', jev_verdict: { top_sha: null } });
    const broken = { recentDeploys: jest.fn(async () => { throw new Error('db'); }), commitsBetween: jest.fn() };
    await expect(runDeployCauseCheck(INCIDENT, broken as any, { env: SHADOW, sb, now })).resolves.toEqual({ shadow_id: null, top: null });
  });
});

describe('VTID-04802 outcome', () => {
  test('component match against the top commit paths', () => {
    expect(componentInFiles('diary-service.ts', COMMITS[1].files)).toBe(true);
    expect(componentInFiles('services/gateway/src/services/diary-service', COMMITS[1].files)).toBe(true);
    expect(componentInFiles('orb greeting', COMMITS[1].files)).toBe(false);
    expect(componentInFiles('', COMMITS[1].files)).toBeNull();
  });

  test('B4 agrees when triage names a component the top commit touched', async () => {
    const r = await runDeployCauseCheck(INCIDENT, deps(RECENT), { env: SHADOW, sb, now, decideOptions: { call: jest.fn().mockResolvedValueOnce(score(0)).mockResolvedValueOnce(score(3)) } });
    await recordDeployCauseOutcome(r, { affected_component: 'diary-service.ts', severity: 'critical' }, sb);
    expect(outcomes[0]).toMatchObject({ id: 's1', outcome: 'triage_ok:critical', agreed: true });
  });

  test('a weak top score or B5 leaves agreement null; no report → outcome only', async () => {
    let r = await runDeployCauseCheck(INCIDENT, deps(RECENT), { env: SHADOW, sb, now, decideOptions: { call: jest.fn().mockResolvedValue(score(1)) } });
    await recordDeployCauseOutcome(r, { affected_component: 'diary-service.ts', severity: 'warning' }, sb);
    expect(outcomes[0]).toMatchObject({ agreed: null });
    r = await runDeployCauseCheck(INCIDENT, deps([]), { env: SHADOW, sb, now });
    await recordDeployCauseOutcome(r, null, sb);
    expect(outcomes[1]).toMatchObject({ outcome: 'triage_no_report', agreed: null });
  });
});

describe('VTID-04802 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  const svc = fs.readFileSync(path.join(__dirname, '../src/services/self-healing-triage-service.ts'), 'utf8');
  test('started before triage, never awaited before it; outcome after the report or on a failed triage', () => {
    const start = svc.indexOf('const deployCause = isDeployCauseOn() ? runDeployCauseCheck(input, defaultDeployCauseDeps()) : null;');
    const triage = svc.indexOf('// 3. The `triage` stage');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(triage);
    expect(svc).not.toContain('await deployCause');
    expect(svc).toContain('void deployCause.then((dc) => recordDeployCauseOutcome(dc, report));');
    expect(svc).toContain('void deployCause.then((dc) => recordDeployCauseOutcome(dc, null));');
  });
  test('deploys are this environment\'s own completed-deploy events', () => {
    const g = fs.readFileSync(path.join(__dirname, '../src/services/jev/gates/deploy-cause-gate.ts'), 'utf8');
    expect(g).toContain('AWS_DEPLOY_TOPICS[toDeployEnv(VITANA_ENV)].success');
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_SELFHEAL_DEPLOY_CAUSE_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_SELFHEAL_DEPLOY_CAUSE_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_SELFHEAL_DEPLOY_CAUSE_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
