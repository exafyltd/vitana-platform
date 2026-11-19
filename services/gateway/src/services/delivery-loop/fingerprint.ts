/**
 * Delivery loop: what a failed pipeline is, as a stable fingerprint. Pure: no I/O, no clock.
 *
 * The fingerprint is the identity of "the same failure" across attempts, branches and pipelines. It is the key of three decisions:
 *   - how many repair attempts one failure has used (the loop stops at `healMaxAttempts` per heal key and escalates),
 *   - whether a repair task for it already exists (one active repair task per heal key),
 *   - what was learned (the repair pattern is stored under it, so the same failure meets its known fix next time).
 *
 * It is built from what makes a failure the same failure and from nothing that changes between runs of it: the project, the
 * failed jobs (name and GitLab's failure_reason), and the error lines of their logs after the volatile parts are normalized away
 * (timestamps, ids, hashes, durations, line numbers, temp paths, colour codes). It does not include the branch, the merge request
 * or the pipeline id, so a failure that comes back on another branch is recognised; the heal key adds the ref where an attempt
 * budget must not be shared between branches.
 */
import { createHash } from 'crypto';
import type { FailedJobFact, FailureClass } from './types';

/**
 * GitLab failure reasons that a retry can fix: the runner, the scheduler or GitLab failed, not the change. The names are
 * GitLab's own (the values of `retry:when`). `job_execution_timeout` is here for the first retry only: if it recurs under the
 * same fingerprint the attempt budget ends the retries and the loop escalates, it does not repair.
 */
export const INFRA_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'runner_system_failure',
  'stuck_or_timeout_failure',
  'scheduler_failure',
  'api_failure',
  'data_integrity_failure',
  'runner_unsupported',
  'stale_schedule',
  'archived_failure',
  'job_execution_timeout',
]);

/** A failure the change itself caused: a job's script exited non-zero. */
export const CODE_FAILURE_REASONS: ReadonlySet<string> = new Set(['script_failure']);

/**
 * `code` when any failed job's script failed; `infra` when every failed job failed for an infrastructure reason; `unknown` when
 * there is no failed job to look at, or a reason that is neither (unknown_failure, unmet_prerequisites, a value this code has not
 * seen): the loop does not repair what it cannot name.
 */
export function classifyFailure(jobs: ReadonlyArray<Pick<FailedJobFact, 'failure_reason'>>): FailureClass {
  if (jobs.length === 0) return 'unknown';
  if (jobs.some((j) => j.failure_reason !== null && CODE_FAILURE_REASONS.has(j.failure_reason))) return 'code';
  if (jobs.every((j) => j.failure_reason !== null && INFRA_FAILURE_REASONS.has(j.failure_reason))) return 'infra';
  return 'unknown';
}

// ---------------------------------------------------------------------------------------------------------
// Log lines
// ---------------------------------------------------------------------------------------------------------

/* eslint-disable no-control-regex */
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const SECTION_RE = /section_(?:start|end):\d+:[^\r\n]*/g;
/* eslint-enable no-control-regex */

/** Colour codes and GitLab's collapsible-section markers removed; carriage-return progress redraws reduced to their last state. */
export function stripAnsi(text: string): string {
  return text
    .replace(SECTION_RE, '')
    .replace(ANSI_RE, '')
    .split('\n')
    .map((line) => {
      const redraws = line.split('\r');
      return redraws[redraws.length - 1];
    })
    .join('\n');
}

/**
 * GitLab's runner prefixes every line of a job log: `2026-11-18T22:27:21.233715Z 01O ` (a timestamp, a two digit step id, `O` for
 * stdout or `E` for stderr) and `+` instead of the space when the line continues the one before. The step id depends on how many
 * sections the run had, so it differs between runs of the same failure: it is not part of the failure.
 */
const RUNNER_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z \d{2}[OE][+ ]/;

export function stripRunnerPrefix(line: string): string {
  return line.replace(RUNNER_PREFIX_RE, '');
}

/** Lines that say what went wrong. Everything else in a job log (the setup, the passing tests) is not part of the failure. */
const ERROR_LINE_RE = /\b(error|errors|failed|failure|fail|exception|cannot|can't|could not|unable to|undefined|not found|denied|refused|timed out|timeout|exit code|exited with|assertion|expected|received|ts\d{4}|eslint|✕|✖)\b|npm ERR!|FAIL |Traceback|panic:|fatal:/i;

/** A line with the parts that change from run to run replaced by a marker, so two runs of one failure give one line. */
export function normalizeLine(line: string): string {
  return line
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s?(?:Z|[+-]\d{2}:?\d{2}))?\b/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{7,64}\b/gi, (m) => (/\d/.test(m) && /[a-f]/i.test(m) ? '<hex>' : m))
    .replace(/\(\s*\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds|m|min)\s*\)/gi, '(<duration>)')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|seconds?|secs?|minutes?|mins?)\b/gi, '<duration>')
    .replace(/(?<=[:(,])\d+(?=[:),])/g, '<n>')
    .replace(/\bline \d+\b/gi, 'line <n>')
    .replace(/(?:\/builds|\/tmp|\/var\/folders|\/home\/[^/\s]+)\/[^\s:)'"]*/g, '<path>')
    .replace(/\b(?:job|pipeline|runner|build|task)[ #:=-]+\d+\b/gi, (m) => m.replace(/\d+/, '<n>'))
    .replace(/\s+/g, ' ')
    .trim();
}

/** At most `max` distinct normalized error lines of a job log, in order. */
export function errorLines(trace: string, max = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const withPrefix of stripAnsi(trace).split('\n')) {
    const raw = stripRunnerPrefix(withPrefix);
    if (!ERROR_LINE_RE.test(raw)) continue;
    const line = normalizeLine(raw).slice(0, 240);
    // A bare keyword ("Error", "FAIL") says nothing about which failure it is; it is noise that one run has and another may not.
    if (line.length < 6 || !line.includes(' ') || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/** "test 2/3" (a parallel job) is the job "test". */
export function jobKey(name: string | null): string {
  return (name ?? 'unnamed').replace(/\s+\d+\/\d+$/, '').slice(0, 120);
}

// ---------------------------------------------------------------------------------------------------------
// The fingerprint
// ---------------------------------------------------------------------------------------------------------

export interface FailureFingerprint {
  /** 16 hex characters: the key of attempts, repair tasks and learned patterns. */
  fingerprint: string;
  failure_class: FailureClass;
  /** `name:failure_reason` of each failed job, sorted, each once. */
  jobs: string[];
  /** The normalized error lines the fingerprint was built from; empty when no log was read. */
  excerpt: string[];
  /** True when at least one error line was read from a log. A `code` failure without one has no evidence to repair from. */
  has_evidence: boolean;
}

export function fingerprintFailure(input: {
  project: string;
  failedJobs: ReadonlyArray<FailedJobFact>;
  /** The tail of each failed job's log by job id; a missing log is a missing key. */
  traces?: Readonly<Record<string, string>>;
}): FailureFingerprint {
  const sorted = [...input.failedJobs].sort((a, b) => (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER));
  const jobs = [...new Set(sorted.map((j) => `${jobKey(j.name)}:${j.failure_reason ?? 'unknown'}`))].sort();

  const excerpt: string[] = [];
  const seen = new Set<string>();
  for (const job of sorted) {
    const trace = job.id === null ? undefined : input.traces?.[String(job.id)];
    if (!trace) continue;
    for (const line of errorLines(trace)) {
      if (seen.has(line)) continue;
      seen.add(line);
      excerpt.push(line);
    }
  }
  const lines = excerpt.slice(0, 12);

  const digest = createHash('sha256').update(['delivery-loop.failure.v1', input.project, ...jobs, '--', ...lines].join('\n')).digest('hex').slice(0, 16);
  return { fingerprint: digest, failure_class: classifyFailure(sorted), jobs, excerpt: lines, has_evidence: lines.length > 0 };
}

/**
 * The key an attempt budget and a repair task are kept under: one failure on one ref of one project. The same failure on another
 * branch has its own budget (a repair of one branch must not use up another's) and the same fingerprint for learning.
 */
export function healKey(project: string, ref: string, fingerprint: string): string {
  return `${project}|${ref}|${fingerprint}`;
}
