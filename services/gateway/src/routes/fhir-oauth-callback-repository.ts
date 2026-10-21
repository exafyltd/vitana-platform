// Genuinely tested via test/routes/fhir-oauth-callback.test.ts (only
// getSupabase itself is mocked, not this module) — not a wholesale
// module mock.
/**
 * routes/fhir-oauth-callback.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in fhir-oauth-callback.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function insertOasisEvent(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('oasis_events').insert(row);
}

export async function fetchIntegrationManifestById(sb: SupabaseClient, manifestId: string) {
  return sb.from('integration_manifest').select('id,connector_id,status').eq('id', manifestId).maybeSingle();
}

export async function upsertPartnerOauthCredential(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('partner_oauth_credential').upsert(row, { onConflict: 'manifest_id,provider' });
}

export async function updateIntegrationManifestStatus(
  sb: SupabaseClient,
  manifestId: string,
  status: string,
  updatedAtIso: string,
) {
  return sb.from('integration_manifest').update({ status, updated_at: updatedAtIso }).eq('id', manifestId);
}
