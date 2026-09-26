/**
 * VTID-04641 — Testing & QA rebuild P2: the results store.
 *
 * Copies completed GitHub Actions runs of every test / gate / monitor / e2e /
 * deploy-smoke workflow (as the test catalog, VTID-04637, classifies them) in
 * both repositories into ci_test_runs, and summarises them per workflow and
 * per environment for the Testing & QA screens.
 *
 * The sync is lazy and idempotent: the results routes call ensureFreshResults()
 * and a sync runs when the last one is older than RESULTS_MAX_AGE_MS (or on an
 * explicit POST /results/sync). Rows are upserted on (repo, run_id), so two
 * gateways syncing the same window write the same rows. No scheduler needed,
 * and none is a poll to OASIS (CLAUDE.md §6: polling is not an event).
 *
 * The pure pieces (row mapping, summaries) are exported for tests; the GitHub
 * and Supabase calls are injected.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TestCatalog, TestCatalogWorkflow } from './test-catalog';

export const RESULTS_MAX_AGE_MS = 5 * 60 * 1000;
/** First sync of a repository reaches this far back (GitHub keeps 90 days). */
export const INITIAL_LOOKBACK_DAYS = 30;
/** Bound one sync: GitHub list pages of 100, and job lookups per sync. */
export const MAX_PAGES_PER_REPO = 10;
export const MAX_JOB_LOOKUPS_PER_SYNC = 80;
/** Re-read a small overlap so runs that completed late are not skipped. */
export const OVERLAP_MS = 6 * 60 * 60 * 1000;

const REPO_KEYS: Record<string, string> = {
  platform: 'exafyltd/vitana-platform',
  frontend: 'exafyltd/vitana-v1',
};
const RESULT_KINDS = new Set(['test', 'gate', 'monitor', 'e2e', 'deploy_smoke']);

export interface GitHubRun {
  id: number;
  name?: string | null;
  path?: string | null;               // '.github/workflows/TEST-SUITE.yml'
  event?: string | null;
  head_branch?: string | null;
  head_sha?: string | null;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
  run_attempt?: number | null;
  created_at: string;
  run_started_at?: string | null;
  updated_at?: string | null;
  actor?: { login?: string | null } | null;
}

export interface GitHubJob {
  name: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface CiTestRunRow {
  repo: string;
  run_id: number;
  run_attempt: number;
  workflow_file: string;
  workflow_name: string | null;
  kind: string | null;
  environments: string[];
  event: string | null;
  branch: string | null;
  head_sha: string | null;
  status: string;
  conclusion: string | null;
  actor: string | null;
  html_url: string | null;
  run_created_at: string;
  run_started_at: string | null;
  run_updated_at: string | null;
  duration_s: number | null;
  jobs: Array<{ name: string; conclusion: string | null; started_at: string | null; completed_at: string | null }>;
}

export interface WorkflowIndexEntry { kind: string; environments: string[]; name: string }

/** `${repo}|${file}` → catalog facts, for the result-bearing workflow kinds only. */
export function buildWorkflowIndex(catalog: Pick<TestCatalog, 'workflows'>): Map<string, WorkflowIndexEntry> {
  const index = new Map<string, WorkflowIndexEntry>();
  for (const w of catalog.workflows as TestCatalogWorkflow[]) {
    if (!RESULT_KINDS.has(w.kind)) continue;
    const repo = REPO_KEYS[w.repo] || w.repo;
    index.set(`${repo}|${w.file}`, { kind: w.kind, environments: w.environments || [], name: w.name });
  }
  return index;
}

export function workflowFileOf(run: Pick<GitHubRun, 'path'>): string | null {
  const p = String(run.path || '');
  const m = p.match(/(?:^|\/)([^/@]+\.ya?ml)(?:@.*)?$/);
  return m ? m[1] : null;
}

/** Maps a GitHub run to a row, or null when it is not a completed run of a catalogued workflow. */
export function toRunRow(repo: string, run: GitHubRun, index: Map<string, WorkflowIndexEntry>): CiTestRunRow | null {
  if (run.status !== 'completed') return null;
  const file = workflowFileOf(run);
  if (!file) return null;
  const entry = index.get(`${repo}|${file}`);
  if (!entry) return null;
  const start = run.run_started_at || run.created_at;
  const end = run.updated_at || null;
  const duration = start && end ? Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000)) : null;
  return {
    repo,
    run_id: run.id,
    run_attempt: run.run_attempt || 1,
    workflow_file: file,
    workflow_name: run.name || entry.name || null,
    kind: entry.kind,
    environments: entry.environments,
    event: run.event || null,
    branch: run.head_branch || null,
    head_sha: run.head_sha || null,
    status: 'completed',
    conclusion: run.conclusion || null,
    actor: run.actor?.login || null,
    html_url: run.html_url || null,
    run_created_at: run.created_at,
    run_started_at: run.run_started_at || null,
    run_updated_at: end,
    duration_s: Number.isFinite(duration as number) ? duration : null,
    jobs: [],
  };
}

export function toJobs(jobs: GitHubJob[]): CiTestRunRow['jobs'] {
  return (jobs || []).map((j) => ({
    name: String(j.name).slice(0, 200),
    conclusion: j.conclusion ?? null,
    started_at: j.started_at ?? null,
    completed_at: j.completed_at ?? null,
  }));
}

// ─── Summaries (pure) ─────────────────────────────────────────────────────

/** A run counts toward pass rate only when it reached a verdict. */
const VERDICTS = new Set(['success', 'failure', 'timed_out']);

export interface WorkflowSummary {
  repo: string;
  workflow_file: string;
  workflow_name: string | null;
  kind: string | null;
  environments: string[];
  last_run: Pick<CiTestRunRow, 'run_id' | 'conclusion' | 'event' | 'branch' | 'head_sha' | 'html_url' | 'run_created_at' | 'duration_s'> | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  runs_7d: number;
  failures_7d: number;
  pass_rate_7d: number | null;
  runs_30d: number;
  pass_rate_30d: number | null;
  failing_streak: number;
  /** Failed and passed on the same commit within the window: the verdict depends on something other than the code. */
  flaky_commits_30d: number;
  health: 'passing' | 'failing' | 'flaky' | 'no_recent_runs';
}

export function summarizeWorkflows(rows: CiTestRunRow[], now: number = Date.now()): WorkflowSummary[] {
  const byWf = new Map<string, CiTestRunRow[]>();
  for (const r of rows) {
    const k = `${r.repo}|${r.workflow_file}`;
    if (!byWf.has(k)) byWf.set(k, []);
    byWf.get(k)!.push(r);
  }
  const d7 = now - 7 * 864e5;
  const d30 = now - 30 * 864e5;
  const out: WorkflowSummary[] = [];
  for (const list of byWf.values()) {
    list.sort((a, b) => Date.parse(b.run_created_at) - Date.parse(a.run_created_at));
    const verdicts = list.filter((r) => VERDICTS.has(String(r.conclusion)));
    const in7 = verdicts.filter((r) => Date.parse(r.run_created_at) >= d7);
    const in30 = verdicts.filter((r) => Date.parse(r.run_created_at) >= d30);
    const rate = (xs: CiTestRunRow[]) => (xs.length ? Math.round((xs.filter((r) => r.conclusion === 'success').length / xs.length) * 1000) / 10 : null);
    let streak = 0;
    for (const r of verdicts) { if (r.conclusion === 'success') break; streak++; }
    const bySha = new Map<string, Set<string>>();
    for (const r of in30) {
      if (!r.head_sha) continue;
      if (!bySha.has(r.head_sha)) bySha.set(r.head_sha, new Set());
      bySha.get(r.head_sha)!.add(r.conclusion === 'success' ? 'pass' : 'fail');
    }
    const flaky = [...bySha.values()].filter((s) => s.size === 2).length;
    const last = list[0];
    const lastVerdict = verdicts[0];
    let health: WorkflowSummary['health'];
    if (!lastVerdict || Date.parse(lastVerdict.run_created_at) < d30) health = 'no_recent_runs';
    else if (lastVerdict.conclusion !== 'success') health = 'failing';
    else if (flaky > 0) health = 'flaky';
    else health = 'passing';
    out.push({
      repo: last.repo,
      workflow_file: last.workflow_file,
      workflow_name: last.workflow_name,
      kind: last.kind,
      environments: last.environments || [],
      last_run: {
        run_id: last.run_id, conclusion: last.conclusion, event: last.event, branch: last.branch,
        head_sha: last.head_sha, html_url: last.html_url, run_created_at: last.run_created_at, duration_s: last.duration_s,
      },
      last_success_at: verdicts.find((r) => r.conclusion === 'success')?.run_created_at || null,
      last_failure_at: verdicts.find((r) => r.conclusion !== 'success')?.run_created_at || null,
      runs_7d: in7.length,
      failures_7d: in7.filter((r) => r.conclusion !== 'success').length,
      pass_rate_7d: rate(in7),
      runs_30d: in30.length,
      pass_rate_30d: rate(in30),
      failing_streak: streak,
      flaky_commits_30d: flaky,
      health,
    });
  }
  const order = { failing: 0, flaky: 1, passing: 2, no_recent_runs: 3 } as const;
  return out.sort((a, b) => order[a.health] - order[b.health] || a.workflow_file.localeCompare(b.workflow_file));
}

export interface EnvironmentSummary {
  environment: string;
  workflows: number;
  failing: number;
  flaky: number;
  passing: number;
  no_recent_runs: number;
  runs_7d: number;
  pass_rate_7d: number | null;
}

export function summarizeEnvironments(workflows: WorkflowSummary[]): EnvironmentSummary[] {
  const envs = ['dev_pr', 'nightly', 'staging', 'production'];
  return envs.map((environment) => {
    const ws = workflows.filter((w) => w.environments.includes(environment));
    const runs = ws.reduce((n, w) => n + w.runs_7d, 0);
    const fails = ws.reduce((n, w) => n + w.failures_7d, 0);
    return {
      environment,
      workflows: ws.length,
      failing: ws.filter((w) => w.health === 'failing').length,
      flaky: ws.filter((w) => w.health === 'flaky').length,
      passing: ws.filter((w) => w.health === 'passing').length,
      no_recent_runs: ws.filter((w) => w.health === 'no_recent_runs').length,
      runs_7d: runs,
      pass_rate_7d: runs ? Math.round(((runs - fails) / runs) * 1000) / 10 : null,
    };
  });
}

// ─── Sync ──────────────────────────────────────────────────────────────────

export interface SyncDeps {
  supabase: SupabaseClient;
  catalog: Pick<TestCatalog, 'workflows'>;
  /** One page of completed runs created at or after `since` (newest first). */
  listRuns: (repo: string, since: string, page: number) => Promise<GitHubRun[]>;
  listJobs: (repo: string, runId: number) => Promise<GitHubJob[]>;
  now?: () => number;
  repos?: string[];
}

export interface RepoSyncResult { repo: string; ingested: number; seen: number; error: string | null; synced_through: string | null }

export async function syncTestResults(deps: SyncDeps): Promise<RepoSyncResult[]> {
  const now = deps.now || Date.now;
  const index = buildWorkflowIndex(deps.catalog);
  const repos = deps.repos || Object.values(REPO_KEYS);
  const results: RepoSyncResult[] = [];
  let jobBudget = MAX_JOB_LOOKUPS_PER_SYNC;

  for (const repo of repos) {
    const { data: state } = await deps.supabase.from('ci_test_sync_state').select('*').eq('repo', repo).maybeSingle();
    const through = state?.synced_through ? Date.parse(state.synced_through) : null;
    const sinceMs = through ? through - OVERLAP_MS : now() - INITIAL_LOOKBACK_DAYS * 864e5;
    const since = new Date(sinceMs).toISOString();

    let ingested = 0;
    let seen = 0;
    let newest = through;
    let error: string | null = null;
    try {
      const candidates = new Map<number, CiTestRunRow>();
      for (let page = 1; page <= MAX_PAGES_PER_REPO; page++) {
        const runs = await deps.listRuns(repo, since, page);
        seen += runs.length;
        for (const run of runs) {
          const row = toRunRow(repo, run, index);
          if (!row) continue;
          const t = Date.parse(row.run_created_at);
          if (newest === null || t > newest) newest = t;
          candidates.set(row.run_id, row);
        }
        if (runs.length < 100) break;
      }

      // A stored run is skipped unless it was re-run since (same run_id, higher
      // attempt, possibly a different verdict).
      const known = new Map<number, { run_attempt: number; conclusion: string | null }>();
      const ids = [...candidates.keys()];
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await deps.supabase
          .from('ci_test_runs').select('run_id,run_attempt,conclusion').eq('repo', repo).in('run_id', ids.slice(i, i + 200));
        for (const k of data || []) known.set(Number(k.run_id), { run_attempt: k.run_attempt, conclusion: k.conclusion });
      }
      const rows = [...candidates.values()].filter((r) => {
        const k = known.get(r.run_id);
        return !k || k.run_attempt !== r.run_attempt || k.conclusion !== r.conclusion;
      });

      for (const row of rows) {
        if (jobBudget <= 0) break;
        jobBudget--;
        try { row.jobs = toJobs(await deps.listJobs(repo, row.run_id)); } catch { /* the run is still worth storing */ }
      }

      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200).map((r) => ({ ...r, ingested_at: new Date(now()).toISOString() }));
        const { error: upErr } = await deps.supabase.from('ci_test_runs').upsert(chunk, { onConflict: 'repo,run_id' });
        if (upErr) throw new Error(`ci_test_runs upsert: ${upErr.message}`);
      }
      ingested = rows.length;
    } catch (err: any) {
      error = String(err?.message || err).slice(0, 500);
      console.error(`[test-results] sync ${repo} failed: ${error}`);
    }

    const syncedThrough = newest !== null ? new Date(newest).toISOString() : null;
    await deps.supabase.from('ci_test_sync_state').upsert({
      repo,
      synced_through: error ? state?.synced_through ?? null : syncedThrough,
      last_synced_at: new Date(now()).toISOString(),
      last_error: error,
      last_ingested: ingested,
      updated_at: new Date(now()).toISOString(),
    }, { onConflict: 'repo' });
    results.push({ repo, ingested, seen, error, synced_through: error ? state?.synced_through ?? null : syncedThrough });
  }
  return results;
}

type EnsureResult = { synced: boolean; results?: RepoSyncResult[] };
let inflight: Promise<EnsureResult> | null = null;

/**
 * Syncs when any repository's last sync is older than maxAgeMs. Concurrent
 * callers share one check-and-sync: the shared promise is taken before the
 * first await, so two reads arriving together cannot both start a sync.
 */
export function ensureFreshResults(
  depsFactory: () => Promise<SyncDeps>,
  opts: { maxAgeMs?: number; force?: boolean; now?: () => number } = {},
): Promise<EnsureResult> {
  if (inflight) return inflight;
  const now = opts.now || Date.now;
  const maxAge = opts.maxAgeMs ?? RESULTS_MAX_AGE_MS;
  inflight = (async (): Promise<EnsureResult> => {
    const deps = await depsFactory();
    if (!opts.force) {
      const { data } = await deps.supabase.from('ci_test_sync_state').select('repo,last_synced_at');
      const repos = deps.repos || Object.values(REPO_KEYS);
      const fresh = repos.every((repo) => {
        const s = (data || []).find((x: { repo: string }) => x.repo === repo);
        return s?.last_synced_at && now() - Date.parse(s.last_synced_at) < maxAge;
      });
      if (fresh) return { synced: false };
    }
    return { synced: true, results: await syncTestResults(deps) };
  })().finally(() => { inflight = null; });
  return inflight;
}

export function resetResultsSyncForTests(): void { inflight = null; }
