// Genuinely tested via test/routes/wearables-waitlist.test.ts, which
// drives a real functional fake Supabase chain (from/select/upsert/
// delete/eq/limit/single/maybeSingle all no-ops returning the same
// chain, resolved via `.then`) — not a wholesale module mock.
/**
 * routes/wearables-waitlist.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in wearables-waitlist.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveUserTenantId(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_active', true).limit(1).maybeSingle();
}

export async function upsertWearableWaitlistEntry(
  sb: SupabaseClient,
  row: { user_id: string; tenant_id: string; provider: string; notify_via: string },
) {
  return sb
    .from('wearable_waitlist')
    .upsert(row, { onConflict: 'user_id,provider' })
    .select('*')
    .single();
}

export async function fetchWearableWaitlistEntriesForUser(sb: SupabaseClient, userId: string) {
  return sb.from('wearable_waitlist').select('provider, created_at, notified_at, notify_via').eq('user_id', userId);
}

export async function deleteWearableWaitlistEntry(sb: SupabaseClient, userId: string, provider: string) {
  return sb.from('wearable_waitlist').delete().eq('user_id', userId).eq('provider', provider);
}
