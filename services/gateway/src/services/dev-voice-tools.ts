/**
 * VTID-02782 — Voice Tool Expansion P1s: Developer / Operator voice tools.
 *
 * Role-gated to admin / exafy_admin / developer. Each handler re-checks role
 * server-side; a community session that names a dev tool gets a clean denial.
 *
 * Tools (12, all read-only or governed-mutation):
 *   dev_list_vtids          — vtid_ledger filter
 *   dev_get_vtid_status     — single vtid lookup
 *   dev_list_pending_approvals
 *   dev_count_approvals
 *   dev_approve_pr          — gated by EXEC-DEPLOY hard gate
 *   dev_reject_pr
 *   dev_list_voice_sessions — Voice Lab debug
 *   dev_list_routines
 *   dev_get_routine_detail
 *   dev_list_active_healing
 *   dev_get_autonomy_pulse
 *   dev_list_agents
 */
import { getSupabase } from '../lib/supabase';
import { isAdminRole } from './admin-scanners/briefing';

interface ToolResult {
  success: boolean;
  result: string;
  error?: string;
}

interface DevToolContext {
  tenantId: string;
  userId: string;
  activeRole: string;
}

function authzOk(ctx: DevToolContext): boolean {
  return !!ctx.userId && (isAdminRole(ctx.activeRole) || ctx.activeRole === 'developer');
}

function deny(): ToolResult {
  return { success: false, result: '', error: 'developer_role_required' };
}

function ok(payload: unknown): ToolResult {
  return { success: true, result: JSON.stringify(payload) };
}

export async function handleDevListVtids(ctx: DevToolContext, args: { status?: string; limit?: number }): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  const sb = getSupabase();
  if (!sb) return { success: false, result: '', error: 'db_unavailable' };
  let q = sb.from('vtid_ledger').select('vtid, status, spec_status, is_terminal, claimed_by, created_at').order('created_at', { ascending: false }).limit(Math.min(args.limit ?? 20, 100));
  if (args.status) q = q.eq('status', args.status);
  const { data, error } = await q;
  if (error) return { success: false, result: '', error: error.message };
  return ok({ count: data?.length ?? 0, rows: data ?? [] });
}

export async function handleDevGetVtidStatus(ctx: DevToolContext, args: { vtid: string }): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  if (!args.vtid) return { success: false, result: '', error: 'vtid_required' };
  const sb = getSupabase();
  if (!sb) return { success: false, result: '', error: 'db_unavailable' };
  const { data, error } = await sb.from('vtid_ledger').select('*').eq('vtid', args.vtid).maybeSingle();
  if (error) return { success: false, result: '', error: error.message };
  if (!data) return { success: true, result: JSON.stringify({ found: false, vtid: args.vtid }) };
  return ok(data);
}

export async function handleDevListPendingApprovals(ctx: DevToolContext, args: { limit?: number }): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  const sb = getSupabase();
  if (!sb) return { success: false, result: '', error: 'db_unavailable' };
  // Approvals live across a few tables depending on phase; try the canonical
  // approvals_queue, fall through to oasis_events tagged with approval.pending.
  try {
    const { data, error } = await sb
      .from('approvals_queue')
      .select('id, kind, status, created_at, payload')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(Math.min(args.limit ?? 20, 100));
    if (!error) return ok({ source: 'approvals_queue', rows: data ?? [] });
  } catch {
    /* fall through */
  }
  try {
    const { data, error } = await sb
      .from('oasis_events')
      .select('id, topic, message, payload, created_at')
      .eq('topic', 'approval.pending')
      .order('created_at', { ascending: false })
      .limit(Math.min(args.limit ?? 20, 100));
    if (error) return { success: false, result: '', error: error.message };
    return ok({ source: 'oasis_events', rows: data ?? [] });
  } catch (err: any) {
    return { success: false, result: '', error: err?.message || 'unknown' };
  }
}

export async function handleDevCountApprovals(ctx: DevToolContext): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  const sb = getSupabase();
  if (!sb) return { success: false, result: '', error: 'db_unavailable' };
  try {
    const { count, error } = await sb
      .from('approvals_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    if (error) return { success: false, result: '', error: error.message };
    return ok({ pending_count: count ?? 0 });
  } catch (err: any) {
    return { success: false, result: '', error: err?.message || 'unknown' };
  }
}

export async function handleDevApprovePr(ctx: DevToolContext, args: { id: string; note?: string }): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  if (!args.id) return { success: false, result: '', error: 'id_required' };
  const sb = getSupabase();
  if (!sb) return { success: false, result: '', error: 'db_unavailable' };
  const { error } = await sb
    .from('approvals_queue')
    .update({ status: 'approved', resolved_by: ctx.userId, resolved_at: new Date().toISOString(), resolution_note: args.note || null })
    .eq('id', args.id)
    .eq('status', 'pending');
  if (error) return { success: false, result: '', error: error.message };
  return ok({ id: args.id, status: 'approved' });
}

export async function handleDevRejectPr(ctx: DevToolContext, args: { id: string; reason?: string }): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  if (!args.id) return { success: false, result: '', error: 'id_required' };
  const sb = getSupabase();
  if (!sb) return { success: false, result: '', error: 'db_unavailable' };
  const { error } = await sb
    .from('approvals_queue')
    .update({ status: 'rejected', resolved_by: ctx.userId, resolved_at: new Date().toISOString(), resolution_note: args.reason || null })
    .eq('id', args.id)
    .eq('status', 'pending');
  if (error) return { success: false, result: '', error: error.message };
  return ok({ id: args.id, status: 'rejected' });
}

export async function handleDevListVoiceSessions(ctx: DevToolContext, args: { hours?: number; limit?: number }): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  const sb = getSupabase();
  if (!sb) return { success: false, result: '', error: 'db_unavailable' };
  const hours = Math.min(Math.max(args.hours ?? 24, 1), 168);
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data, error } = await sb
    .from('oasis_events')
    .select('id, topic, vtid, payload, created_at')
    .like('topic', 'vtid.live.session%')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(Math.min(args.limit ?? 20, 100));
  if (error) return { success: false, result: '', error: error.message };
  return ok({ since, rows: data ?? [] });
}

export async function handleDevListRoutines(ctx: DevToolContext): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  const sb = getSupabase();
  if (!sb) return { success: false, result: '', error: 'db_unavailable' };
  const { data, error } = await sb
    .from('routines')
    .select('name, schedule, last_run_at, last_status')
    .order('name', { ascending: true })
    .limit(50);
  if (error) return { success: false, result: '', error: error.message };
  return ok({ rows: data ?? [] });
}

export async function handleDevGetRoutineDetail(ctx: DevToolContext, args: { name: string; runs?: number }): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  if (!args.name) return { success: false, result: '', error: 'name_required' };
  const sb = getSupabase();
  if (!sb) return { success: false, result: '', error: 'db_unavailable' };
  const limit = Math.min(args.runs ?? 30, 100);
  const [routine, runs] = await Promise.all([
    sb.from('routines').select('*').eq('name', args.name).maybeSingle(),
    sb.from('routine_runs').select('run_id, started_at, finished_at, status, summary').eq('name', args.name).order('started_at', { ascending: false }).limit(limit),
  ]);
  if (routine.error) return { success: false, result: '', error: routine.error.message };
  return ok({ routine: routine.data, runs: runs.data ?? [] });
}

export async function handleDevListActiveHealing(ctx: DevToolContext): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  const sb = getSupabase();
  if (!sb) return { success: false, result: '', error: 'db_unavailable' };
  const { data, error } = await sb
    .from('self_healing_runs')
    .select('id, vtid, error_signature, status, started_at, attempt')
    .in('status', ['investigating', 'fixing', 'verifying'])
    .order('started_at', { ascending: false })
    .limit(50);
  if (error) return { success: false, result: '', error: error.message };
  return ok({ rows: data ?? [] });
}

export async function handleDevGetAutonomyPulse(ctx: DevToolContext, args: { hours?: number }): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  const sb = getSupabase();
  if (!sb) return { success: false, result: '', error: 'db_unavailable' };
  const hours = Math.min(Math.max(args.hours ?? 24, 1), 168);
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const { count: ledgerInProg, error: e1 } = await sb
    .from('vtid_ledger').select('vtid', { count: 'exact', head: true })
    .eq('status', 'in_progress');
  if (e1) return { success: false, result: '', error: e1.message };
  const { count: terminal24h, error: e2 } = await sb
    .from('vtid_ledger').select('vtid', { count: 'exact', head: true })
    .eq('is_terminal', true).gte('updated_at', since);
  if (e2) return { success: false, result: '', error: e2.message };
  const { count: heals, error: e3 } = await sb
    .from('self_healing_runs').select('id', { count: 'exact', head: true })
    .gte('started_at', since);
  return ok({
    window_hours: hours,
    in_progress_vtids: ledgerInProg ?? 0,
    terminalized_in_window: terminal24h ?? 0,
    self_healing_runs_in_window: e3 ? null : heals ?? 0,
  });
}

export async function handleDevListAgents(ctx: DevToolContext): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  const sb = getSupabase();
  if (!sb) return { success: false, result: '', error: 'db_unavailable' };
  const { data, error } = await sb
    .from('agents_registry')
    .select('agent_id, agent_name, tier, last_heartbeat_at, status')
    .order('agent_name', { ascending: true })
    .limit(50);
  if (error) return { success: false, result: '', error: error.message };
  return ok({ rows: data ?? [] });
}

export const DEV_TOOL_HANDLERS: Record<string, (ctx: DevToolContext, args: any) => Promise<ToolResult>> = {
  dev_list_vtids: handleDevListVtids,
  dev_get_vtid_status: handleDevGetVtidStatus,
  dev_list_pending_approvals: handleDevListPendingApprovals,
  dev_count_approvals: handleDevCountApprovals,
  dev_approve_pr: handleDevApprovePr,
  dev_reject_pr: handleDevRejectPr,
  dev_list_voice_sessions: handleDevListVoiceSessions,
  dev_list_routines: handleDevListRoutines,
  dev_get_routine_detail: handleDevGetRoutineDetail,
  dev_list_active_healing: handleDevListActiveHealing,
  dev_get_autonomy_pulse: handleDevGetAutonomyPulse,
  dev_list_agents: handleDevListAgents,
};

export const DEV_TOOL_NAMES = Object.keys(DEV_TOOL_HANDLERS);

export const DEV_TOOL_SCHEMAS = [
  {
    name: 'dev_list_vtids',
    description: 'List recent VTIDs from the ledger. Optional filter by status.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'scheduled / in_progress / completed / failed / blocked' },
        limit: { type: 'integer' },
      },
      required: [],
    },
  },
  {
    name: 'dev_get_vtid_status',
    description: 'Look up a single VTID by id (e.g. VTID-02779).',
    parameters: {
      type: 'object',
      properties: { vtid: { type: 'string' } },
      required: ['vtid'],
    },
  },
  {
    name: 'dev_list_pending_approvals',
    description: 'List PRs / actions waiting on developer approval.',
    parameters: { type: 'object', properties: { limit: { type: 'integer' } }, required: [] },
  },
  {
    name: 'dev_count_approvals',
    description: 'Quick count of pending approvals — for "how many PRs are waiting?".',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'dev_approve_pr',
    description: 'Approve a queued PR / action by id. Subject to EXEC-DEPLOY hard gate.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'dev_reject_pr',
    description: 'Reject a queued PR / action by id with optional reason.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, reason: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'dev_list_voice_sessions',
    description: 'Recent ORB voice sessions for Voice Lab debugging. hours: 1-168, default 24.',
    parameters: {
      type: 'object',
      properties: { hours: { type: 'integer' }, limit: { type: 'integer' } },
      required: [],
    },
  },
  {
    name: 'dev_list_routines',
    description: 'List daily routines + last run status.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'dev_get_routine_detail',
    description: 'Routine detail + last N runs.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, runs: { type: 'integer' } },
      required: ['name'],
    },
  },
  {
    name: 'dev_list_active_healing',
    description: 'Self-healing runs currently in flight.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'dev_get_autonomy_pulse',
    description: 'Autonomy loop metrics for the last N hours: in-flight VTIDs, terminalized count, self-healing run count.',
    parameters: {
      type: 'object',
      properties: { hours: { type: 'integer' } },
      required: [],
    },
  },
  {
    name: 'dev_list_agents',
    description: '21-agent registry with heartbeat status.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];
