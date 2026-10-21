// Genuinely tested via
// test/services/assistant-continuation/providers/teacher/feature-discovery-teacher.test.ts,
// which drives real functional fake SupabaseClients (table-keyed
// builder mocks, not a wholesale module mock).
/**
 * services/assistant-continuation/providers/teacher/feature-discovery-teacher.ts
 * — Aurora migration B1 data-access seam (VTID-03702, Supabase→Aurora
 * migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)`/`.rpc(...)` call in
 * feature-discovery-teacher.ts now goes through here instead of being
 * written inline. PURE MOVE, not a rewrite: same queries, same
 * columns, same conditional-filter logic, same return shapes — no
 * behavior change today. Client-agnostic (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchEnabledSystemCapabilities(sb: SupabaseClient) {
  return sb
    .from('system_capabilities')
    .select('capability_key, display_name, description, manual_path, enabled, pedagogical_order')
    .eq('enabled', true);
}

export async function fetchUserCapabilityAwareness(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('user_capability_awareness')
    .select('capability_key, awareness_state, dismiss_count, last_introduced_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);
}

export async function fetchTeacherCapabilityRefreshSchedule(sb: SupabaseClient, tenantId: string, userId: string) {
  return sb
    .from('teacher_capability_refresh_schedule')
    .select('capability_key, next_refresh_ok_at, refresh_count')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId);
}

export async function recordTeacherRefresh(
  sb: SupabaseClient,
  params: {
    p_tenant_id: string;
    p_user_id: string;
    p_capability_key: string;
    p_next_ok_at: string;
    p_is_refresh: boolean;
  },
) {
  return sb.rpc('record_teacher_refresh', params);
}
