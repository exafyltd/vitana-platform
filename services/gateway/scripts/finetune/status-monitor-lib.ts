/**
 * Vertex CustomJob status classifier — Training Ops monitor
 * (BOOTSTRAP-TRAINING-OPS-MONITOR).
 *
 * Pure, side-effect-free classification of a Vertex AI CustomJob describe
 * payload into an operator-facing verdict. Lives separately from the runner
 * (status-monitor.ts) so it can be unit-tested without invoking gcloud.
 *
 * WHY THIS EXISTS: the submit pipeline (submit-job.ts / CRON-FINETUNE-TRAINER)
 * is fire-and-forget — it does NOT wait for the job to finish. Jobs have sat in
 * JOB_STATE_PENDING unnoticed because L4 GPU quota pressure in us-central1 keeps
 * the run QUEUED (Google credits only start once the job STARTS). This module
 * turns the raw Vertex state into a verdict that surfaces that quota-wait case
 * explicitly so an operator can re-submit to a region with quota (the
 * accelerator/region overrides added in PR #2515).
 *
 * Read-only: this never mutates the job. The runner only ever calls
 * `gcloud ai custom-jobs describe` / `list`.
 */

/** Verdict bucket the operator acts on. */
export type FinetuneVerdict =
  | 'PENDING' // accepted, not yet running (may be quota-waiting — see quotaWait)
  | 'RUNNING' // actively training
  | 'SUCCEEDED' // finished OK; weights should be in the output prefix
  | 'FAILED' // failed / cancelled / expired — needs attention
  | 'UNKNOWN'; // no job found or unrecognised state

/** Subset of `gcloud ai custom-jobs describe` fields we classify on. */
export interface VertexJobDescribe {
  name?: string; // full resource path (projects/.../customJobs/<id>)
  displayName?: string;
  state?: string; // e.g. JOB_STATE_PENDING, JOB_STATE_RUNNING
  createTime?: string;
  startTime?: string; // ONLY set once the job actually starts running
  endTime?: string;
  error?: { code?: number; message?: string } | null;
}

export interface FinetuneStatusReport {
  jobId: string | null;
  displayName: string | null;
  state: string;
  verdict: FinetuneVerdict;
  /** True when the job is PENDING and almost certainly blocked on GPU quota. */
  quotaWait: boolean;
  /** True for any verdict that warrants an operator looking now. */
  needsAttention: boolean;
  /** Minutes since createTime (null if unknown). Used for stuck-pending detection. */
  ageMinutes: number | null;
  /** Human-readable one-liner. */
  summary: string;
  errorMessage: string | null;
}

/**
 * A PENDING job older than this (and never started) is treated as a
 * quota-wait — surfaced so the operator re-submits to a region with capacity.
 */
export const STUCK_PENDING_THRESHOLD_MINUTES = 30;

const RUNNING_STATES = new Set(['JOB_STATE_RUNNING']);
const SUCCEEDED_STATES = new Set(['JOB_STATE_SUCCEEDED']);
const FAILED_STATES = new Set([
  'JOB_STATE_FAILED',
  'JOB_STATE_CANCELLED',
  'JOB_STATE_CANCELLING',
  'JOB_STATE_EXPIRED',
]);
const PENDING_STATES = new Set([
  'JOB_STATE_QUEUED',
  'JOB_STATE_PENDING',
  'JOB_STATE_UPDATING',
]);

/** Extract the numeric job id from a full Vertex resource name. */
export function extractJobId(name?: string | null): string | null {
  if (!name) return null;
  const m = name.match(/customJobs\/(\d+)/);
  if (m) return m[1];
  // Already a bare numeric id?
  if (/^\d+$/.test(name)) return name;
  return null;
}

export function mapStateToVerdict(state: string | undefined | null): FinetuneVerdict {
  if (!state) return 'UNKNOWN';
  if (RUNNING_STATES.has(state)) return 'RUNNING';
  if (SUCCEEDED_STATES.has(state)) return 'SUCCEEDED';
  if (FAILED_STATES.has(state)) return 'FAILED';
  if (PENDING_STATES.has(state)) return 'PENDING';
  return 'UNKNOWN';
}

function diffMinutes(fromIso?: string, nowMs?: number): number | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return null;
  const now = nowMs ?? Date.now();
  return Math.max(0, Math.round((now - t) / 60000));
}

/**
 * Detect the L4-quota-wait case: a job that Vertex ACCEPTED (pending/queued)
 * but never STARTED, and has been waiting past the stuck threshold. There is
 * no explicit "waiting on quota" field in describe output for a queued
 * CustomJob, so we infer it: state is pending AND startTime is unset AND it's
 * been queued longer than STUCK_PENDING_THRESHOLD_MINUTES.
 */
export function isQuotaWait(job: VertexJobDescribe, nowMs?: number): boolean {
  const verdict = mapStateToVerdict(job.state);
  if (verdict !== 'PENDING') return false;
  if (job.startTime) return false; // it started -> not stuck queued
  const age = diffMinutes(job.createTime, nowMs);
  if (age === null) return false;
  return age >= STUCK_PENDING_THRESHOLD_MINUTES;
}

/** Classify a single describe payload into the operator-facing report. */
export function classifyJob(job: VertexJobDescribe, nowMs?: number): FinetuneStatusReport {
  const jobId = extractJobId(job.name);
  const state = job.state ?? 'UNKNOWN';
  const verdict = mapStateToVerdict(state);
  const quotaWait = isQuotaWait(job, nowMs);
  const ageMinutes = diffMinutes(job.createTime, nowMs);
  const errorMessage = job.error?.message ?? null;

  // FAILED always needs attention; a quota-stuck PENDING does too (operator
  // should re-submit to a region with quota). Plain RUNNING/PENDING/SUCCEEDED
  // do not.
  const needsAttention = verdict === 'FAILED' || quotaWait || verdict === 'UNKNOWN';

  let summary: string;
  switch (verdict) {
    case 'RUNNING':
      summary = `Job ${jobId ?? '?'} is RUNNING${
        ageMinutes !== null ? ` (queued+running ${ageMinutes}m)` : ''
      }.`;
      break;
    case 'SUCCEEDED':
      summary = `Job ${jobId ?? '?'} SUCCEEDED — weights should be in the output prefix.`;
      break;
    case 'FAILED':
      summary = `Job ${jobId ?? '?'} ${state}${errorMessage ? `: ${errorMessage}` : ''}.`;
      break;
    case 'PENDING':
      summary = quotaWait
        ? `Job ${jobId ?? '?'} stuck PENDING for ${ageMinutes}m and never started — likely GPU quota wait. ` +
          'Re-submit to a region with capacity (accelerator/region overrides).'
        : `Job ${jobId ?? '?'} is PENDING${
            ageMinutes !== null ? ` (${ageMinutes}m)` : ''
          } — accepted, not yet started.`;
      break;
    default:
      summary = jobId
        ? `Job ${jobId} has unrecognised state ${state}.`
        : 'No matching CustomJob found.';
  }

  return {
    jobId,
    displayName: job.displayName ?? null,
    state,
    verdict,
    quotaWait,
    needsAttention,
    ageMinutes,
    summary,
    errorMessage,
  };
}

/**
 * Pick the latest job from a `gcloud ai custom-jobs list` array by createTime
 * (descending). Used to find the most recent voice-tool-router run. Returns
 * null for an empty list.
 */
export function pickLatestJob(jobs: VertexJobDescribe[]): VertexJobDescribe | null {
  if (!jobs.length) return null;
  return [...jobs].sort((a, b) => {
    const ta = Date.parse(a.createTime ?? '') || 0;
    const tb = Date.parse(b.createTime ?? '') || 0;
    return tb - ta;
  })[0];
}

/** Map a verdict onto an OASIS event status field. */
export function verdictToEventStatus(
  verdict: FinetuneVerdict,
): 'success' | 'warning' | 'error' | 'info' {
  switch (verdict) {
    case 'SUCCEEDED':
      return 'success';
    case 'FAILED':
      return 'error';
    case 'PENDING':
      return 'warning'; // includes quota-wait
    case 'RUNNING':
      return 'info';
    default:
      return 'warning';
  }
}
