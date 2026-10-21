/**
 * VTID-04807: Jev P2 gate A5 — suites that import changed code but are not run
 * by the agent runner, judged for relevance and compared with CI. Shadow only.
 */
const rows: any[] = [];
const outcomes: any[] = [];
let recent: any = { data: null, error: null };
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}` });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
  updateShadowOutcome: jest.fn(async (_sb: unknown, id: string, patch: any) => {
    outcomes.push({ id, ...patch });
    return { data: null, error: null };
  }),
  fetchRecentShadowRow: jest.fn(async () => recent),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MAX_CANDIDATES, collectTestSelectionInput, extractTestTitles, failingSuites, isTestSelectionOn, recordTestSelectionOutcome, runTestSelectionCheck,
} from '../src/services/jev/gates/test-selection-gate';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' } as NodeJS.ProcessEnv;
const SHADOW = { ...JEV_ON, JEV_TEST_SELECTION_MODE: 'shadow' } as NodeJS.ProcessEnv;
const sb = {} as any;

let repoDir: string;
function write(rel: string, content: string) {
  const p = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-04807-'));
  write('services/gateway/test/diary-service.test.ts', "import { createEntry } from '../src/services/diary-service';\ndescribe('paired', () => {});");
  write('services/gateway/test/diary-routes.test.ts', "import router from '../src/routes/diary';\nimport { createEntry } from '../src/services/diary-service';\ndescribe('diary routes', () => { test('POST creates an entry', () => {}); it.each([[1]])('handles %s', () => {}); });");
  write('services/gateway/test/sub/reminders.test.ts', "const svc = require('../../src/services/diary-service.ts');\ntest(\"reminder reads the diary\", () => {});");
  write('services/gateway/test/unrelated.test.ts', "import { other } from '../src/services/other';\ntest('x', () => {});");
  write('services/gateway/test/diary-service-extra.test.ts', "import { x } from '../src/services/diary-service-extra';\ntest('near-miss stem', () => {});");
  write('services/gateway/test/new-case.test.ts', "import { createEntry } from '../src/services/diary-service';\ntest('changed in this diff', () => {});");
});
afterAll(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  setDefaultJevControlForTest(null);
});
beforeEach(() => {
  rows.length = 0;
  outcomes.length = 0;
  recent = { data: null, error: null };
  setDefaultJevControlForTest(createMemoryJevControl().control);
});

const CHANGED = ['services/gateway/src/services/diary-service.ts', 'services/gateway/test/new-case.test.ts'];

function answer(run: number) {
  return { ok: true, model: 'jev-1.13.0', answers: { run: { type: 'noul', noul: run } }, usage: { input_tokens: 300, output_tokens: 1 }, latency_ms: 20, attempts: 1 };
}

describe('VTID-04807 decision', () => {
  test('test_suite_relevance: internal planes, redacted, one question', () => {
    const d = getJevDecision('test_suite_relevance')!;
    expect(d.pii).toBe('redact');
    expect(d.planes).toEqual(['internal', 'system_autopilot']);
    expect(Object.keys(d.questions)).toEqual(['run']);
  });
});

describe('VTID-04807 candidates', () => {
  test('importers of a changed module, minus the paired suite, changed tests, near-miss stems and unrelated suites', () => {
    const input = collectTestSelectionInput(repoDir, CHANGED)!;
    expect(input.candidates.map((c) => c.path)).toEqual([
      'services/gateway/test/diary-routes.test.ts',
      'services/gateway/test/sub/reminders.test.ts',
    ]);
    expect(input.candidates[0]).toMatchObject({ imports_changed: ['diary-service'], test_titles: ['diary routes', 'POST creates an entry', 'handles %s'] });
    expect(input.importers_total).toBe(2);
    expect(input.changed_files).toEqual(CHANGED);
  });
  test('nothing to judge: only tests changed, no importers, or files outside a service', () => {
    expect(collectTestSelectionInput(repoDir, ['services/gateway/test/new-case.test.ts'])).toBeNull();
    expect(collectTestSelectionInput(repoDir, ['services/gateway/src/services/nobody-imports-me.ts'])).toBeNull();
    expect(collectTestSelectionInput(repoDir, ['docs/x.md'])).toBeNull();
    expect(collectTestSelectionInput('/does/not/exist', CHANGED)).toBeNull();
  });
  test('titles and failing suites are read from text', () => {
    expect(extractTestTitles("describe('a', () => { test(`b`, () => {}); });")).toEqual(['a', 'b']);
    expect(failingSuites([{ check_name: 'Gateway', excerpt: 'PASS test/a.test.ts\nFAIL test/diary-routes.test.ts\n  ● x\nFAIL  services/gateway/test/sub/reminders.test.ts' }, { check_name: 'y', excerpt: 'FAIL test/z.test.ts', unavailable: true }]))
      .toEqual(['diary-routes.test.ts', 'reminders.test.ts']);
    expect(MAX_CANDIDATES).toBe(8);
  });
});

describe('VTID-04807 gate', () => {
  const input = () => collectTestSelectionInput(repoDir, CHANGED)!;

  test('off (default, typo): nothing asked or written', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_TEST_SELECTION_MODE: 'on' }] as NodeJS.ProcessEnv[]) {
      expect(isTestSelectionOn(env)).toBe(false);
      expect(await runTestSelectionCheck({ executionId: 'e1', title: 'Fix diary', input: input(), env, sb, decideOptions: { call } })).toBeNull();
    }
    expect(call).not.toHaveBeenCalled();
  });

  test('shadow: one call per candidate, one row with Jev\'s picks', async () => {
    const call = jest.fn().mockResolvedValueOnce(answer(0.9)).mockResolvedValueOnce(answer(0.1));
    expect(await runTestSelectionCheck({ executionId: 'e2', title: 'Fix diary empty body', input: input(), env: SHADOW, sb, decideOptions: { call } })).toBe('s1');
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][0].state).toEqual({
      change: { title: 'Fix diary empty body', files: CHANGED },
      suite: { path: 'services/gateway/test/diary-routes.test.ts', imports: ['diary-service'], titles: ['diary routes', 'POST creates an entry', 'handles %s'] },
    });
    expect(rows[0]).toMatchObject({
      gate: 'test_selection', decision: 'test_suite_relevance', mode: 'shadow', subject_type: 'dev_autopilot_execution', subject_ref: 'e2',
      system_action: 'runner_paired_suites_only', jev_outcome: 'decided',
      jev_verdict: { jev_selected: ['services/gateway/test/diary-routes.test.ts'], importers_total: 2, candidates: [{ run: true, probability: 0.9 }, { run: false, probability: 0.1 }] },
    });
  });

  test('Jev unavailable → a fallback row with no picks; never throws', async () => {
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await runTestSelectionCheck({ executionId: 'e3', title: 't', input: input(), env: SHADOW, sb, decideOptions: { call: failing } });
    expect(rows[0]).toMatchObject({ jev_outcome: 'fallback', cost_usd: 0, jev_verdict: { jev_selected: [], reason: expect.any(String) } });
    await expect(runTestSelectionCheck({ executionId: 'e4', title: 't', input: null as any, env: SHADOW, sb })).resolves.toBeNull();
  });
});

describe('VTID-04807 outcome', () => {
  const row = { id: 's9', jev_outcome: 'decided', jev_verdict: { candidates: [{ path: 'services/gateway/test/diary-routes.test.ts', run: true }, { path: 'services/gateway/test/sub/reminders.test.ts', run: false }] } };
  const ev = (txt: string) => [{ check_name: 'Gateway Service Tests', excerpt: txt }];

  test.each([
    [{ passed: true }, 'ci_passed', null],
    [{ passed: false, evidence: ev('error TS2345') }, 'ci_failed_no_jest_suite', null],
    [{ passed: false, evidence: ev('FAIL test/unrelated.test.ts') }, 'ci_jest_failed:outside_candidates', null],
    [{ passed: false, evidence: ev('FAIL test/diary-routes.test.ts') }, 'ci_jest_failed:jev_selected', true],
    [{ passed: false, evidence: ev('FAIL test/sub/reminders.test.ts') }, 'ci_jest_failed:jev_skipped', false],
  ])('CI %j → %s, agreed %s', async (ci, outcome, agreed) => {
    recent = { data: row, error: null };
    await recordTestSelectionOutcome('e9', ci as any, { sb });
    expect(outcomes[0]).toMatchObject({ id: 's9', outcome, agreed });
  });

  test('no row, a read error or no database → nothing; never throws', async () => {
    await recordTestSelectionOutcome('e9', { passed: true }, { sb });
    recent = { data: null, error: { message: 'x' } };
    await recordTestSelectionOutcome('e9', { passed: true }, { sb });
    await recordTestSelectionOutcome('e9', { passed: true }, { sb: null });
    expect(outcomes).toEqual([]);
  });
});

describe('VTID-04807 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  test('runner: listed after the runner checks pass and before the PR contract, never awaited', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/autopilot-agent/run-agent-execution.ts'), 'utf8');
    const at = src.indexOf('const selInput = collectTestSelectionInput(repoDir, changed.map((c) => c.path));');
    expect(at).toBeGreaterThan(src.indexOf("if (!finished) return finish({ ok: false, error: 'agent did not finish'"));
    expect(at).toBeLessThan(src.indexOf('const contract = applyPrContract({'));
    expect(src).toContain('if (selInput) void runTestSelectionCheck({ executionId, title: finished.pr_title, input: selInput });');
  });
  test('watcher: the outcome on CI failure and on CI pass, never awaited', () => {
    const w = fs.readFileSync(path.join(__dirname, '../src/services/dev-autopilot-watcher.ts'), 'utf8');
    expect(w).toContain('if (isTestSelectionOn()) void recordTestSelectionOutcome(exec.id, { passed: false, evidence });');
    expect(w).toContain('if (isTestSelectionOn()) void recordTestSelectionOutcome(exec.id, { passed: true });');
  });
  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_TEST_SELECTION_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_TEST_SELECTION_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_TEST_SELECTION_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
