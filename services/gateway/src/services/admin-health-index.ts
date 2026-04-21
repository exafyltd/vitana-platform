/**
 * BOOTSTRAP-ADMIN-GG: Tenant Health Index computation.
 *
 * Computes a 0-100 composite health score per tenant from:
 *   - tenant_kpi_current (engagement, community, autopilot families)
 *   - admin_insights      (urgent + action_needed penalties)
 *
 * Components and weights (all normalised to 0-100):
 *   engagement        30%
 *   community         25%
 *   autopilot         25%
 *   insight_penalty   20%   (applied as a deduction from baseline 100)
 *
 * Soft-fails per component: if a family is missing or errored in KPIs,
 * the component scores 60 ("neutral unknown") instead of blowing up.
 */
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from './oasis-event-service';

const LOG_PREFIX = '[admin-health-index]';

export const HEALTH_INDEX_VERSION = 'v1.2026-04-22';

export interface HealthComponents {
  engagement: number;
  community: number;
  autopilot: number;
  insight_penalty: number;
  urgent_insights: number;
  action_needed_insights: number;
}

export interface HealthIndexResult {
  score: number;
  components: HealthComponents;
}

const WEIGHTS = {
  engagement: 0.30,
  community: 0.25,
  autopilot: 0.25,
  insight_penalty: 0.20,
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function scoreEngagement(users: any): number {
  if (!users || users.error) return 60;
  const delta = typeof users.new_signups_7d_delta_pct === 'number'
    ? users.new_signups_7d_delta_pct : 0;
  const signups7d = typeof users.new_signups_7d === 'number' ? users.new_signups_7d : 0;
  // Base: 60. Positive delta adds up to +40, negative subtracts. Volume gives a floor.
  let score = 60;
  if (delta >= 25) score += 30;
  else if (delta >= 10) score += 15;
  else if (delta >= -10) score += 0;
  else if (delta >= -30) score -= 20;
  else score -= 40;
  // Volume nudge — a tenant with zero signups for a week scores lower regardless.
  if (signups7d === 0) score -= 10;
  else if (signups7d >= 10) score += 10;
  return clamp(score);
}

function scoreCommunity(community: any): number {
  if (!community || community.error) return 60;
  const eventsThis = community.events_this_week ?? 0;
  const eventsNext = community.events_next_week ?? 0;
  const groups = community.groups_total ?? 0;
  const newMembers = community.new_memberships_7d ?? 0;
  let score = 50;
  if (eventsThis >= 3) score += 15;
  else if (eventsThis >= 1) score += 8;
  else score -= 10;
  if (eventsNext >= 1) score += 10;
  if (groups >= 5) score += 10;
  else if (groups >= 1) score += 5;
  if (newMembers >= 5) score += 15;
  else if (newMembers >= 1) score += 5;
  return clamp(score);
}

function scoreAutopilot(autopilot: any): number {
  if (!autopilot || autopilot.error) return 60;
  const successRate: number | null = typeof autopilot.runs_success_rate_pct === 'number'
    ? autopilot.runs_success_rate_pct : null;
  const activations = autopilot.recommendations_activated_7d ?? 0;
  const newRecs = autopilot.recommendations_new ?? 0;
  // Base: tie to success rate when available; fall back to 70 when no runs yet.
  let score = successRate !== null ? successRate : 70;
  if (activations >= 3) score += 5;
  if (newRecs >= 50) score -= 10; // deep queue of unacted recommendations
  return clamp(score);
}

/**
 * Compute how many open insights (urgent + action_needed) the tenant carries
 * and convert that into a deduction applied to a baseline of 100.
 * Each urgent costs 10 points, each action_needed costs 3, cap at 100.
 */
function scoreInsightPenalty(urgent: number, actionNeeded: number): { score: number } {
  const deduction = Math.min(100, urgent * 10 + actionNeeded * 3);
  return { score: clamp(100 - deduction) };
}

async function fetchOpenInsightCounts(tenantId: string): Promise<{ urgent: number; actionNeeded: number }> {
  const supabase = getSupabase();
  if (!supabase) return { urgent: 0, actionNeeded: 0 };
  try {
    const [{ count: urgent }, { count: actionNeeded }] = await Promise.all([
      supabase
        .from('admin_insights')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('status', 'open')
        .eq('severity', 'urgent'),
      supabase
        .from('admin_insights')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('status', 'open')
        .eq('severity', 'action_needed'),
    ]);
    return { urgent: urgent ?? 0, actionNeeded: actionNeeded ?? 0 };
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} insight count failed: ${err?.message}`);
    return { urgent: 0, actionNeeded: 0 };
  }
}

export async function computeTenantHealthIndex(tenantId: string): Promise<HealthIndexResult | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    const [kpiRow, insightCounts] = await Promise.all([
      supabase
        .from('tenant_kpi_current')
        .select('kpi')
        .eq('tenant_id', tenantId)
        .maybeSingle(),
      fetchOpenInsightCounts(tenantId),
    ]);

    const kpi = (kpiRow.data?.kpi ?? {}) as Record<string, any>;
    const engagement = scoreEngagement(kpi.users);
    const community = scoreCommunity(kpi.community);
    const autopilot = scoreAutopilot(kpi.autopilot);
    const penalty = scoreInsightPenalty(insightCounts.urgent, insightCounts.actionNeeded);

    const score = clamp(
      Math.round(
        engagement * WEIGHTS.engagement +
          community * WEIGHTS.community +
          autopilot * WEIGHTS.autopilot +
          penalty.score * WEIGHTS.insight_penalty,
      ),
    );

    return {
      score,
      components: {
        engagement,
        community,
        autopilot,
        insight_penalty: penalty.score,
        urgent_insights: insightCounts.urgent,
        action_needed_insights: insightCounts.actionNeeded,
      },
    };
  } catch (err: any) {
    console.warn(`${LOG_PREFIX} compute failed tenant=${tenantId.substring(0, 8)}...: ${err?.message}`);
    return null;
  }
}

/**
 * Compute + upsert today's health index for this tenant. Emits OASIS events:
 *   - tenant.health.computed                 (every run)
 *   - tenant.health.regression_detected      (drop >10 points vs previous snapshot)
 */
export async function storeTenantHealthIndex(tenantId: string): Promise<HealthIndexResult | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const result = await computeTenantHealthIndex(tenantId);
  if (!result) return null;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Fetch previous snapshot for regression detection
  let prevScore: number | null = null;
  try {
    const { data: prev } = await supabase
      .from('tenant_health_index_daily')
      .select('score, snapshot_date')
      .eq('tenant_id', tenantId)
      .lt('snapshot_date', today)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prev?.score !== null && prev?.score !== undefined) prevScore = prev.score;
  } catch {
    /* swallow — first snapshot */
  }

  const { error } = await supabase
    .from('tenant_health_index_daily')
    .upsert(
      {
        tenant_id: tenantId,
        snapshot_date: today,
        score: result.score,
        components: result.components,
        computed_at: new Date().toISOString(),
        source_version: HEALTH_INDEX_VERSION,
      },
      { onConflict: 'tenant_id,snapshot_date' },
    );
  if (error) {
    console.warn(`${LOG_PREFIX} upsert failed: ${error.message}`);
    return result;
  }

  emitOasisEvent({
    vtid: 'BOOTSTRAP-ADMIN-GG',
    type: 'tenant.health.computed',
    source: 'admin-awareness-worker',
    status: 'info',
    message: `Tenant health index computed: ${result.score}`,
    payload: {
      tenant_id: tenantId,
      score: result.score,
      prev_score: prevScore,
      components: result.components,
      snapshot_date: today,
    },
  }).catch(() => {});

  if (prevScore !== null && result.score < prevScore - 10) {
    emitOasisEvent({
      vtid: 'BOOTSTRAP-ADMIN-GG',
      type: 'tenant.health.regression_detected',
      source: 'admin-awareness-worker',
      status: 'warning',
      message: `Tenant health index dropped ${prevScore - result.score} points (${prevScore} → ${result.score})`,
      payload: {
        tenant_id: tenantId,
        prev_score: prevScore,
        current_score: result.score,
        delta: prevScore - result.score,
        components: result.components,
      },
    }).catch(() => {});
  }

  return result;
}
