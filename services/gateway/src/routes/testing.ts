import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import githubService from '../services/github-service';
import * as repo from '../services/testing/testing-repository';
import { loadTestCatalog, queryCatalog, suiteDetail } from '../services/testing/test-catalog';
import { requireAuth, requireExafyAdmin } from '../middleware/auth-supabase-jwt';
import { listCompletedWorkflowRuns, getWorkflowRunJobs } from '../services/github-service';
import {
  ensureFreshResults, summarizeWorkflows, summarizeEnvironments,
  type SyncDeps, type GitHubRun, type CiTestRunRow,
} from '../services/testing/test-results';

const GITHUB_REPO = 'exafyltd/vitana-platform';
const ORB_MONITOR_WORKFLOW = 'E2E-ORB-MONITOR.yml';
const E2E_TEST_WORKFLOW = 'E2E-TEST-RUN.yml';
// BOOTSTRAP-TEST-COVERAGE: the Command Hub's "Unit Tests" panel already had a
// "Gateway Tests (Jest)" quick-run button wired to project id 'gateway-jest',
// but /run's project validation only recognized E2E_SUITES entries — the
// button silently 400'd. This is the real CI workflow (593 suites / ~11.7k
// tests) that TEST-SUITE.yml runs on every push/PR.
const GATEWAY_UNIT_WORKFLOW = 'TEST-SUITE.yml';
const GATEWAY_UNIT_PROJECT = 'gateway-jest';

const router = Router();

// VTID-04635: every route that starts work (a GitHub workflow dispatch, a
// local Playwright run, a new cycle) requires an authenticated exafy_admin.
// These were mounted with no auth at all, so an anonymous request could
// dispatch TEST-SUITE.yml / E2E-TEST-RUN.yml / E2E-ORB-MONITOR.yml. Reads
// (suites, runs, cycles, orb-monitor status) stay open for now; the rebuilt
// screens (plan: Testing & QA rebuild) move them behind the same gate. The
// middleware is written out on each route (not spread from an array) so the
// Impact Scan's auth rule can see it.

// VTID-04635: E2E runs target staging only. The owner rule (CLAUDE.md 48,
// vitana-v1 absolute rule) forbids automated suites against production, and
// E2E-TEST-RUN.yml already refuses production hosts; the gateway now refuses
// anything but the staging community app before dispatching, instead of
// forwarding whatever URL the caller sent.
export const E2E_STAGING_COMMUNITY_URL = 'https://preview-aws.vitanaland.com';
const E2E_ALLOWED_COMMUNITY_HOSTS = new Set(['preview-aws.vitanaland.com']);

/** Returns the staging URL to test, or null when the caller asked for any other host. */
export function resolveE2eCommunityUrl(requested: unknown): string | null {
  if (requested === undefined || requested === null || requested === '') return E2E_STAGING_COMMUNITY_URL;
  if (typeof requested !== 'string') return null;
  let host: string;
  try {
    const u = new URL(requested);
    if (u.protocol !== 'https:') return null;
    host = u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  return E2E_ALLOWED_COMMUNITY_HOSTS.has(host) ? E2E_STAGING_COMMUNITY_URL : null;
}

// ─── Available E2E test suites (from Playwright config) ───────────────────
const E2E_SUITES = [
  // Desktop (Lovable V1)
  { project: 'desktop-community',     ui: 'desktop', role: 'community',    label: 'Desktop — Community' },
  { project: 'desktop-patient',       ui: 'desktop', role: 'patient',      label: 'Desktop — Patient' },
  { project: 'desktop-professional',  ui: 'desktop', role: 'professional', label: 'Desktop — Professional' },
  { project: 'desktop-staff',         ui: 'desktop', role: 'staff',        label: 'Desktop — Staff' },
  { project: 'desktop-admin',         ui: 'desktop', role: 'admin',        label: 'Desktop — Admin' },
  { project: 'desktop-shared',        ui: 'desktop', role: 'shared',       label: 'Desktop — Shared' },
  // Mobile (Lovable V1)
  { project: 'mobile-community',      ui: 'mobile',  role: 'community',    label: 'Mobile — Community' },
  { project: 'mobile-patient',        ui: 'mobile',  role: 'patient',      label: 'Mobile — Patient' },
  { project: 'mobile-professional',   ui: 'mobile',  role: 'professional', label: 'Mobile — Professional' },
  { project: 'mobile-staff',          ui: 'mobile',  role: 'staff',        label: 'Mobile — Staff' },
  { project: 'mobile-admin',          ui: 'mobile',  role: 'admin',        label: 'Mobile — Admin' },
  { project: 'mobile-shared',         ui: 'mobile',  role: 'shared',       label: 'Mobile — Shared' },
  // Command Hub
  { project: 'hub-developer',         ui: 'hub',     role: 'developer',    label: 'Hub — Developer' },
  { project: 'hub-admin',             ui: 'hub',     role: 'admin',        label: 'Hub — Admin' },
  { project: 'hub-staff',             ui: 'hub',     role: 'staff',        label: 'Hub — Staff' },
  { project: 'hub-shared',            ui: 'hub',     role: 'shared',       label: 'Hub — Shared' },
];

// e2e/ directory relative to gateway root
const E2E_DIR = path.resolve(__dirname, '../../../..', 'e2e');

// ─── GET /suites — List available test suites ─────────────────────────────
router.get('/suites', (_req: Request, res: Response) => {
  const grouped = {
    desktop: E2E_SUITES.filter(s => s.ui === 'desktop'),
    mobile:  E2E_SUITES.filter(s => s.ui === 'mobile'),
    hub:     E2E_SUITES.filter(s => s.ui === 'hub'),
  };
  res.json({ ok: true, suites: E2E_SUITES, grouped });
});

// ─── GET /runs — List historical test runs ────────────────────────────────
// ─── GET /catalog — the generated test catalog (VTID-04637) ──────────────
// Every automated test in both repositories, grouped into suites, with the
// workflows that run them, their schedules and the environment each touches
// (dev_pr / nightly / staging / production). Built by TEST-CATALOG.yml on
// every merge; read here from S3. exafy_admin only: it lists internal hosts,
// workflow files and gaps.
router.get('/catalog', requireAuth, requireExafyAdmin, async (req: Request, res: Response) => {
  try {
    const { catalog, fromCache, source } = await loadTestCatalog();
    const q = req.query as Record<string, string | undefined>;
    const body = queryCatalog(catalog, {
      environment: q.environment,
      domain: q.domain,
      runner: q.runner,
      repo: q.repo,
      q: q.q,
      include_files: q.include_files === 'true',
    });
    res.json({ ok: true, from_cache: fromCache, source, ...body });
  } catch (err: any) {
    res.status(503).json({ ok: false, error: 'catalog_unavailable', message: err?.message || String(err) });
  }
});

// ─── GET /catalog/suite?id=… — one suite with its files (VTID-04637) ─────
router.get('/catalog/suite', requireAuth, requireExafyAdmin, async (req: Request, res: Response) => {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id is required' });
  try {
    const { catalog } = await loadTestCatalog();
    const detail = suiteDetail(catalog, id);
    if (!detail) return res.status(404).json({ ok: false, error: 'suite_not_found' });
    res.json({ ok: true, ...detail });
  } catch (err: any) {
    res.status(503).json({ ok: false, error: 'catalog_unavailable', message: err?.message || String(err) });
  }
});

// ─── Results store (VTID-04641) ──────────────────────────────────────────
// Every completed run of a catalogued test / gate / monitor / e2e workflow in
// both repositories, copied from GitHub Actions into ci_test_runs. Reads sync
// lazily when the copy is older than five minutes. exafy_admin only.

function repoToken(repoName: string): string | undefined {
  return repoName === 'exafyltd/vitana-v1' ? process.env.FRONTEND_DEPLOY_TOKEN : undefined;
}

async function resultsDeps(): Promise<SyncDeps> {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase not configured');
  const { catalog } = await loadTestCatalog();
  return {
    supabase,
    catalog,
    listRuns: (r, since, page) => listCompletedWorkflowRuns(r, since, page, repoToken(r)) as Promise<GitHubRun[]>,
    listJobs: async (r, runId) => (await getWorkflowRunJobs(r, runId, repoToken(r))).jobs,
  };
}

/** Reads wait at most this long for a sync; a longer one finishes in the background. */
const READ_SYNC_WAIT_MS = 4000;

async function freshen(force = false): Promise<{ synced: boolean; pending?: boolean; sync_error: string | null }> {
  const run = ensureFreshResults(resultsDeps, { force })
    .then((r) => ({ ...r, sync_error: null as string | null }))
    .catch((err: any) => ({ synced: false, sync_error: String(err?.message || err) }));
  if (force) return run;
  let timer: NodeJS.Timeout | undefined;
  const wait = new Promise<{ synced: boolean; pending: boolean; sync_error: null }>((resolve) => {
    timer = setTimeout(() => resolve({ synced: false, pending: true, sync_error: null }), READ_SYNC_WAIT_MS);
  });
  try {
    return await Promise.race([run, wait]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Latest STAGING-VERIFY verdict per service, from the OASIS events it records (VTID-04613). */
async function latestStagingVerify(supabase: NonNullable<ReturnType<typeof getSupabase>>) {
  const { data } = await supabase
    .from('oasis_events')
    .select('created_at, topic, metadata')
    .like('topic', 'staging.verify.%')
    .order('created_at', { ascending: false })
    .limit(40);
  const seen = new Map<string, Record<string, unknown>>();
  for (const e of data || []) {
    const m = (e.metadata || {}) as Record<string, any>;
    const service = String(m.service || 'unknown');
    if (seen.has(service)) continue;
    const results = Array.isArray(m.results) ? m.results : [];
    seen.set(service, {
      service,
      outcome: String(e.topic).replace('staging.verify.', ''),
      commit: m.commit || null,
      at: e.created_at,
      run_url: m.run_url || null,
      tests: results.length,
      failed: results.filter((r: any) => r && r.ok === false).map((r: any) => ({ suite: r.suite, name: r.name, problems: r.problems })),
    });
  }
  return [...seen.values()];
}

router.get('/results/summary', requireAuth, requireExafyAdmin, async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });
  const sync = await freshen();
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const rows: CiTestRunRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('ci_test_runs')
      .select('repo,run_id,run_attempt,workflow_file,workflow_name,kind,environments,event,branch,head_sha,status,conclusion,actor,html_url,run_created_at,run_started_at,run_updated_at,duration_s')
      .gte('run_created_at', since)
      .order('run_created_at', { ascending: false })
      .range(from, from + 999);
    if (error) return res.status(500).json({ ok: false, error: error.message });
    rows.push(...((data || []) as CiTestRunRow[]));
    if (!data || data.length < 1000 || from >= 20000) break;
  }
  const workflows = summarizeWorkflows(rows);
  const { data: state } = await supabase.from('ci_test_sync_state').select('*');
  res.json({
    ok: true,
    window_days: 30,
    runs: rows.length,
    environments: summarizeEnvironments(workflows),
    workflows,
    staging_verify: await latestStagingVerify(supabase),
    sync: { ...sync, state: state || [] },
  });
});

router.get('/results/runs', requireAuth, requireExafyAdmin, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });
  const sync = await freshen();
  const q = req.query as Record<string, string | undefined>;
  const limit = Math.min(Math.max(parseInt(q.limit || '50', 10) || 50, 1), 200);
  const offset = Math.max(parseInt(q.offset || '0', 10) || 0, 0);
  let query = supabase.from('ci_test_runs').select('*')
    .order('run_created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (q.repo) query = query.eq('repo', q.repo);
  if (q.workflow) query = query.eq('workflow_file', q.workflow);
  if (q.conclusion) query = query.eq('conclusion', q.conclusion);
  if (q.environment) query = query.contains('environments', [q.environment]);
  if (q.kind) query = query.eq('kind', q.kind);
  const { data, error } = await query;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, runs: data || [], count: (data || []).length, offset, limit, sync_error: sync.sync_error });
});

router.post('/results/sync', requireAuth, requireExafyAdmin, async (_req: Request, res: Response) => {
  // impact-allow-no-oasis: a sync copies GitHub run history into ci_test_runs; it is a read-side refresh (polling), which CLAUDE.md §6 keeps out of OASIS.
  const sync = await freshen(true);
  if (sync.sync_error) return res.status(503).json({ ok: false, error: sync.sync_error });
  res.json({ ok: true, ...sync });
});

router.get('/runs', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const type = (req.query.type as string) || 'e2e';
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  const { data, error } = await repo.fetchRuns(supabase, type, offset, limit);

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, runs: data || [], count: (data || []).length });
});

// ─── GET /runs/:id — Get run details with individual results ──────────────
router.get('/runs/:id', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const { data: run, error: runErr } = await repo.fetchRunById(supabase, req.params.id);

  if (runErr) return res.status(404).json({ ok: false, error: 'Run not found' });

  const { data: results, error: resErr } = await repo.fetchResultsForRun(supabase, req.params.id);

  if (resErr) return res.status(500).json({ ok: false, error: resErr.message });
  res.json({ ok: true, run, results: results || [] });
});

// ─── POST /run — Trigger a test run ──────────────────────────────────────
router.post('/run', requireAuth, requireExafyAdmin, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: run attribution (who started what, where) is recorded by the Testing & QA results store (rebuild phase P2); this handler's contract is unchanged by VTID-04635.
  const { projects = [], type = 'e2e' } = req.body;
  if (!Array.isArray(projects) || projects.length === 0) {
    return res.status(400).json({ ok: false, error: 'projects array is required' });
  }

  // BOOTSTRAP-TEST-COVERAGE: gateway-jest dispatches the real TEST-SUITE.yml
  // CI workflow (not the Playwright E2E runner below) and tracks completion
  // by polling GitHub Actions, since workflow_dispatch returns no run id.
  if (projects.includes(GATEWAY_UNIT_PROJECT)) {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

    const dispatchedAt = new Date();
    try {
      await githubService.triggerWorkflow(GITHUB_REPO, GATEWAY_UNIT_WORKFLOW, 'main');
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: 'GitHub dispatch failed: ' + (err.message || 'Unknown') });
    }

    const { data: run, error: insertErr } = await repo.insertRun(supabase, {
      type: 'unit', status: 'running', projects: [GATEWAY_UNIT_PROJECT], triggered_by: 'manual',
    });

    if (insertErr || !run) {
      return res.status(500).json({ ok: false, error: insertErr?.message || 'Failed to create run' });
    }

    res.json({ ok: true, run_id: run.id, status: 'running', via: 'github-actions' });
    pollGatewayUnitRunCompletion(run.id, dispatchedAt, supabase).catch(err => {
      console.error('[Testing] gateway-jest poll failed:', err);
    });
    return;
  }

  const community_url = resolveE2eCommunityUrl(req.body?.community_url);
  if (!community_url) {
    return res.status(400).json({ ok: false, error: `E2E runs target staging only (${E2E_STAGING_COMMUNITY_URL})` });
  }

  // Validate projects exist
  const validProjects = projects.filter((p: string) =>
    E2E_SUITES.some(s => s.project === p) || p === 'all'
  );
  if (validProjects.length === 0) {
    return res.status(400).json({ ok: false, error: 'No valid projects specified' });
  }

  // If e2e directory exists (local dev), run locally
  if (fs.existsSync(E2E_DIR)) {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

    const { data: run, error: insertErr } = await repo.insertRun(supabase, {
      type,
      status: 'running',
      projects: validProjects,
      triggered_by: 'manual',
    });

    if (insertErr || !run) {
      return res.status(500).json({ ok: false, error: insertErr?.message || 'Failed to create run' });
    }

    res.json({ ok: true, run_id: run.id, status: 'running', via: 'local' });
    executePlaywrightRun(run.id, validProjects, type, supabase, community_url).catch(err => {
      console.error('[Testing] Run failed:', err);
    });
    return;
  }

  // Cloud Run: dispatch GitHub Actions workflow
  try {
    await githubService.triggerWorkflow(GITHUB_REPO, E2E_TEST_WORKFLOW, 'main', {
      projects: validProjects.join(','),
      community_url,
    });
    res.json({ ok: true, status: 'dispatched', via: 'github-actions', projects: validProjects, community_url });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: 'GitHub dispatch failed: ' + (err.message || 'Unknown') });
  }
});

// ─── GET /cycles — List test cycles ──────────────────────────────────────
router.get('/cycles', async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const { data, error } = await repo.fetchCycles(supabase);

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, cycles: data || [] });
});

// ─── POST /cycles — Create a test cycle ──────────────────────────────────
router.post('/cycles', requireAuth, requireExafyAdmin, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: run attribution (who started what, where) is recorded by the Testing & QA results store (rebuild phase P2); this handler's contract is unchanged by VTID-04635.
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const { name, projects, type = 'e2e', schedule = null } = req.body;
  if (!name || !Array.isArray(projects) || projects.length === 0) {
    return res.status(400).json({ ok: false, error: 'name and projects[] required' });
  }

  const { data, error } = await repo.insertCycle(supabase, { name, type, projects, schedule });

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, cycle: data });
});

// ─── POST /cycles/:id/run — Execute a test cycle ────────────────────────
router.post('/cycles/:id/run', requireAuth, requireExafyAdmin, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: run attribution (who started what, where) is recorded by the Testing & QA results store (rebuild phase P2); this handler's contract is unchanged by VTID-04635.
  const community_url = resolveE2eCommunityUrl(req.body?.community_url);
  if (!community_url) {
    return res.status(400).json({ ok: false, error: `E2E runs target staging only (${E2E_STAGING_COMMUNITY_URL})` });
  }
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const { data: cycle, error: cycleErr } = await repo.fetchCycleById(supabase, req.params.id);

  if (cycleErr || !cycle) {
    return res.status(404).json({ ok: false, error: 'Cycle not found' });
  }

  // If e2e directory exists (local dev), run locally
  if (fs.existsSync(E2E_DIR)) {
    const { data: run, error: runErr } = await repo.insertRun(supabase, {
      type: cycle.type,
      status: 'running',
      projects: cycle.projects,
      triggered_by: 'cycle',
      cycle_id: cycle.id,
    });

    if (runErr || !run) {
      return res.status(500).json({ ok: false, error: runErr?.message || 'Failed to create run' });
    }

    await repo.updateCycle(supabase, cycle.id, { last_run_id: run.id, last_run_at: new Date().toISOString() });

    res.json({ ok: true, run_id: run.id, status: 'running', cycle_name: cycle.name, via: 'local' });
    executePlaywrightRun(run.id, cycle.projects, cycle.type, supabase, community_url).catch(err => {
      console.error('[Testing] Cycle run failed:', err);
    });
    return;
  }

  // Cloud Run: dispatch GitHub Actions workflow
  try {
    const projects = Array.isArray(cycle.projects) ? cycle.projects : [];
    await githubService.triggerWorkflow(GITHUB_REPO, E2E_TEST_WORKFLOW, 'main', {
      projects: projects.join(','),
      community_url,
    });

    await repo.updateCycle(supabase, cycle.id, { last_run_at: new Date().toISOString() });

    res.json({ ok: true, status: 'dispatched', via: 'github-actions', cycle_name: cycle.name });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: 'GitHub dispatch failed: ' + (err.message || 'Unknown') });
  }
});

// ─── Background test execution ───────────────────────────────────────────
async function executePlaywrightRun(
  runId: string,
  projects: string[],
  type: string,
  supabase: ReturnType<typeof getSupabase>,
  communityUrl?: string,
) {
  if (!supabase) return;

  const startTime = Date.now();
  const resultsFile = path.join(E2E_DIR, `results-${runId}.json`);

  try {
    // Build command args
    const projectArgs = projects.includes('all')
      ? []
      : projects.flatMap(p => ['--project', p]);

    const args = [
      'playwright', 'test',
      ...projectArgs,
      '--reporter=json',
    ];

    console.log(`[Testing] Starting run ${runId}: npx ${args.join(' ')}`);

    // Detect environment: Cloud Run (Linux) vs WSL2 (Windows node available)
    const isCloudRun = !!process.env.K_SERVICE;
    const e2eDir = E2E_DIR;

    const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      let stdout = '';
      let stderr = '';

      let proc;
      if (isCloudRun) {
        proc = spawn('npx', args, { cwd: e2eDir, shell: true, env: { ...process.env, CI: 'true', ...(communityUrl ? { COMMUNITY_URL: communityUrl } : {}) } });
      } else {
        // WSL2: use cmd.exe to run on Windows side where Chromium works
        const cmd = `cd /d "${e2eDir.replace(/\//g, '\\')}" && npx ${args.join(' ')}`;
        proc = spawn('cmd.exe', ['/c', cmd], { cwd: e2eDir });
      }

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      proc.on('close', (code: number | null) => {
        resolve({ stdout, stderr, code: code ?? 1 });
      });
      proc.on('error', (err: Error) => {
        resolve({ stdout, stderr: stderr + '\n' + err.message, code: 1 });
      });
    });

    const duration = Date.now() - startTime;

    // Try to parse Playwright JSON reporter output
    let parsedResults: any = null;
    try {
      // JSON reporter outputs to stdout
      parsedResults = JSON.parse(result.stdout);
    } catch {
      // If stdout isn't valid JSON, try reading results file
      try {
        const resultsPath = path.join(e2eDir, 'results.json');
        if (fs.existsSync(resultsPath)) {
          parsedResults = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
        }
      } catch { /* no results file */ }
    }

    // Extract stats from Playwright JSON format
    let total = 0, passed = 0, failed = 0, skipped = 0;
    const testRows: Array<{
      project: string;
      test_name: string;
      file_path: string;
      status: string;
      duration_ms: number;
      error_message: string | null;
      retry_count: number;
    }> = [];

    if (parsedResults?.suites) {
      // Playwright JSON reporter format
      const extractTests = (suite: any, filePath: string = '') => {
        const fp = suite.file || filePath;
        if (suite.specs) {
          for (const spec of suite.specs) {
            for (const test of spec.tests || []) {
              const lastResult = test.results?.[test.results.length - 1];
              const status = test.status || lastResult?.status || 'unknown';
              const proj = test.projectName || spec.tags?.[0] || 'unknown';
              total++;
              if (status === 'expected' || status === 'passed') passed++;
              else if (status === 'skipped') skipped++;
              else failed++;

              testRows.push({
                project: proj,
                test_name: spec.title || 'unnamed',
                file_path: fp,
                status: status === 'expected' ? 'passed' : status,
                duration_ms: lastResult?.duration || 0,
                error_message: lastResult?.error?.message || null,
                retry_count: (test.results?.length || 1) - 1,
              });
            }
          }
        }
        if (suite.suites) {
          for (const child of suite.suites) {
            extractTests(child, fp);
          }
        }
      };
      for (const suite of parsedResults.suites) {
        extractTests(suite);
      }
    } else if (parsedResults?.stats) {
      // Alternative: stats object
      total = parsedResults.stats.expected + parsedResults.stats.unexpected + parsedResults.stats.skipped;
      passed = parsedResults.stats.expected;
      failed = parsedResults.stats.unexpected;
      skipped = parsedResults.stats.skipped;
    }

    // Determine run status
    const runStatus = result.code === 0 ? 'passed' : (failed > 0 ? 'failed' : 'error');

    // Update run record
    await repo.updateRun(supabase, runId, {
      status: runStatus,
      total,
      passed,
      failed,
      skipped,
      duration_ms: duration,
      finished_at: new Date().toISOString(),
      error_message: runStatus === 'error' ? result.stderr.slice(0, 2000) : null,
    });

    // Insert individual test results (batch)
    if (testRows.length > 0) {
      const rows = testRows.map(r => ({ ...r, run_id: runId }));
      // Insert in batches of 100
      for (let i = 0; i < rows.length; i += 100) {
        await repo.insertTestResultsBatch(supabase, rows.slice(i, i + 100));
      }
    }

    console.log(`[Testing] Run ${runId} completed: ${runStatus} (${passed}/${total} passed, ${duration}ms)`);

    // Clean up temp results file
    try { if (fs.existsSync(resultsFile)) fs.unlinkSync(resultsFile); } catch {}

  } catch (err: any) {
    console.error(`[Testing] Run ${runId} error:`, err);
    await repo.updateRun(supabase, runId, {
      status: 'error',
      duration_ms: Date.now() - startTime,
      finished_at: new Date().toISOString(),
      error_message: err.message?.slice(0, 2000) || 'Unknown error',
    });
  }
}

// ─── gateway-jest completion poller (BOOTSTRAP-TEST-COVERAGE) ─────────────
// workflow_dispatch returns no run id, so we find the run we just kicked off
// by matching the first TEST-SUITE.yml run created after our dispatch call,
// then poll until GitHub reports it complete. Bounded to ~15 minutes (the
// observed full run is ~9-10 min); gives up (leaves status='running') past
// that rather than polling forever.
export async function pollGatewayUnitRunCompletion(
  runRowId: string,
  dispatchedAt: Date,
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
) {
  const deadline = Date.now() + 15 * 60 * 1000;
  let ghRunId: number | null = null;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20_000));
    try {
      const data = await githubService.getWorkflowRuns(GITHUB_REPO, GATEWAY_UNIT_WORKFLOW);
      if (!ghRunId) {
        const match = (data.workflow_runs || []).find(r => new Date(r.created_at) >= dispatchedAt);
        if (match) ghRunId = match.id;
        else continue;
      }
      const run = (data.workflow_runs || []).find(r => r.id === ghRunId);
      if (run && run.status === 'completed') {
        await repo.updateRun(supabase, runRowId, {
          status: run.conclusion === 'success' ? 'passed' : 'failed',
          duration_ms: Date.now() - dispatchedAt.getTime(),
          finished_at: new Date().toISOString(),
          error_message: run.conclusion !== 'success' ? `GitHub Actions run concluded: ${run.conclusion}. See ${run.html_url}` : null,
        });
        return;
      }
    } catch (err) {
      console.error('[Testing] gateway-jest poll iteration failed:', err);
    }
  }

  // Timed out — leave the row as 'running' but note we stopped watching it.
  await repo.updateRun(supabase, runRowId, { error_message: 'Stopped polling after 15 minutes; check GitHub Actions directly for final status.' });
}

// ─── ORB Monitor — GitHub Actions workflow status ────────────────────────

router.get('/orb-monitor/status', async (_req: Request, res: Response) => {
  try {
    const data = await githubService.getWorkflowRuns(GITHUB_REPO, ORB_MONITOR_WORKFLOW);
    const runs = (data.workflow_runs || []).map((r: any) => ({
      id: r.id,
      status: r.status,
      conclusion: r.conclusion,
      created_at: r.created_at,
      html_url: r.html_url,
    }));

    // Parse per-screen status from matrix jobs of the latest completed run
    const screens: Record<string, { conclusion: string | null; status: string }> = {};
    const latestCompleted = runs.find((r: any) => r.status === 'completed');
    if (latestCompleted) {
      try {
        const jobsData = await githubService.getWorkflowRunJobs(GITHUB_REPO, latestCompleted.id);
        for (const job of jobsData.jobs || []) {
          // Matrix job names: "orb-test (hub, hub-shared, ...)" — first word in parens is screen
          const match = job.name.match(/\((\w+)/);
          if (match) {
            screens[match[1]] = { conclusion: job.conclusion, status: job.status };
          }
        }
      } catch { /* jobs fetch is best-effort */ }
    }

    res.json({ ok: true, runs, screens, workflow: ORB_MONITOR_WORKFLOW });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message || 'Failed to fetch ORB monitor status' });
  }
});

router.post('/orb-monitor/trigger', requireAuth, requireExafyAdmin, async (_req: Request, res: Response) => {
  // impact-allow-no-oasis: run attribution (who started what, where) is recorded by the Testing & QA results store (rebuild phase P2); this handler's contract is unchanged by VTID-04635.
  try {
    await githubService.triggerWorkflow(GITHUB_REPO, ORB_MONITOR_WORKFLOW, 'main');
    res.json({ ok: true, message: 'ORB Monitor workflow triggered' });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message || 'Failed to trigger ORB monitor' });
  }
});

export default router;
