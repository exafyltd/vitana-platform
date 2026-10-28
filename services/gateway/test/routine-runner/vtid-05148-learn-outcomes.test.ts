/**
 * VTID-05148 — learn-outcomes routine (Loop Engineering Phase 4, L3 Learn):
 * tests_added per fix PR, the escaped-bug write_test finding, the three L3
 * metrics and the repeat-failure breach, graduation proposals and their
 * withdrawal, and the guarantee that nothing here writes an eligibility flag
 * or an autonomy level.
 */
import * as fs from 'fs';
import * as path from 'path';
import { checkLearnOutcomes, LearnMetrics } from '../../src/services/routine-runner/checks';
import {
  ClassStats,
  computeEscapedBugsToTests,
  computeLearnMetrics,
  computePatternReuse,
  computeRepeatFailure,
  escapedBugDedupeKey,
  FixRow,
  graduationStats,
  graduationStep,
  isGraduationCandidate,
  isTestFile,
  LearnDeps,
  LearnEvent,
  MAX_PRS_PER_RUN,
  openGraduationProposals,
  OutcomeRow,
  parsePrUrl,
  recordTestsAdded,
  runLearnOutcomes,
  shouldWithdraw,
  testsAddedFrom,
} from '../../src/services/routine-runner/learn-outcomes';
import { resetRoutineRunnerForTest, runDueRoutines, RunnerDeps } from '../../src/services/routine-runner/runner';
import { RUNNER_ROUTINES } from '../../src/services/routine-runner/sources';

const MONDAY = new Date('2026-10-12T12:00:00Z');
const TUESDAY = new Date('2026-10-13T12:00:00Z');

type Route = (path: string) => unknown;

function fakeDeps(opts: {
  routes?: Array<[RegExp, unknown | Route]>;
  github?: boolean;
  prFiles?: (repo: string, n: number) => Promise<Array<{ filename: string; status?: string }>>;
  insertOk?: boolean;
} = {}) {
  const calls = {
    gets: [] as string[],
    patches: [] as Array<{ id: string; diagnosis: Record<string, unknown> }>,
    inserts: [] as any[],
    emits: [] as LearnEvent[],
    prFiles: [] as string[],
  };
  let n = 0;
  const deps: LearnDeps = {
    get: async <T>(p: string): Promise<T> => {
      calls.gets.push(p);
      for (const [re, v] of opts.routes || []) {
        if (re.test(p)) return (typeof v === 'function' ? (v as Route)(p) : v) as T;
      }
      return [] as unknown as T;
    },
    patchDiagnosis: async (id, diagnosis) => { calls.patches.push({ id, diagnosis }); },
    githubConfigured: () => opts.github !== false,
    prFiles: async (repo, num) => {
      calls.prFiles.push(`${repo}#${num}`);
      return opts.prFiles ? opts.prFiles(repo, num) : [];
    },
    insertWriteTestFinding: async (input) => {
      calls.inserts.push(input);
      return opts.insertOk === false ? { ok: false, error: '500' } : { ok: true };
    },
    newId: () => `rec-${++n}`,
    emit: async (e) => { calls.emits.push(e); },
  };
  return { deps, calls };
}

const fixRow = (id: string, pr: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  vtid: `VTID-DA-${id}`,
  endpoint: `services/gateway/src/${id}.ts`,
  diagnosis: { stage: 'execute_run', summary: `fix ${id}`, execution_id: `exec-${id}`, ...(pr ? { pr_url: pr } : {}), ...extra },
});
const PENDING = /self_healing_log\?outcome=eq\.fixed&diagnosis->>pr_url/;

// =============================================================================
// P1 — tests_added
// =============================================================================

describe('test file patterns', () => {
  it.each([
    ['services/gateway/src/foo.test.ts', true],
    ['scripts/ci/staging-verify/lib.test.cjs', true],
    ['e2e/flows/login.spec.ts', true],
    ['services/gateway/test/helpers/fixture.json', true],
    ['src/components/__tests__/Card.tsx', true],
    ['services/gateway/src/routes/foo.ts', false],
    ['docs/testing.md', false],
    ['services/gateway/src/latest/x.ts', false],
    ['src/foo.test.tsx.snap', false],
  ])('%s → %s', (f, expected) => expect(isTestFile(f)).toBe(expected));

  it('keeps added/changed test files, drops non-test files and removed tests', () => {
    expect(testsAddedFrom([
      { filename: 'services/gateway/src/a.ts', status: 'modified' },
      { filename: 'services/gateway/test/a.test.ts', status: 'added' },
      { filename: 'services/gateway/test/old.test.ts', status: 'removed' },
      { filename: 'services/gateway/test/b.test.ts', status: 'modified' },
    ])).toEqual(['services/gateway/test/a.test.ts', 'services/gateway/test/b.test.ts']);
  });

  it('parses a GitHub PR url, nothing else', () => {
    expect(parsePrUrl('https://github.com/exafyltd/vitana-platform/pull/4081')).toEqual({ repo: 'exafyltd/vitana-platform', number: 4081 });
    expect(parsePrUrl('https://github.com/exafyltd/vitana-v1/pull/12/files')).toEqual({ repo: 'exafyltd/vitana-v1', number: 12 });
    expect(parsePrUrl('https://gitlab.com/a/b/pull/1')).toBeNull();
    expect(parsePrUrl(null)).toBeNull();
  });
});

describe('recordTestsAdded (P1)', () => {
  it('a PR with tests: tests_added merged into the WHOLE diagnosis (read-modify-write), no finding', async () => {
    const row = fixRow('a', 'https://github.com/exafyltd/vitana-platform/pull/10');
    const { deps, calls } = fakeDeps({
      routes: [[PENDING, [row]]],
      prFiles: async () => [{ filename: 'services/gateway/src/a.ts' }, { filename: 'services/gateway/test/a.test.ts', status: 'added' }],
    });
    const r = await recordTestsAdded(deps);
    expect(calls.prFiles).toEqual(['exafyltd/vitana-platform#10']);
    expect(calls.patches).toEqual([{ id: 'a', diagnosis: { ...row.diagnosis, tests_added: ['services/gateway/test/a.test.ts'] } }]);
    expect(calls.patches[0].diagnosis).toMatchObject({ summary: 'fix a', execution_id: 'exec-a', pr_url: row.diagnosis.pr_url, stage: 'execute_run' });
    expect(calls.inserts).toEqual([]);
    expect(r).toMatchObject({ state: 'ran', with_tests: 1, without_tests: 0, findings_created: 0 });
  });

  it('selects only fixed rows with a pr_url and no tests_added, newest first, capped at 50', async () => {
    const { deps, calls } = fakeDeps({ routes: [[PENDING, []]] });
    await recordTestsAdded(deps);
    expect(calls.gets[0]).toBe(
      '/rest/v1/self_healing_log?outcome=eq.fixed&diagnosis->>pr_url=not.is.null&diagnosis->tests_added=is.null' +
        '&select=id,vtid,endpoint,diagnosis&order=created_at.desc&limit=50'
    );
  });

  it('at most 50 PRs per run', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => fixRow(`r${i}`, `https://github.com/exafyltd/vitana-platform/pull/${i + 1}`));
    const { deps, calls } = fakeDeps({ routes: [[PENDING, rows]], prFiles: async () => [{ filename: 'test/x.test.ts' }] });
    const r = await recordTestsAdded(deps);
    expect(MAX_PRS_PER_RUN).toBe(50);
    expect(calls.prFiles).toHaveLength(50);
    expect(calls.patches).toHaveLength(50);
    expect(r).toMatchObject({ capped: true });
  });

  it('a GitHub error leaves the row untouched (never written as "no tests"), no finding', async () => {
    const { deps, calls } = fakeDeps({
      routes: [[PENDING, [fixRow('a', 'https://github.com/exafyltd/vitana-platform/pull/10')]]],
      prFiles: async () => { throw new Error('GitHub PR files → 502'); },
    });
    const r = await recordTestsAdded(deps);
    expect(calls.patches).toEqual([]);
    expect(calls.inserts).toEqual([]);
    expect(r).toMatchObject({ github_errors: 1, without_tests: 0 });
  });

  it('a PR without tests: one write_test finding through the missing-test insert, then tests_added []', async () => {
    const row = fixRow('a', 'https://github.com/exafyltd/vitana-platform/pull/10');
    const { deps, calls } = fakeDeps({
      routes: [[PENDING, [row]], [/autopilot_recommendations\?spec_snapshot->>dedupe_key/, []]],
      prFiles: async () => [{ filename: 'services/gateway/src/a.ts' }],
    });
    const r = await recordTestsAdded(deps);
    const key = escapedBugDedupeKey('VTID-DA-a', 'services/gateway/src/a.ts');
    expect(calls.gets[1]).toBe(`/rest/v1/autopilot_recommendations?spec_snapshot->>dedupe_key=eq.${encodeURIComponent(key)}&select=id&limit=1`);
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0]).toMatchObject({
      id: 'rec-1',
      dedupe_key: key,
      capability: 'VTID-DA-a',
      target_endpoint: 'services/gateway/src/a.ts',
      files_referenced: ['services/gateway/src/a.ts'],
      extra_snapshot: { repair_kind: 'write_test', source: 'learn-outcomes', fix_vtid: 'VTID-DA-a', fix_pr_url: row.diagnosis.pr_url, self_healing_log_id: 'a' },
    });
    expect(calls.patches).toEqual([{ id: 'a', diagnosis: { ...row.diagnosis, tests_added: [] } }]);
    expect(r).toMatchObject({ without_tests: 1, findings_created: 1 });
  });

  it('the finding is created once: an existing dedupe_key is not inserted again', async () => {
    const { deps, calls } = fakeDeps({
      routes: [[PENDING, [fixRow('a', 'https://github.com/exafyltd/vitana-platform/pull/10')]], [/dedupe_key/, [{ id: 'old' }]]],
      prFiles: async () => [{ filename: 'README.md' }],
    });
    const r = await recordTestsAdded(deps);
    expect(calls.inserts).toEqual([]);
    expect(calls.patches).toHaveLength(1);
    expect(r).toMatchObject({ findings_deduped: 1, findings_created: 0 });
  });

  it('a failed finding insert leaves the row for the next run', async () => {
    const { deps, calls } = fakeDeps({
      routes: [[PENDING, [fixRow('a', 'https://github.com/exafyltd/vitana-platform/pull/10')]]],
      prFiles: async () => [],
      insertOk: false,
    });
    const r = await recordTestsAdded(deps);
    expect(calls.inserts).toHaveLength(1);
    expect(calls.patches).toEqual([]);
    expect(r).toMatchObject({ write_errors: 1 });
  });

  it('no GitHub token → skipped, nothing read or written', async () => {
    const { deps, calls } = fakeDeps({ github: false });
    expect(await recordTestsAdded(deps)).toEqual({ state: 'skipped', reason: 'github_token_missing' });
    expect(calls.gets).toEqual([]);
  });

  it('an unparsable pr_url is skipped untouched', async () => {
    const { deps, calls } = fakeDeps({ routes: [[PENDING, [fixRow('a', 'not-a-url')]]] });
    const r = await recordTestsAdded(deps);
    expect(calls.prFiles).toEqual([]);
    expect(calls.patches).toEqual([]);
    expect(r).toMatchObject({ unparsable_pr_url: 1 });
  });
});

// =============================================================================
// P3 — metrics
// =============================================================================

const fix = (id: string, endpoint: string, at: string, fc = 'auto_fix_applied', extra: Partial<FixRow> = {}): FixRow => ({
  id, endpoint, failure_class: fc, created_at: at, tests_added: null, repair_pattern_id: null, ...extra,
});

describe('L3 metrics', () => {
  it('a failure on the same endpoint within 7 days after a fix repeats it; later, earlier or elsewhere does not', () => {
    const fixes = [
      fix('1', 'e1', '2026-10-01T00:00:00Z'),
      fix('2', 'e2', '2026-10-01T00:00:00Z'),
      fix('3', 'e3', '2026-10-01T00:00:00Z'),
      fix('4', 'e4', '2026-10-01T00:00:00Z', '5xx'),
    ];
    const followUps = [
      { endpoint: 'e1', created_at: '2026-10-07T23:59:00Z' }, // within 7 days → repeated
      { endpoint: 'e2', created_at: '2026-10-08T00:01:00Z' }, // just outside
      { endpoint: 'e3', created_at: '2026-09-30T00:00:00Z' }, // before the fix
      { endpoint: 'other', created_at: '2026-10-02T00:00:00Z' }, // another endpoint
      { endpoint: 'e4', created_at: '2026-10-08T00:00:00Z' }, // exactly 7 days → counted
    ];
    const r = computeRepeatFailure(fixes, followUps);
    expect(r).toMatchObject({ fixes: 4, repeated: 2, rate: 0.5, follow_up_days: 7, truncated: false });
    expect(r.by_class).toEqual([
      { failure_class: 'auto_fix_applied', fixes: 3, repeated: 1, rate: 1 / 3 },
      { failure_class: '5xx', fixes: 1, repeated: 1, rate: 1 },
    ]);
  });

  it('escaped bugs → tests: rows without tests_added are unknown, never missing', () => {
    const r = computeEscapedBugsToTests([
      fix('1', 'e', 't', 'c', { tests_added: ['test/a.test.ts'] }),
      fix('2', 'e', 't', 'c', { tests_added: [] }),
      fix('3', 'e', 't', 'c', { tests_added: null }),
      fix('4', 'e', 't', 'c', { tests_added: ['x.spec.ts'] }),
    ]);
    expect(r).toEqual({ with_tests: 2, without_tests: 1, unknown: 1, share: 2 / 3 });
    expect(computeEscapedBugsToTests([fix('1', 'e', 't')])).toEqual({ with_tests: 0, without_tests: 0, unknown: 1, share: null });
  });

  it('pattern reuse is not_measured with a reason until a fix records a repair_patterns reference', () => {
    const none = computePatternReuse([fix('1', 'e', 't'), fix('2', 'e', 't')]);
    expect(none.state).toBe('not_measured');
    expect((none as any).reason).toMatch(/repair_pattern/);
    expect(computePatternReuse([fix('1', 'e', 't', 'c', { repair_pattern_id: 'p1' }), fix('2', 'e', 't')]))
      .toEqual({ state: 'measured', fixes: 2, reused: 1, share: 0.5 });
  });
});

describe('checkLearnOutcomes — learn.repeat_failure.high', () => {
  const metrics = (by_class: Array<{ failure_class: string; fixes: number; repeated: number }>): LearnMetrics => ({
    window_days: 30,
    repeat_failure: {
      fixes: by_class.reduce((a, c) => a + c.fixes, 0),
      repeated: by_class.reduce((a, c) => a + c.repeated, 0),
      rate: null,
      follow_up_days: 7,
      by_class: by_class.map((c) => ({ ...c, rate: c.fixes ? c.repeated / c.fixes : null })),
      truncated: false,
    },
    pattern_reuse: { state: 'not_measured', reason: 'r' },
    escaped_bugs_to_tests: { with_tests: 0, without_tests: 0, unknown: 0, share: null },
  });
  const steps = { tests_added: {}, graduation: {} };

  it('breaches above 30 % with at least 5 fixes', () => {
    const v = checkLearnOutcomes(metrics([{ failure_class: 'timeout', fixes: 5, repeated: 2 }]), steps);
    expect(v.status).toBe('partial');
    expect(v.breach).toMatchObject({ topic: 'learn.repeat_failure.high', vtid: 'VTID-05148' });
    expect((v.breach!.payload as any).classes).toEqual([{ failure_class: 'timeout', fixes: 5, repeated: 2, rate: 0.4 }]);
  });

  it('exactly 30 % is not a breach; under 5 fixes is not a breach', () => {
    expect(checkLearnOutcomes(metrics([{ failure_class: 'a', fixes: 10, repeated: 3 }]), steps).breach).toBeUndefined();
    expect(checkLearnOutcomes(metrics([{ failure_class: 'a', fixes: 4, repeated: 4 }]), steps).breach).toBeUndefined();
  });

  it('the run findings carry the three metrics and both step reports', () => {
    const v = checkLearnOutcomes(metrics([]), { tests_added: { state: 'ran' }, graduation: { state: 'skipped' } });
    expect(v.status).toBe('success');
    expect(Object.keys(v.findings)).toEqual(['metrics', 'tests_added_step', 'graduation_step', 'high_repeat_classes']);
    expect(Object.keys((v.findings as any).metrics)).toEqual(['window_days', 'repeat_failure', 'pattern_reuse', 'escaped_bugs_to_tests']);
  });
});

// =============================================================================
// P2 — graduation
// =============================================================================

const outcomes = (scanner: string, risk: string | null, n: number, success: number, extra: Partial<OutcomeRow> = {}): OutcomeRow[] =>
  Array.from({ length: n }, (_, i) => ({
    scanner_name: scanner,
    risk_class: risk,
    exec_outcome: i < success ? 'success' : 'failure',
    human_modified_plan: false,
    ...extra,
  }));

const stats = (rows: OutcomeRow[]): ClassStats => graduationStats(rows)[0];

describe('graduation candidate rule (each boundary)', () => {
  it('needs ≥ 20 executions', () => {
    expect(isGraduationCandidate(stats(outcomes('s', 'low', 19, 19)))).toBe(false);
    expect(isGraduationCandidate(stats(outcomes('s', 'low', 20, 20)))).toBe(true);
  });
  it('needs success ≥ 95 %', () => {
    expect(isGraduationCandidate(stats(outcomes('s', 'low', 20, 19)))).toBe(true); // 95 %
    expect(isGraduationCandidate(stats(outcomes('s', 'low', 20, 18)))).toBe(false); // 90 %
  });
  it('zero rolled_back and zero human-modified plans', () => {
    const rb = [...outcomes('s', 'low', 39, 39), { scanner_name: 's', risk_class: 'low', exec_outcome: 'rolled_back', human_modified_plan: false }];
    expect(isGraduationCandidate(stats(rb))).toBe(false);
    const hm = [...outcomes('s', 'low', 29, 29), ...outcomes('s', 'low', 1, 1, { human_modified_plan: true })];
    expect(isGraduationCandidate(stats(hm))).toBe(false);
  });
  it('a class without a named scanner is never proposed', () => {
    expect(isGraduationCandidate(stats(outcomes('unknown', 'low', 30, 30)))).toBe(false);
  });
  it('groups by (scanner_name, risk_class) and ignores rows without an exec_outcome', () => {
    const s = graduationStats([...outcomes('a', 'low', 2, 2), ...outcomes('a', null, 1, 1), { scanner_name: 'a', risk_class: 'low', exec_outcome: null as any, human_modified_plan: false }]);
    expect(s.map((x) => [x.class_key, x.executions])).toEqual([['a|low', 2], ['a|unknown', 1]]);
  });
  it('withdraw below 90 % or on any rollback; no executions is no evidence', () => {
    expect(shouldWithdraw(stats(outcomes('s', 'low', 10, 9)))).toBe(false); // 90 %
    expect(shouldWithdraw(stats(outcomes('s', 'low', 10, 8)))).toBe(true);
    expect(shouldWithdraw(stats([...outcomes('s', 'low', 10, 10), { scanner_name: 's', risk_class: 'low', exec_outcome: 'rolled_back', human_modified_plan: false }]))).toBe(true);
    expect(shouldWithdraw(undefined)).toBe(false);
  });
  it('open proposals: the latest event per class is a proposal', () => {
    const ev = (topic: string, key: string, at: string) => ({ topic, created_at: at, metadata: { class_key: key } });
    const open = openGraduationProposals([
      ev('learn.graduation.proposed', 'a|low', '2026-10-01T00:00:00Z'),
      ev('learn.graduation.withdrawn', 'a|low', '2026-10-05T00:00:00Z'),
      ev('learn.graduation.proposed', 'b|low', '2026-10-02T00:00:00Z'),
      ev('learn.graduation.withdrawn', 'c|low', '2026-10-01T00:00:00Z'),
      ev('learn.graduation.proposed', 'c|low', '2026-10-06T00:00:00Z'),
      ev('other.topic', 'd|low', '2026-10-06T00:00:00Z'),
    ]);
    expect(open.map((e) => e.metadata!.class_key)).toEqual(['c|low', 'b|low']);
  });
});

describe('graduationStep', () => {
  const OUTCOMES = /dev_autopilot_outcomes\?exec_outcome=not\.is\.null/;
  const EVENTS = /oasis_events\?topic=in\.\(learn\.graduation\.proposed,learn\.graduation\.withdrawn\)/;

  it('runs on Mondays (UTC) only', async () => {
    const { deps, calls } = fakeDeps();
    expect(await graduationStep(deps, TUESDAY)).toEqual({ state: 'skipped', reason: 'graduation runs on Mondays (UTC)' });
    expect(calls.gets).toEqual([]);
  });

  it('proposes a candidate, skips an already-eligible class and a class with an open proposal, withdraws a regressed one', async () => {
    const rows = [
      ...outcomes('good', 'low', 20, 20),
      ...outcomes('eligible', 'low', 25, 25),
      ...outcomes('open', 'low', 30, 30),
      ...outcomes('regressed', 'medium', 10, 8),
    ];
    const events = [
      { id: 'e1', topic: 'learn.graduation.proposed', created_at: '2026-10-05T12:00:00Z', metadata: { class_key: 'open|low' } },
      { id: 'e2', topic: 'learn.graduation.proposed', created_at: '2026-10-05T12:00:00Z', metadata: { class_key: 'regressed|medium' } },
    ];
    const { deps, calls } = fakeDeps({
      routes: [
        [OUTCOMES, (p: string) => (/offset=0$/.test(p) ? rows : [])],
        [EVENTS, events],
        [/autopilot_recommendations\?spec_snapshot->>scanner=eq\.eligible/, [{ auto_exec_eligible: true }, { auto_exec_eligible: true }]],
        [/autopilot_recommendations\?spec_snapshot->>scanner=eq\.good/, [{ auto_exec_eligible: false }, { auto_exec_eligible: true }]],
      ],
    });
    const r = await graduationStep(deps, MONDAY);
    expect(r).toMatchObject({ state: 'ran', proposed: ['good|low'], withdrawn: ['regressed|medium'], already_eligible: ['eligible|low'], open_before: 2 });
    expect(calls.emits.map((e) => [e.type, e.status, e.payload.class_key])).toEqual([
      ['learn.graduation.withdrawn', 'info', 'regressed|medium'],
      ['learn.graduation.proposed', 'info', 'good|low'],
    ]);
    const proposal = calls.emits[1];
    expect(proposal.payload).toMatchObject({ scanner_name: 'good', risk_class: 'low', executions: 20, successes: 20, success_rate: 1, rolled_back: 0, human_modified: 0, window_days: 30 });
    expect(String(proposal.payload.rule)).toMatch(/never applied by code/);
    expect(calls.gets.find((g) => OUTCOMES.test(g))).toContain('&created_at=gte.2026-09-12T12%3A00%3A00.000Z');
  });
});

// =============================================================================
// The whole run, through the runner
// =============================================================================

describe('runLearnOutcomes', () => {
  it('records tests_added, computes the metrics from 30 days of rows, and fails loudly on a read error', async () => {
    const pending = fixRow('a', 'https://github.com/exafyltd/vitana-platform/pull/10');
    const { deps, calls } = fakeDeps({
      routes: [
        [PENDING, [pending]],
        [/outcome=eq\.fixed&created_at=gte\./, (p: string) => (/offset=0$/.test(p) ? [fix('1', 'e1', '2026-10-01T00:00:00Z', 'c', { tests_added: ['t.test.ts'] })] : [])],
        [/outcome=in\.\(pending,failed,escalated\)/, (p: string) => (/offset=0$/.test(p) ? [{ endpoint: 'e1', created_at: '2026-10-02T00:00:00Z' }] : [])],
      ],
      prFiles: async () => [{ filename: 'test/a.test.ts' }],
    });
    const v = await runLearnOutcomes(deps, TUESDAY);
    expect(v.status).toBe('success');
    const m = (v.findings as any).metrics;
    expect(m.repeat_failure).toMatchObject({ fixes: 1, repeated: 1, rate: 1 });
    expect(m.escaped_bugs_to_tests).toMatchObject({ with_tests: 1, unknown: 0 });
    expect((v.findings as any).tests_added_step).toMatchObject({ with_tests: 1 });
    expect((v.findings as any).graduation_step).toMatchObject({ state: 'skipped' });
    expect(calls.gets.some((g) => g.includes('tests_added:diagnosis->tests_added,repair_pattern_id:diagnosis->>repair_pattern_id'))).toBe(true);

    const broken = fakeDeps({ github: false });
    broken.deps.get = async () => { throw new Error('GET /rest/v1/self_healing_log → 500'); };
    await expect(runLearnOutcomes(broken.deps, TUESDAY)).rejects.toThrow(/500/);
  });

  it('is in RUNNER_ROUTINES at 12:00 UTC and a breach goes through the runner like every routine', async () => {
    const entry = RUNNER_ROUTINES.find((r) => r.name === 'learn-outcomes')!;
    expect([entry.hour, entry.minute]).toEqual([12, 0]);
    resetRoutineRunnerForTest();
    const emitted: string[] = [];
    const routed: string[] = [];
    const runnerDeps: RunnerDeps = {
      claim: async () => 'run-1',
      finish: async () => undefined,
      emitBreach: async (_r, v) => { emitted.push(v.breach!.topic); },
      routeBreach: async (r) => { routed.push(r); },
    };
    const routine = {
      name: 'learn-outcomes',
      hour: 12,
      minute: 0,
      run: async () => checkLearnOutcomes(
        computeLearnMetrics(
          Array.from({ length: 5 }, (_, i) => fix(`${i}`, `e${i}`, '2026-10-01T00:00:00Z', 'timeout')),
          [{ endpoint: 'e0', created_at: '2026-10-02T00:00:00Z' }, { endpoint: 'e1', created_at: '2026-10-02T00:00:00Z' }],
        ),
        { tests_added: {}, graduation: {} },
      ),
    };
    expect(await runDueRoutines(runnerDeps, new Date('2026-10-13T11:59:00Z'), [routine])).toEqual([{ name: 'learn-outcomes', outcome: 'not_due' }]);
    const res = await runDueRoutines(runnerDeps, new Date('2026-10-13T12:00:00Z'), [routine]);
    expect(res).toEqual([{ name: 'learn-outcomes', outcome: 'ran', status: 'partial' }]);
    expect(emitted).toEqual(['learn.repeat_failure.high']);
    expect(routed).toEqual(['learn-outcomes']);
    resetRoutineRunnerForTest();
  });
});

// =============================================================================
// Never applied: no code path writes an eligibility flag or an autonomy level
// =============================================================================

describe('graduation is never applied (source guard)', () => {
  const SRC = path.resolve(__dirname, '../../src');
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const files = [
    'services/routine-runner/learn-outcomes.ts',
    'services/routine-runner/checks.ts',
    'services/routine-runner/sources.ts',
    'services/loop-catalog.ts',
  ];
  // routes/autonomy-pulse.ts reads auto_exec_eligible into a finding item's
  // metadata (existing, PR-11); its guard is the no-write-method test below.

  it.each(files)('%s writes no auto_exec_eligible and no autonomy level', (f) => {
    const code = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
    expect(code).not.toMatch(/auto_exec_eligible\s*[:=](?!=)/);
    expect(code).not.toMatch(/autonomy_level/i);
    expect(code).not.toMatch(/setAutonomyLevel|set_autonomy_level/);
  });

  it('learn-outcomes.ts writes only self_healing_log.diagnosis (PATCH), the write_test finding and OASIS events', () => {
    const code = stripComments(fs.readFileSync(path.join(SRC, 'services/routine-runner/learn-outcomes.ts'), 'utf8'));
    const methods = [...code.matchAll(/method:\s*'(\w+)'/g)].map((m) => m[1]);
    expect(methods).toEqual(['PATCH']);
    expect(code).toContain("`${s.url}/rest/v1/self_healing_log?id=eq.${encodeURIComponent(id)}`");
    expect(code).toContain("require('../../routes/test-contracts-missing')");
    expect(code).not.toMatch(/\.from\(['"]/); // no Supabase client writes either
    expect(code).not.toMatch(/routines\?name=eq|system_config|autonomy_settings/);
  });

  it('autonomy-pulse.ts stays read-only (no write method anywhere)', () => {
    const code = stripComments(fs.readFileSync(path.join(SRC, 'routes/autonomy-pulse.ts'), 'utf8'));
    expect(code).not.toMatch(/method:\s*'(POST|PATCH|PUT|DELETE)'/);
  });
});

describe('the spec says what the code does', () => {
  const md = fs.readFileSync(path.resolve(__dirname, '../../../../routines/learn-outcomes.md'), 'utf8');
  it('schedule, thresholds and topics', () => {
    expect(md).toContain('`0 12 * * *`');
    for (const t of ['learn.repeat_failure.high', 'learn.graduation.proposed', 'learn.graduation.withdrawn', 'at most 50 PRs per run', '≥ 20 executions', '≥ 95 %', 'below 90 %', 'within 7 days', 'more than 30 %', 'at least 5 fixes']) {
      expect(md).toContain(t);
    }
  });
});
