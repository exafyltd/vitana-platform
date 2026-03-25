import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const router = Router();

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
router.get('/runs', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const type = (req.query.type as string) || 'e2e';
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  const { data, error } = await supabase
    .from('test_runs')
    .select('*')
    .eq('type', type)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, runs: data || [], count: (data || []).length });
});

// ─── GET /runs/:id — Get run details with individual results ──────────────
router.get('/runs/:id', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const { data: run, error: runErr } = await supabase
    .from('test_runs')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (runErr) return res.status(404).json({ ok: false, error: 'Run not found' });

  const { data: results, error: resErr } = await supabase
    .from('test_results')
    .select('*')
    .eq('run_id', req.params.id)
    .order('project', { ascending: true })
    .order('test_name', { ascending: true });

  if (resErr) return res.status(500).json({ ok: false, error: resErr.message });
  res.json({ ok: true, run, results: results || [] });
});

// ─── POST /run — Trigger a test run ──────────────────────────────────────
router.post('/run', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const { projects = [], type = 'e2e', cycle_id } = req.body;
  if (!Array.isArray(projects) || projects.length === 0) {
    return res.status(400).json({ ok: false, error: 'projects array is required' });
  }

  // Check if e2e directory exists (not available on Cloud Run)
  if (!fs.existsSync(E2E_DIR)) {
    return res.status(503).json({ ok: false, error: 'E2E test runner not available in this environment. Tests can only be run from a dev machine or via CI/CD.' });
  }

  // Validate projects exist
  const validProjects = projects.filter((p: string) =>
    E2E_SUITES.some(s => s.project === p) || p === 'all'
  );
  if (validProjects.length === 0) {
    return res.status(400).json({ ok: false, error: 'No valid projects specified' });
  }

  // Create run record
  const { data: run, error: insertErr } = await supabase
    .from('test_runs')
    .insert({
      type,
      status: 'running',
      projects: validProjects,
      triggered_by: cycle_id ? 'cycle' : 'manual',
      cycle_id: cycle_id || null,
    })
    .select()
    .single();

  if (insertErr || !run) {
    return res.status(500).json({ ok: false, error: insertErr?.message || 'Failed to create run' });
  }

  // Return immediately — test execution happens in background
  res.json({ ok: true, run_id: run.id, status: 'running' });

  // Spawn Playwright in background
  executePlaywrightRun(run.id, validProjects, type, supabase).catch(err => {
    console.error('[Testing] Run failed:', err);
  });
});

// ─── GET /cycles — List test cycles ──────────────────────────────────────
router.get('/cycles', async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const { data, error } = await supabase
    .from('test_cycles')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, cycles: data || [] });
});

// ─── POST /cycles — Create a test cycle ──────────────────────────────────
router.post('/cycles', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const { name, projects, type = 'e2e', schedule = null } = req.body;
  if (!name || !Array.isArray(projects) || projects.length === 0) {
    return res.status(400).json({ ok: false, error: 'name and projects[] required' });
  }

  const { data, error } = await supabase
    .from('test_cycles')
    .insert({ name, type, projects, schedule })
    .select()
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, cycle: data });
});

// ─── POST /cycles/:id/run — Execute a test cycle ────────────────────────
router.post('/cycles/:id/run', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const { data: cycle, error: cycleErr } = await supabase
    .from('test_cycles')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (cycleErr || !cycle) {
    return res.status(404).json({ ok: false, error: 'Cycle not found' });
  }

  // Check if e2e directory exists
  if (!fs.existsSync(E2E_DIR)) {
    return res.status(503).json({ ok: false, error: 'E2E test runner not available in this environment.' });
  }

  // Create run linked to cycle
  const { data: run, error: runErr } = await supabase
    .from('test_runs')
    .insert({
      type: cycle.type,
      status: 'running',
      projects: cycle.projects,
      triggered_by: 'cycle',
      cycle_id: cycle.id,
    })
    .select()
    .single();

  if (runErr || !run) {
    return res.status(500).json({ ok: false, error: runErr?.message || 'Failed to create run' });
  }

  // Update cycle last_run
  await supabase
    .from('test_cycles')
    .update({ last_run_id: run.id, last_run_at: new Date().toISOString() })
    .eq('id', cycle.id);

  res.json({ ok: true, run_id: run.id, status: 'running', cycle_name: cycle.name });

  // Spawn Playwright in background
  executePlaywrightRun(run.id, cycle.projects, cycle.type, supabase).catch(err => {
    console.error('[Testing] Cycle run failed:', err);
  });
});

// ─── Background test execution ───────────────────────────────────────────
async function executePlaywrightRun(
  runId: string,
  projects: string[],
  type: string,
  supabase: ReturnType<typeof getSupabase>
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
        proc = spawn('npx', args, { cwd: e2eDir, shell: true, env: { ...process.env, CI: 'true' } });
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
    await supabase
      .from('test_runs')
      .update({
        status: runStatus,
        total,
        passed,
        failed,
        skipped,
        duration_ms: duration,
        finished_at: new Date().toISOString(),
        error_message: runStatus === 'error' ? result.stderr.slice(0, 2000) : null,
      })
      .eq('id', runId);

    // Insert individual test results (batch)
    if (testRows.length > 0) {
      const rows = testRows.map(r => ({ ...r, run_id: runId }));
      // Insert in batches of 100
      for (let i = 0; i < rows.length; i += 100) {
        await supabase.from('test_results').insert(rows.slice(i, i + 100));
      }
    }

    console.log(`[Testing] Run ${runId} completed: ${runStatus} (${passed}/${total} passed, ${duration}ms)`);

    // Clean up temp results file
    try { if (fs.existsSync(resultsFile)) fs.unlinkSync(resultsFile); } catch {}

  } catch (err: any) {
    console.error(`[Testing] Run ${runId} error:`, err);
    await supabase
      .from('test_runs')
      .update({
        status: 'error',
        duration_ms: Date.now() - startTime,
        finished_at: new Date().toISOString(),
        error_message: err.message?.slice(0, 2000) || 'Unknown error',
      })
      .eq('id', runId);
  }
}

export default router;
