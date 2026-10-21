/**
 * VTID-04804: Jev P2 gate C2 — voice backstop firings clustered per day and
 * judged as defect candidates. Shadow only.
 */
const rows: any[] = [];
const seen = new Set<string>();
let diag: any = { data: [], error: null };
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}` });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
  fetchVoiceDiagEvents: jest.fn(async () => diag),
  fetchRecentShadowBySubject: jest.fn(async (_sb: unknown, _gate: string, ref: string) => ({ data: seen.has(ref) ? { id: 'old' } : null, error: null })),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import * as repo from '../src/services/jev/jev-repository';
import {
  BACKSTOP_STAGES, MIN_FIRINGS, clusterBackstops, clusterKey, isBackstopClustersOn, runBackstopClusterDay,
  startBackstopClusterScheduler, stopBackstopClusterSchedulerForTest,
} from '../src/services/jev/gates/backstop-cluster-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_VOICE_BACKSTOP_CLUSTERS_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;
const DAY = '2026-09-30';

function fire(stage: string, sub: Record<string, string>, session: string, env = 'staging', turn_count = 4) {
  return { metadata: { stage, ...sub, session_id: session, env, turn_count } };
}
const ROWS = [
  ...[1, 2, 3, 4].map((i) => fire('remember_backstop', { reason: 'claimed_without_call' }, `s${i % 2}`)),
  ...[1, 2, 3].map((i) => fire('recall_backstop', { outcome: 'denied' }, `s${i}`, 'staging', 6)),
  fire('tool_loop_guard', {}, 's9'),
  fire('tool_loop_guard', {}, 's9'),
  fire('remember_backstop', { reason: 'claimed_without_call' }, 'p1', 'production'),
  fire('orb_session_opened', {}, 's1'),
];

function answer(defect: number, kind = 'prompt_instruction') {
  return {
    ok: true, model: 'jev-1.13.0',
    answers: { defect: { type: 'noul', noul: defect }, kind: { type: 'choice', choice: kind, probabilities: { [kind]: 0.8 }, confidence: 0.8 } },
    usage: { input_tokens: 300, output_tokens: 2 }, latency_ms: 20, attempts: 1,
  };
}

beforeEach(() => {
  rows.length = 0;
  seen.clear();
  diag = { data: ROWS, error: null };
  (repo.fetchVoiceDiagEvents as jest.Mock).mockClear();
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterEach(() => stopBackstopClusterSchedulerForTest());
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04804 decision', () => {
  test('backstop_cluster_defect: telemetry, internal planes, no PII, defect + kind', () => {
    const d = getJevDecision('backstop_cluster_defect')!;
    expect(d.data).toBe('telemetry');
    expect(d.pii).toBe('forbid');
    expect(d.planes).toEqual(['internal', 'system_autopilot']);
    expect(Object.keys(d.questions)).toEqual(['defect', 'kind']);
    expect(Object.keys((d.questions.kind as any).criteria)).toContain('expected_safety_net');
  });
});

describe('VTID-04804 clustering', () => {
  test('groups by stage + sub-cause, this environment only, biggest first; non-backstop stages ignored', () => {
    const c = clusterBackstops(ROWS, 'staging');
    expect(c).toEqual([
      { stage: 'remember_backstop', sub: 'claimed_without_call', firings: 4, sessions: 2, avg_turns: 4 },
      { stage: 'recall_backstop', sub: 'denied', firings: 3, sessions: 3, avg_turns: 6 },
      { stage: 'tool_loop_guard', sub: 'none', firings: 2, sessions: 1, avg_turns: 4 },
    ]);
    expect(clusterBackstops(ROWS, 'production')).toEqual([{ stage: 'remember_backstop', sub: 'claimed_without_call', firings: 1, sessions: 1, avg_turns: 4 }]);
    expect(clusterKey('staging', DAY, c[0])).toBe('staging:2026-09-30:remember_backstop:claimed_without_call');
    expect(Object.keys(BACKSTOP_STAGES)).toContain('remember_hold_dropped');
  });
});

describe('VTID-04804 gate', () => {
  test('off (default, typo): nothing read, asked or written', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_VOICE_BACKSTOP_CLUSTERS_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      expect(isBackstopClustersOn(env)).toBe(false);
      expect(await runBackstopClusterDay(DAY, { env, sb, vitanaEnv: 'staging', decideOptions: { call } })).toBe(0);
      expect(startBackstopClusterScheduler(env)).toBe(false);
    }
    expect(repo.fetchVoiceDiagEvents).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  test(`clusters with at least ${MIN_FIRINGS} firings are judged, one row each, counts only`, async () => {
    const call = jest.fn().mockResolvedValueOnce(answer(0.9)).mockResolvedValueOnce(answer(0.1, 'expected_safety_net'));
    expect(await runBackstopClusterDay(DAY, { env: SHADOW, sb, vitanaEnv: 'staging', decideOptions: { call } })).toBe(2);
    const [, stages, since, until] = (repo.fetchVoiceDiagEvents as jest.Mock).mock.calls[0];
    expect(stages).toEqual(Object.keys(BACKSTOP_STAGES));
    expect([since, until]).toEqual(['2026-09-30T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][0].state.cluster).toMatchObject({ stage: 'remember_backstop', sub_cause: 'claimed_without_call', firings: 4, sessions: 2, window_hours: 24 });
    expect(JSON.stringify(call.mock.calls[0][0].state)).not.toContain('"s0"');
    expect(rows[0]).toMatchObject({
      gate: 'voice_backstop_clusters', decision: 'backstop_cluster_defect', mode: 'shadow', plane: 'internal', tenant_id: null,
      subject_type: 'voice_backstop_cluster', subject_ref: 'staging:2026-09-30:remember_backstop:claimed_without_call',
      jev_outcome: 'decided', system_action: 'no_finding',
      jev_verdict: { defect: true, probability: 0.9, kind: 'prompt_instruction', firings: 4, day: DAY },
    });
    expect(rows[1]).toMatchObject({ jev_verdict: { defect: false, kind: 'expected_safety_net', stage: 'recall_backstop' } });
  });

  test('a cluster already judged for that day is not asked again', async () => {
    seen.add('staging:2026-09-30:remember_backstop:claimed_without_call');
    const call = jest.fn().mockResolvedValue(answer(0.9));
    expect(await runBackstopClusterDay(DAY, { env: SHADOW, sb, vitanaEnv: 'staging', decideOptions: { call } })).toBe(1);
    expect(call).toHaveBeenCalledTimes(1);
    expect(rows[0].subject_ref).toBe('staging:2026-09-30:recall_backstop:denied');
  });

  test('Jev unavailable → a fallback row; a read error or a throwing read → 0; never throws', async () => {
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await runBackstopClusterDay(DAY, { env: SHADOW, sb, vitanaEnv: 'staging', decideOptions: { call: failing } });
    expect(rows[0]).toMatchObject({ jev_outcome: 'fallback', jev_confidence: null, cost_usd: 0, jev_verdict: { reason: expect.any(String), firings: 4 } });
    diag = { data: null, error: { message: 'timeout' } };
    expect(await runBackstopClusterDay(DAY, { env: SHADOW, sb, vitanaEnv: 'staging' })).toBe(0);
    (repo.fetchVoiceDiagEvents as jest.Mock).mockImplementationOnce(async () => { throw new Error('db'); });
    await expect(runBackstopClusterDay(DAY, { env: SHADOW, sb, vitanaEnv: 'staging' })).resolves.toBe(0);
    expect(await runBackstopClusterDay(DAY, { env: SHADOW, sb: null, vitanaEnv: 'staging' })).toBe(0);
  });
});

describe('VTID-04804 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  test('the scheduler starts from index.ts, guarded, non-fatal', () => {
    const idx = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
    expect(idx).toContain("require('./services/jev/gates/backstop-cluster-gate')");
    expect(idx).toContain('if (startBackstopClusterScheduler())');
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_VOICE_BACKSTOP_CLUSTERS_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_VOICE_BACKSTOP_CLUSTERS_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_VOICE_BACKSTOP_CLUSTERS_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
