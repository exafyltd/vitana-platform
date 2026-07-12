/**
 * Admin briefing service (VTID-ASSISTANT-ROLES).
 *
 * Builds the session-opening briefing for the ADMIN assistant lane —
 * SCOPED TO ONE TENANT. Status → since-last-session → ranked immediate
 * attention → single recommended next step, mirroring the developer
 * briefing envelope so both lanes share one contract.
 *
 * Fan-in sources (service-role reads, every query filtered by tenant_id;
 * the HTTP route in front of this is gated by requireTenantAdmin):
 *   - admin_insights        open/pending-approval insights
 *   - tenant_kpi_current    KPI snapshot
 *   - media_uploads         content moderation queue (+ SLA age)
 *   - signup_attempts       funnel-stuck signups
 *   - tenant_invitations    pending invitations
 *   - user_tenants          member count + new members in window
 *   - oasis_events          tenant error/alert events in window
 *
 * All strings are LLM/system-prompt or admin-facing content — English by
 * design (CLAUDE.md §13b).
 */

import { getSupabase } from '../../lib/supabase';
import {
  briefingSource,
  relAgeShort,
  type AttentionItem,
  type BriefingEnvelope,
  type BriefingItem,
  type NextStep,
} from './briefing-types';
import { getCachedBriefing, setCachedBriefing } from './briefing-cache';

const MODERATION_SLA_MS = 24 * 3600_000;
const FUNNEL_STUCK_MS = 24 * 3600_000;

interface AdminBriefingCounts {
  insights: {
    open: number;
    pendingApproval: number;
    urgent: number;
    topTitle: string | null;
    topId: string | null;
    topSeverity: string | null;
  };
  moderation: { pending: number; flagged: number; oldest: string | null; topId: string | null };
  funnel: { stuck: number; total7d: number };
  invitations: { pending: number };
  members: { total: number; newInWindow: number };
  alerts: { count: number; topMessage: string | null };
  healthIndex: { value: number | null; delta: number | null };
}

async function collectCounts(tenantId: string, sinceIso: string | null, degraded: string[]): Promise<AdminBriefingCounts> {
  const sb = getSupabase();
  const windowStart = sinceIso || new Date(Date.now() - 24 * 3600_000).toISOString();

  const counts: AdminBriefingCounts = {
    insights: { open: 0, pendingApproval: 0, urgent: 0, topTitle: null, topId: null, topSeverity: null },
    moderation: { pending: 0, flagged: 0, oldest: null, topId: null },
    funnel: { stuck: 0, total7d: 0 },
    invitations: { pending: 0 },
    members: { total: 0, newInWindow: 0 },
    alerts: { count: 0, topMessage: null },
    healthIndex: { value: null, delta: null },
  };

  if (!sb) {
    degraded.push('database');
    return counts;
  }

  await Promise.all([
    briefingSource('insights', degraded, null, (async () => {
      const { data, error } = await sb
        .from('admin_insights')
        .select('id, title, severity, status, created_at')
        .eq('tenant_id', tenantId)
        .in('status', ['open', 'pending_approval'])
        .order('created_at', { ascending: true })
        .limit(100);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      counts.insights.open = rows.length;
      counts.insights.pendingApproval = rows.filter((r: any) => r.status === 'pending_approval').length;
      counts.insights.urgent = rows.filter((r: any) => r.severity === 'urgent' || r.severity === 'action_needed').length;
      const top = rows.find((r: any) => r.severity === 'urgent')
        ?? rows.find((r: any) => r.severity === 'action_needed')
        ?? rows[0];
      counts.insights.topTitle = top?.title ?? null;
      counts.insights.topId = top?.id ?? null;
      counts.insights.topSeverity = top?.severity ?? null;
      return null;
    })()),
    briefingSource('moderation', degraded, null, (async () => {
      const { data, error } = await sb
        .from('media_uploads')
        .select('id, status, created_at')
        .eq('tenant_id', tenantId)
        .in('status', ['pending', 'flagged'])
        .order('created_at', { ascending: true })
        .limit(100);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      counts.moderation.pending = rows.filter((r: any) => r.status === 'pending').length;
      counts.moderation.flagged = rows.filter((r: any) => r.status === 'flagged').length;
      counts.moderation.oldest = rows[0]?.created_at ?? null;
      counts.moderation.topId = rows[0]?.id ?? null;
      return null;
    })()),
    briefingSource('signup_funnel', degraded, null, (async () => {
      const stuckBefore = new Date(Date.now() - FUNNEL_STUCK_MS).toISOString();
      const weekStart = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
      const [stuckRes, weekRes] = await Promise.all([
        sb
          .from('signup_attempts')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .in('status', ['started', 'email_sent'])
          .lte('started_at', stuckBefore),
        sb
          .from('signup_attempts')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .gte('started_at', weekStart),
      ]);
      if (stuckRes.error) throw new Error(stuckRes.error.message);
      counts.funnel.stuck = stuckRes.count ?? 0;
      counts.funnel.total7d = weekRes.error ? 0 : (weekRes.count ?? 0);
      return null;
    })()),
    briefingSource('invitations', degraded, null, (async () => {
      const { count, error } = await sb
        .from('tenant_invitations')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('status', 'pending');
      if (error) throw new Error(error.message);
      counts.invitations.pending = count ?? 0;
      return null;
    })()),
    briefingSource('members', degraded, null, (async () => {
      const [totalRes, newRes] = await Promise.all([
        sb
          .from('user_tenants')
          .select('user_id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId),
        sb
          .from('user_tenants')
          .select('user_id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .gte('created_at', sinceIso || new Date(Date.now() - 24 * 3600_000).toISOString()),
      ]);
      if (totalRes.error) throw new Error(totalRes.error.message);
      counts.members.total = totalRes.count ?? 0;
      counts.members.newInWindow = newRes.error ? 0 : (newRes.count ?? 0);
      return null;
    })()),
    briefingSource('alerts', degraded, null, (async () => {
      const { data, error } = await sb
        .from('oasis_events')
        .select('message')
        .eq('tenant', tenantId)
        .in('status', ['error', 'critical'])
        .gte('created_at', windowStart)
        .order('created_at', { ascending: false })
        .limit(25);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      counts.alerts.count = rows.length;
      counts.alerts.topMessage = rows[0]?.message ?? null;
      return null;
    })()),
    briefingSource('health_index', degraded, null, (async () => {
      const { computeTenantHealthIndex } = await import('../admin-health-index');
      const idx = await computeTenantHealthIndex(tenantId);
      if (idx) {
        counts.healthIndex.value = idx.score;
        // Yesterday's persisted score gives the delta when available.
        const { data } = await sb
          .from('tenant_health_index_daily')
          .select('score')
          .eq('tenant_id', tenantId)
          .order('day', { ascending: false })
          .range(1, 1);
        const prev = (data ?? [])[0] as { score?: number } | undefined;
        if (prev && typeof prev.score === 'number') {
          counts.healthIndex.delta = idx.score - prev.score;
        }
      }
      return null;
    })()),
  ]);

  return counts;
}

/** Deterministic attention ranking for the admin lane. Exported for tests. */
export function rankAdminAttention(c: AdminBriefingCounts): AttentionItem[] {
  const items: AttentionItem[] = [];

  const moderationTotal = c.moderation.pending + c.moderation.flagged;
  if (moderationTotal > 0) {
    const slaBreach = !!c.moderation.oldest
      && Date.now() - new Date(c.moderation.oldest).getTime() > MODERATION_SLA_MS;
    items.push({
      source: 'moderation',
      severity: slaBreach ? 'critical' : 'warning',
      rank: slaBreach ? 92 : 82,
      oldest_at: c.moderation.oldest,
      sla_breach: slaBreach,
      line: `${moderationTotal} content item${moderationTotal === 1 ? '' : 's'} in the moderation queue (${c.moderation.flagged} flagged)` +
        (slaBreach ? ` — the oldest has been waiting ${relAgeShort(c.moderation.oldest)} and is past the 24-hour mark.` : '.'),
      action_hint: 'admin_list_moderation_queue',
      data: { top_id: c.moderation.topId },
    });
  }

  if (c.insights.pendingApproval > 0 || c.insights.urgent > 0) {
    items.push({
      source: 'insights',
      severity: c.insights.urgent > 0 ? 'critical' : 'warning',
      rank: c.insights.urgent > 0 ? 88 : 78,
      line: `${c.insights.open} insight${c.insights.open === 1 ? '' : 's'} open, ${c.insights.pendingApproval} awaiting your decision` +
        (c.insights.topTitle ? ` — top: "${c.insights.topTitle}" (${c.insights.topSeverity}).` : '.'),
      action_hint: 'admin_briefing',
      data: { top_id: c.insights.topId },
    });
  }

  if (c.alerts.count > 0) {
    items.push({
      source: 'alerts',
      severity: c.alerts.count >= 5 ? 'critical' : 'warning',
      rank: c.alerts.count >= 5 ? 90 : 74,
      line: `${c.alerts.count} error alert${c.alerts.count === 1 ? '' : 's'} for this tenant in the window` +
        (c.alerts.topMessage ? ` — most recent: "${String(c.alerts.topMessage).slice(0, 120)}".` : '.'),
      action_hint: 'admin_get_overview',
    });
  }

  if (c.funnel.stuck > 0) {
    items.push({
      source: 'signup_funnel',
      severity: 'warning',
      rank: 68,
      line: `${c.funnel.stuck} signup${c.funnel.stuck === 1 ? ' is' : 's are'} stuck in the funnel for over 24 hours — they started but never finished onboarding.`,
      action_hint: 'admin_get_signup_funnel',
    });
  }

  if (c.healthIndex.value !== null && c.healthIndex.delta !== null && c.healthIndex.delta < -3) {
    items.push({
      source: 'health_index',
      severity: 'warning',
      rank: 64,
      line: `The tenant health index dropped ${Math.abs(c.healthIndex.delta)} points to ${c.healthIndex.value}.`,
      action_hint: 'admin_kpi_snapshot',
    });
  }

  return items.sort((a, b) => b.rank - a.rank);
}

/** Map the top attention item to the single recommended next step. */
export function deriveAdminNextStep(attention: AttentionItem[], c: AdminBriefingCounts): NextStep | null {
  const top = attention[0];
  if (!top) {
    return {
      recommendation: c.invitations.pending > 0
        ? `All quiet. ${c.invitations.pending} invitation${c.invitations.pending === 1 ? ' is' : 's are'} still pending — I can read them out, or we look at this week's KPIs.`
        : 'All quiet in your tenant. I suggest a quick look at the weekly KPIs — say the word and I read them out.',
      tool: 'admin_kpi_snapshot',
      args_template: {},
      tier: 0,
    };
  }
  switch (top.source) {
    case 'moderation':
      return {
        recommendation: 'Clear the moderation queue — I read you each item and take your approve/reject decision one at a time.',
        tool: 'admin_list_moderation_queue',
        args_template: {},
        tier: 0,
      };
    case 'insights':
      return {
        recommendation: 'Go through the insights awaiting your decision — I read each one with its recommended action, you decide approve, reject, or snooze.',
        tool: 'admin_briefing',
        args_template: {},
        tier: 0,
      };
    case 'alerts':
      return {
        recommendation: 'Check the error alerts first — I can read the most recent ones so you know whether members are affected.',
        tool: 'admin_get_overview',
        args_template: { section: 'alerts' },
        tier: 0,
      };
    case 'signup_funnel':
      return {
        recommendation: 'Look at the stuck signups — I can summarize where they dropped off so you can decide whether to re-invite them.',
        tool: 'admin_get_signup_funnel',
        args_template: {},
        tier: 0,
      };
    default:
      return {
        recommendation: 'Start with the KPI snapshot to see where the drop is coming from.',
        tool: 'admin_kpi_snapshot',
        args_template: {},
        tier: 0,
      };
  }
}

/** Build the admin briefing envelope for one tenant. */
export async function buildAdminBriefing(tenantId: string, sinceIso: string | null): Promise<BriefingEnvelope> {
  const cacheKey = `admin:${tenantId}:${sinceIso ?? '24h'}`;
  const cached = getCachedBriefing(cacheKey);
  if (cached) return cached;

  const degraded: string[] = [];
  const c = await collectCounts(tenantId, sinceIso, degraded);
  const attention = rankAdminAttention(c);
  const nextStep = deriveAdminNextStep(attention, c);

  const statusItems: BriefingItem[] = [
    {
      source: 'members',
      line: `Members: ${c.members.total} total${c.members.newInWindow ? `, ${c.members.newInWindow} new in the window` : ''}. ${c.funnel.total7d} signup${c.funnel.total7d === 1 ? '' : 's'} started this week.`,
    },
    {
      source: 'health_index',
      line: c.healthIndex.value !== null
        ? `Tenant health index: ${c.healthIndex.value}${c.healthIndex.delta !== null ? ` (${c.healthIndex.delta >= 0 ? '+' : ''}${c.healthIndex.delta} vs last week)` : ''}.`
        : 'Tenant health index: not available.',
    },
    {
      source: 'queues',
      line: `Queues: ${c.moderation.pending + c.moderation.flagged} moderation, ${c.insights.open} insights, ${c.invitations.pending} pending invitation${c.invitations.pending === 1 ? '' : 's'}.`,
    },
  ];

  const critical = attention.filter((a) => a.severity === 'critical').length;
  const warning = attention.filter((a) => a.severity === 'warning').length;
  const headline = critical + warning === 0
    ? 'Your tenant is calm — no items need action.'
    : `${critical} critical and ${warning} warning item${critical + warning === 1 ? '' : 's'} need your attention.`;

  const sinceItems: BriefingItem[] = [
    {
      source: 'growth',
      line: `${c.members.newInWindow} new member${c.members.newInWindow === 1 ? '' : 's'} joined; ${c.funnel.stuck} signup${c.funnel.stuck === 1 ? '' : 's'} stuck in the funnel.`,
    },
    {
      source: 'alerts',
      line: c.alerts.count === 0
        ? 'No error alerts for this tenant in the window.'
        : `${c.alerts.count} error alert${c.alerts.count === 1 ? '' : 's'} logged for this tenant.`,
    },
  ];

  const envelope: BriefingEnvelope = {
    ok: true,
    role: 'admin',
    tenant_id: tenantId,
    generated_at: new Date().toISOString(),
    status: { headline, items: statusItems },
    since_last_session: { since: sinceIso, items: sinceItems },
    attention: { items: attention },
    next_step: nextStep,
    degraded_sources: degraded,
  };

  setCachedBriefing(cacheKey, envelope);
  return envelope;
}

/** Render the envelope as the `## CURRENT BRIEFING` system-instruction block. */
export function renderAdminBriefingBlock(env: BriefingEnvelope): string {
  const lines: string[] = [];
  lines.push('## CURRENT BRIEFING (ADMIN — tenant-scoped, generated at session start)');
  lines.push('Deliver this as your opening per the BRIEFING-FIRST OPENING rule. Everything below is scoped to the admin\'s own tenant. Ground every number; do not invent any.');
  lines.push('');
  lines.push(`STATUS: ${env.status.headline}`);
  for (const item of env.status.items) lines.push(`- ${item.line}`);
  lines.push('');
  lines.push(`SINCE LAST SESSION${env.since_last_session.since ? ` (since ${env.since_last_session.since})` : ' (last 24 h)'}:`);
  for (const item of env.since_last_session.items) lines.push(`- ${item.line}`);
  lines.push('');
  if (env.attention.items.length > 0) {
    lines.push('IMMEDIATE ATTENTION (ranked, speak the top 1-3):');
    for (const item of env.attention.items.slice(0, 5)) {
      lines.push(`- [${item.severity.toUpperCase()}] ${item.line}${item.action_hint ? ` (tool: ${item.action_hint})` : ''}`);
    }
  } else {
    lines.push('IMMEDIATE ATTENTION: nothing urgent.');
  }
  lines.push('');
  if (env.next_step) {
    lines.push(`RECOMMENDED NEXT STEP: ${env.next_step.recommendation}${env.next_step.tool ? ` (tool: ${env.next_step.tool})` : ''}`);
  }
  if (env.degraded_sources.length > 0) {
    lines.push('');
    lines.push(`DEGRADED SOURCES (say honestly you could not check these): ${env.degraded_sources.join(', ')}`);
  }
  return lines.join('\n');
}
