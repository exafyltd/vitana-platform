/**
 * Autonomy Trace — unified autonomy timeline (PR-12)
 *
 * A single chronological view of every autonomous action in flight or
 * recently completed, combining:
 *
 *   - Dev Autopilot executions (cooling → running → ci → merging →
 *     deploying → verifying → completed / failed / reverted)
 *   - Self-healing log rows (pending, dispatched, escalated, reconciled)
 *   - Deploy events from OASIS (deploy.gateway.success/failed,
 *     cicd.deploy.service.succeeded/failed, _requested, _accepted)
 *   - CI/verification events (autopilot.verification.passed/failed)
 *
 * Replaces the need to open GitHub Actions + Cloud Run console + Supabase
 * to answer "what did the system just do?".
 *
 * Each node in the returned timeline:
 *   - stable_id, group_id (lineage correlation), ts, source, kind
 *   - status (one of started | progress | success | failure | info)
 *   - headline, detail, metadata
 *   - links[]: deep-links back to canonical sources (PR, deploy, OASIS query)
 *
 * The UI renders these grouped by group_id so a single execution's
 * approve → ci → deploy → verify → done timeline shows as one lane.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';

const router = Router();
const LOG_PREFIX = '[autonomy-trace]';

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
    res.status(403).json({ ok: false, error: 'Autonomy Trace requires developer access (exafy_admin)' });
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
// Types
// =============================================================================

export type TraceSource =
  | 'execution'
  | 'self_healing'
  | 'deploy_event'
  | 'verification'
  // VTID-02956 (PR-L1.5): test-contract runs share the same timeline so
  // the supervisor sees contract pass/fail next to executions + deploys.
  | 'test_contract';
export type TraceStatus = 'started' | 'progress' | 'success' | 'failure' | 'info';
export type TraceKind =
  | 'execution_cooling'
  | 'execution_running'
  | 'execution_ci'
  | 'execution_merging'
  | 'execution_deploying'
  | 'execution_verifying'
  | 'execution_completed'
  | 'execution_failed'
  | 'execution_reverted'
  | 'execution_self_healed'
  | 'self_heal_pending'
  | 'self_heal_dispatched'
  | 'self_heal_escalated'
  | 'self_heal_reconciled'
  | 'deploy_requested'
  | 'deploy_succeeded'
  | 'deploy_failed'
  | 'verification_passed'
  | 'verification_failed'
  // VTID-02956 (PR-L1.5): test-contract lifecycle.
  | 'contract_passed'
  | 'contract_failed'
  | 'contract_dispatched';

export interface TraceNode {
  stable_id: string;
  group_id: string;
  ts: string;
  source: TraceSource;
  kind: TraceKind;
  status: TraceStatus;
  headline: string;
  detail: string;
  metadata: Record<string, unknown>;
  links: Array<{ label: string; url: string }>;
}

// =============================================================================
// Row types
// =============================================================================

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
  parent_execution_id: string | null;
  triage_report: Record<string, unknown> | null;
  failure_stage: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string | null;
  completed_at: string | null;
  // Embedded via PostgREST resource embedding; carries the upstream
  // finding's title + scanner + file_path so each trace row tells a
  // supervisor what the execution was trying to do.
  recommendation: {
    title: string | null;
    spec_snapshot: {
      scanner?: string;
      file_path?: string;
      signal_type?: string;
      [k: string]: unknown;
    } | null;
  } | null;
}

interface HealRow {
  id: string;
  vtid: string;
  endpoint: string;
  failure_class: string;
  outcome: string;
  created_at: string;
  resolved_at: string | null;
  diagnosis: Record<string, unknown> | null;
  attempt_number: number | null;
}

interface OasisEventRow {
  id: string;
  topic: string;
  vtid: string | null;
  status: string;
  message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// =============================================================================
// Helpers
// =============================================================================

function githubPrUrl(pr_url: string | null): string | null {
  if (!pr_url) return null;
  if (pr_url.startsWith('http')) return pr_url;
  return null;
}

function deployEventTopicToKind(topic: string): TraceKind | null {
  switch (topic) {
    case 'deploy.gateway.success':
    case 'cicd.deploy.service.succeeded':
      return 'deploy_succeeded';
    case 'deploy.gateway.failed':
    case 'cicd.deploy.service.failed':
      return 'deploy_failed';
    case 'cicd.deploy.service.requested':
    case 'cicd.deploy.requested':
      return 'deploy_requested';
    case 'autopilot.verification.passed':
      return 'verification_passed';
    case 'autopilot.verification.failed':
      return 'verification_failed';
    // VTID-02956 (PR-L1.5): test-contract topics show up in oasis_events
    // because /api/v1/test-contracts/:id/run emits them. Surfacing them
    // here lets Trace render contract pass/fail on the same timeline as
    // executions + deploys + heals.
    case 'test-contract.run.passed':
      return 'contract_passed';
    case 'test-contract.run.failed':
      return 'contract_failed';
    case 'test-contract.run.dispatched':
      return 'contract_dispatched';
    default:
      return null;
  }
}

// =============================================================================
// Normalizers
// =============================================================================

function normalizeExecution(row: ExecRow): TraceNode[] {
  const nodes: TraceNode[] = [];
  const groupId = row.parent_execution_id ? `execution:${row.parent_execution_id}` : `execution:${row.id}`;
  const execShort = row.id.slice(0, 8);
  const prLink = githubPrUrl(row.pr_url);
  const links = prLink ? [{ label: `PR ${row.pr_number ?? '↗'}`, url: prLink }] : [];
  links.push({ label: 'Lineage', url: `/command-hub/dev-autopilot?execution_id=${row.id}` });

  // The executions table is a snapshot — we emit one node per observed state.
  // Since we only have created_at / updated_at / completed_at we model this
  // as: a started node at created_at, a current-state node at updated_at,
  // and a terminal node at completed_at if set.
  const statusToKind: Record<string, TraceKind | null> = {
    cooling: 'execution_cooling',
    running: 'execution_running',
    ci: 'execution_ci',
    merging: 'execution_merging',
    deploying: 'execution_deploying',
    verifying: 'execution_verifying',
    completed: 'execution_completed',
    failed: 'execution_failed',
    reverted: 'execution_reverted',
    self_healed: 'execution_self_healed',
    cancelled: null,
    queued: null,
  };

  const kind = statusToKind[row.status];
  if (!kind) return nodes;

  const status: TraceStatus =
    row.status === 'completed' || row.status === 'self_healed' ? 'success' :
    row.status === 'failed' || row.status === 'reverted' ? 'failure' :
    row.status === 'cooling' ? 'started' : 'progress';

  const depth = row.auto_fix_depth || 0;
  const childBadge = depth > 0 ? ` [self-heal d${depth}]` : '';

  // Build a useful headline from the upstream finding when possible. Falls
  // back to the raw exec id only when no finding metadata is available.
  const findingTitle = row.recommendation?.title || null;
  const scanner = row.recommendation?.spec_snapshot?.scanner || null;
  const filePath = row.recommendation?.spec_snapshot?.file_path || null;
  const fileBase = filePath ? (filePath.split('/').pop() || filePath) : null;

  const taskLabel = findingTitle
    ? findingTitle
    : fileBase
    ? `${row.recommendation?.spec_snapshot?.signal_type || 'task'} on ${fileBase}`
    : `Execution ${execShort}`;

  const headline = `${taskLabel}${childBadge} — ${row.status}`;

  // Detail: stage-aware + finding context.
  const triageHypothesis = row.triage_report
    && (row.triage_report as { root_cause_hypothesis?: string }).root_cause_hypothesis;
  const failureStage = row.failure_stage ? ` [${row.failure_stage}]` : '';
  const errorMsg = row.metadata && (row.metadata as { error?: string }).error;

  let detail: string;
  if (row.status === 'cooling' && row.execute_after) {
    detail = `Fires at ${new Date(row.execute_after).toISOString()} unless cancelled.`;
  } else if (row.status === 'verifying') {
    detail = 'Watching OASIS errors for 30 min to detect blast radius.';
  } else if (row.status === 'failed' || row.status === 'reverted' || row.status === 'failed_escalated') {
    detail = `${failureStage} ${triageHypothesis || errorMsg || 'Failed'}`.trim();
  } else if (row.status === 'completed') {
    detail = `Completed${row.pr_number ? ` via PR #${row.pr_number}` : ''}`;
  } else {
    detail = scanner ? `${scanner}` : 'Current lifecycle stage.';
  }
  if (filePath && (row.status === 'cooling' || row.status === 'running' || row.status === 'ci' || row.status === 'merging' || row.status === 'deploying')) {
    detail = `${scanner || 'autopilot'} → ${filePath}`;
  }

  nodes.push({
    stable_id: `exec:${row.id}:${row.status}`,
    group_id: groupId,
    ts: row.completed_at || row.updated_at || row.created_at,
    source: 'execution',
    kind,
    status,
    headline,
    detail,
    metadata: {
      execution_id: row.id,
      finding_id: row.finding_id,
      status: row.status,
      branch: row.branch,
      pr_url: row.pr_url,
      pr_number: row.pr_number,
      auto_fix_depth: depth,
      parent_execution_id: row.parent_execution_id,
      self_healing_vtid: row.self_healing_vtid,
      // Surfaced from the embedded recommendation so the UI can render
      // chips per row (scanner, file_path) without a second fetch.
      task_title: findingTitle,
      scanner,
      file_path: filePath,
    },
    links,
  });
  return nodes;
}

function normalizeHeal(row: HealRow): TraceNode {
  const kind: TraceKind =
    row.outcome === 'pending' ? 'self_heal_pending' :
    row.outcome === 'dispatched' || row.outcome === 'in_progress' ? 'self_heal_dispatched' :
    row.outcome === 'escalated' ? 'self_heal_escalated' :
    'self_heal_reconciled';
  const status: TraceStatus =
    row.outcome === 'pending' ? 'started' :
    row.outcome === 'reconciled' || row.outcome === 'resolved' ? 'success' :
    row.outcome === 'escalated' ? 'failure' : 'progress';
  return {
    stable_id: `heal:${row.id}:${row.outcome}`,
    group_id: `heal:${row.vtid}`,
    ts: row.resolved_at || row.created_at,
    source: 'self_healing',
    kind,
    status,
    headline: `Self-heal ${row.vtid} — ${row.outcome}`,
    detail: (row.diagnosis && (row.diagnosis as { summary?: string }).summary)
      || `${row.failure_class} on ${row.endpoint}`,
    metadata: {
      vtid: row.vtid,
      endpoint: row.endpoint,
      failure_class: row.failure_class,
      outcome: row.outcome,
      attempt_number: row.attempt_number,
    },
    links: [{ label: 'Open VTID', url: `/command-hub/infrastructure/self-healing?vtid=${encodeURIComponent(row.vtid)}` }],
  };
}

function normalizeOasisEvent(row: OasisEventRow): TraceNode | null {
  const kind = deployEventTopicToKind(row.topic);
  if (!kind) return null;
  const source: TraceSource =
    kind.startsWith('verification_') ? 'verification' :
    kind.startsWith('contract_') ? 'test_contract' :
    'deploy_event';
  const status: TraceStatus =
    kind.endsWith('_succeeded') || kind === 'verification_passed' || kind === 'contract_passed' ? 'success' :
    kind.endsWith('_failed') || kind === 'verification_failed' || kind === 'contract_failed' ? 'failure' :
    kind === 'deploy_requested' || kind === 'contract_dispatched' ? 'started' : 'info';
  // VTID-02956 (PR-L1.5): contract events group by capability so multiple
  // runs of the same contract form one lane. Falling back to oasis:id
  // preserves the existing behavior for non-contract topics.
  const meta = row.metadata || {};
  const capability = typeof (meta as { capability?: unknown }).capability === 'string'
    ? (meta as { capability: string }).capability
    : null;
  const groupId =
    capability ? `contract:${capability}` :
    row.vtid ? `vtid:${row.vtid}` :
    `oasis:${row.id}`;
  const links: Array<{ label: string; url: string }> = [];
  if (capability) {
    links.push({
      label: 'Open contract',
      url: `/command-hub/voice/test-contracts/?capability=${encodeURIComponent(capability)}`,
    });
  }
  return {
    stable_id: `oasis:${row.id}`,
    group_id: groupId,
    ts: row.created_at,
    source,
    kind,
    status,
    headline: row.message || row.topic,
    detail: row.topic,
    metadata: { vtid: row.vtid, topic: row.topic, ...meta },
    links,
  };
}

// =============================================================================
// Data fetches
// =============================================================================

async function fetchExecutions(s: SupaConfig, limit: number, sinceIso: string): Promise<ExecRow[]> {
  // Embed autopilot_recommendations(title, spec_snapshot) so each row carries
  // the upstream finding context — title, scanner, file_path. Without this,
  // the autonomy trace shows raw "Execution xxxxxxx — failed" headlines that
  // tell a supervisor nothing about WHAT was being attempted.
  const r = await supaGet<ExecRow[]>(
    s,
    `/rest/v1/dev_autopilot_executions` +
    `?or=(updated_at.gte.${encodeURIComponent(sinceIso)},created_at.gte.${encodeURIComponent(sinceIso)})` +
    `&select=id,finding_id,status,pr_url,pr_number,branch,execute_after,auto_fix_depth,self_healing_vtid,parent_execution_id,triage_report,failure_stage,metadata,created_at,updated_at,completed_at,recommendation:autopilot_recommendations!finding_id(title,spec_snapshot)` +
    `&order=updated_at.desc,created_at.desc&limit=${limit}`,
  );
  return r.ok && r.data ? r.data : [];
}

async function fetchHeals(s: SupaConfig, limit: number, sinceIso: string): Promise<HealRow[]> {
  const r = await supaGet<HealRow[]>(
    s,
    `/rest/v1/self_healing_log?created_at=gte.${encodeURIComponent(sinceIso)}` +
    `&select=id,vtid,endpoint,failure_class,outcome,created_at,resolved_at,diagnosis,attempt_number` +
    `&order=created_at.desc&limit=${limit}`,
  );
  return r.ok && r.data ? r.data : [];
}

async function fetchOasisDeployEvents(s: SupaConfig, limit: number, sinceIso: string): Promise<OasisEventRow[]> {
  const topics = [
    'deploy.gateway.success',
    'deploy.gateway.failed',
    'cicd.deploy.service.requested',
    'cicd.deploy.service.succeeded',
    'cicd.deploy.service.failed',
    'autopilot.verification.passed',
    'autopilot.verification.failed',
    // VTID-02956 (PR-L1.5): test-contract topics share this fetcher so
    // Trace doesn't add a second oasis_events round-trip. The function
    // name is now a slight misnomer (it covers deploy + verification +
    // contract), but renaming would mean updating many call sites.
    'test-contract.run.passed',
    'test-contract.run.failed',
    'test-contract.run.dispatched',
  ];
  const topicsIn = `(${topics.map((t) => `"${t}"`).join(',')})`;
  const r = await supaGet<OasisEventRow[]>(
    s,
    `/rest/v1/oasis_events?topic=in.${topicsIn}&created_at=gte.${encodeURIComponent(sinceIso)}` +
    `&select=id,topic,vtid,status,message,metadata,created_at` +
    `&order=created_at.desc&limit=${limit}`,
  );
  return r.ok && r.data ? r.data : [];
}

// =============================================================================
// Aggregator (pure — unit-testable)
// =============================================================================

export function aggregateTrace(
  executions: ExecRow[],
  heals: HealRow[],
  oasisEvents: OasisEventRow[],
): { nodes: TraceNode[]; groups: Record<string, TraceNode[]> } {
  const nodes: TraceNode[] = [];
  for (const e of executions) nodes.push(...normalizeExecution(e));
  for (const h of heals) nodes.push(normalizeHeal(h));
  for (const o of oasisEvents) {
    const n = normalizeOasisEvent(o);
    if (n) nodes.push(n);
  }

  // Sort by timestamp descending (newest first).
  nodes.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  // Group by group_id so the UI can render lanes.
  const groups: Record<string, TraceNode[]> = {};
  for (const n of nodes) {
    if (!groups[n.group_id]) groups[n.group_id] = [];
    groups[n.group_id].push(n);
  }
  // Within a group, sort ascending so the lane reads start → end.
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  }

  return { nodes, groups };
}

// =============================================================================
// Routes
// =============================================================================

router.get('/trace', requireDevRole, async (req: Request, res: Response) => {
  const supa = getSupabase();
  if (!supa) return res.status(500).json({ ok: false, error: 'Supabase not configured' });

  const hoursBack = Math.min(Math.max(parseInt(String(req.query.hours || '24'), 10), 1), 24 * 30);
  const limitPer = Math.min(parseInt(String(req.query.limit || '100'), 10), 500);
  const sinceIso = new Date(Date.now() - hoursBack * 3600_000).toISOString();

  try {
    const [executions, heals, oasisEvents] = await Promise.all([
      fetchExecutions(supa, limitPer, sinceIso),
      fetchHeals(supa, limitPer, sinceIso),
      fetchOasisDeployEvents(supa, limitPer, sinceIso),
    ]);

    const { nodes, groups } = aggregateTrace(executions, heals, oasisEvents);

    return res.json({
      ok: true,
      nodes,
      groups,
      window: { hours: hoursBack, since: sinceIso },
      counts: {
        executions: executions.length,
        heals: heals.length,
        oasis_events: oasisEvents.length,
        total_nodes: nodes.length,
        total_groups: Object.keys(groups).length,
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} trace fetch failed:`, err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
