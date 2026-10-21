/**
 * routes/admin-autopilot.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in routes/admin-autopilot.ts (against
 * tenant_autopilot_settings, tenant_autopilot_bindings, tenant_autopilot_runs,
 * autopilot_recommendations) now goes through here instead of being written
 * inline. PURE MOVE, not a rewrite: same queries, same columns, same
 * `{ data, error }`/`{ data, error, count }` shapes — no behavior change
 * today. Several call sites share an identical query shape (e.g. the
 * `wave_config`-only settings read used by both GET /waves and PATCH
 * /waves/:waveId) and are intentionally backed by one shared function
 * rather than duplicated.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== tenant_autopilot_settings ====================

export async function fetchSettingsFull(supabase: SupabaseClient, tenantId: string) {
  return supabase.from('tenant_autopilot_settings').select('*').eq('tenant_id', tenantId).maybeSingle();
}

export async function insertSettingsDefault(supabase: SupabaseClient, tenantId: string) {
  return supabase.from('tenant_autopilot_settings').insert({ tenant_id: tenantId }).select('*').single();
}

export async function fetchSettingsIdOnly(supabase: SupabaseClient, tenantId: string) {
  return supabase.from('tenant_autopilot_settings').select('id').eq('tenant_id', tenantId).maybeSingle();
}

export async function insertSettingsWithOverrides(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('tenant_autopilot_settings').insert(row).select('*').single();
}

export async function updateSettingsReturning(supabase: SupabaseClient, tenantId: string, updates: Record<string, unknown>) {
  return supabase.from('tenant_autopilot_settings').update(updates).eq('tenant_id', tenantId).select('*').single();
}

/** Shared by GET /recommendations and GET /recommendations/summary. */
export async function fetchSettingsForRecommendations(supabase: SupabaseClient, tenantId: string) {
  return supabase.from('tenant_autopilot_settings').select('allowed_domains, allowed_risk_levels, enabled').eq('tenant_id', tenantId).maybeSingle();
}

/** Shared by GET /waves and PATCH /waves/:waveId. */
export async function fetchSettingsWaveConfig(supabase: SupabaseClient, tenantId: string) {
  return supabase.from('tenant_autopilot_settings').select('wave_config').eq('tenant_id', tenantId).maybeSingle();
}

export async function insertSettingsMinimal(supabase: SupabaseClient, tenantId: string) {
  return supabase.from('tenant_autopilot_settings').insert({ tenant_id: tenantId });
}

export async function updateSettingsNoReturn(supabase: SupabaseClient, tenantId: string, fields: Record<string, unknown>) {
  return supabase.from('tenant_autopilot_settings').update(fields).eq('tenant_id', tenantId);
}

// ==================== tenant_autopilot_bindings ====================

export async function fetchBindings(supabase: SupabaseClient, tenantId: string, enabledFilter?: boolean) {
  let query = supabase.from('tenant_autopilot_bindings').select('*').eq('tenant_id', tenantId).order('automation_id', { ascending: true });
  if (enabledFilter !== undefined) query = query.eq('enabled', enabledFilter);
  return query;
}

export async function upsertBinding(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('tenant_autopilot_bindings').upsert(row, { onConflict: 'tenant_id,automation_id' }).select('*').single();
}

export async function updateBinding(supabase: SupabaseClient, bindingId: string, tenantId: string, updates: Record<string, unknown>) {
  return supabase.from('tenant_autopilot_bindings').update(updates).eq('id', bindingId).eq('tenant_id', tenantId).select('*').single();
}

export async function deleteBinding(supabase: SupabaseClient, bindingId: string, tenantId: string) {
  return supabase.from('tenant_autopilot_bindings').delete().eq('id', bindingId).eq('tenant_id', tenantId);
}

export async function fetchBindingsForWaves(supabase: SupabaseClient, tenantId: string) {
  return supabase.from('tenant_autopilot_bindings').select('automation_id, enabled').eq('tenant_id', tenantId);
}

/** No select-back -- used in a per-automation batch-upsert loop (PATCH /waves/:waveId). */
export async function upsertBindingNoReturn(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('tenant_autopilot_bindings').upsert(row, { onConflict: 'tenant_id,automation_id' });
}

export async function fetchBindingsFull(supabase: SupabaseClient, tenantId: string) {
  return supabase.from('tenant_autopilot_bindings').select('*').eq('tenant_id', tenantId);
}

// ==================== tenant_autopilot_runs ====================

export interface RunsFilters {
  tenantId: string;
  status?: unknown;
  automationId?: unknown;
  offset: number;
  limit: number;
}

export async function fetchRuns(supabase: SupabaseClient, f: RunsFilters) {
  let query = supabase
    .from('tenant_autopilot_runs')
    .select('*', { count: 'exact' })
    .eq('tenant_id', f.tenantId)
    .order('started_at', { ascending: false })
    .range(f.offset, f.offset + f.limit - 1);

  if (f.status) query = query.eq('status', f.status as string);
  if (f.automationId) query = query.eq('automation_id', f.automationId as string);

  return query;
}

export async function fetchRunsForStats(supabase: SupabaseClient, tenantId: string, since: string) {
  return supabase.from('tenant_autopilot_runs').select('status, duration_ms, started_at, automation_id').eq('tenant_id', tenantId).gte('started_at', since);
}

// ==================== autopilot_recommendations ====================

export interface RecommendationsFilters {
  allowedDomains: string[];
  allowedRisks: string[];
  status?: unknown;
  domain?: unknown;
  riskLevel?: unknown;
  offset: number;
  limit: number;
}

export async function fetchRecommendations(supabase: SupabaseClient, f: RecommendationsFilters) {
  let query = supabase
    .from('autopilot_recommendations')
    .select('*', { count: 'exact' })
    .in('domain', f.allowedDomains)
    .in('risk_level', f.allowedRisks)
    .order('impact_score', { ascending: false })
    .order('created_at', { ascending: false })
    .range(f.offset, f.offset + f.limit - 1);

  // Exclude snoozed
  query = query.or('snoozed_until.is.null,snoozed_until.lt.' + new Date().toISOString());

  if (f.status) query = query.eq('status', f.status as string);
  if (f.domain) query = query.eq('domain', f.domain as string);
  if (f.riskLevel) query = query.eq('risk_level', f.riskLevel as string);

  return query;
}

export async function fetchRecommendationsStatusOnly(supabase: SupabaseClient, allowedDomains: string[], allowedRisks: string[]) {
  return supabase.from('autopilot_recommendations').select('status').in('domain', allowedDomains).in('risk_level', allowedRisks);
}
