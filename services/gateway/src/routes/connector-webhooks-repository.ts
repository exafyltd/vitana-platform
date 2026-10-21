// impact-allow-no-test: pure data-access seam (thin Supabase query/upsert
// wrappers, no independent request-handling behavior). Coverage note: NO
// call site in routes/connector-webhooks.ts has any test coverage today —
// no test file in this repo references this route.
/**
 * routes/connector-webhooks.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/connector-webhooks.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Reused across all four connector_webhooks_log insert sites (unknown_connector, handler_error, invalid, ok). */
export async function insertConnectorWebhookLog(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('connector_webhooks_log').insert(row);
}

export async function fetchUserConnectionForWebhook(sb: SupabaseClient, userId: string, connectorId: string) {
  return sb.from('user_connections').select('id, tenant_id').eq('user_id', userId).eq('connector_id', connectorId).limit(1).maybeSingle();
}

/** Reused for both the auth.completed and auth.revoked connection-state flips — same update-by-id shape. */
export async function updateUserConnectionState(sb: SupabaseClient, connectionId: string, patch: Record<string, unknown>) {
  return sb.from('user_connections').update(patch).eq('id', connectionId);
}

export async function upsertWearableDailyMetrics(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('wearable_daily_metrics').upsert(row, { onConflict: 'user_id,provider,metric_date' });
}

export async function upsertWearableWorkout(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('wearable_workouts').upsert(row, { onConflict: 'user_id,provider,external_workout_id' });
}
