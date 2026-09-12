// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior); exercised indirectly (via
// jest.requireActual) by test/shopping-agent.test.ts, which covers every
// call site here.
/**
 * services/user-health-context.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in user-health-context.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param). Each function returns a Promise so the caller's existing
 * Promise.all + safe()-wrapping concurrency pattern is unchanged.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAppUserContextRow(sb: SupabaseClient, userId: string) {
  return sb
    .from('app_users')
    .select('country_code, delivery_country_code, region_group, currency_preference, product_scope_preference, lifecycle_stage')
    .eq('user_id', userId)
    .maybeSingle();
}

export async function fetchActiveTenantForUser(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_active', true).limit(1).maybeSingle();
}

export async function fetchUserLimitations(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_limitations')
    .select(
      'allergies, dietary_restrictions, contraindications, current_medications, pregnancy_status, age_bracket, religious_restrictions, ingredient_sensitivities, budget_max_per_product_cents, budget_monthly_cap_cents, budget_preferred_band',
    )
    .eq('user_id', userId)
    .maybeSingle();
}

export async function fetchHealthMemoryFacts(sb: SupabaseClient, userId: string, healthKeys: string[]) {
  return sb.from('memory_facts').select('fact_key, fact_value, extracted_at, provenance_source').eq('user_id', userId).in('fact_key', healthKeys).is('superseded_by', null);
}

export async function fetchUserTopicProfile(sb: SupabaseClient, userId: string) {
  return sb.from('user_topic_profile').select('topic_key, score').eq('user_id', userId);
}

export async function fetchConvertedProductOrders(sb: SupabaseClient, userId: string, limit: number) {
  return sb.from('product_orders').select('product_id, purchased_at, state').eq('user_id', userId).eq('state', 'converted').order('purchased_at', { ascending: false }).limit(limit);
}

export async function fetchWearableRollup7d(sb: SupabaseClient, userId: string) {
  return sb
    .from('wearable_rollup_7d')
    .select('sleep_avg_minutes, sleep_deep_pct, hrv_avg_ms, resting_hr, activity_minutes, workout_count, days_with_data, latest_date')
    .eq('user_id', userId)
    .maybeSingle();
}

export async function fetchUpcomingCalendarEvents(sb: SupabaseClient, userId: string, nowIso: string, horizonIso: string, limit: number) {
  return sb
    .from('calendar_events')
    .select('title, start_time, event_type, wellness_tags')
    .eq('user_id', userId)
    .gte('start_time', nowIso)
    .lte('start_time', horizonIso)
    .order('start_time', { ascending: true })
    .limit(limit);
}
