// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references admin-scanners/signups-funnel.ts — zero coverage
// today.
/**
 * services/admin-scanners/signups-funnel.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream —
 * see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in
 * admin-scanners/signups-funnel.ts now goes through here instead of
 * being written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes, same call
 * order — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function countSignupsStuckAtStarted(sb: SupabaseClient, tenantId: string, beforeIso: string) {
  return sb
    .from('signup_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'started')
    .lt('started_at', beforeIso);
}

export async function countSignupsStuckAtEmailSent(sb: SupabaseClient, tenantId: string, beforeIso: string) {
  return sb
    .from('signup_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'email_sent')
    .lt('started_at', beforeIso);
}

export async function countSignupsAbandonedSince(sb: SupabaseClient, tenantId: string, sinceIso: string) {
  return sb
    .from('signup_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'abandoned')
    .gte('started_at', sinceIso);
}

export async function countSignupsTotalSince(sb: SupabaseClient, tenantId: string, sinceIso: string) {
  return sb.from('signup_attempts').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('started_at', sinceIso);
}

export async function countOnboardingInvitationsExpiredSince(sb: SupabaseClient, tenantId: string, sinceIso: string) {
  return sb
    .from('onboarding_invitations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'expired')
    .gte('created_at', sinceIso);
}
