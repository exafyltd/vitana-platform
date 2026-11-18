/**
 * VTID-05547 (plan agentic-delivery §3.12, §10): the Delivery screen's numbers, from OASIS rows and VTID
 * ledger rows only (VTID-01170 read-path lock). Pure: the route (routes/delivery.ts) reads the rows and
 * calls these. A figure with no source in the rows is null, never 0 (plan §10 Measurement).
 *
 * Rows are the oasis_events columns the screen needs; metadata is what the GitLab delivery stage
 * (delivery-mapper.ts) and the GitHub-era deploy and verify writers put there.
 *
 * Exactly once: each event carries metadata.dedupe_key, and readers keep the first (earliest) row per key.
 * Shadow rows (metadata.mode 'shadow') are left out unless asked for.
 */

export interface EventRow {
  id?: string;
  created_at: string;
  vtid?: string | null;
  topic: string;
  status?: string | null;
  message?: string | null;
  service?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface LedgerRow {
  vtid: string;
  title?: string | null;
  status?: string | null;
  is_terminal?: boolean | null;
  terminal_outcome?: string | null;
}

/** Every topic the screen reads; the route asks OASIS for exactly these. */
export const DELIVERY_READ_TOPICS = [
  'scm.gitlab.merge_request.opened',
  'scm.gitlab.merge_request.updated',
  'scm.gitlab.merge_request.merged',
  'scm.gitlab.merge_request.closed',
  'scm.gitlab.pipeline.started',
  'scm.gitlab.pipeline.succeeded',
  'scm.gitlab.pipeline.failed',
  'scm.gitlab.pipeline.canceled',
  'delivery.landed',
  'delivery.merge.refused',
  'scm.migration.cutover',
  'staging.deploy.completed',
  'staging.deploy.failed',
  'staging.deploy.rolled_back',
  'staging.verify.passed',
  'staging.verify.failed',
  'staging.verify.superseded',
] as const;

const MR_TOPICS = new Set(DELIVERY_READ_TOPICS.filter((t) => t.startsWith('scm.gitlab.merge_request.')));
const PIPELINE_TOPICS = new Set(DELIVERY_READ_TOPICS.filter((t) => t.startsWith('scm.gitlab.pipeline.')));

type Meta = Record<string, unknown>;
const meta = (r: EventRow): Meta => (r.metadata && typeof r.metadata === 'object' ? r.metadata : {});
const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const t = (r: EventRow): number => {
  const ms = Date.parse(r.created_at);
  return Number.isFinite(ms) ? ms : 0;
};
const byTimeAsc = (a: EventRow, b: EventRow) => t(a) - t(b);

/** Ascending by time; the first row per metadata.dedupe_key is kept, rows with no key all stay. */
export function dedupeRows(rows: EventRow[]): EventRow[] {
  const seen = new Set<string>();
  const out: EventRow[] = [];
  for (const r of [...rows].sort(byTimeAsc)) {
    const key = s(meta(r).dedupe_key);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(r);
  }
  return out;
}

export const isShadow = (r: EventRow): boolean => meta(r).mode === 'shadow';

/** The rows the screen works from: deduped, and without shadow rows unless included. Ascending. */
export function prepareRows(rows: EventRow[], includeShadow: boolean): EventRow[] {
  const deduped = dedupeRows(rows);
  return includeShadow ? deduped : deduped.filter((r) => !isShadow(r));
}

// ---------------------------------------------------------------------------------------------------------
// Merge queue
// ---------------------------------------------------------------------------------------------------------

export interface QueueItem {
  position: number | null;
  vtid: string | null;
  merge_request_iid: number;
  lane_key: string | null;
  state_label: string;
  since: string;
  wait_s: number;
  head_sha: string | null;
  url: string | null;
  mode: string | null;
}
export interface RepoQueue {
  paused: boolean;
  items: QueueItem[];
}

/** updating is being landed now, then ready by accept time, then waiting; blocked and paused are listed last, with no position. */
const QUEUE_RANK: Record<string, number> = { 'queue-updating': 0, 'queue-ready': 1, 'queue-waiting': 2, 'queue-blocked': 3, 'queue-paused': 4 };

export function buildMergeQueue(rows: EventRow[], nowMs: number): Record<string, RepoQueue> {
  const byMr = new Map<string, EventRow[]>();
  for (const r of rows) {
    if (!MR_TOPICS.has(r.topic as never)) continue;
    const m = meta(r);
    const repo = s(m.repo);
    const iid = n(m.merge_request_iid);
    if (!repo || iid === null) continue;
    const k = `${repo}#${iid}`;
    byMr.set(k, [...(byMr.get(k) ?? []), r]);
  }
  const out: Record<string, RepoQueue> = {};
  for (const list of byMr.values()) {
    list.sort(byTimeAsc);
    const last = list[list.length - 1];
    if (last.topic !== 'scm.gitlab.merge_request.opened' && last.topic !== 'scm.gitlab.merge_request.updated') continue; // merged or closed: off the queue
    const lm = meta(last);
    const label = s(lm.queue_label);
    const repo = s(lm.repo) as string;
    out[repo] ??= { paused: false, items: [] };
    if (!label) continue;
    let sinceRow = last;
    for (let i = list.length - 2; i >= 0 && s(meta(list[i]).queue_label) === label; i--) sinceRow = list[i];
    out[repo].items.push({
      position: null,
      vtid: s(last.vtid),
      merge_request_iid: n(lm.merge_request_iid) as number,
      lane_key: s(lm.lane_key),
      state_label: label,
      since: sinceRow.created_at,
      wait_s: Math.max(0, Math.round((nowMs - t(sinceRow)) / 1000)),
      head_sha: s(lm.head_sha),
      url: s(lm.url),
      mode: s(lm.mode),
    });
  }
  for (const q of Object.values(out)) {
    q.items.sort((a, b) => (QUEUE_RANK[a.state_label] ?? 9) - (QUEUE_RANK[b.state_label] ?? 9) || Date.parse(a.since) - Date.parse(b.since));
    let pos = 0;
    for (const item of q.items) item.position = (QUEUE_RANK[item.state_label] ?? 9) <= 2 ? ++pos : null;
    q.paused = q.items.some((i) => i.state_label === 'queue-paused');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------------------------------------

export interface PipelineItem {
  pipeline_id: number | null;
  merge_request_iid: number | null;
  ref: string | null;
  sha: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'canceled';
  vtid: string | null;
  wait_s: number | null;
  run_s: number | null;
  jobs_failed: number;
  url: string | null;
  at: string;
  mode: string | null;
}
export interface MainState {
  state: 'green' | 'red' | 'running' | 'unknown';
  pipeline_id: number | null;
  sha: string | null;
  since: string | null;
  url: string | null;
}
export interface RepoPipelines {
  main: MainState;
  items: PipelineItem[];
}

const PIPELINE_STATUS: Record<string, PipelineItem['status']> = {
  'scm.gitlab.pipeline.started': 'running',
  'scm.gitlab.pipeline.succeeded': 'succeeded',
  'scm.gitlab.pipeline.failed': 'failed',
  'scm.gitlab.pipeline.canceled': 'canceled',
};

export function buildPipelines(rows: EventRow[], limitPerRepo = 25): Record<string, RepoPipelines> {
  const latest = new Map<string, EventRow>();
  for (const r of [...rows].sort(byTimeAsc)) {
    if (!PIPELINE_TOPICS.has(r.topic as never)) continue;
    const m = meta(r);
    const repo = s(m.repo);
    if (!repo) continue;
    latest.set(`${repo}|${n(m.pipeline_id) ?? r.id ?? r.created_at}`, r);
  }
  const perRepo = new Map<string, EventRow[]>();
  for (const r of latest.values()) {
    const repo = s(meta(r).repo) as string;
    perRepo.set(repo, [...(perRepo.get(repo) ?? []), r]);
  }
  const out: Record<string, RepoPipelines> = {};
  for (const [repo, list] of perRepo) {
    list.sort((a, b) => t(b) - t(a));
    // The latest pipeline per merge request (or per ref when it has none).
    const seen = new Set<string>();
    const items: PipelineItem[] = [];
    for (const r of list) {
      const m = meta(r);
      const group = n(m.merge_request_iid) !== null ? `mr${n(m.merge_request_iid)}` : `ref:${s(m.ref) ?? '?'}`;
      if (seen.has(group)) continue;
      seen.add(group);
      const jobs = Array.isArray(m.jobs) ? (m.jobs as Array<Record<string, unknown>>) : [];
      items.push({
        pipeline_id: n(m.pipeline_id),
        merge_request_iid: n(m.merge_request_iid),
        ref: s(m.ref),
        sha: s(m.sha),
        status: PIPELINE_STATUS[r.topic],
        vtid: s(r.vtid),
        wait_s: n(m.queued_s),
        run_s: n(m.duration_s),
        jobs_failed: jobs.filter((j) => j && j.status === 'failed').length,
        url: s(m.url),
        at: r.created_at,
        mode: s(m.mode),
      });
    }
    const mainRow = list.find((r) => s(meta(r).ref) === 'main' && meta(r).tag !== true);
    const mm = mainRow ? meta(mainRow) : {};
    const state: MainState['state'] = !mainRow
      ? 'unknown'
      : mainRow.topic === 'scm.gitlab.pipeline.succeeded'
        ? 'green'
        : mainRow.topic === 'scm.gitlab.pipeline.failed'
          ? 'red'
          : mainRow.topic === 'scm.gitlab.pipeline.started'
            ? 'running'
            : 'unknown';
    out[repo] = {
      main: { state, pipeline_id: n(mm.pipeline_id), sha: s(mm.sha), since: mainRow ? mainRow.created_at : null, url: s(mm.url) },
      items: items.slice(0, limitPerRepo),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------------------------------------

export interface DeployItem {
  service: string | null;
  commit: string | null;
  status: 'completed' | 'failed' | 'rolled_back';
  at: string;
  host: 'gitlab' | 'github';
  workflow: string | null;
}
export interface VerifyItem {
  service: string | null;
  commit: string | null;
  outcome: string;
  at: string;
  run_url: string | null;
  workflow: string | null;
}

const DEPLOY_STATUS: Record<string, DeployItem['status']> = {
  'staging.deploy.completed': 'completed',
  'staging.deploy.failed': 'failed',
  'staging.deploy.rolled_back': 'rolled_back',
};

/** The latest staging deploy per service and the latest STAGING-VERIFY per service (service ids differ between the two writers, so they are listed apart). */
export function buildReleases(rows: EventRow[]): { deploys: DeployItem[]; verifications: VerifyItem[]; latest_verify: VerifyItem | null } {
  const deploys = new Map<string, DeployItem>();
  const verifies = new Map<string, VerifyItem>();
  for (const r of [...rows].sort(byTimeAsc)) {
    const m = meta(r);
    if (r.topic in DEPLOY_STATUS) {
      const service = s(m.service) ?? s(r.service);
      deploys.set(service ?? '?', {
        service,
        commit: s(m.git_commit) ?? s(m.commit),
        status: DEPLOY_STATUS[r.topic],
        at: r.created_at,
        host: m.host === 'gitlab' ? 'gitlab' : 'github',
        workflow: s(m.workflow),
      });
    } else if (r.topic.startsWith('staging.verify.')) {
      const service = s(m.service);
      verifies.set(service ?? '?', {
        service,
        commit: s(m.commit),
        outcome: s(m.outcome) ?? r.topic.slice('staging.verify.'.length),
        at: r.created_at,
        run_url: s(m.run_url),
        workflow: s(m.workflow),
      });
    }
  }
  const verifications = [...verifies.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    deploys: [...deploys.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    verifications,
    latest_verify: verifications[0] ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Metrics (live rows only; the caller leaves shadow rows out)
// ---------------------------------------------------------------------------------------------------------

export interface Spread {
  p50: number;
  p95: number;
  n: number;
}

/** Nearest-rank percentiles; null for no values. */
export function spread(values: number[]): Spread | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const at = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
  return { p50: at(0.5), p95: at(0.95), n: v.length };
}

export interface DeliveryMetrics {
  window_hours: number;
  /** Seconds from the first finished job's wait + run: the first result of a pipeline. */
  first_result_s: Spread | null;
  /** Pipeline seconds of finished merge request pipelines (running time; the required checks). */
  required_checks_s: Spread | null;
  accept_to_main_s: Spread | null;
  landings_per_hour: Record<string, number> | null;
  queue_depth: Record<string, number> | null;
  landing_to_verify_s: Spread | null;
  staging_verify_pass_rate: { value: number; n: number } | null;
  change_failure_rate: { value: number; landings: number; signals: string[]; missing_signals: string[] } | null;
  time_to_restore_s: Spread | null;
  /** Machine counts and cost stay in CloudWatch (plan §3.12); OASIS has no source for it. */
  cost_per_day: null;
}

const DAY_MS = 24 * 3600 * 1000;

export function buildMetrics(rows: EventRow[], nowMs: number, windowHours: number): DeliveryMetrics {
  const asc = [...rows].sort(byTimeAsc);
  const landed = asc.filter((r) => r.topic === 'delivery.landed');

  const firstResults: number[] = [];
  const checks: number[] = [];
  for (const r of asc) {
    if (r.topic !== 'scm.gitlab.pipeline.succeeded' && r.topic !== 'scm.gitlab.pipeline.failed') continue;
    const m = meta(r);
    const jobs = (Array.isArray(m.jobs) ? m.jobs : []) as Array<Record<string, unknown>>;
    const done = jobs.filter((j) => j && (j.status === 'success' || j.status === 'failed') && n(j.run_s) !== null);
    if (done.length > 0) firstResults.push(Math.min(...done.map((j) => (n(j.wait_s) ?? 0) + (n(j.run_s) as number))));
    if (n(m.merge_request_iid) !== null && n(m.duration_s) !== null) checks.push(n(m.duration_s) as number);
  }

  const landingsPerHour: Record<string, number> = {};
  for (const r of landed) {
    const repo = s(meta(r).repo);
    if (repo) landingsPerHour[repo] = (landingsPerHour[repo] ?? 0) + 1;
  }
  for (const repo of Object.keys(landingsPerHour)) landingsPerHour[repo] = Math.round((landingsPerHour[repo] / windowHours) * 10000) / 10000;

  const queue = buildMergeQueue(asc, nowMs);
  const depth: Record<string, number> = {};
  for (const [repo, q] of Object.entries(queue)) depth[repo] = q.items.length;

  const verifyRows = asc.filter((r) => r.topic === 'staging.verify.passed' || r.topic === 'staging.verify.failed');
  const landingToVerify: number[] = [];
  for (const l of landed) {
    const v = s(l.vtid);
    const next = v ? verifyRows.find((r) => t(r) >= t(l) && Array.isArray(meta(r).vtids) && (meta(r).vtids as unknown[]).includes(v)) : undefined;
    if (next) landingToVerify.push(Math.round((t(next) - t(l)) / 1000));
  }
  const passed = verifyRows.filter((r) => r.topic === 'staging.verify.passed').length;

  // Change failure: a landing followed within 24 hours by a red main (any repo's main pipeline of the same repo) or a failed STAGING-VERIFY for its VTID.
  let failures = 0;
  for (const l of landed) {
    const lm = meta(l);
    const v = s(l.vtid);
    const redMain = asc.some(
      (r) =>
        r.topic === 'scm.gitlab.pipeline.failed' && s(meta(r).ref) === 'main' && s(meta(r).repo) === s(lm.repo) && t(r) >= t(l) && t(r) - t(l) <= DAY_MS,
    );
    const badVerify = !!v && verifyRows.some((r) => r.topic === 'staging.verify.failed' && t(r) >= t(l) && t(r) - t(l) <= DAY_MS && Array.isArray(meta(r).vtids) && (meta(r).vtids as unknown[]).includes(v));
    if (redMain || badVerify) failures++;
  }

  // Time to restore: a failed main pipeline to the next successful one of the same repo.
  const restore: number[] = [];
  const redSince = new Map<string, number>();
  for (const r of asc) {
    const m = meta(r);
    if (s(m.ref) !== 'main' || m.tag === true) continue;
    const repo = s(m.repo);
    if (!repo) continue;
    if (r.topic === 'scm.gitlab.pipeline.failed' && !redSince.has(repo)) redSince.set(repo, t(r));
    else if (r.topic === 'scm.gitlab.pipeline.succeeded' && redSince.has(repo)) {
      restore.push(Math.round((t(r) - (redSince.get(repo) as number)) / 1000));
      redSince.delete(repo);
    }
  }

  return {
    window_hours: windowHours,
    first_result_s: spread(firstResults),
    required_checks_s: spread(checks),
    accept_to_main_s: spread(landed.map((r) => n(meta(r).accept_to_land_s)).filter((x): x is number => x !== null)),
    landings_per_hour: Object.keys(landingsPerHour).length > 0 ? landingsPerHour : null,
    queue_depth: Object.keys(depth).length > 0 ? depth : null,
    landing_to_verify_s: spread(landingToVerify),
    staging_verify_pass_rate: verifyRows.length > 0 ? { value: Math.round((passed / verifyRows.length) * 1000) / 1000, n: verifyRows.length } : null,
    change_failure_rate:
      landed.length > 0
        ? {
            value: Math.round((failures / landed.length) * 1000) / 1000,
            landings: landed.length,
            signals: ['red_main', 'staging_verify_failed'],
            missing_signals: ['revert', 'production_rollback'],
          }
        : null,
    time_to_restore_s: spread(restore),
    cost_per_day: null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// VTID titles and status from the ledger
// ---------------------------------------------------------------------------------------------------------

export interface LedgerView {
  title: string | null;
  status: string | null;
  is_terminal: boolean | null;
  terminal_outcome: string | null;
}

export function indexLedger(rows: LedgerRow[]): Record<string, LedgerView> {
  const out: Record<string, LedgerView> = {};
  for (const r of rows) {
    if (r && typeof r.vtid === 'string') {
      out[r.vtid] = { title: s(r.title), status: s(r.status), is_terminal: typeof r.is_terminal === 'boolean' ? r.is_terminal : null, terminal_outcome: s(r.terminal_outcome) };
    }
  }
  return out;
}

/** Every real VTID the summary mentions (BOOTSTRAP-* ids have no ledger row). */
export function vtidsOf(parts: { queue: Record<string, RepoQueue>; pipelines: Record<string, RepoPipelines> }): string[] {
  const set = new Set<string>();
  for (const q of Object.values(parts.queue)) for (const i of q.items) if (i.vtid && /^VTID-\d{5}$/.test(i.vtid)) set.add(i.vtid);
  for (const p of Object.values(parts.pipelines)) for (const i of p.items) if (i.vtid && /^VTID-\d{5}$/.test(i.vtid)) set.add(i.vtid);
  return [...set];
}
