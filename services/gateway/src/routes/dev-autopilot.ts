/**
 * Developer Autopilot — gateway router
 *
 * Endpoints for the self-improving queue. Mounted at /api/v1/dev-autopilot.
 *
 * All endpoints except POST /scan require the dev-assistant role; RBAC is
 * enforced at mount time in index.ts plus a per-handler guard that rejects
 * non-developer tokens. For PR-2 we accept either (a) a valid bearer token
 * with 'developer' or 'admin' role, or (b) the X-DevAutopilot-Scan-Token
 * header matching DEV_AUTOPILOT_SCAN_TOKEN env var (for POST /scan from the
 * GitHub Actions workflow).
 */

import { Router, Request, Response } from 'express';
import { ingestScan, ScanInput } from '../services/dev-autopilot-synthesis';
import { generatePlanVersion } from '../services/dev-autopilot-planning';
import { approveAutoExecute, cancelExecution } from '../services/dev-autopilot-execute';
import { bridgeFailureToSelfHealing, FailureStage } from '../services/dev-autopilot-bridge';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

const LOG_PREFIX = '[dev-autopilot-router]';
const SCAN_VTID = 'VTID-DEV-AUTOPILOT';
const SCAN_TOKEN = process.env.DEV_AUTOPILOT_SCAN_TOKEN || '';

// =============================================================================
// Supabase helper (read-mostly)
// =============================================================================

interface SupaConfig {
  url: string;
  key: string;
}

function getSupabase(): SupaConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return { url, key };
}

async function supaGet<T>(supa: SupaConfig, path: string): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(`${supa.url}${path}`, {
      headers: { apikey: supa.key, Authorization: `Bearer ${supa.key}` },
    });
    if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function supaPatch(supa: SupaConfig, path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${supa.url}${path}`, {
      method: 'PATCH',
      headers: {
        apikey: supa.key,
        Authorization: `Bearer ${supa.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// =============================================================================
// Auth guard
// =============================================================================

function requireDevRole(req: Request, res: Response, next: () => void) {
  // Dev-assistant RBAC — reuse the populated req.user from upstream auth
  // middleware if present. For the MVP we accept a service-role header too
  // so local/internal callers (the watcher, the workflow) can hit the API.
  const user = (req as unknown as { user?: { role?: string } }).user;
  const role = user?.role;
  if (role === 'developer' || role === 'admin') return next();
  if (req.get('X-Gateway-Internal') === (process.env.GATEWAY_INTERNAL_TOKEN || '__dev__') &&
      process.env.GATEWAY_INTERNAL_TOKEN) {
    return next();
  }
  return res.status(403).json({ ok: false, error: 'Dev Autopilot requires developer role' });
}

function requireScanToken(req: Request, res: Response, next: () => void) {
  const token = req.get('X-DevAutopilot-Scan-Token') || '';
  if (!SCAN_TOKEN) {
    console.warn(`${LOG_PREFIX} DEV_AUTOPILOT_SCAN_TOKEN not set — rejecting all scan posts`);
    return res.status(503).json({ ok: false, error: 'Scan token not configured on gateway' });
  }
  if (token !== SCAN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Invalid scan token' });
  }
  next();
}

// =============================================================================
// POST /scan — ingest a scan run (called by GH Actions workflow or manually)
// =============================================================================

router.post('/scan', requireScanToken, async (req: Request, res: Response) => {
  const body = req.body as Partial<ScanInput>;
  if (!body || !Array.isArray(body.signals)) {
    return res.status(400).json({ ok: false, error: 'body must include signals[]' });
  }
  try {
    const result = await ingestScan({
      signals: body.signals,
      triggered_by: body.triggered_by || 'api',
      metadata: body.metadata || {},
    });
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    console.error(`${LOG_PREFIX} /scan failed:`, err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// =============================================================================
// GET /runs — last N runs
// =============================================================================

router.get('/runs', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  const limit = Math.min(parseInt(String(req.query.limit || '20'), 10), 100);
  const r = await supaGet<unknown[]>(supa, `/rest/v1/dev_autopilot_runs?order=started_at.desc&limit=${limit}`);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error });
  return res.json({ ok: true, runs: r.data });
});

router.get('/runs/:run_id', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  const runId = req.params.run_id;
  const r = await supaGet<unknown[]>(supa, `/rest/v1/dev_autopilot_runs?run_id=eq.${runId}&limit=1`);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error });
  const row = (r.data || [])[0];
  if (!row) return res.status(404).json({ ok: false, error: 'run not found' });
  return res.json({ ok: true, run: row });
});

// =============================================================================
// GET /queue — queue with optional filters
// =============================================================================

router.get('/queue', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });

  const qs = new URLSearchParams();
  qs.append('source_type', 'eq.dev_autopilot');
  const status = String(req.query.status || 'new');
  qs.append('status', `eq.${status}`);
  if (req.query.risk)   qs.append('risk_class', `eq.${String(req.query.risk)}`);
  if (req.query.domain) qs.append('domain', `eq.${String(req.query.domain)}`);

  // Sort
  const sort = String(req.query.sort || 'impact');
  const sortMap: Record<string, string> = {
    impact: 'impact_score.desc',
    effort: 'effort_score.asc',
    age: 'last_seen_at.desc',
    seen: 'seen_count.desc',
  };
  qs.append('order', sortMap[sort] || sortMap.impact);

  const limit = Math.min(parseInt(String(req.query.limit || '200'), 10), 500);
  qs.append('limit', String(limit));

  const path = `/rest/v1/autopilot_recommendations?${qs.toString()}`;
  const r = await supaGet<unknown[]>(supa, path);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error });
  return res.json({ ok: true, findings: r.data || [] });
});

// =============================================================================
// GET /findings/:id — full detail including plan versions
// =============================================================================

router.get('/findings/:id', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  const id = req.params.id;
  const recR = await supaGet<unknown[]>(supa, `/rest/v1/autopilot_recommendations?id=eq.${id}&limit=1`);
  if (!recR.ok) return res.status(500).json({ ok: false, error: recR.error });
  const rec = (recR.data || [])[0];
  if (!rec) return res.status(404).json({ ok: false, error: 'finding not found' });

  const plansR = await supaGet<unknown[]>(
    supa,
    `/rest/v1/dev_autopilot_plan_versions?finding_id=eq.${id}&order=version.desc`,
  );
  return res.json({ ok: true, finding: rec, plan_versions: plansR.data || [] });
});

// =============================================================================
// POST /findings/:id/generate-plan (lazy Stage B)
// POST /findings/:id/continue-planning (feedback → plan v2+)
// =============================================================================

router.post('/findings/:id/generate-plan', requireDevRole, async (req: Request, res: Response) => {
  try {
    const result = await generatePlanVersion(req.params.id);
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    console.error(`${LOG_PREFIX} generate-plan failed:`, err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

router.post('/findings/:id/continue-planning', requireDevRole, async (req: Request, res: Response) => {
  const feedback = String(req.body?.feedback || '').trim();
  if (!feedback) {
    return res.status(400).json({ ok: false, error: 'feedback required' });
  }
  if (feedback.length > 4000) {
    return res.status(400).json({ ok: false, error: 'feedback must be ≤ 4000 chars' });
  }
  try {
    const result = await generatePlanVersion(req.params.id, { feedback_note: feedback });
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    console.error(`${LOG_PREFIX} continue-planning failed:`, err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// =============================================================================
// POST /findings/:id/reject and batch variant
// =============================================================================

async function rejectById(supa: SupaConfig, id: string): Promise<{ ok: boolean; error?: string }> {
  const r = await supaPatch(supa, `/rest/v1/autopilot_recommendations?id=eq.${id}&source_type=eq.dev_autopilot`, {
    status: 'rejected',
    updated_at: new Date().toISOString(),
  });
  if (r.ok) {
    await emitOasisEvent({
      vtid: SCAN_VTID,
      type: 'dev_autopilot.finding.rejected',
      source: 'dev-autopilot',
      status: 'info',
      message: `Finding ${id} rejected`,
      payload: { finding_id: id },
    });
  }
  return r;
}

router.post('/findings/:id/reject', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  const r = await rejectById(supa, req.params.id);
  return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { ok: false, error: r.error });
});

router.post('/findings/batch-reject', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  const ids = (req.body?.ids || []) as string[];
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'ids[] required' });
  }
  const results = await Promise.all(ids.map(id => rejectById(supa, id).then(r => ({ id, ...r }))));
  const rejected = results.filter(r => r.ok).map(r => r.id);
  const failed = results.filter(r => !r.ok).map(r => ({ id: r.id, reason: r.error }));
  return res.json({ ok: true, rejected, failed });
});

// =============================================================================
// POST /findings/:id/snooze and batch variant
// =============================================================================

async function snoozeById(
  supa: SupaConfig,
  id: string,
  hours: number,
): Promise<{ ok: boolean; error?: string }> {
  const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  const r = await supaPatch(supa, `/rest/v1/autopilot_recommendations?id=eq.${id}&source_type=eq.dev_autopilot`, {
    status: 'snoozed',
    snoozed_until: until,
    updated_at: new Date().toISOString(),
  });
  if (r.ok) {
    await emitOasisEvent({
      vtid: SCAN_VTID,
      type: 'dev_autopilot.finding.snoozed',
      source: 'dev-autopilot',
      status: 'info',
      message: `Finding ${id} snoozed for ${hours}h`,
      payload: { finding_id: id, snoozed_until: until },
    });
  }
  return r;
}

router.post('/findings/:id/snooze', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  const hours = Number(req.body?.hours ?? 24);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
    return res.status(400).json({ ok: false, error: 'hours must be in (0, 720]' });
  }
  const r = await snoozeById(supa, req.params.id, hours);
  return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { ok: false, error: r.error });
});

router.post('/findings/batch-snooze', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  const ids = (req.body?.ids || []) as string[];
  const hours = Number(req.body?.hours ?? 24);
  if (!Array.isArray(ids) || ids.length === 0 || !Number.isFinite(hours) || hours <= 0) {
    return res.status(400).json({ ok: false, error: 'ids[] and hours required' });
  }
  const results = await Promise.all(ids.map(id => snoozeById(supa, id, hours).then(r => ({ id, ...r }))));
  return res.json({
    ok: true,
    snoozed: results.filter(r => r.ok).map(r => r.id),
    failed: results.filter(r => !r.ok).map(r => ({ id: r.id, reason: r.error })),
  });
});

// =============================================================================
// POST /findings/:id/approve-auto-execute and batch variant
// POST /executions/:id/cancel
// GET  /executions?status=active (UI tracing)
// =============================================================================

router.post('/findings/:id/approve-auto-execute', requireDevRole, async (req: Request, res: Response) => {
  try {
    const approvedBy = (req as unknown as { user?: { id?: string } }).user?.id;
    const result = await approveAutoExecute({ finding_id: req.params.id, approved_by: approvedBy });
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error(`${LOG_PREFIX} approve-auto-execute failed:`, err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

router.post('/findings/batch-approve-auto-execute', requireDevRole, async (req: Request, res: Response) => {
  const ids = (req.body?.ids || []) as string[];
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'ids[] required' });
  }
  const approvedBy = (req as unknown as { user?: { id?: string } }).user?.id;
  const approved: unknown[] = [];
  const failed: unknown[] = [];
  let firstFailureEmitted = false;
  for (const id of ids) {
    const r = await approveAutoExecute({ finding_id: id, approved_by: approvedBy });
    if (r.ok) approved.push({ id, execution: r.execution });
    else {
      failed.push({ id, reason: r.error, violations: r.decision?.violations });
      if (!firstFailureEmitted) {
        firstFailureEmitted = true;
        await emitOasisEvent({
          vtid: SCAN_VTID,
          type: 'dev_autopilot.batch.first_failure',
          source: 'dev-autopilot',
          status: 'warning',
          message: `Batch approval partial fail on finding ${id}`,
          payload: { finding_id: id, error: r.error, violations: r.decision?.violations },
        });
      }
    }
  }
  return res.json({ ok: true, approved, failed });
});

router.post('/executions/:id/cancel', requireDevRole, async (req: Request, res: Response) => {
  const r = await cancelExecution(req.params.id);
  return res.status(r.ok ? 200 : 400).json(r);
});

// POST /executions/:id/bridge — manually route a failed execution through the
// self-healing bridge. Useful for re-running the bridge after a fix, or for
// testing from Command Hub. Valid stages: ci | deploy | verification.
router.post('/executions/:id/bridge', requireDevRole, async (req: Request, res: Response) => {
  const stage = String(req.body?.failure_stage || 'ci') as FailureStage;
  if (!['ci', 'deploy', 'verification'].includes(stage)) {
    return res.status(400).json({ ok: false, error: 'failure_stage must be ci | deploy | verification' });
  }
  try {
    const result = await bridgeFailureToSelfHealing({
      execution_id: req.params.id,
      failure_stage: stage,
      error: req.body?.error,
      verification_result: req.body?.verification_result,
      blast_radius: req.body?.blast_radius,
    });
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error(`${LOG_PREFIX} bridge route error:`, err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// GET /executions/:id/lineage — returns the self-heal chain (parent + children)
// so the UI can draw the retry lineage inline with the execution detail.
router.get('/executions/:id/lineage', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  const rootId = req.params.id;

  // Walk up to the root (parent_execution_id === null), then fetch all
  // descendants whose finding_id matches. Most lineages are shallow (<= 3)
  // so this is cheap; we cap at 20 hops defensively.
  type LineageRow = { id: string; finding_id: string; parent_execution_id: string | null };
  const visited = new Set<string>();
  let currentId: string | null = rootId;
  let root: LineageRow | null = null;
  for (let i = 0; i < 20 && currentId && !visited.has(currentId); i++) {
    visited.add(currentId);
    const hop: { ok: boolean; data?: LineageRow[]; error?: string } = await supaGet<LineageRow[]>(
      supa,
      `/rest/v1/dev_autopilot_executions?id=eq.${currentId}&select=id,finding_id,parent_execution_id&limit=1`,
    );
    if (!hop.ok || !hop.data || hop.data.length === 0) break;
    root = hop.data[0];
    currentId = root.parent_execution_id;
  }
  if (!root) return res.status(404).json({ ok: false, error: 'execution not found' });

  const all = await supaGet<unknown[]>(
    supa,
    `/rest/v1/dev_autopilot_executions?finding_id=eq.${root.finding_id}&order=created_at.asc`,
  );
  if (!all.ok) return res.status(500).json({ ok: false, error: all.error });
  return res.json({ ok: true, root_id: root.id, lineage: all.data || [] });
});

router.get('/executions', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  const filter = String(req.query.status || 'active');
  let statusClause: string;
  if (filter === 'active') {
    statusClause = 'status=in.(cooling,running,ci,merging,deploying,verifying)';
  } else if (filter === 'all') {
    statusClause = '';
  } else {
    statusClause = `status=eq.${filter}`;
  }
  const limit = Math.min(parseInt(String(req.query.limit || '100'), 10), 500);
  const qs = [statusClause, `order=created_at.desc`, `limit=${limit}`].filter(Boolean).join('&');
  const r = await supaGet<unknown[]>(supa, `/rest/v1/dev_autopilot_executions?${qs}`);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error });
  return res.json({ ok: true, executions: r.data || [] });
});

// =============================================================================
// GET /config, POST /config/kill-switch
// =============================================================================

router.get('/config', requireDevRole, async (_req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  const r = await supaGet<unknown[]>(supa, `/rest/v1/dev_autopilot_config?id=eq.1&limit=1`);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error });
  const row = (r.data || [])[0];
  if (!row) return res.status(404).json({ ok: false, error: 'config row missing' });
  return res.json({ ok: true, config: row });
});

router.post('/config/kill-switch', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  const armed = Boolean(req.body?.armed);
  const r = await supaPatch(supa, `/rest/v1/dev_autopilot_config?id=eq.1`, {
    kill_switch: armed,
    updated_at: new Date().toISOString(),
  });
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error });
  await emitOasisEvent({
    vtid: SCAN_VTID,
    type: armed ? 'dev_autopilot.kill_switch.activated' : 'dev_autopilot.kill_switch.deactivated',
    source: 'dev-autopilot',
    status: 'warning',
    message: `Dev Autopilot kill switch ${armed ? 'ARMED' : 'disarmed'}`,
  });
  return res.json({ ok: true, armed });
});

export default router;
