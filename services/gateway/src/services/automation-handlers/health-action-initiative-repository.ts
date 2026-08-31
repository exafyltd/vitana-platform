// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior). test/services/automation-
// handlers-phase2.test.ts imports this module and directly exercises
// runLabTestKitOrdering (AP-1601) — 3 of the 10 call sites here. The other
// handlers (runHealthScreeningScheduler, runMotivationalHealthNudge,
// runExerciseInitiation, runSupplementReorderReminder) have no functional
// test coverage in this repo today -- moved as a literal, mechanical
// read-for-read copy and verified via tsc --noEmit.
/**
 * services/automation-handlers/health-action-initiative.ts — Aurora
 * migration B1 data-access seam (VTID-03702, Supabase→Aurora migration
 * workstream — see docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in health-action-initiative.ts now goes
 * through here instead of being written inline. PURE MOVE, not a rewrite:
 * same queries, same columns, same conditional-filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== lab_tests / lab_test_orders ====================

export async function fetchActiveLabTest(sb: SupabaseClient) {
  return sb.from('lab_tests').select('id, name').eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
}

export async function countLabTestOrdersForUser(sb: SupabaseClient, userId: string) {
  return sb.from('lab_test_orders').select('id', { count: 'exact', head: true }).eq('user_id', userId);
}

// ==================== user_notifications ====================

export async function fetchRecentAutomationSuggestion(sb: SupabaseClient, userId: string, automationId: string, sinceIso: string) {
  return sb
    .from('user_notifications')
    .select('id')
    .eq('user_id', userId)
    .contains('data', { automation_id: automationId })
    .gte('created_at', sinceIso)
    .limit(1);
}

// ==================== provider_appointments ====================

export async function countRecentProviderAppointments(sb: SupabaseClient, userId: string, sinceIso: string) {
  return sb.from('provider_appointments').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('start_time', sinceIso);
}

// ==================== vitana_index_scores ====================

export async function fetchVitanaIndexScoreForDate(sb: SupabaseClient, tenantId: string, userId: string, date: string) {
  return sb.from('vitana_index_scores').select('score_total').eq('tenant_id', tenantId).eq('user_id', userId).eq('date', date).maybeSingle();
}

// ==================== wearable_workouts ====================

export async function countRecentWearableWorkouts(sb: SupabaseClient, tenantId: string, userId: string, sinceIso: string) {
  return sb.from('wearable_workouts').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('user_id', userId).gte('started_at', sinceIso);
}

export async function countAllWearableWorkouts(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb.from('wearable_workouts').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('user_id', userId);
}

// ==================== product_orders / products ====================

export async function fetchCompletedProductOrders(sb: SupabaseClient, tenantId: string, userId: string, limit: number) {
  return sb
    .from('product_orders')
    .select('id, product_id, purchased_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('state', 'completed')
    .order('purchased_at', { ascending: false })
    .limit(limit);
}

export async function fetchProductById(sb: SupabaseClient, productId: string) {
  return sb.from('products').select('title, category').eq('id', productId).maybeSingle();
}
