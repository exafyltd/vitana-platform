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

import { Router, Request, Response } from 'express';

const router = Router();
const LOG_PREFIX = '[autonomy-trace]';

// =============================================================================
// Auth (aligned with dev-autopilot + autonomy-pulse)
// =============================================================================

function requireDevRole(req: Request, res: Response, next: () => void) {
  // Matches dev-autopilot.ts — auth middleware populates req.user.role
  // (singular). Accept internal gateway calls via X-Gateway-Internal too.
  const user = (req as unknown as { user?: { role?: string } }).user;
  const role = user?.role;
  if (role === 'developer' || role === 'admin') return next();
  if (req.get('X-Gateway-Internal') === (process.env.GATEWAY_INTERNAL_TOKEN || '__dev__') &&
      process.env.GATEWAY_INTERNAL_TOKEN) {
    return next();
  }
  return res.status(403).json({ ok: false, error: 'Autonomy Trace requires developer role' });
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

export type TraceSource = 'execution' | 'self_healing' | 'deploy_event' | 'verification';
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
  | 'verification_failed';

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
  created_at: string;
  updated_at: string | null;
  completed_at: string | null;
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
  const headline = `Execution ${execShort}${childBadge} — ${row.status}`;
  const detail =
    row.status === 'cooling' && row.execute_after
      ? `Fires at ${new Date(row.execute_after).toISOString()} unless cancelled.`
      : row.status === 'verifying'
      ? 'Watching OASIS errors for 30 min to detect blast radius.'
      : row.status === 'failed' || row.status === 'reverted'
      ? (row.triage_report && (row.triage_report as { root_cause_hypothesis?: string }).root_cause_hypothesis) || 'Failed'
      : `Current lifecycle stage.`;

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
  const source: TraceSource = kind.startsWith('verification_') ? 'verification' : 'deploy_event';
  const status: TraceStatus =
    kind.endsWith('_succeeded') || kind === 'verification_passed' ? 'success' :
    kind.endsWith('_failed') || kind === 'verification_failed' ? 'failure' :
    kind === 'deploy_requested' ? 'started' : 'info';
  const groupId = row.vtid ? `vtid:${row.vtid}` : `oasis:${row.id}`;
  return {
    stable_id: `oasis:${row.id}`,
    group_id: groupId,
    ts: row.created_at,
    source,
    kind,
    status,
    headline: row.message || row.topic,
    detail: row.topic,
    metadata: { vtid: row.vtid, topic: row.topic, ...(row.metadata || {}) },
    links: [],
  };
}

// =============================================================================
// Data fetches
// =============================================================================

async function fetchExecutions(s: SupaConfig, limit: number, sinceIso: string): Promise<ExecRow[]> {
  const r = await supaGet<ExecRow[]>(
    s,
    `/rest/v1/dev_autopilot_executions` +
    `?or=(updated_at.gte.${encodeURIComponent(sinceIso)},created_at.gte.${encodeURIComponent(sinceIso)})` +
    `&select=id,finding_id,status,pr_url,pr_number,branch,execute_after,auto_fix_depth,self_healing_vtid,parent_execution_id,triage_report,created_at,updated_at,completed_at` +
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
