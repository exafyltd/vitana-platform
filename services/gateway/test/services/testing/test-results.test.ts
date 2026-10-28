/**
 * VTID-04641 — Testing & QA results store: mapping, summaries and sync.
 *
 * The sync copies completed GitHub Actions runs of catalogued test / gate /
 * monitor / e2e workflows into ci_test_runs. These tests pin what is stored
 * (and what is not), the per-workflow and per-environment summaries the
 * screens show, that a sync resumes from its cursor, that a re-run replaces
 * the stored verdict, and that one repository's failure is recorded without
 * stopping the other.
 */
import {
  buildWorkflowIndex, toRunRow, workflowFileOf, summarizeWorkflows, summarizeEnvironments,
  syncTestResults, ensureFreshResults, resetResultsSyncForTests, OVERLAP_MS,
  type CiTestRunRow, type GitHubRun,
} from '../../../src/services/testing/test-results';

// ── In-memory Supabase: just the query surface the store uses ──────────────
type Row = Record<string, any>;
function fakeSupabase(tables: Record<string, Row[]> = {}) {
  const db: Record<string, Row[]> = { ci_test_runs: [], ci_test_sync_state: [], ...tables };
  function from(table: string) {
    let rows = () => db[table] || [];
    const filters: Array<(r: Row) => boolean> = [];
    let order: { col: string; asc: boolean } | null = null;
    let range: [number, number] | null = null;
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return q; },
      in: (c: string, vs: any[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      gte: (c: string, v: any) => { filters.push((r) => String(r[c]) >= String(v)); return q; },
      contains: (c: string, vs: any[]) => { filters.push((r) => vs.every((v) => (r[c] || []).includes(v))); return q; },
      order: (col: string, o: { ascending: boolean }) => { order = { col, asc: o.ascending }; return q; },
      range: (a: number, b: number) => { range = [a, b]; return q; },
      limit: (n: number) => { range = [0, n - 1]; return q; },
      maybeSingle: () => Promise.resolve({ data: result()[0] || null, error: null }),
      upsert: (input: Row | Row[], opts: { onConflict: string }) => {
        const keys = opts.onConflict.split(',');
        for (const r of [].concat(input as any) as Row[]) {
          const list = (db[table] = db[table] || []);
          const i = list.findIndex((x) => keys.every((k) => x[k] === r[k]));
          if (i >= 0) list[i] = { ...list[i], ...r }; else list.push({ ...r });
        }
        return Promise.resolve({ error: null });
      },
      then: (ok: any, bad: any) => Promise.resolve({ data: result(), error: null }).then(ok, bad),
    };
    function result() {
      let out = rows().filter((r) => filters.every((f) => f(r)));
      if (order) {
        const { col, asc } = order;
        out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      return out;
    }
    return q;
  }
  return { db, client: { from } as any };
}

const CATALOG = {
  workflows: [
    { repo: 'platform', file: 'TEST-SUITE.yml', name: 'Test Suite', kind: 'test', environments: ['dev_pr', 'nightly'] },
    { repo: 'platform', file: 'ALERT-X.yml', name: 'Alert X', kind: 'monitor', environments: ['production'] },
    { repo: 'platform', file: 'STAGING-VERIFY.yml', name: 'Staging verify', kind: 'e2e', environments: ['staging'] },
    { repo: 'frontend', file: 'CI.yml', name: 'Frontend CI', kind: 'test', environments: ['dev_pr'] },
    { repo: 'platform', file: 'AWS-STAGE-DEPLOY-GATEWAY.yml', name: 'deploy', kind: 'job', environments: ['staging'] },
  ],
} as any;

const P = 'exafyltd/vitana-platform';
const F = 'exafyltd/vitana-v1';
const NOW = Date.parse('2026-09-26T12:00:00Z');
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600e3).toISOString();

function ghRun(id: number, file: string, conclusion: string, hoursAgo: number, extra: Partial<GitHubRun> = {}): GitHubRun {
  return {
    id, name: file, path: `.github/workflows/${file}`, event: 'push', head_branch: 'main', head_sha: `sha${id}`,
    status: 'completed', conclusion, html_url: `https://github.com/x/actions/runs/${id}`, run_attempt: 1,
    created_at: iso(hoursAgo), run_started_at: iso(hoursAgo), updated_at: new Date(NOW - hoursAgo * 3600e3 + 90e3).toISOString(),
    actor: { login: 'exafyltd' }, ...extra,
  };
}

function row(id: number, file: string, conclusion: string, hoursAgo: number, extra: Partial<CiTestRunRow> = {}): CiTestRunRow {
  const r = toRunRow(P, ghRun(id, file, conclusion, hoursAgo), buildWorkflowIndex(CATALOG))!;
  return { ...r, ...extra };
}

describe('mapping GitHub runs to rows', () => {
  const index = buildWorkflowIndex(CATALOG);

  it('indexes only result-bearing workflow kinds, keyed by full repository name', () => {
    expect(index.has(`${P}|TEST-SUITE.yml`)).toBe(true);
    expect(index.has(`${F}|CI.yml`)).toBe(true);
    expect(index.has(`${P}|AWS-STAGE-DEPLOY-GATEWAY.yml`)).toBe(false);
  });

  it('reads the workflow file from the run path, including a ref suffix', () => {
    expect(workflowFileOf({ path: '.github/workflows/TEST-SUITE.yml' })).toBe('TEST-SUITE.yml');
    expect(workflowFileOf({ path: '.github/workflows/CI.yaml@refs/heads/main' })).toBe('CI.yaml');
    expect(workflowFileOf({ path: '' })).toBeNull();
  });

  it('stores a completed run of a catalogued workflow with its environments and duration', () => {
    const r = toRunRow(P, ghRun(1, 'ALERT-X.yml', 'failure', 2), index)!;
    expect(r).toMatchObject({ repo: P, run_id: 1, workflow_file: 'ALERT-X.yml', kind: 'monitor', environments: ['production'], conclusion: 'failure', duration_s: 90, actor: 'exafyltd' });
  });

  it('skips runs still in progress, deploy jobs and workflows the catalog does not know', () => {
    expect(toRunRow(P, ghRun(2, 'TEST-SUITE.yml', 'success', 1, { status: 'in_progress' }), index)).toBeNull();
    expect(toRunRow(P, ghRun(3, 'AWS-STAGE-DEPLOY-GATEWAY.yml', 'success', 1), index)).toBeNull();
    expect(toRunRow(P, ghRun(4, 'UNKNOWN.yml', 'success', 1), index)).toBeNull();
  });
});

describe('summaries', () => {
  it('reports health, pass rates, the failing streak and last success per workflow', () => {
    const rows = [
      row(1, 'TEST-SUITE.yml', 'success', 100),
      row(2, 'TEST-SUITE.yml', 'failure', 10),
      row(3, 'TEST-SUITE.yml', 'failure', 5),
      row(4, 'TEST-SUITE.yml', 'cancelled', 1), // no verdict: ignored for rates and streak
      row(5, 'ALERT-X.yml', 'success', 3),
    ];
    const [failing, passing] = summarizeWorkflows(rows, NOW);
    expect(failing).toMatchObject({
      workflow_file: 'TEST-SUITE.yml', health: 'failing', failing_streak: 2, runs_7d: 3, failures_7d: 2,
      pass_rate_7d: 33.3, last_success_at: iso(100), last_failure_at: iso(5),
    });
    expect(failing.last_run?.run_id).toBe(4);
    expect(passing).toMatchObject({ workflow_file: 'ALERT-X.yml', health: 'passing', pass_rate_7d: 100 });
  });

  it('calls a workflow flaky when one commit both passed and failed', () => {
    const rows = [
      row(1, 'TEST-SUITE.yml', 'failure', 5, { head_sha: 'same' }),
      row(2, 'TEST-SUITE.yml', 'success', 4, { head_sha: 'same' }),
    ];
    expect(summarizeWorkflows(rows, NOW)[0]).toMatchObject({ health: 'flaky', flaky_commits_30d: 1 });
  });

  it('marks a workflow with no verdict in 30 days as having no recent runs', () => {
    expect(summarizeWorkflows([row(1, 'ALERT-X.yml', 'success', 24 * 40)], NOW)[0].health).toBe('no_recent_runs');
  });

  it('rolls workflows up per environment', () => {
    const ws = summarizeWorkflows([row(1, 'TEST-SUITE.yml', 'failure', 2), row(2, 'ALERT-X.yml', 'success', 2)], NOW);
    const envs = Object.fromEntries(summarizeEnvironments(ws).map((e) => [e.environment, e]));
    expect(envs.production).toMatchObject({ workflows: 1, passing: 1, pass_rate_7d: 100 });
    expect(envs.dev_pr).toMatchObject({ workflows: 1, failing: 1, pass_rate_7d: 0 });
    expect(envs.staging).toMatchObject({ workflows: 0, pass_rate_7d: null });
  });
});

describe('syncTestResults', () => {
  beforeEach(() => resetResultsSyncForTests());

  function deps(sb: ReturnType<typeof fakeSupabase>, runsByRepo: Record<string, GitHubRun[]>, overrides: any = {}) {
    const listRuns = jest.fn(async (repo: string, since: string, page: number) =>
      page === 1 ? (runsByRepo[repo] || []).filter((r) => r.created_at >= since) : []);
    const listJobs = jest.fn(async () => [{ name: 'Gateway (Jest)', conclusion: 'success', started_at: iso(1), completed_at: iso(0.9) }]);
    return { supabase: sb.client, catalog: CATALOG, listRuns, listJobs, now: () => NOW, ...overrides };
  }

  it('stores catalogued runs with their jobs and records the cursor per repository', async () => {
    const sb = fakeSupabase();
    const d = deps(sb, {
      [P]: [ghRun(10, 'TEST-SUITE.yml', 'success', 2), ghRun(11, 'AWS-STAGE-DEPLOY-GATEWAY.yml', 'success', 2)],
      [F]: [ghRun(20, 'CI.yml', 'failure', 1)],
    });
    const res = await syncTestResults(d);
    expect(res).toEqual([
      expect.objectContaining({ repo: P, ingested: 1, seen: 2, error: null, synced_through: iso(2) }),
      expect.objectContaining({ repo: F, ingested: 1, error: null, synced_through: iso(1) }),
    ]);
    expect(sb.db.ci_test_runs.map((r) => r.run_id).sort()).toEqual([10, 20]);
    expect(sb.db.ci_test_runs[0].jobs[0]).toMatchObject({ name: 'Gateway (Jest)', conclusion: 'success' });
    expect(sb.db.ci_test_sync_state.find((s) => s.repo === P)).toMatchObject({ synced_through: iso(2), last_error: null, last_ingested: 1 });
  });

  it('resumes from the cursor minus the overlap, and does not re-fetch jobs for stored runs', async () => {
    const sb = fakeSupabase();
    await syncTestResults(deps(sb, { [P]: [ghRun(10, 'TEST-SUITE.yml', 'success', 2)] }));
    const d = deps(sb, { [P]: [ghRun(10, 'TEST-SUITE.yml', 'success', 2), ghRun(12, 'TEST-SUITE.yml', 'failure', 0.5)] });
    const res = await syncTestResults(d);
    expect(d.listRuns.mock.calls[0][1]).toBe(new Date(Date.parse(iso(2)) - OVERLAP_MS).toISOString());
    expect(res[0]).toMatchObject({ ingested: 1 });
    expect(d.listJobs).toHaveBeenCalledTimes(1);
    expect(d.listJobs).toHaveBeenCalledWith(P, 12);
  });

  it('replaces a stored verdict when the run was re-run', async () => {
    const sb = fakeSupabase();
    await syncTestResults(deps(sb, { [P]: [ghRun(10, 'TEST-SUITE.yml', 'failure', 2)] }));
    await syncTestResults(deps(sb, { [P]: [ghRun(10, 'TEST-SUITE.yml', 'success', 2, { run_attempt: 2 })] }));
    expect(sb.db.ci_test_runs.filter((r) => r.run_id === 10)).toEqual([expect.objectContaining({ conclusion: 'success', run_attempt: 2 })]);
  });

  it('records one repository failing (e.g. no token for vitana-v1) and still syncs the other', async () => {
    const sb = fakeSupabase();
    const d = deps(sb, { [P]: [ghRun(10, 'TEST-SUITE.yml', 'success', 2)] });
    const inner = d.listRuns;
    d.listRuns = jest.fn(async (repo: string, since: string, page: number) => {
      if (repo === F) throw new Error('GitHub API error: 403 - Forbidden');
      return inner(repo, since, page);
    });
    const res = await syncTestResults(d);
    expect(res.find((r) => r.repo === P)).toMatchObject({ ingested: 1, error: null });
    expect(res.find((r) => r.repo === F)).toMatchObject({ ingested: 0, error: 'GitHub API error: 403 - Forbidden', synced_through: null });
    expect(sb.db.ci_test_sync_state.find((s) => s.repo === F)?.last_error).toMatch(/403/);
  });
});

describe('ensureFreshResults', () => {
  beforeEach(() => resetResultsSyncForTests());

  it('skips the sync while every repository was synced within the max age, and forces on request', async () => {
    const sb = fakeSupabase({
      ci_test_sync_state: [
        { repo: P, last_synced_at: new Date(NOW - 60e3).toISOString() },
        { repo: F, last_synced_at: new Date(NOW - 60e3).toISOString() },
      ],
    });
    const listRuns = jest.fn(async () => []);
    const factory = async () => ({ supabase: sb.client, catalog: CATALOG, listRuns, listJobs: jest.fn(), now: () => NOW });
    expect(await ensureFreshResults(factory, { now: () => NOW })).toEqual({ synced: false });
    expect(listRuns).not.toHaveBeenCalled();
    const forced = await ensureFreshResults(factory, { now: () => NOW, force: true });
    expect(forced.synced).toBe(true);
    expect(listRuns).toHaveBeenCalled();
  });

  it('syncs when any repository is stale, and concurrent callers share one sync', async () => {
    const sb = fakeSupabase({ ci_test_sync_state: [{ repo: P, last_synced_at: new Date(NOW - 60e3).toISOString() }] });
    const listRuns = jest.fn(async () => []);
    const factory = async () => ({ supabase: sb.client, catalog: CATALOG, listRuns, listJobs: jest.fn(), now: () => NOW });
    const [a, b] = await Promise.all([ensureFreshResults(factory, { now: () => NOW }), ensureFreshResults(factory, { now: () => NOW })]);
    expect(a.synced).toBe(true);
    expect(b.synced).toBe(true);
    expect(listRuns).toHaveBeenCalledTimes(2); // one call per repository, one sync
  });
});
