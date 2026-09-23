/**
 * VTID-04319 (Orchestrator v2, P1): read side of the run ledger
 * (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.3, §3.5).
 *
 * P1 is projection only: `agent_runs_unified` is a view over the three
 * existing run tables plus the (still empty) native `agent_runs`. Nothing
 * here writes. P4 moves the dev planes onto native writes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const RUN_PLANES = ['dev_autopilot', 'community_autopilot', 'self_healing', 'orb', 'operator', 'backoffice'] as const;
export const RUN_STATUSES = [
  'queued', 'running', 'waiting_signal', 'awaiting_approval', 'succeeded', 'failed', 'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface UnifiedRun {
  run_key: string;
  plane: string;
  agent_id: string;
  source_id: string;
  status: RunStatus;
  source_status: string | null;
  vtid: string | null;
  tenant_id: string | null;
  user_id: string | null;
  parent_run_key: string | null;
  created_via: string | null;
  title: string | null;
  error: string | null;
  result_ref: string | null;
  created_at: string;
  updated_at: string | null;
  completed_at: string | null;
}

export interface RunQuery {
  plane?: string | null;
  status?: string | null;
  agent_id?: string | null;
  since?: string | null;
  limit?: number | null;
}

export const RUN_LIST_DEFAULT_LIMIT = 50;
export const RUN_LIST_MAX_LIMIT = 200;

export function normalizeRunQuery(q: Record<string, unknown>): Required<Pick<RunQuery, 'limit'>> & RunQuery {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const status = str(q.status);
  const n = Number(q.limit);
  const since = str(q.since);
  return {
    plane: str(q.plane),
    status: status && (RUN_STATUSES as readonly string[]).includes(status) ? status : null,
    agent_id: str(q.agent_id),
    since: since && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : null,
    limit: Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), RUN_LIST_MAX_LIMIT) : RUN_LIST_DEFAULT_LIMIT,
  };
}

export async function listUnifiedRuns(sb: SupabaseClient, q: RunQuery): Promise<{ runs: UnifiedRun[]; error: string | null }> {
  let query: any = sb.from('agent_runs_unified').select('*').order('created_at', { ascending: false });
  if (q.plane) query = query.eq('plane', q.plane);
  if (q.status) query = query.eq('status', q.status);
  if (q.agent_id) query = query.eq('agent_id', q.agent_id);
  if (q.since) query = query.gte('created_at', q.since);
  query = query.limit(q.limit ?? RUN_LIST_DEFAULT_LIMIT);
  const { data, error } = await query;
  if (error) return { runs: [], error: error.message };
  return { runs: (data as UnifiedRun[]) || [], error: null };
}

export interface RunSummaryRow {
  plane: string;
  total: number;
  by_status: Record<string, number>;
}

/** Pure: fold (plane, status) rows into per-plane counts. */
export function summarizeRunRows(rows: Array<{ plane: string; status: string }>): RunSummaryRow[] {
  const byPlane = new Map<string, RunSummaryRow>();
  for (const r of rows) {
    const row = byPlane.get(r.plane) ?? { plane: r.plane, total: 0, by_status: {} };
    row.total += 1;
    row.by_status[r.status] = (row.by_status[r.status] ?? 0) + 1;
    byPlane.set(r.plane, row);
  }
  return Array.from(byPlane.values()).sort((a, b) => b.total - a.total);
}

export const SUMMARY_ROW_CAP = 10_000;

export async function summarizeRuns(
  sb: SupabaseClient,
  sinceIso: string,
): Promise<{ planes: RunSummaryRow[]; truncated: boolean; error: string | null }> {
  const { data, error } = await sb
    .from('agent_runs_unified')
    .select('plane, status')
    .gte('created_at', sinceIso)
    .limit(SUMMARY_ROW_CAP);
  if (error) return { planes: [], truncated: false, error: error.message };
  const rows = (data as Array<{ plane: string; status: string }>) || [];
  return { planes: summarizeRunRows(rows), truncated: rows.length >= SUMMARY_ROW_CAP, error: null };
}

export const AGENT_CARD_COLUMNS =
  'agent_id, display_name, description, tier, role, status, last_heartbeat_at, llm_provider, llm_model, ' +
  'source_path, skills, domains, roles_allowed, surfaces_allowed, llm_stage, max_tier, budget_per_run_usd, ' +
  'budget_per_day_usd, owner, eval_suite, eval_pass_rate, enabled';

export async function listAgentCards(sb: SupabaseClient): Promise<{ agents: any[]; error: string | null }> {
  const { data, error } = await sb.from('agents_registry').select(AGENT_CARD_COLUMNS).order('agent_id');
  if (error) return { agents: [], error: error.message };
  return { agents: (data as any[]) || [], error: null };
}
