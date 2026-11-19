/**
 * Delivery loop failure fingerprint (services/delivery-loop/fingerprint.ts).
 *
 * The fingerprint is "the same failure" across attempts, branches and pipelines: it keys the repair attempt budget, the one-repair-
 * task-per-failure rule and the learned pattern. So the properties that matter are (1) two runs of one failure, whose logs differ in
 * timestamps, ids, hashes, durations and paths, give ONE fingerprint, and (2) a different failure gives a different one.
 */
import {
  CODE_FAILURE_REASONS,
  INFRA_FAILURE_REASONS,
  classifyFailure,
  errorLines,
  fingerprintFailure,
  healKey,
  jobKey,
  normalizeLine,
  stripAnsi,
  stripRunnerPrefix,
} from '../../src/services/delivery-loop/fingerprint';
import type { FailedJobFact } from '../../src/services/delivery-loop/types';

const PROJECT = 'vitana/vitana-platform';
const job = (over: Partial<FailedJobFact> = {}): FailedJobFact => ({ id: 14, name: 'unit-tests', stage: 'test', failure_reason: 'script_failure', exit_code: 1, ...over });

/** A jest failure log as a GitLab runner prints it; the volatile parts are parameters. */
function jestLog(v: { time: string; sha: string; secs: string; job: number; line: number; uuid: string; tmp: string }) {
  return [
    `Running with gitlab-runner 17.0.0 (abc1234) on fleet-runner-${v.job} xK3dQ`,
    `\u001b[0;33mPreparing the "docker" executor\u001b[0;m`,
    `section_start:${v.job}:step_script\r\u001b[0K\u001b[36;1mExecuting "step_script" stage of the job script\u001b[0;m`,
    `$ npx jest test/delivery`,
    `[${v.time}] starting run for commit ${v.sha}`,
    `PASS test/delivery/a.test.ts (3.2 s)`,
    `FAIL test/delivery/gitlab-delivery-mapping.test.ts (${v.secs} s)`,
    `  ● issue intake › an issue opened with the intake label`,
    `    expect(received).toEqual(expected) // deep equality`,
    `    Expected: "scm.gitlab.issue.opened"`,
    `    Received: undefined`,
    `      at Object.<anonymous> (${v.tmp}/builds/vitana/vitana-platform/services/gateway/test/delivery/gitlab-delivery-mapping.test.ts:${v.line}:42)`,
    `request ${v.uuid} finished in ${v.secs} seconds`,
    `Tests: 1 failed, 83 passed, 84 total`,
    `section_end:${v.job}:step_script\r\u001b[0K`,
    `\u001b[31;1mERROR: Job failed: exit code 1\u001b[0;m`,
  ].join('\n');
}
const RUN_A = jestLog({ time: '2026-11-18T10:00:01.123Z', sha: 'e1844355ae169d0c1f740eb57c220273122574c2', secs: '4.2', job: 5001, line: 120, uuid: '3f2b8c1e-0a4d-4f5e-9c7b-1d2e3f4a5b6c', tmp: '/tmp/build-aaa' });
const RUN_B = jestLog({ time: '2026-11-19T22:45:59.987Z', sha: 'ad1b7b35f6aa11bb22cc33dd44ee55ff66778899', secs: '5.9', job: 5733, line: 120, uuid: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', tmp: '/tmp/build-zzz' });

/**
 * A failing job log in the exact form GitLab's runner prints it (read from a real failed job of the rehearsal project, 2026-11-18):
 * every line starts with a timestamp, a two digit step id and O (stdout) or E (stderr); `+` replaces the space on a continuation.
 * The step id and the timestamps differ between runs of one failure.
 */
function runnerLog(v: { day: string; step: string; stepEnd: string }) {
  const t = (s: number) => `${v.day}T22:27:${String(s).padStart(2, '0')}.233715Z`;
  return [
    `${t(20)} ${v.step}O ok 1 - handles the empty case`,
    `${t(21)} ${v.step}O not ok 2 - rejects a negative total`,
    `${t(21)} ${v.step}O   ---`,
    `${t(21)} ${v.step}O   error: |-`,
    `${t(21)} ${v.step}O     Expected values to be strictly equal:`,
    `${t(21)} ${v.step}O     expected: 10`,
    `${t(21)} ${v.step}O # fail 1`,
    `${t(21)} ${v.step}O # duration_ms 63.255881`,
    `${t(21)} ${v.stepEnd}O section_end:1795040841:step_script\u001b[0K`,
    `${t(21)} ${v.stepEnd}O+\u001b[0K\u001b[36;1mCleaning up project directory\u001b[0;m`,
    `${t(21)} ${v.stepEnd}O \u001b[31;1mERROR: Job failed: exit code 1\u001b[0;m`,
  ].join('\n');
}

describe('the runner prefix of a real job log', () => {
  it('stripRunnerPrefix removes the timestamp, the step id and the stream, and the + of a continuation', () => {
    expect(stripRunnerPrefix('2026-11-18T22:27:21.233715Z 01O # fail 1')).toBe('# fail 1');
    expect(stripRunnerPrefix('2026-11-18T22:27:21.233715Z 02E warning: x')).toBe('warning: x');
    expect(stripRunnerPrefix('2026-11-18T22:27:21.336770Z 00O+continued line')).toBe('continued line');
    expect(stripRunnerPrefix('2026-11-18T22:27:21Z 10O whole seconds')).toBe('whole seconds');
    expect(stripRunnerPrefix('no prefix here')).toBe('no prefix here');
    expect(stripRunnerPrefix('2026-11-18T22:27:21.233715Z 1O too short a step id')).toBe('2026-11-18T22:27:21.233715Z 1O too short a step id');
  });

  it('the error lines of a real-shaped log have no prefix, no step id and no cleanup noise', () => {
    expect(errorLines(runnerLog({ day: '2026-11-18', step: '01', stepEnd: '00' }))).toEqual([
      'error: |-',
      'Expected values to be strictly equal:',
      'expected: 10',
      '# fail 1',
      'ERROR: Job failed: exit code 1',
    ]);
  });

  it('two runs of one failure that differ only in the day, the timestamps and the step ids are one fingerprint', () => {
    const a = fingerprintFailure({ project: 'vitana/rehearsal', failedJobs: [job({ id: 3477, name: 'unit' })], traces: { '3477': runnerLog({ day: '2026-11-18', step: '01', stepEnd: '00' }) } });
    const b = fingerprintFailure({ project: 'vitana/rehearsal', failedJobs: [job({ id: 3999, name: 'unit' })], traces: { '3999': runnerLog({ day: '2026-12-02', step: '03', stepEnd: '02' }) } });
    expect(a.has_evidence).toBe(true);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('a different assertion in the same job is a different fingerprint', () => {
    const base = runnerLog({ day: '2026-11-18', step: '01', stepEnd: '00' });
    const a = fingerprintFailure({ project: 'vitana/rehearsal', failedJobs: [job({ id: 1, name: 'unit' })], traces: { '1': base } });
    const b = fingerprintFailure({ project: 'vitana/rehearsal', failedJobs: [job({ id: 1, name: 'unit' })], traces: { '1': base.replace('expected: 10', 'expected: 11') } });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('classifyFailure', () => {
  it('code when a job script failed, infra when every job failed for GitLab or the runner, unknown otherwise', () => {
    expect(classifyFailure([{ failure_reason: 'script_failure' }])).toBe('code');
    expect(classifyFailure([{ failure_reason: 'runner_system_failure' }, { failure_reason: 'script_failure' }])).toBe('code');
    expect(classifyFailure([{ failure_reason: 'runner_system_failure' }])).toBe('infra');
    expect(classifyFailure([{ failure_reason: 'stuck_or_timeout_failure' }, { failure_reason: 'api_failure' }])).toBe('infra');
    expect(classifyFailure([{ failure_reason: 'unknown_failure' }])).toBe('unknown');
    expect(classifyFailure([{ failure_reason: 'unmet_prerequisites' }])).toBe('unknown');
    expect(classifyFailure([{ failure_reason: 'a_value_gitlab_added_later' }])).toBe('unknown');
    expect(classifyFailure([{ failure_reason: null }])).toBe('unknown');
    expect(classifyFailure([{ failure_reason: 'runner_system_failure' }, { failure_reason: null }])).toBe('unknown');
  });

  it('no failed job to look at is unknown, never code', () => {
    expect(classifyFailure([])).toBe('unknown');
  });

  it('the two reason sets do not overlap, and script_failure is the only code reason', () => {
    for (const r of CODE_FAILURE_REASONS) expect(INFRA_FAILURE_REASONS.has(r)).toBe(false);
    expect([...CODE_FAILURE_REASONS]).toEqual(['script_failure']);
  });
});

describe('stripAnsi', () => {
  it('removes colour codes and GitLab section markers, and keeps the last state of a carriage-return redraw', () => {
    expect(stripAnsi('\u001b[31;1mERROR: Job failed\u001b[0;m')).toBe('ERROR: Job failed');
    expect(stripAnsi('section_start:1700000000:step_script\r\u001b[0Kdoing it')).toBe('doing it');
    expect(stripAnsi('progress 10%\rprogress 55%\rprogress 100%\nnext line')).toBe('progress 100%\nnext line');
    expect(stripAnsi('\u001b[?25l\u001b[2Kcursor and erase\u001b[0m')).toBe('cursor and erase');
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('normalizeLine', () => {
  it.each([
    ['2026-11-18T10:00:01.123Z boom', '<time> boom'],
    ['2026-11-18 10:00:01 +0100 boom', '<time> boom'],
    ['at 10:00:01.5 boom', 'at <time> boom'],
    ['request 3f2b8c1e-0a4d-4f5e-9c7b-1d2e3f4a5b6c failed', 'request <uuid> failed'],
    ['commit e1844355ae169d0c1f740eb57c220273122574c2 failed', 'commit <hex> failed'],
    ['FAIL x.test.ts (4.2 s)', 'FAIL x.test.ts (<duration>)'],
    ['took 350 ms', 'took <duration>'],
    ['finished in 5.9 seconds', 'finished in <duration>'],
    ['at Object.<anonymous> (a/b.test.ts:120:42)', 'at Object.<anonymous> (a/b.test.ts:<n>:<n>)'],
    ['error on line 77', 'error on line <n>'],
    ['cannot open /builds/vitana/vitana-platform/x.ts', 'cannot open <path>'],
    ['cannot open /tmp/build-aaa/x.ts', 'cannot open <path>'],
    ['  lots   of    space  ', 'lots of space'],
    ['runner 5733 lost', 'runner <n> lost'],
  ])('%s', (input, expected) => {
    expect(normalizeLine(input)).toBe(expected);
  });

  it('leaves the words of an error alone, including words that happen to be hex letters', () => {
    expect(normalizeLine('Error: cannot find module "deadbeef-utils" decade facade')).toBe('Error: cannot find module "deadbeef-utils" decade facade');
    expect(normalizeLine('TS2345: Argument of type string is not assignable')).toBe('TS2345: Argument of type string is not assignable');
  });
});

describe('errorLines', () => {
  it('keeps the lines that say what went wrong, and none of the setup or the passing tests', () => {
    const lines = errorLines(RUN_A);
    expect(lines.some((l) => l.includes('FAIL test/delivery/gitlab-delivery-mapping.test.ts'))).toBe(true);
    expect(lines.some((l) => l.includes('Expected: "scm.gitlab.issue.opened"'))).toBe(true);
    expect(lines.some((l) => l.includes('ERROR: Job failed: exit code 1'))).toBe(true);
    expect(lines.some((l) => l.includes('Preparing'))).toBe(false);
    expect(lines.some((l) => l.includes('PASS'))).toBe(false);
    expect(lines.some((l) => l.includes('starting run'))).toBe(false);
  });

  it('gives the same lines for two runs that differ only in volatile parts', () => {
    expect(errorLines(RUN_A)).toEqual(errorLines(RUN_B));
  });

  it('keeps each distinct line once, in order, at most `max`', () => {
    const log = Array.from({ length: 30 }, (_, i) => `Error: failure number ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? 'x' : ''}`).join('\nError: failure number A\n');
    const lines = errorLines(log, 5);
    expect(lines).toHaveLength(5);
    expect(new Set(lines).size).toBe(5);
    expect(lines[0]).toBe('Error: failure number A');
  });

  it('is empty for a log with no error line, an empty log, or only bare keywords that say nothing about which failure it is', () => {
    expect(errorLines('all good\nnothing to see\n')).toEqual([]);
    expect(errorLines('')).toEqual([]);
    expect(errorLines('fail\nError\nFAIL\nERROR\n  failed  \n')).toEqual([]);
    expect(errorLines('Error: x')).toEqual(['Error: x']); // two tokens: kept
  });

  it('cuts a very long line', () => {
    expect(errorLines(`Error: ${'x'.repeat(1000)}`)[0]).toHaveLength(240);
  });
});

describe('jobKey', () => {
  it('a parallel job "test 2/3" is the job "test"; a missing name is "unnamed"; a long name is cut', () => {
    expect(jobKey('test 2/3')).toBe('test');
    expect(jobKey('rspec 10/12')).toBe('rspec');
    expect(jobKey('unit-tests')).toBe('unit-tests');
    expect(jobKey('lane 2/3 final')).toBe('lane 2/3 final');
    expect(jobKey(null)).toBe('unnamed');
    expect(jobKey('x'.repeat(300))).toHaveLength(120);
  });
});

describe('fingerprintFailure', () => {
  const fp = (jobs: FailedJobFact[], traces?: Record<string, string>, project = PROJECT) => fingerprintFailure({ project, failedJobs: jobs, traces });

  it('is 16 hex characters, with the class, the jobs and the evidence it was built from', () => {
    const f = fp([job()], { '14': RUN_A });
    expect(f.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(f.failure_class).toBe('code');
    expect(f.jobs).toEqual(['unit-tests:script_failure']);
    expect(f.has_evidence).toBe(true);
    expect(f.excerpt.length).toBeGreaterThan(0);
  });

  it('two runs of the same failure give ONE fingerprint, though their logs differ in time, ids, hashes, durations and paths', () => {
    expect(fp([job({ id: 14 })], { '14': RUN_A }).fingerprint).toBe(fp([job({ id: 9001 })], { '9001': RUN_B }).fingerprint);
  });

  it('a different error is a different fingerprint', () => {
    const other = RUN_A.replace('Expected: "scm.gitlab.issue.opened"', 'Expected: "scm.gitlab.issue.closed"');
    expect(fp([job()], { '14': other }).fingerprint).not.toBe(fp([job()], { '14': RUN_A }).fingerprint);
  });

  it('a different job, a different failure reason or a different project is a different fingerprint', () => {
    const base = fp([job()], { '14': RUN_A }).fingerprint;
    expect(fp([job({ name: 'lint' })], { '14': RUN_A }).fingerprint).not.toBe(base);
    expect(fp([job({ failure_reason: 'runner_system_failure' })], { '14': RUN_A }).fingerprint).not.toBe(base);
    expect(fp([job()], { '14': RUN_A }, 'vitana/vitana-v1').fingerprint).not.toBe(base);
  });

  it('the order of the jobs and of their ids does not matter, and a parallel job is one job', () => {
    const a = fp([job({ id: 1, name: 'lint' }), job({ id: 2, name: 'unit-tests' })], { '1': 'Error: lint broke', '2': 'Error: unit broke' });
    const b = fp([job({ id: 2, name: 'unit-tests' }), job({ id: 1, name: 'lint' })], { '2': 'Error: unit broke', '1': 'Error: lint broke' });
    expect(a.fingerprint).toBe(b.fingerprint);
    const split = fp([job({ id: 1, name: 'test 1/3' }), job({ id: 2, name: 'test 2/3' }), job({ id: 3, name: 'test 3/3' })], { '2': 'Error: boom' });
    expect(split.jobs).toEqual(['test:script_failure']);
  });

  it('without a log it is built from the jobs alone, and says it has no evidence', () => {
    const f = fp([job()]);
    expect(f.has_evidence).toBe(false);
    expect(f.excerpt).toEqual([]);
    expect(f.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(f.fingerprint).not.toBe(fp([job()], { '14': RUN_A }).fingerprint);
  });

  it('a log with no error line is no evidence', () => {
    expect(fp([job()], { '14': 'all good\n' }).has_evidence).toBe(false);
  });

  it('a log for a job id that is not failed is ignored; a job without an id has no log', () => {
    expect(fp([job({ id: 14 })], { '77': RUN_A }).has_evidence).toBe(false);
    expect(fp([job({ id: null })], { 'null': RUN_A }).has_evidence).toBe(false);
  });

  it('an infra failure is classified infra, so it is retried and not repaired', () => {
    expect(fp([job({ failure_reason: 'runner_system_failure', exit_code: null })]).failure_class).toBe('infra');
  });

  it('no failed job is unknown', () => {
    const f = fp([]);
    expect(f.failure_class).toBe('unknown');
    expect(f.jobs).toEqual([]);
  });

  it('is pinned: changing it would orphan every attempt budget and learned pattern', () => {
    // Both values were computed outside this code: sha256 of the lines joined by \n, first 16 hex characters.
    expect(fp([job({ id: 1 })], { '1': 'Error: boom\n' }).fingerprint).toBe('1fa07224c3897566');
    expect(fp([job({ id: 1 })]).fingerprint).toBe('9d708813b2e7e4b7');
  });
});

describe('healKey', () => {
  it('is one failure on one ref of one project; another branch has its own budget', () => {
    expect(healKey(PROJECT, 'kiro/x/y', 'abc')).toBe('vitana/vitana-platform|kiro/x/y|abc');
    expect(healKey(PROJECT, 'kiro/x/y', 'abc')).not.toBe(healKey(PROJECT, 'kiro/x/z', 'abc'));
    expect(healKey(PROJECT, 'main', 'abc')).not.toBe(healKey('vitana/vitana-v1', 'main', 'abc'));
  });
});
