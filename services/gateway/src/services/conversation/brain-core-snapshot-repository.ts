/**
 * VTID-04399 (Plan v1 WS-1.2) — data access for the per-user core context
 * snapshot (`user_assistant_state.signal_name = 'brain_core_snapshot_v1'`).
 *
 * One row per (tenant, user); same upsert key every other
 * `user_assistant_state` signal uses. Client-agnostic: takes `sb` as a param.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchBrainCoreSnapshotRow(
  sb: SupabaseClient,
  tenantId: string,
  userId: string,
  signalName: string,
) {
  return sb
    .from('user_assistant_state')
    .select('value, updated_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('signal_name', signalName)
    .maybeSingle();
}

export async function upsertBrainCoreSnapshotRow(
  sb: SupabaseClient,
  row: { tenant_id: string; user_id: string; signal_name: string; value: unknown; source: string; last_seen_at: string },
) {
  return sb.from('user_assistant_state').upsert(row, { onConflict: 'tenant_id,user_id,signal_name' });
}
