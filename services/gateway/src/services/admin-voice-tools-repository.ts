// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references admin-voice-tools.ts — zero coverage today.
/**
 * services/admin-voice-tools.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in admin-voice-tools.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 *
 * `fetchInsightDetail` preserves the source's conditional id-vs-
 * natural_key filter branch.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchTenantKpiCurrent(sb: SupabaseClient, tenantId: string) {
  return sb.from('tenant_kpi_current').select('kpi, generated_at').eq('tenant_id', tenantId).maybeSingle();
}

export async function fetchInsightDetail(
  sb: SupabaseClient,
  tenantId: string,
  args: { insight_id?: string; natural_key?: string },
) {
  let q = sb
    .from('admin_insights')
    .select('id, scanner, natural_key, domain, title, description, severity, status, recommended_action, context, confidence_score, autonomy_level, created_at, snoozed_until')
    .eq('tenant_id', tenantId);
  if (args.insight_id) q = q.eq('id', args.insight_id);
  else q = q.eq('natural_key', args.natural_key as string);
  return q.maybeSingle();
}

export async function updateInsightStatus(
  sb: SupabaseClient,
  tenantId: string,
  insightId: string,
  update: Record<string, unknown>,
) {
  return sb
    .from('admin_insights')
    .update(update)
    .eq('tenant_id', tenantId)
    .eq('id', insightId)
    .select('id, status, title')
    .maybeSingle();
}

export async function fetchTenantKpiDailyHistory(sb: SupabaseClient, tenantId: string, startDate: string) {
  return sb
    .from('tenant_kpi_daily')
    .select('snapshot_date, kpi')
    .eq('tenant_id', tenantId)
    .gte('snapshot_date', startDate)
    .order('snapshot_date', { ascending: false });
}
