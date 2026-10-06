/**
 * VTID-04808: Jev P2 gate A7 — before a green Dev Autopilot PR merges, would
 * merging it make another open one conflict or break? Shadow only.
 */
const rows: any[] = [];
const outcomes: any[] = [];
let openRows: any = { data: [], error: null };
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}` });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
  updateShadowOutcome: jest.fn(async (_sb: unknown, id: string, patch: any) => {
    outcomes.push({ id, ...patch });
    return { data: null, error: null };
  }),
  fetchOpenShadowRowsNamingOther: jest.fn(async () => openRows),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import * as repo from '../src/services/jev/jev-repository';
import {
  MAX_OTHERS, isPrClashOn, overlappingChanges, recordPrClashOutcome, runPrClashCheck, type OpenChange,
} from '../src/services/jev/gates/pr-clash-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_PR_CLASH_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;

const MERGING: OpenChange = { execution_id: 'm1', title: 'Diary: validate empty body', files: ['services/gateway/src/services/diary-service.ts', 'services/gateway/test/diary-service.test.ts'] };
const SAME_FILE: OpenChange = { execution_id: 'o1', title: 'Diary: log entry ids', files: ['services/gateway/src/services/diary-service.ts', 'services/gateway/test/diary-log.test.ts'] };
const SAME_DIR: OpenChange = { execution_id: 'o2', title: 'Reminders: retry', files: ['services/gateway/src/services/reminder-service.ts'] };
const ELSEWHERE: OpenChange = { execution_id: 'o3', title: 'Frontend: label', files: ['services/gateway/src/frontend/command-hub/app.js'] };

function answer(clash: number) {
  return { ok: true, model: 'jev-1.13.0', answers: { clash: { type: 'noul', noul: clash } }, usage: { input_tokens: 300, output_tokens: 1 }, latency_ms: 20, attempts: 1 };
}
const deps = (merging: OpenChange | null, others: OpenChange[]) => ({ loadMerging: jest.fn(async () => merging), loadOthers: jest.fn(async () => others) });

beforeEach(() => {
  rows.length = 0;
  outcomes.length = 0;
  openRows = { data: [], error: null };
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04808 decision and overlap', () => {
  test('pr_clash: internal planes, redacted, one question', () => {
    const d = getJevDecision('pr_clash')!;
    expect(d.pii).toBe('redact');
    expect(d.planes).toEqual(['internal', 'system_autopilot']);
    expect(Object.keys(d.questions)).toEqual(['clash']);
  });
  test('others sharing a file come first, then a directory; unrelated and itself are left out; at most 3', () => {
    const pairs = overlappingChanges(MERGING, [SAME_DIR, ELSEWHERE, SAME_FILE, MERGING]);
    expect(pairs.map((p) => p.other.execution_id)).toEqual(['o1', 'o2']);
    expect(pairs[0]).toMatchObject({ shared_files: ['services/gateway/src/services/diary-service.ts'], shared_dirs: ['services/gateway/src/services', 'services/gateway/test'] });
    const many = Array.from({ length: 6 }, (_, i) => ({ ...SAME_DIR, execution_id: `x${i}` }));
    expect(overlappingChanges(MERGING, many)).toHaveLength(MAX_OTHERS);
  });
});

describe('VTID-04808 gate', () => {
  test('off (default, typo): nothing loaded, asked or written', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_PR_CLASH_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      const d = deps(MERGING, [SAME_FILE]);
      expect(isPrClashOn(env)).toBe(false);
      expect(await runPrClashCheck({ executionId: 'm1', deps: d, env, sb, decideOptions: { call } })).toBeNull();
      expect(d.loadMerging).not.toHaveBeenCalled();
    }
    expect(call).not.toHaveBeenCalled();
  });

  test('shadow: one call per overlapping open change, one row per merge', async () => {
    const call = jest.fn().mockResolvedValueOnce(answer(0.9)).mockResolvedValueOnce(answer(0.1));
    expect(await runPrClashCheck({ executionId: 'm1', deps: deps(MERGING, [SAME_FILE, SAME_DIR, ELSEWHERE]), env: SHADOW, sb, decideOptions: { call } })).toBe('s1');
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][0].state).toEqual({
      merging: { title: MERGING.title, files: MERGING.files },
      other: { title: SAME_FILE.title, files: SAME_FILE.files },
      overlap: { files: ['services/gateway/src/services/diary-service.ts'], directories: ['services/gateway/src/services', 'services/gateway/test'] },
    });
    expect(rows[0]).toMatchObject({
      gate: 'pr_clash', decision: 'pr_clash', mode: 'shadow', subject_type: 'dev_autopilot_execution', subject_ref: 'm1', system_action: 'merged', jev_outcome: 'decided',
      jev_verdict: { others: [{ execution_id: 'o1', shared_files: 1, clash: true, probability: 0.9 }, { execution_id: 'o2', shared_files: 0, shared_dirs: 1, clash: false }] },
    });
  });

  test('nothing open that overlaps, no plan files, or no finding → no call, no row', async () => {
    const call = jest.fn();
    expect(await runPrClashCheck({ executionId: 'm1', deps: deps(MERGING, [ELSEWHERE]), env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(await runPrClashCheck({ executionId: 'm1', deps: deps({ ...MERGING, files: [] }, [SAME_FILE]), env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(await runPrClashCheck({ executionId: 'm1', deps: deps(null, [SAME_FILE]), env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  test('Jev unavailable → a fallback row; a throwing loader → null; never throws', async () => {
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await runPrClashCheck({ executionId: 'm1', deps: deps(MERGING, [SAME_FILE]), env: SHADOW, sb, decideOptions: { call: failing } });
    expect(rows[0]).toMatchObject({ jev_outcome: 'fallback', cost_usd: 0, jev_verdict: { others: [{ clash: null }], reason: expect.any(String) } });
    const broken = { loadMerging: jest.fn(async () => { throw new Error('db'); }), loadOthers: jest.fn() };
    await expect(runPrClashCheck({ executionId: 'm1', deps: broken, env: SHADOW, sb })).resolves.toBeNull();
  });
});

describe('VTID-04808 outcome', () => {
  const ROW = { id: 's7', jev_outcome: 'decided', jev_verdict: { others: [{ execution_id: 'o1aaaaaaaa', clash: true }, { execution_id: 'o2bbbbbbbb', clash: false }, { execution_id: 'o3cccccccc', clash: null }] } };
  test.each([
    ['o1aaaaaaaa', true, 'other_conflicted:o1aaaaaa', true],
    ['o1aaaaaaaa', false, 'other_merged_clean:o1aaaaaa', false],
    ['o2bbbbbbbb', true, 'other_conflicted:o2bbbbbb', false],
    ['o2bbbbbbbb', false, 'other_merged_clean:o2bbbbbb', true],
    ['o3cccccccc', true, 'other_conflicted:o3cccccc', null],
  ])('other %s conflicted=%s → %s, agreed %s', async (id, conflicted, outcome, agreed) => {
    openRows = { data: [ROW], error: null };
    expect(await recordPrClashOutcome(id as string, conflicted as boolean, { sb })).toBe(1);
    expect(outcomes[0]).toMatchObject({ id: 's7', outcome, agreed });
    expect((repo.fetchOpenShadowRowsNamingOther as jest.Mock).mock.calls.slice(-1)[0].slice(1, 3)).toEqual(['pr_clash', id]);
  });
  test('no open row, a read error or no database → nothing; never throws', async () => {
    expect(await recordPrClashOutcome('zz', true, { sb })).toBe(0);
    openRows = { data: null, error: { message: 'x' } };
    expect(await recordPrClashOutcome('zz', true, { sb })).toBe(0);
    expect(await recordPrClashOutcome('zz', true, { sb: null })).toBe(0);
    (repo.fetchOpenShadowRowsNamingOther as jest.Mock).mockImplementationOnce(async () => { throw new Error('db'); });
    await expect(recordPrClashOutcome('zz', true, { sb })).resolves.toBe(0);
    expect(outcomes).toEqual([]);
  });
});

describe('VTID-04808 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  const w = fs.readFileSync(path.join(__dirname, '../src/services/dev-autopilot-watcher.ts'), 'utf8');
  test('asked right before the merge, never awaited; the merge is unchanged', () => {
    const at = w.indexOf('    clashCheckBeforeMerge(s, exec);');
    expect(at).toBeGreaterThan(w.indexOf('// Both gate evaluations passed. Proceed with merge.'));
    expect(w).not.toContain('await clashCheckBeforeMerge');
    expect(w).toContain('void runPrClashCheck({');
    expect(w).toContain('status=in.(ci,merging)&pr_number=not.is.null&id=neq.${exec.id}');
  });
  test('outcomes: a dirty CI failure (both checks) and a CI pass; other failures say nothing', () => {
    expect(w).toContain("if (isPrClashOn() && mState === 'dirty') void recordPrClashOutcome(exec.id, true);");
    expect(w).toContain("if (isPrClashOn() && recheckMState === 'dirty') void recordPrClashOutcome(exec.id, true);");
    expect(w).toContain('if (isPrClashOn()) void recordPrClashOutcome(exec.id, false);');
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_PR_CLASH_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_PR_CLASH_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_PR_CLASH_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
