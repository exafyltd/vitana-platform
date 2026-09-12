// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/wearables.ts — zero coverage today.
/**
 * routes/wearables.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in this file now goes through here
 * instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActivePrimaryTenant(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_active', true).limit(1).maybeSingle();
}

export async function fetchWearableConnectorRegistry(sb: SupabaseClient) {
  return sb.from('connector_registry').select('*').in('category', ['wearable', 'aggregator']).eq('enabled', true).order('category', { ascending: false }).order('display_name', { ascending: true });
}

export async function fetchUserWearableConnections(sb: SupabaseClient, userId: string) {
  return sb.from('user_connections').select('connector_id, is_active, last_sync_at, display_name').eq('user_id', userId).in('category', ['wearable', 'aggregator']);
}

export function upsertPendingWidgetConnection(sb: SupabaseClient, row: Record<string, unknown>): PromiseLike<{ error: unknown }> {
  return sb.from('user_connections').upsert(row, { onConflict: 'tenant_id,user_id,connector_id,provider_user_id' });
}

export function upsertOAuthConnection(sb: SupabaseClient, row: Record<string, unknown>): PromiseLike<{ error: unknown }> {
  return sb.from('user_connections').upsert(row, { onConflict: 'tenant_id,user_id,connector_id,provider_user_id' });
}

export async function disconnectUserConnection(sb: SupabaseClient, userId: string, connectorId: string) {
  return sb.from('user_connections').update({ is_active: false, disconnected_at: new Date().toISOString() }).eq('user_id', userId).eq('connector_id', connectorId);
}

export async function fetchUserWearableConnectionsFull(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_connections')
    .select('connector_id, category, display_name, provider_username, is_active, last_sync_at, last_error, connected_at, disconnected_at')
    .eq('user_id', userId)
    .in('category', ['wearable', 'aggregator'])
    .order('connected_at', { ascending: false });
}

export async function fetchWearableRollup7d(sb: SupabaseClient, userId: string) {
  return sb.from('wearable_rollup_7d').select('*').eq('user_id', userId).maybeSingle();
}

export async function fetchRecentWearableDailyMetrics(sb: SupabaseClient, userId: string, limit: number) {
  return sb
    .from('wearable_daily_metrics')
    .select('metric_date, provider, sleep_minutes, sleep_deep_minutes, hrv_avg_ms, resting_hr, active_minutes, workout_count, steps')
    .eq('user_id', userId)
    .order('metric_date', { ascending: false })
    .limit(limit);
}
