/**
 * Autonomy Pulse — unified supervisor feed (PR-11)
 *
 * One endpoint that aggregates every pending decision and in-flight
 * autonomous action across the self-healing pipeline and the dev-autopilot
 * pipeline. Goal: a single pane of glass so the supervisor never has to
 * correlate across GitHub, Cloud Run, Supabase, OASIS, Self-Healing, and
 * Dev Autopilot screens separately.
 *
 * Feed item types:
 *   - pending_finding      autopilot_recommendations (dev_autopilot, new) — needs approval
 *   - pending_heal         self_healing_log (outcome=pending) — needs diagnosis review
 *   - active_execution     dev_autopilot_executions (cooling|running|ci|merging|deploying|verifying)
 *
 * Each item carries a normalized shape with:
 *   - id, source, title, description, severity, created_at, age_minutes
 *   - actions: which verbs the UI can present (approve/reject/snooze/cancel/...)
 *   - source_url: deep link back to the canonical source tab
 *   - raw: the original row (minus heavy fields) for anyone who needs detail
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

const router = Router();
const LOG_PREFIX = '[autonomy-pulse]';

// =============================================================================
// Auth — dev-only (requires app_metadata.exafy_admin === true)
// =============================================================================

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
    res.status(403).json({ ok: false, error: 'Autonomy Pulse requires developer access (exafy_admin)' });
  });
  if (authFailed) return;
}

// =============================================================================
// Supabase
// =============================================================================

interface SupaConfig { url: string; key: string; }

function getSupabase(): SupaConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return { url, key };
}

async function supaGet<T>(s: SupaConfig, path: string): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(`${s.url}${path}`, {
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}` },
    });
    if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// =============================================================================
// Types (normalized feed item)
// =============================================================================

export type PulseSource =
  | 'dev_autopilot_finding'
  | 'self_healing'
  | 'autonomous_execution'
  // VTID-02956 (PR-L1.5): failing test contracts surface here so Pulse
  // becomes the single "what needs my attention" view across detectors,
  // self-healing, executions, AND runtime contract regressions.
  | 'test_contract_failure';
export type PulseSeverity = 'critical' | 'warning' | 'info';
export type PulseAction =
  | 'approve'            // dev_autopilot finding → approve-auto-execute
  | 'reject'             // dev_autopilot finding → reject
  | 'snooze'             // dev_autopilot finding → snooze 24h
  | 'view_plan'          // dev_autopilot finding → expand plan in dev-autopilot tab
  | 'investigate'        // self_healing → open diagnosis
  | 'apply_heal'         // self_healing → apply fix spec
  | 'discard_heal'       // self_healing → mark won't-fix
  | 'cancel'             // autonomous_execution → cancel during cooldown
  | 'view_trace'         // autonomous_execution → open lineage
  | 'rerun_contract'     // test_contract_failure → manually re-run the probe
  | 'open_contract';     // test_contract_failure → open contract panel

export interface PulseItem {
  id: string;                          // stable across reloads: `${source}:${row.id}`
  source: PulseSource;
  title: string;
  description: string;
  severity: PulseSeverity;
  created_at: string;
  age_minutes: number;
  actions: PulseAction[];
  source_url: string;                  // deep link to the canonical tab
  metadata: Record<string, unknown>;
}

// =============================================================================
// Row types per source
// =============================================================================

interface FindingRow {
  id: string;
  title: string | null;
  summary: string | null;
  risk_class: 'low' | 'medium' | 'high' | null;
  impact_score: number | null;
  effort_score: number | null;
  auto_exec_eligible: boolean | null;
  domain: string | null;
  first_seen_at: string | null;
  seen_count: number | null;
  spec_snapshot: Record<string, unknown> | null;
}

interface HealRow {
  id: string;
  vtid: string;
  endpoint: string;
  failure_class: string;
  created_at: string;
  diagnosis: Record<string, unknown> | null;
  attempt_number: number | null;
}

interface ExecRow {
  id: string;
  finding_id: string;
  status: string;
  pr_url: string | null;
  pr_number: number | null;
  branch: string | null;
  execute_after: string | null;
  auto_fix_depth: number | null;
  self_healing_vtid: string | null;
  created_at: string;
  updated_at: string | null;
}

// VTID-02956 (PR-L1.5): Failing test contracts row.
interface ContractRow {
  id: string;
  capability: string;
  service: string;
  environment: string;
  target_endpoint: string | null;
  target_file: string | null;
  owner: string;
  status: 'fail' | 'quarantined';
  last_status: string | null;       // previous status — for regression detection
  last_run_at: string | null;
  last_failure_signature: string | null;
}

// =============================================================================
// Normalizers
// =============================================================================

function ageMinutes(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.round(ms / 60_000));
}

function severityFromRisk(risk: string | null, impact: number | null): PulseSeverity {
  if (risk === 'high' || (impact && impact >= 8)) return 'critical';
  if (risk === 'medium' || (impact && impact >= 5)) return 'warning';
  return 'info';
}

function severityFromFailureClass(fc: string): PulseSeverity {
  const critical = new Set(['timeout', '5xx', 'crash', 'oom']);
  return critical.has(fc) ? 'critical' : 'warning';
}

function normalizeFinding(row: FindingRow): PulseItem {
  const created = row.first_seen_at || new Date().toISOString();
  return {
    id: `dev_autopilot_finding:${row.id}`,
    source: 'dev_autopilot_finding',
    title: row.title || 'Untitled finding',
    description: row.summary || '',
    severity: severityFromRisk(row.risk_class, row.impact_score),
    created_at: created,
    age_minutes: ageMinutes(created),
    actions: row.auto_exec_eligible
      ? ['approve', 'view_plan', 'snooze', 'reject']
      : ['view_plan', 'snooze', 'reject'],
    source_url: `/command-hub/dev-autopilot?finding_id=${row.id}`,
    metadata: {
      finding_id: row.id,
      risk_class: row.risk_class,
      impact_score: row.impact_score,
      effort_score: row.effort_score,
      auto_exec_eligible: row.auto_exec_eligible,
      domain: row.domain,
      seen_count: row.seen_count,
      file_path: (row.spec_snapshot as { file_path?: string })?.file_path,
    },
  };
}

function normalizeHeal(row: HealRow): PulseItem {
  const confidence = Number((row.diagnosis || {}).confidence || 0);
  const description = typeof (row.diagnosis || {}).summary === 'string'
    ? ((row.diagnosis || {}).summary as string)
    : `${row.failure_class} failure on ${row.endpoint}`;
  return {
    id: `self_healing:${row.id}`,
    source: 'self_healing',
    title: `Self-heal needed: ${row.endpoint}`,
    description,
    severity: severityFromFailureClass(row.failure_class),
    created_at: row.created_at,
    age_minutes: ageMinutes(row.created_at),
    actions: confidence >= 0.8
      ? ['apply_heal', 'investigate', 'discard_heal']
      : ['investigate', 'apply_heal', 'discard_heal'],
    source_url: `/command-hub/infrastructure/self-healing?vtid=${encodeURIComponent(row.vtid)}`,
    metadata: {
      vtid: row.vtid,
      endpoint: row.endpoint,
      failure_class: row.failure_class,
      attempt_number: row.attempt_number,
      confidence,
    },
  };
}

// VTID-02956 (PR-L1.5): a failing or quarantined test contract is a
// runtime regression — it's the most actionable signal Pulse can carry
// because the assertion is precise (the contract's expected_behavior
// states exactly what "healthy" means). A `regressed: pass→fail`
// transition is treated as critical; a still-failing or quarantined
// contract is warning (already on the queue, no new news).
function normalizeContract(row: ContractRow): PulseItem {
  const regressed = row.status === 'fail' && row.last_status === 'pass';
  const severity: PulseSeverity = row.status === 'quarantined' || regressed ? 'critical' : 'warning';
  const ts = row.last_run_at || new Date().toISOString();
  const headlineSuffix = regressed ? ' (regressed)' : row.status === 'quarantined' ? ' (quarantined)' : '';
  return {
    id: `test_contract_failure:${row.id}`,
    source: 'test_contract_failure',
    title: `Contract failing: ${row.capability}${headlineSuffix}`,
    description: row.last_failure_signature
      || `${row.target_endpoint || row.target_file || row.service} no longer satisfies its test contract.`,
    severity,
    created_at: ts,
    age_minutes: ageMinutes(ts),
    actions: ['rerun_contract', 'open_contract', 'investigate'],
    source_url: `/command-hub/voice/test-contracts/?capability=${encodeURIComponent(row.capability)}`,
    metadata: {
      contract_id: row.id,
      capability: row.capability,
      service: row.service,
      environment: row.environment,
      target_endpoint: row.target_endpoint,
      target_file: row.target_file,
      owner: row.owner,
      status: row.status,
      previous_status: row.last_status,
      regressed,
      failure_signature: row.last_failure_signature,
    },
  };
}

function normalizeExecution(row: ExecRow): PulseItem {
  const created = row.updated_at || row.created_at;
  const statusLabel: Record<string, string> = {
    cooling: 'cooling down before execution',
    running: 'agent is executing the plan',
    ci: 'PR awaiting CI checks',
    merging: 'merging approved PR',
    deploying: 'gateway deploying',
    verifying: 'post-deploy verification',
  };
  const label = statusLabel[row.status] || row.status;
  const title = row.pr_url
    ? `Execution ${row.id.slice(0, 8)} — ${label}`
    : `Execution ${row.id.slice(0, 8)} — ${label}`;
  return {
    id: `autonomous_execution:${row.id}`,
    source: 'autonomous_execution',
    title,
    description: row.pr_url ? `PR: ${row.pr_url}` : `Plan execution in progress`,
    severity: (row.auto_fix_depth || 0) > 0 ? 'warning' : 'info',
    created_at: created,
    age_minutes: ageMinutes(created),
    actions: row.status === 'cooling'
      ? ['cancel', 'view_trace']
      : ['view_trace'],
    source_url: `/command-hub/dev-autopilot?execution_id=${row.id}`,
    metadata: {
      execution_id: row.id,
      finding_id: row.finding_id,
      status: row.status,
      pr_url: row.pr_url,
      pr_number: row.pr_number,
      branch: row.branch,
      execute_after: row.execute_after,
      auto_fix_depth: row.auto_fix_depth,
      self_healing_vtid: row.self_healing_vtid,
    },
  };
}

// =============================================================================
// Data fetches (parallelizable)
// =============================================================================

async function fetchFindings(s: SupaConfig, limit: number): Promise<FindingRow[]> {
  const r = await supaGet<FindingRow[]>(
    s,
    `/rest/v1/autopilot_recommendations?source_type=eq.dev_autopilot&status=eq.new` +
    `&select=id,title,summary,risk_class,impact_score,effort_score,auto_exec_eligible,domain,first_seen_at,seen_count,spec_snapshot` +
    `&order=impact_score.desc.nullslast,first_seen_at.desc&limit=${limit}`,
  );
  return r.ok && r.data ? r.data : [];
}

async function fetchHeals(s: SupaConfig, limit: number): Promise<HealRow[]> {
  const r = await supaGet<HealRow[]>(
    s,
    `/rest/v1/self_healing_log?outcome=eq.pending` +
    `&select=id,vtid,endpoint,failure_class,created_at,diagnosis,attempt_number` +
    `&order=created_at.desc&limit=${limit}`,
  );
  return r.ok && r.data ? r.data : [];
}

async function fetchExecutions(s: SupaConfig, limit: number): Promise<ExecRow[]> {
  const r = await supaGet<ExecRow[]>(
    s,
    `/rest/v1/dev_autopilot_executions?status=in.(cooling,running,ci,merging,deploying,verifying)` +
    `&select=id,finding_id,status,pr_url,pr_number,branch,execute_after,auto_fix_depth,self_healing_vtid,created_at,updated_at` +
    `&order=created_at.desc&limit=${limit}`,
  );
  return r.ok && r.data ? r.data : [];
}

async function fetchFailingContracts(s: SupaConfig, limit: number): Promise<ContractRow[]> {
  const r = await supaGet<ContractRow[]>(
    s,
    `/rest/v1/test_contracts?status=in.(fail,quarantined)` +
    `&select=id,capability,service,environment,target_endpoint,target_file,owner,status,last_status,last_run_at,last_failure_signature` +
    `&order=last_run_at.desc.nullslast&limit=${limit}`,
  );
  return r.ok && r.data ? r.data : [];
}

// =============================================================================
// Pure aggregator — unit-testable (no network)
// =============================================================================

export function aggregatePulse(
  findings: FindingRow[],
  heals: HealRow[],
  executions: ExecRow[],
  contracts: ContractRow[] = [],
): PulseItem[] {
  const items = [
    ...findings.map(normalizeFinding),
    ...heals.map(normalizeHeal),
    ...executions.map(normalizeExecution),
    ...contracts.map(normalizeContract),
  ];
  // Sort: critical first, then newer first within same severity.
  const sevRank: Record<PulseSeverity, number> = { critical: 0, warning: 1, info: 2 };
  items.sort((a, b) => {
    const s = sevRank[a.severity] - sevRank[b.severity];
    if (s !== 0) return s;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  return items;
}

// =============================================================================
// Routes
// =============================================================================

router.get('/pulse', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });

  const perSourceLimit = Math.min(parseInt(String(req.query.limit || '50'), 10), 200);
  const filter = String(req.query.filter || 'all') as 'all' | 'findings' | 'heals' | 'executions' | 'contracts';

  try {
    const [findings, heals, executions, contracts] = await Promise.all([
      filter === 'all' || filter === 'findings'
        ? fetchFindings(supa, perSourceLimit)
        : Promise.resolve<FindingRow[]>([]),
      filter === 'all' || filter === 'heals'
        ? fetchHeals(supa, perSourceLimit)
        : Promise.resolve<HealRow[]>([]),
      filter === 'all' || filter === 'executions'
        ? fetchExecutions(supa, perSourceLimit)
        : Promise.resolve<ExecRow[]>([]),
      filter === 'all' || filter === 'contracts'
        ? fetchFailingContracts(supa, perSourceLimit)
        : Promise.resolve<ContractRow[]>([]),
    ]);

    const items = aggregatePulse(findings, heals, executions, contracts);
    return res.json({
      ok: true,
      items,
      counts: {
        findings: findings.length,
        heals: heals.length,
        executions: executions.length,
        contracts: contracts.length,
        total: items.length,
        critical: items.filter((i) => i.severity === 'critical').length,
        warning: items.filter((i) => i.severity === 'warning').length,
        info: items.filter((i) => i.severity === 'info').length,
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} pulse fetch failed:`, err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

/** GET /pulse/counts — lightweight badge counter for Command Hub nav. */
router.get('/pulse/counts', requireDevRole, async (_req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });

  try {
    const [findings, heals, executions, contracts] = await Promise.all([
      supaGet<Array<{ id: string }>>(supa, `/rest/v1/autopilot_recommendations?source_type=eq.dev_autopilot&status=eq.new&select=id&limit=1000`),
      supaGet<Array<{ id: string }>>(supa, `/rest/v1/self_healing_log?outcome=eq.pending&select=id&limit=1000`),
      supaGet<Array<{ id: string }>>(supa, `/rest/v1/dev_autopilot_executions?status=in.(cooling,running,ci,merging,deploying,verifying)&select=id&limit=1000`),
      supaGet<Array<{ id: string }>>(supa, `/rest/v1/test_contracts?status=in.(fail,quarantined)&select=id&limit=1000`),
    ]);

    return res.json({
      ok: true,
      counts: {
        findings: findings.data?.length || 0,
        heals: heals.data?.length || 0,
        executions: executions.data?.length || 0,
        contracts: contracts.data?.length || 0,
        total:
          (findings.data?.length || 0) +
          (heals.data?.length || 0) +
          (executions.data?.length || 0) +
          (contracts.data?.length || 0),
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
