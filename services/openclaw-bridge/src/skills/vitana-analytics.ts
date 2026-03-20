/**
 * Vitana Analytics Skill for OpenClaw
 *
 * Tenant usage dashboards, cohort metrics, engagement scores,
 * revenue tracking, and churn signals. Feeds into autopilot
 * decision-making for proactive automation.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TenantMetricsSchema = z.object({
  tenant_id: z.string().uuid(),
  period: z.enum(['day', 'week', 'month', 'quarter']).default('month'),
});

const UserEngagementSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  days: z.number().int().min(1).max(365).default(30),
});

const ChurnRiskSchema = z.object({
  tenant_id: z.string().uuid(),
  threshold_days_inactive: z.number().int().min(1).max(180).default(14),
  limit: z.number().int().min(1).max(100).default(25),
});

const RevenueSchema = z.object({
  tenant_id: z.string().uuid(),
  period: z.enum(['day', 'week', 'month', 'quarter']).default('month'),
  months_back: z.number().int().min(1).max(24).default(6),
});

const AutopilotStatsSchema = z.object({
  tenant_id: z.string().uuid(),
  days: z.number().int().min(1).max(90).default(30),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE required');
  return createClient(url, key);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Get aggregate tenant metrics: active users, sessions, actions.
   */
  async tenant_metrics(input: unknown) {
    const { tenant_id, period } = TenantMetricsSchema.parse(input);
    const supabase = getSupabase();

    const periodDays = { day: 1, week: 7, month: 30, quarter: 90 }[period];
    const since = daysAgo(periodDays);

    // Active users (users with autopilot log entries)
    const { count: activeUsers } = await supabase
      .from('autopilot_logs')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenant_id)
      .gte('created_at', since);

    // Total profiles
    const { count: totalUsers } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenant_id);

    // Appointments in period
    const { count: appointments } = await supabase
      .from('appointments')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenant_id)
      .gte('scheduled_at', since);

    // Live rooms in period
    const { count: liveRooms } = await supabase
      .from('live_rooms')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenant_id)
      .gte('scheduled_at', since);

    return {
      success: true,
      period,
      since,
      metrics: {
        total_users: totalUsers ?? 0,
        active_actions: activeUsers ?? 0,
        appointments: appointments ?? 0,
        live_rooms: liveRooms ?? 0,
      },
    };
  },

  /**
   * Get engagement score for a specific user.
   */
  async user_engagement(input: unknown) {
    const { tenant_id, user_id, days } = UserEngagementSchema.parse(input);
    const supabase = getSupabase();
    const since = daysAgo(days);

    // Count user's actions
    const { data: logs } = await supabase
      .from('autopilot_logs')
      .select('action, created_at')
      .eq('tenant_id', tenant_id)
      .ilike('details->>user_id', user_id)
      .gte('created_at', since);

    const actionCount = logs?.length ?? 0;

    // Count appointments
    const { count: appts } = await supabase
      .from('appointments')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenant_id)
      .eq('patient_id', user_id)
      .gte('scheduled_at', since);

    // Calculate engagement score (0-100)
    const score = Math.min(100, Math.round(
      (actionCount * 2) + ((appts ?? 0) * 10)
    ));

    return {
      success: true,
      user_id,
      period_days: days,
      engagement: {
        score,
        action_count: actionCount,
        appointments: appts ?? 0,
        level: score >= 70 ? 'high' : score >= 30 ? 'medium' : 'low',
      },
    };
  },

  /**
   * Identify users at risk of churning based on inactivity.
   */
  async churn_risk(input: unknown) {
    const { tenant_id, threshold_days_inactive, limit } = ChurnRiskSchema.parse(input);
    const supabase = getSupabase();

    const cutoff = daysAgo(threshold_days_inactive);

    // Users who haven't had any activity since cutoff
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, plan, last_active_at')
      .eq('tenant_id', tenant_id)
      .lt('last_active_at', cutoff)
      .order('last_active_at', { ascending: true })
      .limit(limit);

    if (error) throw new Error(`churn_risk failed: ${error.message}`);

    return {
      success: true,
      threshold_days: threshold_days_inactive,
      at_risk_users: data ?? [],
      count: data?.length ?? 0,
    };
  },

  /**
   * Get revenue metrics from Stripe subscription data.
   */
  async revenue(input: unknown) {
    const { tenant_id, period, months_back } = RevenueSchema.parse(input);
    const supabase = getSupabase();
    const since = daysAgo(months_back * 30);

    const { data, error } = await supabase
      .from('stripe_subscriptions')
      .select('plan, status, amount, currency, created_at')
      .eq('tenant_id', tenant_id)
      .gte('created_at', since);

    if (error) throw new Error(`revenue failed: ${error.message}`);

    const active = (data ?? []).filter((s) => s.status === 'active');
    const mrr = active.reduce((sum, s) => sum + (s.amount ?? 0), 0);

    return {
      success: true,
      period,
      since,
      revenue: {
        mrr,
        active_subscriptions: active.length,
        total_subscriptions: data?.length ?? 0,
        currency: active[0]?.currency ?? 'usd',
      },
    };
  },

  /**
   * Get autopilot execution statistics (used for self-monitoring).
   */
  async autopilot_stats(input: unknown) {
    const { tenant_id, days } = AutopilotStatsSchema.parse(input);
    const supabase = getSupabase();
    const since = daysAgo(days);

    const { data, error } = await supabase
      .from('autopilot_logs')
      .select('action, created_at')
      .eq('tenant_id', tenant_id)
      .gte('created_at', since);

    if (error) throw new Error(`autopilot_stats failed: ${error.message}`);

    // Group by action
    const actionCounts: Record<string, number> = {};
    for (const log of data ?? []) {
      actionCounts[log.action] = (actionCounts[log.action] ?? 0) + 1;
    }

    return {
      success: true,
      period_days: days,
      stats: {
        total_actions: data?.length ?? 0,
        unique_action_types: Object.keys(actionCounts).length,
        top_actions: Object.entries(actionCounts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([action, count]) => ({ action, count })),
      },
    };
  },
};

export const SKILL_META = {
  name: 'vitana-analytics',
  description: 'Tenant metrics, user engagement, churn risk detection, and revenue analytics',
  actions: Object.keys(actions),
};
