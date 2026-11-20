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
  failureRegion,
  fingerprintFailure,
  healKey,
  jobKey,
  normalizeLine,
  scriptOutput,
  stripAnsi,
  stripRunnerPrefix,
} from '../../src/services/delivery-loop/fingerprint';
import type { FailedJobFact } from '../../src/services/delivery-loop/types';
import { REAL_SCRIPT_FAILURE_LOG } from './fixtures/gitlab-job-script-failure';

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

  it('the error lines of a real-shaped log have no prefix, no step id and no cleanup noise, and not the runner\'s own failure footer', () => {
    // The footer `ERROR: Job failed: exit code 1` is printed by the runner for every failed script: it says nothing about which failure this is.
    expect(errorLines(runnerLog({ day: '2026-11-18', step: '01', stepEnd: '00' }))).toEqual([
      'error: |-',
      'Expected values to be strictly equal:',
      'expected: 10',
      '# fail 1',
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

/**
 * Found by the real-GitLab rehearsal (job 3941): the repair task was sent `expected: 6,` and the runner's footer, and not the
 * assertion, the values or the place, because the keyword list had `assertion` but `AssertionError` has no word boundary inside it.
 * These tests run on the log that job really printed (fixtures/gitlab-job-script-failure.ts).
 */
describe('a real failed job: node assertion failure on stderr (job 3941 of the rehearsal)', () => {
  it('the error lines name the assertion, its code and the two values, in the order the job printed them', () => {
    expect(errorLines(REAL_SCRIPT_FAILURE_LOG)).toEqual([
      'AssertionError [ERR_ASSERTION]: total of 1,<n>,3 should be 6',
      "code: 'ERR_ASSERTION',",
      'actual: 7,',
      'expected: 6,',
    ]);
  });

  it('the job\'s own output is only what is between the step_script markers: no runner preparation, no cleanup, no footer, no codes, no prefixes', () => {
    const out = scriptOutput(REAL_SCRIPT_FAILURE_LOG);
    const text = out.join('\n');
    expect(text).toContain('AssertionError [ERR_ASSERTION]: total of 1,2,3 should be 6');
    expect(text).toContain('7 !== 6');
    expect(text).toContain('at file:///builds/vitana/rehearsal/test.mjs:4:8');
    expect(text).toContain('$ npm test');
    for (const runnerOnly of ['Running with gitlab-runner', 'Preparing the', 'Dialing instance', 'Getting source from Git', 'Checking out', 'Cleaning up project directory', 'ERROR: Job failed']) {
      expect(text).not.toContain(runnerOnly);
    }
    expect(text).not.toMatch(/section_(start|end)/);
    expect(text).not.toContain('\u001b');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(out.every((l) => l === l.trimEnd())).toBe(true);
  });

  it('the output begins at the first command the script echoed: the runner\'s own lines at the top of the section (executor, pull policy, image digest) are not the job\'s', () => {
    const out = scriptOutput(REAL_SCRIPT_FAILURE_LOG);
    expect(out[0]).toBe('$ node --version');
    const text = out.join('\n');
    for (const runnerOnly of ['Executing "step_script"', 'pull policy', 'Using docker image', 'sha256:']) expect(text).not.toContain(runnerOnly);
    expect(failureRegion(REAL_SCRIPT_FAILURE_LOG).startsWith('$ node --version')).toBe(true);
  });

  it('only when the start of the section is in view: a tail that begins inside the script keeps its first lines, a section with no echoed command keeps all of them', () => {
    const midScript = [
      '2026-11-19T11:16:05.000000Z 01O output of an earlier command',
      '2026-11-19T11:16:05.100000Z 01O \u001b[32;1m$ npm test\u001b[0;m',
      '2026-11-19T11:16:06.000000Z 01E Error: boom',
      '2026-11-19T11:16:07.838506Z 00O section_end:1795086967:step_script\r\u001b[0K',
    ].join('\n');
    expect(scriptOutput(midScript)).toEqual(['output of an earlier command', '$ npm test', 'Error: boom']);
    const noEcho = [
      '2026-11-19T11:16:03.959937Z 00O+section_start:1795086963:step_script\r\u001b[0K',
      '2026-11-19T11:16:03.960042Z 00O+\u001b[0K\u001b[36;1mExecuting "step_script" stage of the job script\u001b[0;m',
      '2026-11-19T11:16:06.000000Z 01E Error: boom',
      '2026-11-19T11:16:07.838506Z 00O section_end:1795086967:step_script\r\u001b[0K',
    ].join('\n');
    expect(scriptOutput(noEcho)).toEqual(['Executing "step_script" stage of the job script', 'Error: boom']);
  });

  it('the failure region is what the repair worker is told: the assertion, the values and the place, as printed (not normalized)', () => {
    const region = failureRegion(REAL_SCRIPT_FAILURE_LOG);
    expect(region).toContain('AssertionError [ERR_ASSERTION]: total of 1,2,3 should be 6'); // "2" is not "<n>": the worker needs the real text
    expect(region).toContain('7 !== 6');
    expect(region).toContain('at file:///builds/vitana/rehearsal/test.mjs:4:8'); // the path and the line are not "<path>" and "<n>"
    expect(region).toContain('actual: 7,');
    expect(region).toContain('expected: 6,');
    expect(region).toContain("operator: 'strictEqual'");
    expect(region).not.toContain('Cleaning up project directory');
    expect(region).not.toContain('ERROR: Job failed');
    expect(region).not.toContain('\u001b');
    expect(region.endsWith('Node.js v20.20.2')).toBe(true);
  });

  it('it is evidence (so a repair is attempted) and it is one fingerprint however many times it fails', () => {
    const a = fingerprintFailure({ project: 'vitana/rehearsal', failedJobs: [job({ id: 3941, name: 'unit' })], traces: { '3941': REAL_SCRIPT_FAILURE_LOG } });
    expect(a.has_evidence).toBe(true);
    expect(a.failure_class).toBe('code');
    expect(a.excerpt).toHaveLength(4);
    // The same failure again: another day, another runner step numbering.
    const again = REAL_SCRIPT_FAILURE_LOG.replace(/2026-11-19T11:1\d/g, '2026-12-03T08:44').replace(/ 01([OE])/g, ' 03$1').replace(/ 00([O+])/g, ' 02$1');
    const b = fingerprintFailure({ project: 'vitana/rehearsal', failedJobs: [job({ id: 4402, name: 'unit' })], traces: { '4402': again } });
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it('a different assertion in that job is a different failure', () => {
    const other = REAL_SCRIPT_FAILURE_LOG.replace('should be 6', 'should be 9').replace('expected: 6,', 'expected: 9,');
    const a = fingerprintFailure({ project: 'vitana/rehearsal', failedJobs: [job({ id: 1, name: 'unit' })], traces: { '1': REAL_SCRIPT_FAILURE_LOG } });
    const b = fingerprintFailure({ project: 'vitana/rehearsal', failedJobs: [job({ id: 1, name: 'unit' })], traces: { '1': other } });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('a script that printed nothing leaves only the runner\'s footer, which is no evidence: nothing to repair from', () => {
    const silent = REAL_SCRIPT_FAILURE_LOG.split('\n')
      .filter((l) => !/ 01[OE]/.test(l)) // drop everything the script printed, keep the runner's sections and its footer
      .join('\n');
    expect(silent).toContain('ERROR: Job failed: exit code 1');
    expect(errorLines(silent)).toEqual([]);
    expect(failureRegion(silent).includes('ERROR: Job failed')).toBe(false);
    expect(fingerprintFailure({ project: 'vitana/rehearsal', failedJobs: [job({ id: 1, name: 'unit' })], traces: { '1': silent } }).has_evidence).toBe(false);
  });
});

describe('which lines say what went wrong', () => {
  it.each([
    ["AssertionError [ERR_ASSERTION]: boom", 'AssertionError [ERR_ASSERTION]: boom'],
    ['TypeError: x is not a function', 'TypeError: x is not a function'],
    ["ModuleNotFoundError: No module named 'yaml'", "ModuleNotFoundError: No module named 'yaml'"],
    ['Caused by: java.lang.NullPointerException', 'Caused by: java.lang.NullPointerException'],
    ["code: 'ERR_MODULE_NOT_FOUND',", "code: 'ERR_MODULE_NOT_FOUND',"],
    ['  actual: 7,', 'actual: 7,'],
    ['  ✕ rejects a negative total (3 ms)', '✕ rejects a negative total (<duration>)'],
    ['  ✖ 2 problems', '✖ 2 problems'],
  ])('%s is an error line', (input, normalized) => {
    expect(errorLines(input)).toEqual([normalized]);
  });

  it.each([
    'a terror of a horror, a mirror, an arrow',
    'Starting the tests with the node runner',
    'ERRATA for the release notes',
    'the AssertionErrorful is not a class name here',
  ])('%s is not', (line) => {
    expect(errorLines(line)).toEqual([]);
  });
});

describe('failureRegion limits', () => {
  const plain = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');

  it('keeps the END of the output, which is where the failure is, at most maxLines', () => {
    const region = failureRegion(plain(200), { maxLines: 10 });
    expect(region.split('\n')).toHaveLength(10);
    expect(region.startsWith('line 191')).toBe(true);
    expect(region.endsWith('line 200')).toBe(true);
  });

  it('cuts at a line boundary when the text is over maxChars, and never starts in the middle of a line', () => {
    const region = failureRegion(plain(500), { maxLines: 500, maxChars: 300 });
    expect(region.length).toBeLessThanOrEqual(300);
    expect(region.split('\n')[0]).toMatch(/^line \d+$/);
    expect(region.endsWith('line 500')).toBe(true);
  });

  it('a single huge line keeps its end', () => {
    const region = failureRegion(`${'x'.repeat(9000)}END`, { maxChars: 100, maxLineChars: 20_000 });
    expect(region).toHaveLength(100);
    expect(region.endsWith('xxxEND')).toBe(true);
  });

  it('a very long line is shortened before the budget is spent on it', () => {
    const region = failureRegion(`short\n${'y'.repeat(5000)}\nlast`, { maxLineChars: 50 });
    expect(region.split('\n')[1]).toHaveLength(51); // 50 characters and the ellipsis
    expect(region.endsWith('last')).toBe(true);
  });

  it('has no blank line at the edges and never two blank lines in a row', () => {
    expect(failureRegion('\n\nfirst\n\n\n\nsecond\n\n\n')).toBe('first\n\nsecond');
  });

  it('is empty for an empty log, for a log that is only the runner\'s, and for one that is only blank lines', () => {
    expect(failureRegion('')).toBe('');
    expect(failureRegion('\n\n  \n')).toBe('');
    expect(failureRegion('2026-11-19T11:16:08.179750Z 00O \u001b[31;1mERROR: Job failed: exit code 1\u001b[0;m\n')).toBe('');
  });

  it('a log that GitLab cut mid-script (no start marker) is the script\'s from its first line; one that was killed (no end marker) from the start marker to the last line', () => {
    const cut = ['2026-11-19T11:16:07.730214Z 01E AssertionError [ERR_ASSERTION]: late', '2026-11-19T11:16:07.838506Z 00O section_end:1795086967:step_script\r\u001b[0K', '2026-11-19T11:16:08.179750Z 00O ERROR: Job failed: exit code 1'].join('\n');
    expect(scriptOutput(cut)).toEqual(['AssertionError [ERR_ASSERTION]: late']);
    const killed = ['2026-11-19T11:16:03.959937Z 00O+section_start:1795086963:step_script\r\u001b[0K', '2026-11-19T11:16:05.000000Z 01O working', '2026-11-19T11:16:06.000000Z 01O still working'].join('\n');
    expect(scriptOutput(killed)).toEqual(['working', 'still working']);
  });
});

describe('stripAnsi on a log with CRLF line endings', () => {
  it('a carriage return before the newline is the end of the line, not a redraw that erases it', () => {
    expect(stripAnsi('first\r\nsecond\r\n')).toBe('first\nsecond\n');
    expect(errorLines('Error: something broke\r\nnext\r\n')).toEqual(['Error: something broke']);
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
    expect(lines.some((l) => l.includes('ERROR: Job failed'))).toBe(false); // the runner's footer, outside the job's own output
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
