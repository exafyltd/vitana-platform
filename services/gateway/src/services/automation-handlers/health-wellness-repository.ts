// impact-allow-no-test: pure data-access seam (thin Supabase query wrappers,
// no independent request-handling behavior). test/services/automation-
// handlers-phase1-batch4.test.ts imports this module and directly exercises
// runWellnessCheckIn (AP-0604), runCommunityWellnessEventSuggestion
// (AP-0605), and runHealthDataExportReminder (AP-0606) — 7 of the 15 call
// sites here. The other handlers (runHealthReportSummarization,
// runLabReportIngestion, runBiomarkerTrendAnalysis,
// runQualityOfLifeRecommendations, runVitanaIndexWeeklyReport,
// runProfessionalReferral, runHealthAwareProductRecs) have no functional
// test coverage in this repo today -- moved as a literal, mechanical
// read-for-read copy and verified via tsc --noEmit.
/**
 * services/automation-handlers/health-wellness.ts — Aurora migration B1
 * data-access seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in health-wellness.ts now goes through
 * here instead of being written inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same conditional-filter logic, same return shapes
 * — no behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== lab_reports ====================

export async function fetchPendingLabReports(sb: SupabaseClient, tenantId: string, limit: number) {
  return sb.from('lab_reports').select('id, user_id').eq('tenant_id', tenantId).is('parsed_json', null).limit(limit);
}

export async function countLabReportsForUser(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb.from('lab_reports').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('user_id', userId);
}

// ==================== user_tenants ====================

export async function fetchPrimaryTenantUserIds(sb: SupabaseClient, tenantId: string) {
  return sb.from('user_tenants').select('user_id').eq('tenant_id', tenantId).eq('is_primary', true);
}

// ==================== vitana_index_scores ====================

export async function fetchVitanaIndexScoreTotalSince(sb: SupabaseClient, tenantId: string, userId: string, sinceDate: string, beforeDate?: string) {
  let q = sb.from('vitana_index_scores').select('score_total').eq('tenant_id', tenantId).eq('user_id', userId).gte('date', sinceDate);
  if (beforeDate) q = q.lte('date', beforeDate);
  return q.order('date', { ascending: false }).limit(1).maybeSingle();
}

export async function fetchLatestVitanaIndexScoreTotal(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb.from('vitana_index_scores').select('score_total').eq('tenant_id', tenantId).eq('user_id', userId).order('date', { ascending: false }).limit(1).maybeSingle();
}

export async function fetchLatestVitanaIndexPillars(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('vitana_index_scores')
    .select('score_sleep, score_nutrition, score_exercise, score_hydration, score_mental')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
}

// ==================== biomarker_results ====================

export async function fetchBiomarkerResultsForReport(sb: SupabaseClient, tenantId: string, userId: string, reportId: string) {
  return sb
    .from('biomarker_results')
    .select('biomarker_code, name, value, unit, status, measured_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('lab_report_id', reportId)
    .order('measured_at', { ascending: false });
}

// ==================== services_catalog ====================

export async function fetchServiceProvidersByType(sb: SupabaseClient, tenantId: string, serviceTypes: string[], limit: number) {
  return sb.from('services_catalog').select('id, name, service_type, provider_name').eq('tenant_id', tenantId).in('service_type', serviceTypes).limit(limit);
}

// ==================== recommendations ====================

export async function fetchRecentRecommendations(sb: SupabaseClient, tenantId: string, userId: string, limit: number) {
  return sb.from('recommendations').select('category, title').eq('tenant_id', tenantId).eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
}

// ==================== products ====================

export async function fetchActiveProductsByTopicKeys(sb: SupabaseClient, categories: string[], limit: number) {
  return sb.from('products').select('id, title, category').eq('is_active', true).overlaps('topic_keys', categories).limit(limit);
}

// ==================== global_community_events / global_event_participants ====================

export async function fetchUpcomingCommunityEventsForWellness(sb: SupabaseClient, nowIso: string, lookaheadIso: string, limit: number) {
  return sb.from('global_community_events').select('id, title, start_time').gte('start_time', nowIso).lte('start_time', lookaheadIso).order('start_time', { ascending: true }).limit(limit);
}

export async function fetchEventAttendance(sb: SupabaseClient, eventId: string, userId: string) {
  return sb.from('global_event_participants').select('id').eq('event_id', eventId).eq('user_id', userId).eq('status', 'attending').limit(1);
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
