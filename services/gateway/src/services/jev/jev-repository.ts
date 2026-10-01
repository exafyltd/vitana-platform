/**
 * VTID-04754: every Supabase call the Jev module makes, in one seam
 * (same pattern as the *-repository.ts files elsewhere in the gateway).
 * Client-agnostic: takes `sb` as a parameter. Service role only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchPrimaryTenant(sb: SupabaseClient, userId: string) {
  return sb.from('user_tenants').select('tenant_id').eq('user_id', userId).eq('is_primary', true).maybeSingle();
}

export async function fetchTenantActiveRole(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb.from('user_tenants').select('active_role').eq('user_id', userId).eq('tenant_id', tenantId).maybeSingle();
}

export async function fetchLatestRolePreference(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb
    .from('role_preferences')
    .select('role, updated_at')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchExplicitRoleGrants(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb.from('user_permitted_roles').select('role').eq('user_id', userId).eq('tenant_id', tenantId);
}

export async function fetchActiveMembershipRoles(sb: SupabaseClient, userId: string, tenantId: string) {
  return sb.from('memberships').select('role').eq('user_id', userId).eq('tenant_id', tenantId).eq('status', 'active');
}

/** Accepts a tenant uuid or slug. */
export async function fetchTenantByIdOrSlug(sb: SupabaseClient, idOrSlug: string) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  return sb.from('tenants').select('tenant_id, slug').eq(isUuid ? 'tenant_id' : 'slug', idOrSlug).maybeSingle();
}

export async function fetchTenantFeatureFlags(sb: SupabaseClient, tenantId: string) {
  return sb.from('tenant_settings').select('feature_flags').eq('tenant_id', tenantId).maybeSingle();
}

export async function fetchTenantMonthSpend(sb: SupabaseClient, tenantId: string, month: string) {
  return sb.from('jev_spend_counters').select('cost_usd').eq('tenant_id', tenantId).eq('month', month);
}

export async function fetchMonthSpendRows(sb: SupabaseClient, month: string) {
  return sb.from('jev_spend_counters').select('tenant_id, plane, calls, input_tokens, cost_usd').eq('month', month);
}

export async function recordSpendRpc(sb: SupabaseClient, tenantId: string, plane: string, inputTokens: number, costUsd: number) {
  return sb.rpc('jev_record_spend', { p_tenant_id: tenantId, p_plane: plane, p_input_tokens: inputTokens, p_cost_usd: costUsd });
}

export async function insertShadowDecision(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('jev_shadow_decisions').insert(row).select('id').single();
}

export async function updateShadowOutcome(sb: SupabaseClient, id: string, patch: Record<string, unknown>) {
  return sb.from('jev_shadow_decisions').update(patch).eq('id', id);
}

export async function shadowGateStatsRpc(sb: SupabaseClient, days: number) {
  return sb.rpc('jev_shadow_gate_stats', { p_days: days });
}

/** VTID-04759: the newest gate row for a subject since a time (incident dedupe). */
export async function fetchRecentShadowBySubject(sb: SupabaseClient, gate: string, subjectRef: string, sinceIso: string) {
  return sb
    .from('jev_shadow_decisions')
    .select('id, subject_ref, created_at')
    .eq('gate', gate)
    .eq('subject_ref', subjectRef)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

/** VTID-04774: the newest gate row for a subject, with its verdict (outcome write-back). */
export async function fetchRecentShadowRow(sb: SupabaseClient, gate: string, subjectRef: string, sinceIso: string) {
  return sb
    .from('jev_shadow_decisions')
    .select('id, jev_outcome, jev_verdict')
    .eq('gate', gate)
    .eq('subject_ref', subjectRef)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

/** VTID-04802: the newest deploy-completed events of one topic at or before a time. */
export async function fetchRecentDeployEvents(sb: SupabaseClient, topic: string, beforeIso: string, limit: number) {
  return sb
    .from('oasis_events')
    .select('created_at, metadata')
    .eq('topic', topic)
    .lte('created_at', beforeIso)
    .order('created_at', { ascending: false })
    .limit(limit);
}

/** VTID-04808: open (no outcome yet) shadow rows of a gate whose verdict lists an execution among `others`. */
export async function fetchOpenShadowRowsNamingOther(sb: SupabaseClient, gate: string, executionId: string, sinceIso: string) {
  return sb
    .from('jev_shadow_decisions')
    .select('id, jev_outcome, jev_verdict')
    .eq('gate', gate)
    .is('outcome', null)
    .contains('jev_verdict', { others: [{ execution_id: executionId }] })
    .gte('created_at', sinceIso)
    .limit(10);
}

/** VTID-04805: stalled voice sessions in a window (metadata only). */
export async function fetchStallEvents(sb: SupabaseClient, sinceIso: string, untilIso: string, limit = 500) {
  return sb
    .from('oasis_events')
    .select('metadata, created_at')
    .eq('topic', 'orb.live.stall_detected')
    .gte('created_at', sinceIso)
    .lt('created_at', untilIso)
    .order('created_at', { ascending: true })
    .limit(limit);
}

/** VTID-04805: one voice session's own events in a window (topic + metadata only). */
export async function fetchSessionEvents(sb: SupabaseClient, sessionId: string, sinceIso: string, untilIso: string, limit = 400) {
  return sb
    .from('oasis_events')
    .select('topic, metadata')
    .eq('metadata->>session_id', sessionId)
    .gte('created_at', sinceIso)
    .lt('created_at', untilIso)
    .limit(limit);
}

/** VTID-04804: voice backstop diag events in a window (metadata only). */
export async function fetchVoiceDiagEvents(sb: SupabaseClient, stages: readonly string[], sinceIso: string, untilIso: string, limit = 5000) {
  return sb
    .from('oasis_events')
    .select('metadata')
    .eq('topic', 'orb.live.diag')
    .in('metadata->>stage', stages as string[])
    .gte('created_at', sinceIso)
    .lt('created_at', untilIso)
    .limit(limit);
}
