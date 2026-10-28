// Genuinely tested via test/services/voice-lab/livekit-test-eval.test.ts,
// which drives a functional fake Supabase client via a mocked
// getSupabase() — not a wholesale module mock of this file.
/**
 * services/voice-lab/livekit-test-eval.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in livekit-test-eval.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 *
 * The three tiers of the test-identity resolution (by user_id, by
 * canonical email, by any user with a vitana_id) share the same
 * SELECT column list, kept as a shared constant here to match the
 * source's own SELECT const.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const SELECT = 'user_id, tenant_id, active_role, app_users(email, vitana_id)';

export async function fetchUserTenantByUserId(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_tenants')
    .select(SELECT)
    .eq('user_id', userId)
    .order('is_primary', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchUserTenantByEmail(sb: SupabaseClient, email: string) {
  return sb
    .from('user_tenants')
    .select(SELECT)
    .eq('app_users.email', email)
    .not('app_users', 'is', null)
    .order('is_primary', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchUserTenantWithAnyVitanaId(sb: SupabaseClient) {
  return sb
    .from('user_tenants')
    .select(SELECT)
    .not('app_users.vitana_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
}
