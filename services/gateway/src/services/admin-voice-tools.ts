/**
 * BOOTSTRAP-ADMIN-DD: Admin voice tool handlers.
 *
 * These handlers run inside the orb-live tool dispatch when role is admin /
 * exafy_admin / developer. They wrap the existing REST endpoints we shipped
 * in Phases AA/BB/CC/EE/GG so Vitana can speak the answer instead of the
 * admin clicking around in Command Hub.
 *
 * Tools (all admin-scoped):
 *   admin_briefing            — top N open insights
 *   admin_kpi_snapshot        — current KPI family snapshot
 *   admin_insight_detail      — full body of one insight
 *   admin_approve             — mark insight approved
 *   admin_reject              — mark insight rejected
 *   admin_snooze              — snooze insight for N hours/days
 *   admin_history             — KPI family time-series for last N days
 *   admin_pause_autopilot     — emergency kill-switch (placeholder; needs FF)
 */
import { getSupabase } from '../lib/supabase';
import { fetchAdminBriefingBlock, isAdminRole } from './admin-scanners/briefing';
import { computeTenantHealthIndex } from './admin-health-index';
import { emitOasisEvent } from './oasis-event-service';

const LOG_PREFIX = '[admin-voice]';

interface ToolResult {
  success: boolean;
  result: string;
  error?: string;
}

interface AdminToolContext {
  tenantId: string;
  userId: string;
  activeRole: string;
}

function authzOk(ctx: AdminToolContext): boolean {
  return !!ctx.tenantId && !!ctx.userId && isAdminRole(ctx.activeRole);
}

function deny(): ToolResult {
  return {
    success: false,
    result: '',
    error: 'admin_role_required',
  };
}

/** Top N open insights ranked by severity × confidence. Returns markdown. */
export async function handleAdminBriefing(
  ctx: AdminToolContext,
  args: { limit?: number },
): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  const limit = Math.max(1, Math.min(10, args.limit ?? 3));
  try {
    const block = await fetchAdminBriefingBlock(ctx.tenantId, limit);
    return {
      success: true,
      result: block || `No open insights for tenant — everything looks calm.`,
    };
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} briefing failed: ${err?.message}`);
    return { success: false, result: '', error: err?.message || 'unknown' };
  }
}

/** Current KPI family. Returns a compact summary line per KPI. */
export async function handleAdminKpiSnapshot(
  ctx: AdminToolContext,
  args: { domain?: string },
): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  const supabase = getSupabase();
  if (!supabase) return { success: false, result: '', error: 'db_unavailable' };
  try {
    const { data, error } = await supabase
      .from('tenant_kpi_current')
      .select('kpi, generated_at')
      .eq('tenant_id', ctx.tenantId)
      .maybeSingle();
    if (error) return { success: false, result: '', error: error.message };
    if (!data) return { success: true, result: 'No KPI snapshot yet — the worker may not have ticked for this tenant.' };

    const kpi = (data.kpi || {}) as Record<string, any>;
    const wantedDomain = (args.domain || '').toLowerCase();
    const families = Object.keys(kpi);
    const filtered = wantedDomain && families.includes(wantedDomain) ? [wantedDomain] : families;
    const lines: string[] = [];
    for (const family of filtered) {
      const f = kpi[family] || {};
      if (f.error) {
        lines.push(`${family}: error (${f.error})`);
        continue;
      }
      const entries = Object.entries(f)
        .filter(([k]) => !k.endsWith('_error'))
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      lines.push(`${family}: ${entries}`);
    }
    return {
      success: true,
      result: `KPI snapshot (${data.generated_at}):\n${lines.join('\n')}`,
    };
  } catch (err: any) {
    return { success: false, result: '', error: err?.message || 'unknown' };
  }
}

/** Fetch one insight by id (or natural_key). Returns full description + recommended_action. */
export async function handleAdminInsightDetail(
  ctx: AdminToolContext,
  args: { insight_id?: string; natural_key?: string },
): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  const supabase = getSupabase();
  if (!supabase) return { success: false, result: '', error: 'db_unavailable' };
  if (!args.insight_id && !args.natural_key) {
    return { success: false, result: '', error: 'provide_insight_id_or_natural_key' };
  }
  try {
    let q = supabase
      .from('admin_insights')
      .select('id, scanner, natural_key, domain, title, description, severity, status, recommended_action, context, confidence_score, autonomy_level, created_at, snoozed_until')
      .eq('tenant_id', ctx.tenantId);
    if (args.insight_id) q = q.eq('id', args.insight_id);
    else q = q.eq('natural_key', args.natural_key as string);
    const { data, error } = await q.maybeSingle();
    if (error) return { success: false, result: '', error: error.message };
    if (!data) return { success: false, result: '', error: 'insight_not_found' };
    return {
      success: true,
      result: JSON.stringify(data),
    };
  } catch (err: any) {
    return { success: false, result: '', error: err?.message || 'unknown' };
  }
}

async function transitionInsight(
  ctx: AdminToolContext,
  insightId: string,
  newStatus: 'approved' | 'rejected' | 'snoozed' | 'dismissed',
  extra: Record<string, unknown> = {},
): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  const supabase = getSupabase();
  if (!supabase) return { success: false, result: '', error: 'db_unavailable' };
  try {
    const update: Record<string, unknown> = {
      status: newStatus,
      updated_at: new Date().toISOString(),
      ...extra,
    };
    if (newStatus === 'approved' || newStatus === 'rejected' || newStatus === 'dismissed') {
      update.resolved_at = new Date().toISOString();
      update.resolved_by = ctx.userId;
      update.resolved_via = 'voice';
    }
    const { data, error } = await supabase
      .from('admin_insights')
      .update(update)
      .eq('tenant_id', ctx.tenantId)
      .eq('id', insightId)
      .select('id, status, title')
      .maybeSingle();
    if (error) return { success: false, result: '', error: error.message };
    if (!data) return { success: false, result: '', error: 'insight_not_found' };

    emitOasisEvent({
      vtid: 'BOOTSTRAP-ADMIN-DD',
      type:
        newStatus === 'approved' ? 'admin.insight.approved' :
        newStatus === 'rejected' ? 'admin.insight.rejected' :
        newStatus === 'snoozed' ? 'admin.insight.snoozed' :
        'admin.insight.dismissed',
      source: 'orb-voice',
      status: 'info',
      message: `Admin ${newStatus} insight ${insightId} via voice: ${data.title}`,
      payload: {
        tenant_id: ctx.tenantId,
        insight_id: insightId,
        new_status: newStatus,
        decided_via: 'voice',
        ...(extra as Record<string, unknown>),
      },
      actor_id: ctx.userId,
      actor_role: 'admin',
      surface: 'orb',
    }).catch(() => {});

    return {
      success: true,
      result: `Insight "${data.title}" → ${newStatus}.`,
    };
  } catch (err: any) {
    return { success: false, result: '', error: err?.message || 'unknown' };
  }
}

export const handleAdminApprove = (
  ctx: AdminToolContext,
  args: { insight_id: string },
): Promise<ToolResult> => transitionInsight(ctx, args.insight_id, 'approved');

export const handleAdminReject = (
  ctx: AdminToolContext,
  args: { insight_id: string; reason?: string },
): Promise<ToolResult> => transitionInsight(ctx, args.insight_id, 'rejected', { reject_reason: args.reason });

export async function handleAdminSnooze(
  ctx: AdminToolContext,
  args: { insight_id: string; hours?: number; days?: number },
): Promise<ToolResult> {
  const hours = args.hours ?? (args.days ? args.days * 24 : 24);
  const until = new Date(Date.now() + hours * 3600_000).toISOString();
  return transitionInsight(ctx, args.insight_id, 'snoozed', { snoozed_until: until });
}

/** KPI history for last N days. Returns array of (snapshot_date, kpi.<domain>). */
export async function handleAdminHistory(
  ctx: AdminToolContext,
  args: { domain?: string; days?: number },
): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  const supabase = getSupabase();
  if (!supabase) return { success: false, result: '', error: 'db_unavailable' };
  const days = Math.max(7, Math.min(90, args.days ?? 30));
  const startDate = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  try {
    const { data, error } = await supabase
      .from('tenant_kpi_daily')
      .select('snapshot_date, kpi')
      .eq('tenant_id', ctx.tenantId)
      .gte('snapshot_date', startDate)
      .order('snapshot_date', { ascending: false });
    if (error) return { success: false, result: '', error: error.message };
    const rows = data ?? [];
    const summary = rows.map((r: any) => {
      const k = r.kpi || {};
      if (args.domain && k[args.domain]) {
        return { date: r.snapshot_date, [args.domain]: k[args.domain] };
      }
      return { date: r.snapshot_date, ...k };
    });
    return {
      success: true,
      result: JSON.stringify({ days, count: rows.length, snapshots: summary }),
    };
  } catch (err: any) {
    return { success: false, result: '', error: err?.message || 'unknown' };
  }
}

/** Live health-index — current score + components. Recomputes on demand. */
export async function handleAdminHealthCheck(
  ctx: AdminToolContext,
  _args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  try {
    const result = await computeTenantHealthIndex(ctx.tenantId);
    if (!result) return { success: false, result: '', error: 'compute_failed' };
    return {
      success: true,
      result: `Tenant health index: ${result.score}/100. ` +
        `Components: engagement=${result.components.engagement}, community=${result.components.community}, ` +
        `autopilot=${result.components.autopilot}, insight_penalty=${result.components.insight_penalty} ` +
        `(${result.components.urgent_insights} urgent + ${result.components.action_needed_insights} action_needed open).`,
    };
  } catch (err: any) {
    return { success: false, result: '', error: err?.message || 'unknown' };
  }
}

/** Emergency pause — stub until Phase FF (autopilot executor) lands. */
export async function handleAdminPauseAutopilot(
  ctx: AdminToolContext,
  args: { hours?: number },
): Promise<ToolResult> {
  if (!authzOk(ctx)) return deny();
  // TODO Phase FF: write to admin_autopilot_kill_switch table once it exists.
  // For now, emit an OASIS event so the audit trail captures intent and any
  // operator can act on it manually.
  const hours = Math.max(1, Math.min(168, args.hours ?? 24));
  emitOasisEvent({
    vtid: 'BOOTSTRAP-ADMIN-DD',
    type: 'admin.autopilot.pause_requested',
    source: 'orb-voice',
    status: 'warning',
    message: `Admin requested autopilot pause for ${hours}h via voice (no executor live yet)`,
    payload: { tenant_id: ctx.tenantId, hours, requested_by: ctx.userId },
    actor_id: ctx.userId,
    actor_role: 'admin',
    surface: 'orb',
  }).catch(() => {});
  return {
    success: true,
    result: `Autopilot pause request logged for ${hours} hours. Note: the autopilot executor is not live yet (Phase FF), so this is observe-only.`,
  };
}

/** Tool name → handler. The orb dispatcher reads this map. */
export const ADMIN_TOOL_HANDLERS: Record<
  string,
  (ctx: AdminToolContext, args: any) => Promise<ToolResult>
> = {
  admin_briefing: handleAdminBriefing,
  admin_kpi_snapshot: handleAdminKpiSnapshot,
  admin_insight_detail: handleAdminInsightDetail,
  admin_approve: handleAdminApprove,
  admin_reject: handleAdminReject,
  admin_snooze: handleAdminSnooze,
  admin_history: handleAdminHistory,
  admin_health_check: handleAdminHealthCheck,
  admin_pause_autopilot: handleAdminPauseAutopilot,
};

export const ADMIN_TOOL_NAMES = Object.keys(ADMIN_TOOL_HANDLERS);

/** Tool schema declarations to inject into buildLiveApiTools when role is admin. */
export const ADMIN_TOOL_SCHEMAS = [
  {
    name: 'admin_briefing',
    description:
      'Return the top open admin_insights for this tenant, ranked by severity × confidence. Call this AT THE START of every admin orb session to know what needs attention. The bootstrap context already includes the briefing on session-open; only call again if the admin asks "what else?", "anything new?", or "give me the briefing again".',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max insights to return (1-10, default 3).' },
      },
    },
  },
  {
    name: 'admin_kpi_snapshot',
    description:
      'Return the current KPI snapshot for this tenant — users, community, autopilot, etc. Call when admin asks numbers like "how many signups today", "active members", "events this week", "autopilot success rate". Optionally filter to one domain.',
    parameters: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Optional KPI family: users, community, autopilot. Omit for all.',
        },
      },
    },
  },
  {
    name: 'admin_insight_detail',
    description:
      'Fetch the full body of one open insight by id or natural_key. Use when admin asks "tell me more about that one", "what does that insight say", or after admin_briefing to drill in.',
    parameters: {
      type: 'object',
      properties: {
        insight_id: { type: 'string' },
        natural_key: { type: 'string' },
      },
    },
  },
  {
    name: 'admin_approve',
    description:
      'Mark an insight approved. Approved insights become eligible for autonomous execution by the admin autopilot once Phase FF is live; today, approval is a record of intent. Always confirm the insight title with the admin before calling.',
    parameters: {
      type: 'object',
      properties: {
        insight_id: { type: 'string', description: 'admin_insights.id' },
      },
      required: ['insight_id'],
    },
  },
  {
    name: 'admin_reject',
    description:
      'Mark an insight rejected — the system should stop suggesting this signal. Capture the reason if the admin gives one; it tunes future scanner thresholds.',
    parameters: {
      type: 'object',
      properties: {
        insight_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['insight_id'],
    },
  },
  {
    name: 'admin_snooze',
    description:
      'Snooze an insight for N hours (or days). The insight returns to the briefing once the snooze expires. Use when admin says "remind me later", "not now", "ask again tomorrow".',
    parameters: {
      type: 'object',
      properties: {
        insight_id: { type: 'string' },
        hours: { type: 'number' },
        days: { type: 'number' },
      },
      required: ['insight_id'],
    },
  },
  {
    name: 'admin_history',
    description:
      'Return KPI time-series for the last N days (default 30). Use when admin asks for a trend: "how did signups go this month", "events compared to last week", "show me autopilot history".',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Optional KPI family filter.' },
        days: { type: 'integer', description: '7-90, default 30.' },
      },
    },
  },
  {
    name: 'admin_health_check',
    description:
      'Compute and return the tenant health index right now (0-100 score with component breakdown). Use when admin asks "how is the tenant doing", "what is our health score", "give me a quick status".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'admin_pause_autopilot',
    description:
      'Request an autopilot pause for N hours. The admin autopilot executor (Phase FF) is not yet live, so this is observe-only — it logs the intent to the audit trail but does not actually halt anything yet. Confirm with the admin before calling.',
    parameters: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: '1-168, default 24.' },
      },
    },
  },
];
