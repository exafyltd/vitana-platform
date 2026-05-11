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

import { Router, Request, Response, NextFunction } from 'express';
import { ingestScan, ScanInput } from '../services/dev-autopilot-synthesis';
import { generatePlanVersion } from '../services/dev-autopilot-planning';
import { approveAutoExecute, cancelExecution } from '../services/dev-autopilot-execute';
import { bridgeFailureToSelfHealing, FailureStage } from '../services/dev-autopilot-bridge';
import { writeAutopilotFailure } from '../services/dev-autopilot-self-heal-log';
import { dryRunPreflight, RiskClass } from '../services/dev-autopilot-safety';
import { emitOasisEvent } from '../services/oasis-event-service';
import { recordOutcome } from '../services/dev-autopilot-outcomes';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

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

async function supaPost(supa: SupaConfig, path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${supa.url}${path}`, {
      method: 'POST',
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

/** Dev-only guard. Runs requireAuth (verifies Supabase JWT + populates
 *  req.identity) then requires app_metadata.exafy_admin === true. The
 *  Supabase JWT's `role` claim is always 'authenticated' for logged-in
 *  users; dev access is granted via exafy_admin. Internal calls can
 *  bypass via X-Gateway-Internal + GATEWAY_INTERNAL_TOKEN. */
async function requireDevRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.get('X-Gateway-Internal') === (process.env.GATEWAY_INTERNAL_TOKEN || '__dev__') &&
      process.env.GATEWAY_INTERNAL_TOKEN) {
    return next();
  }
  let authFailed = false;
  await requireAuth(req as AuthenticatedRequest, res, () => {
    const identity = (req as AuthenticatedRequest).identity;
    if (!identity) {
      authFailed = true;
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      return;
    }
    if (identity.exafy_admin === true) return next();
    authFailed = true;
    res.status(403).json({ ok: false, error: 'Dev Autopilot requires developer access (exafy_admin)' });
  });
  if (authFailed) return;
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
  const triggeredBy = body.triggered_by || 'api';
  try {
    const result = await ingestScan({
      signals: body.signals,
      triggered_by: triggeredBy,
      metadata: body.metadata || {},
    });
    if (!result.ok) {
      // Synthesis returned a non-ok result. Surface it on the Self-Healing
      // screen so a silent ingest failure is visible without scraping CI logs.
      const supa = getSupabase();
      if (supa) {
        await writeAutopilotFailure(supa, {
          stage: 'scan_ingest',
          vtid: 'VTID-DA-SCAN',
          endpoint: 'autopilot.scan_ingest',
          failure_class: 'dev_autopilot_scan_ingest_failed',
          confidence: 0,
          diagnosis: {
            summary: `Scan ingest returned ok=false: ${result.error || 'no error message'}`,
            triggered_by: triggeredBy,
            signal_count: body.signals.length,
            error: result.error,
          },
          outcome: 'escalated',
          attempt_number: 1,
        });
      }
    }
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    console.error(`${LOG_PREFIX} /scan failed:`, err);
    const supa = getSupabase();
    if (supa) {
      await writeAutopilotFailure(supa, {
        stage: 'scan_ingest',
        vtid: 'VTID-DA-SCAN',
        endpoint: 'autopilot.scan_ingest',
        failure_class: 'dev_autopilot_scan_ingest_threw',
        confidence: 0,
        diagnosis: {
          summary: `Scan ingest threw: ${String(err).slice(0, 300)}`,
          triggered_by: triggeredBy,
          signal_count: body.signals.length,
          error: String(err),
        },
        outcome: 'escalated',
        attempt_number: 1,
      });
    }
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// =============================================================================
// POST /impact-ingest — diff-aware impact findings from PR-time scans
// =============================================================================
// Called by .github/workflows/DEV-AUTOPILOT-IMPACT.yml after the impact scan
// completes on a push to main. Rows land in autopilot_recommendations with
// source_type='dev_autopilot_impact' so they show up in the Developer
// Autopilot view alongside baseline findings and can be auto-executed by
// the same plan → approve → PR pipeline.
//
// Dedup: (source_type, signal_fingerprint) partial-unique index on status
// IN ('new','snoozed') means re-ingesting the same finding bumps
// seen_count instead of duplicating. Fingerprint = sha256 of
// rule|file_path|message[:60] — stable across line-shift diffs.
//
// Skipped: findings with severity='info' (too noisy for the queue).

router.post('/impact-ingest', requireScanToken, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });

  const body = req.body as {
    findings?: Array<{
      rule: string;
      category?: string;
      severity: 'blocker' | 'warning' | 'info';
      file_path?: string | null;
      line_number?: number | null;
      message: string;
      suggested_action?: string;
      raw?: Record<string, unknown>;
    }>;
    metadata?: Record<string, unknown>;
  };
  if (!body || !Array.isArray(body.findings)) {
    return res.status(400).json({ ok: false, error: 'body must include findings[]' });
  }

  const { createHash } = await import('node:crypto');
  const now = new Date().toISOString();
  let newCount = 0;
  let updatedCount = 0;
  let skippedInfo = 0;

  for (const f of body.findings) {
    if (!f || !f.rule || !f.message) continue;
    if (f.severity === 'info') { skippedInfo++; continue; }

    const fingerprint = createHash('sha256')
      .update(`${f.rule}|${f.file_path || ''}|${(f.message || '').slice(0, 60)}`)
      .digest('hex')
      .slice(0, 32);

    // Lookup existing live finding with this fingerprint
    const existing = await supaGet<Array<{ id: string; seen_count: number | null }>>(
      supa,
      `/rest/v1/autopilot_recommendations?source_type=eq.dev_autopilot_impact&signal_fingerprint=eq.${fingerprint}&status=in.(new,snoozed)&select=id,seen_count&limit=1`,
    );
    const hit = existing.ok && existing.data && existing.data[0];
    if (hit) {
      await supaPatch(supa, `/rest/v1/autopilot_recommendations?id=eq.${hit.id}`, {
        seen_count: (hit.seen_count || 1) + 1,
        last_seen_at: now,
        updated_at: now,
      });
      updatedCount++;
      continue;
    }

    // Scoring maps severity → risk class + impact score; effort is
    // deliberately low because most impact findings are small companion
    // changes the autopilot can handle in one short PR.
    const riskClass = f.severity === 'blocker' ? 'high' : 'medium';
    const impactScore = f.severity === 'blocker' ? 8 : 5;
    const effortScore = 3;
    const title = buildImpactTitle(f);
    const domain = domainForImpactCategory(f.category || 'companion');

    const inserted = await supaPost(supa, '/rest/v1/autopilot_recommendations', {
      title,
      summary: f.message,
      domain,
      risk_level: riskClass,
      risk_class: riskClass,
      impact_score: impactScore,
      effort_score: effortScore,
      status: 'new',
      source_type: 'dev_autopilot_impact',
      // Impact findings ship as auto-exec-eligible at blocker severity only —
      // warnings are still reviewable but won't be picked up by auto-approve
      // (which gates on the scanner allowlist, not this field).
      auto_exec_eligible: f.severity === 'blocker',
      signal_fingerprint: fingerprint,
      first_seen_at: now,
      last_seen_at: now,
      seen_count: 1,
      spec_snapshot: {
        rule: f.rule,
        category: f.category || 'companion',
        severity: f.severity,
        file_path: f.file_path || null,
        line_number: f.line_number || null,
        suggested_action: f.suggested_action || null,
        scanner: `impact:${f.rule}`,
        signal_type: 'impact_' + (f.category || 'companion'),
        ...(f.raw || {}),
        source_metadata: body.metadata || null,
      },
    });
    if (inserted.ok) newCount++;
  }

  return res.json({
    ok: true,
    new_count: newCount,
    updated_count: updatedCount,
    skipped_info: skippedInfo,
  });
});

function buildImpactTitle(f: {
  rule: string;
  file_path?: string | null;
  severity: 'blocker' | 'warning' | 'info';
}): string {
  const base = f.file_path ? (f.file_path.split('/').pop() || f.file_path) : null;
  const rulePretty = f.rule.replace(/-/g, ' ');
  if (base) return `[${f.severity}] ${rulePretty} in ${base}`;
  return `[${f.severity}] ${rulePretty}`;
}

function domainForImpactCategory(cat: string): string {
  switch (cat) {
    case 'conflict':   return 'architecture';
    case 'semantic':   return 'routes';
    case 'companion':  return 'services';
    default:           return 'general';
  }
}

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
// GET /scanners — scanner registry + live counts
// =============================================================================

router.get('/scanners', requireDevRole, async (_req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });

  // 1. Load canonical registry rows.
  const regR = await supaGet<Array<{
    scanner: string;
    title: string;
    description: string;
    signal_type: string;
    category: string;
    maturity: string;
    default_severity: string;
    default_risk_class: string;
    enabled: boolean;
    docs_url: string | null;
    created_at: string;
    updated_at: string;
  }>>(supa, `/rest/v1/dev_autopilot_scanners?order=category.asc,scanner.asc`);
  if (!regR.ok) return res.status(500).json({ ok: false, error: regR.error });

  // 2. Compute live counts per scanner:
  //      - open_findings  — recommendations in status='new' by spec_snapshot->>'scanner'
  //      - last_scan_at   — most recent signal ingested per scanner
  //    Both come from dev_autopilot_signals + autopilot_recommendations. We
  //    fetch the raw rows once and aggregate in JS — avoids N round-trips.
  // 3. Cross-reference the auto-approve config so each row carries its
  //    auto_approved status — the Command Hub Auto-Approve tab reads this
  //    to show ops which scanners the autopilot would pick unattended.
  const [openR, signalsR, cfgR] = await Promise.all([
    supaGet<Array<{ spec_snapshot: { scanner?: string } | null }>>(
      supa,
      `/rest/v1/autopilot_recommendations?source_type=eq.dev_autopilot&status=eq.new&select=spec_snapshot&limit=2000`,
    ),
    supaGet<Array<{ scanner: string | null; created_at: string | null }>>(
      supa,
      `/rest/v1/dev_autopilot_signals?scanner=not.is.null&select=scanner,created_at&order=created_at.desc&limit=5000`,
    ),
    supaGet<Array<{ auto_approve_enabled: boolean; auto_approve_scanners: string[] }>>(
      supa,
      `/rest/v1/dev_autopilot_config?id=eq.1&select=auto_approve_enabled,auto_approve_scanners&limit=1`,
    ),
  ]);

  const openCount = new Map<string, number>();
  if (openR.ok && Array.isArray(openR.data)) {
    for (const row of openR.data) {
      const name = row.spec_snapshot?.scanner;
      if (!name) continue;
      openCount.set(name, (openCount.get(name) || 0) + 1);
    }
  }
  const lastSeen = new Map<string, string>();
  const totalSignals = new Map<string, number>();
  if (signalsR.ok && Array.isArray(signalsR.data)) {
    for (const row of signalsR.data) {
      if (!row.scanner) continue;
      if (!lastSeen.has(row.scanner) && row.created_at) lastSeen.set(row.scanner, row.created_at);
      totalSignals.set(row.scanner, (totalSignals.get(row.scanner) || 0) + 1);
    }
  }
  const cfg = cfgR.ok && cfgR.data && cfgR.data[0];
  const autoEnabled = !!(cfg && cfg.auto_approve_enabled);
  const autoList = new Set(cfg && cfg.auto_approve_scanners ? cfg.auto_approve_scanners : []);

  const scanners = (regR.data || []).map(r => ({
    ...r,
    open_findings: openCount.get(r.scanner) || 0,
    last_signal_at: lastSeen.get(r.scanner) || null,
    total_signals_in_last_5000: totalSignals.get(r.scanner) || 0,
    // Effective auto-approve status — true only when the master switch is ON
    // AND the scanner id is in the allowlist.
    auto_approved: autoEnabled && autoList.has(r.scanner),
    in_auto_approve_list: autoList.has(r.scanner),
  }));

  return res.json({ ok: true, scanners, count: scanners.length });
});

// =============================================================================
// GET /impact-rules — diff-aware rule registry
// =============================================================================

router.get('/impact-rules', requireDevRole, async (_req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });

  const [rulesR, cfgR] = await Promise.all([
    supaGet<Array<{
      rule: string;
      title: string;
      description: string;
      category: string;
      severity: string;
      enabled: boolean;
      docs_url: string | null;
      created_at: string;
      updated_at: string;
    }>>(supa, `/rest/v1/dev_autopilot_impact_rules?order=category.asc,rule.asc`),
    supaGet<Array<{ auto_approve_impact_enabled: boolean; auto_approve_impact_rules: string[] }>>(
      supa,
      `/rest/v1/dev_autopilot_config?id=eq.1&select=auto_approve_impact_enabled,auto_approve_impact_rules&limit=1`,
    ),
  ]);
  if (!rulesR.ok) return res.status(500).json({ ok: false, error: rulesR.error });

  const cfg = cfgR.ok && cfgR.data && cfgR.data[0];
  const autoEnabled = !!(cfg && cfg.auto_approve_impact_enabled);
  const autoList = new Set(cfg && cfg.auto_approve_impact_rules ? cfg.auto_approve_impact_rules : []);

  const rules = (rulesR.data || []).map(r => ({
    ...r,
    auto_approved: autoEnabled && autoList.has(r.rule),
    in_auto_approve_list: autoList.has(r.rule),
  }));

  return res.json({ ok: true, rules, count: rules.length });
});

// =============================================================================
// Self-healing autonomy readiness
// =============================================================================

type SelfHealingGateStatus = 'ready' | 'blocked' | 'pending';

interface SelfHealingAutonomyGate {
  id: string;
  title: string;
  status: SelfHealingGateStatus;
  description: string;
  evidence: string[];
  next_step?: string;
  command_hub_target?: string;
}

interface SelfHealingAutonomyReadiness {
  summary: {
    ready_gates: number;
    total_gates: number;
    autonomy_percent: number;
    next_gate: SelfHealingAutonomyGate | null;
  };
  gates: SelfHealingAutonomyGate[];
}

export function buildSelfHealingAutonomyReadiness(): SelfHealingAutonomyReadiness {
  const gates: SelfHealingAutonomyGate[] = [
    {
      id: 'spec_hydration',
      title: 'Hydrated worker specs',
      status: 'ready',
      description: 'Self-healing VTIDs must reach workers with canonical spec text, metadata, task domain, target paths, and spec hash.',
      evidence: [
        'pending tasks include spec_content from vtid_specs',
        'self-healing workers fail closed without hydrated specs',
        'target_paths are forwarded into governance routing',
      ],
      command_hub_target: '/command-hub/autonomy/self-healing/',
    },
    {
      id: 'completion_evidence',
      title: 'No false terminal success',
      status: 'ready',
      description: 'A self-healing task cannot terminalize success from an LLM claim or a verification bypass.',
      evidence: [
        'worker-runner removed unconditional skip_verification',
        'gateway rejects self-healing success without repair evidence',
        'worker terminalizes success only after gateway completion acceptance',
      ],
      command_hub_target: '/command-hub/autonomy/self-healing/',
    },
    {
      id: 'patch_artifacts',
      title: 'Real patch artifacts',
      status: 'blocked',
      description: 'The worker must apply a validated diff in an isolated workspace before reporting a repair.',
      evidence: [],
      next_step: 'Create patch-contract.ts and patch-workspace-service.ts, then require diff hash, changed files, and test output before ok=true.',
      command_hub_target: '/command-hub/autopilot/auto-approve/',
    },
    {
      id: 'test_execution',
      title: 'Declared tests executed',
      status: 'pending',
      description: 'Every repair must run the tests declared by the patch contract plus package-level minimum checks.',
      evidence: [],
      next_step: 'Persist test commands, exit codes, and output snippets as repair evidence.',
      command_hub_target: '/command-hub/autopilot/runs/',
    },
    {
      id: 'deploy_canary',
      title: 'Canary deploy identity',
      status: 'pending',
      description: 'A fix is not production-healed until the deployed revision and traffic split are known.',
      evidence: [],
      next_step: 'Record git SHA, Cloud Run revision, deployment URL, and 10% canary traffic before full rollout.',
      command_hub_target: '/command-hub/operations/deployments/',
    },
    {
      id: 'production_verification',
      title: 'Production health verification',
      status: 'pending',
      description: 'Terminal fixed requires a healthy post-fix snapshot for the target and no blast-radius regression.',
      evidence: [],
      next_step: 'Tie self-healing snapshots to patch/deploy evidence and require target health before fixed.',
      command_hub_target: '/command-hub/autonomy/self-healing/',
    },
    {
      id: 'rollback_execution',
      title: 'Actual rollback',
      status: 'pending',
      description: 'Rollback events must reflect real traffic movement, not only an emitted status event.',
      evidence: [],
      next_step: 'Dispatch the rollback workflow or Cloud Run traffic API, then verify the previous revision is serving.',
      command_hub_target: '/command-hub/operations/deployments/',
    },
    {
      id: 'repair_memory',
      title: 'Repair memory and anti-loop controls',
      status: 'pending',
      description: 'The system must remember failed and known-good fixes per incident signature.',
      evidence: [],
      next_step: 'Persist repair attempts by incident signature, spec hash, patch hash, test result, deploy revision, and recurrence outcome.',
      command_hub_target: '/command-hub/autonomy/self-healing/',
    },
  ];

  const readyGates = gates.filter(g => g.status === 'ready').length;
  const nextGate = gates.find(g => g.status !== 'ready') || null;

  return {
    summary: {
      ready_gates: readyGates,
      total_gates: gates.length,
      autonomy_percent: gates.length > 0 ? Math.round((readyGates / gates.length) * 100) : 0,
      next_gate: nextGate,
    },
    gates,
  };
}

// =============================================================================
// GET /auto-approve — aggregated view of the auto-approve registry
// =============================================================================
// One call for the Command Hub Auto-Approve tab. Returns:
//   - master switches (enabled flags, daily budget, concurrency cap)
//   - budget usage (approved_today, running_now)
//   - baseline scanners with auto_approved + in_auto_approve_list flags
//   - impact rules with the same flags
//   - derived "autonomy progress" — share of scanners/rules currently opted in
// The long-term direction is documented inline: the user's stated goal is
// "extend the list until fully autonomous, self-improving and self-healing".
// Each unchecked row here is a step on that path.

router.get('/auto-approve', requireDevRole, async (_req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });

  const [cfgR, scannersR, rulesR, approvedTodayR, runningR] = await Promise.all([
    supaGet<Array<{
      auto_approve_enabled: boolean;
      auto_approve_max_effort: number;
      auto_approve_risk_classes: string[];
      auto_approve_scanners: string[];
      auto_approve_impact_enabled: boolean;
      auto_approve_impact_rules: string[];
      daily_budget: number;
      concurrency_cap: number;
      kill_switch: boolean;
    }>>(supa,
      `/rest/v1/dev_autopilot_config?id=eq.1`
      + `&select=auto_approve_enabled,auto_approve_max_effort,auto_approve_risk_classes,`
      + `auto_approve_scanners,auto_approve_impact_enabled,auto_approve_impact_rules,`
      + `daily_budget,concurrency_cap,kill_switch&limit=1`),
    supaGet<Array<{
      scanner: string; title: string; description: string; category: string;
      maturity: string; default_severity: string; default_risk_class: string;
      enabled: boolean;
    }>>(supa, `/rest/v1/dev_autopilot_scanners?order=category.asc,scanner.asc`),
    supaGet<Array<{
      rule: string; title: string; description: string; category: string;
      severity: string; enabled: boolean;
    }>>(supa, `/rest/v1/dev_autopilot_impact_rules?order=category.asc,rule.asc`),
    supaGet<unknown[]>(
      supa,
      `/rest/v1/dev_autopilot_executions?approved_at=gte.${(function () {
        const t = new Date(); t.setUTCHours(0, 0, 0, 0); return t.toISOString();
      })()}&select=id`,
    ),
    supaGet<unknown[]>(
      supa,
      `/rest/v1/dev_autopilot_executions?status=in.(running,ci,merging,deploying,verifying)&select=id`,
    ),
  ]);
  if (!cfgR.ok) return res.status(500).json({ ok: false, error: cfgR.error });
  const cfg = cfgR.data && cfgR.data[0];
  if (!cfg) return res.status(500).json({ ok: false, error: 'dev_autopilot_config missing' });

  const scannerAllow = new Set(cfg.auto_approve_scanners || []);
  const impactAllow = new Set(cfg.auto_approve_impact_rules || []);

  const scanners = (scannersR.data || []).map(s => ({
    ...s,
    auto_approved: cfg.auto_approve_enabled && scannerAllow.has(s.scanner),
    in_auto_approve_list: scannerAllow.has(s.scanner),
  }));
  const rules = (rulesR.data || []).map(r => ({
    ...r,
    auto_approved: cfg.auto_approve_impact_enabled && impactAllow.has(r.rule),
    in_auto_approve_list: impactAllow.has(r.rule),
  }));

  const approvedToday = Array.isArray(approvedTodayR.data) ? approvedTodayR.data.length : 0;
  const running = Array.isArray(runningR.data) ? runningR.data.length : 0;

  const totalSurfaces = scanners.length + rules.length;
  const autoSurfaces = scanners.filter(s => s.auto_approved).length
    + rules.filter(r => r.auto_approved).length;
  const autonomyProgress = totalSurfaces > 0
    ? Math.round((autoSurfaces / totalSurfaces) * 100)
    : 0;

  return res.json({
    ok: true,
    config: {
      kill_switch: cfg.kill_switch,
      daily_budget: cfg.daily_budget,
      concurrency_cap: cfg.concurrency_cap,
      baseline: {
        enabled: cfg.auto_approve_enabled,
        max_effort: cfg.auto_approve_max_effort,
        risk_classes: cfg.auto_approve_risk_classes || [],
        allowed_scanners: cfg.auto_approve_scanners || [],
      },
      impact: {
        enabled: cfg.auto_approve_impact_enabled,
        allowed_rules: cfg.auto_approve_impact_rules || [],
      },
    },
    budget: {
      approved_today: approvedToday,
      daily_budget: cfg.daily_budget,
      running_now: running,
      concurrency_cap: cfg.concurrency_cap,
    },
    progress: {
      auto_approved_surfaces: autoSurfaces,
      total_surfaces: totalSurfaces,
      autonomy_percent: autonomyProgress,
    },
    self_healing: buildSelfHealingAutonomyReadiness(),
    scanners,
    rules,
  });
});

// =============================================================================
// GET /pending-approvals — escalation inbox for the AUTOPILOT popup
// =============================================================================
// Single source of truth for the AUTOPILOT pill badge AND the popup body.
// Returns dev_autopilot* findings that need a human go/no-go decision:
// status='new' AND auto_exec_eligible=false (i.e., the triage step did NOT
// mark this as low-risk-auto-exec). Snoozed rows are filtered out by the
// snoozed_until check. Sorted riskiest-first.
//
// Once Phase 2 ships the auto-exec triage rule, low-risk findings flip to
// auto_exec_eligible=true and the dispatcher executes them silently — those
// disappear from this endpoint, which is exactly what makes the popup small
// enough to be useful for batch decisions.

const PENDING_APPROVALS_PREDICATE =
  'source_type=in.(dev_autopilot,dev_autopilot_impact)' +
  '&status=eq.new' +
  // not.is.true covers both FALSE (default for new rows) and NULL (legacy rows
  // pre-dating the column's existence) — anything not affirmatively auto-exec.
  '&auto_exec_eligible=not.is.true' +
  '&or=(snoozed_until.is.null,snoozed_until.lt.now())';

const PENDING_APPROVALS_SELECT =
  'id,title,summary,domain,risk_class,impact_score,effort_score,' +
  'source_type,seen_count,last_seen_at,signal_fingerprint,spec_snapshot';

router.get('/pending-approvals', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });

  const limit = Math.min(parseInt(String(req.query.limit || '200'), 10), 500);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10), 0);

  // Sort riskiest-first then highest impact then most recent activity.
  const order = 'order=risk_class.desc.nullslast,impact_score.desc.nullslast,last_seen_at.desc';
  const path =
    `/rest/v1/autopilot_recommendations?${PENDING_APPROVALS_PREDICATE}` +
    `&select=${PENDING_APPROVALS_SELECT}&${order}&limit=${limit}&offset=${offset}`;

  const r = await supaGet<unknown[]>(supa, path);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.error });
  const recommendations = r.data || [];
  return res.json({ ok: true, recommendations, count: recommendations.length });
});

router.get('/pending-approvals/count', requireDevRole, async (_req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });

  // PostgREST exact count: HEAD with Prefer: count=exact returns total in
  // Content-Range. We use a tiny GET to sidestep adding a HEAD helper.
  const path =
    `/rest/v1/autopilot_recommendations?${PENDING_APPROVALS_PREDICATE}` +
    `&select=id&limit=1`;

  try {
    const url = `${supa.url}${path}`;
    const resp = await fetch(url, {
      headers: {
        apikey: supa.key,
        Authorization: `Bearer ${supa.key}`,
        Prefer: 'count=exact',
      },
    });
    if (!resp.ok) {
      return res.status(500).json({ ok: false, error: `${resp.status}: ${await resp.text()}` });
    }
    const range = resp.headers.get('content-range') || '';
    const total = parseInt(range.split('/').pop() || '0', 10) || 0;
    return res.json({ ok: true, count: total });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

// =============================================================================
// GET /queue — queue with optional filters
// =============================================================================

router.get('/queue', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });

  const qs = new URLSearchParams();
  // Include both baseline Dev Autopilot findings and the diff-aware impact
  // findings. Callers that want just one kind can pass ?kind=baseline or
  // ?kind=impact; default shows both so the Developer Autopilot view can
  // activate items from either source.
  const kind = String(req.query.kind || 'all');
  if (kind === 'baseline') qs.append('source_type', 'eq.dev_autopilot');
  else if (kind === 'impact') qs.append('source_type', 'eq.dev_autopilot_impact');
  else qs.append('source_type', 'in.(dev_autopilot,dev_autopilot_impact)');
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

  // Pre-flight the safety gate (VTID-01974). High-risk and out-of-allow-scope
  // findings render as Approve & execute cards otherwise; the gate only fires
  // post-approval, so the user faced dead-end buttons. Annotating each row
  // with auto_actionable + block_reason + block_message lets the UI route
  // un-actionable rows into a manual-review lane up front.
  const cfgR = await supaGet<Array<{ allow_scope: string[]; deny_scope: string[] }>>(
    supa,
    `/rest/v1/dev_autopilot_config?id=eq.1&select=allow_scope,deny_scope&limit=1`,
  );
  const cfg = cfgR.ok && cfgR.data && cfgR.data[0]
    ? cfgR.data[0]
    : { allow_scope: [] as string[], deny_scope: [] as string[] };

  const findings = (r.data as Array<Record<string, unknown>> | undefined) || [];
  const annotated = findings.map((f) => {
    const spec = (f.spec_snapshot as Record<string, unknown> | undefined) || {};
    const filePath = typeof spec.file_path === 'string' ? spec.file_path : '';
    const riskClass = (typeof f.risk_class === 'string' ? f.risk_class : 'medium') as RiskClass;
    const pf = dryRunPreflight({
      file_path: filePath,
      risk_class: riskClass,
      allow_scope: cfg.allow_scope || [],
      deny_scope: cfg.deny_scope || [],
    });
    return {
      ...f,
      auto_actionable: pf.auto_actionable,
      block_reason: pf.block_reason,
      block_message: pf.block_message,
    };
  });

  return res.json({ ok: true, findings: annotated });
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

async function rejectById(
  supa: SupaConfig,
  id: string,
  approver_user_id?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const r = await supaPatch(supa, `/rest/v1/autopilot_recommendations?id=eq.${id}&source_type=in.(dev_autopilot,dev_autopilot_impact)`, {
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
    // Outcomes substrate: human said no. The future autonomy-graduation
    // policy reads these rows to identify scanners whose findings get
    // rejected often (signal that the scanner's signal:noise is bad).
    await recordOutcome({
      finding_id: id,
      decision: 'rejected',
      approver_user_id: approver_user_id || null,
    });
  }
  return r;
}

router.post('/findings/:id/reject', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  const userId = (req as AuthenticatedRequest).identity?.user_id;
  const r = await rejectById(supa, req.params.id, userId);
  return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { ok: false, error: r.error });
});

router.post('/findings/batch-reject', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  const ids = (req.body?.ids || []) as string[];
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'ids[] required' });
  }
  const userId = (req as AuthenticatedRequest).identity?.user_id;
  const results = await Promise.all(ids.map(id => rejectById(supa, id, userId).then(r => ({ id, ...r }))));
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
  const r = await supaPatch(supa, `/rest/v1/autopilot_recommendations?id=eq.${id}&source_type=in.(dev_autopilot,dev_autopilot_impact)`, {
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
