// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references routes/social-connect.ts — zero coverage today.
/**
 * routes/social-connect.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in social-connect.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic,
 * same return shapes — no behavior change today. Client-agnostic
 * (takes `sb` as a param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchActiveSocialConnectionId(sb: SupabaseClient, userId: string, provider: string) {
  return sb
    .from('social_connections')
    .select('id')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('is_active', true)
    .maybeSingle();
}

export async function fetchSocialConnectionProfileSummary(sb: SupabaseClient, userId: string, provider: string) {
  return sb
    .from('social_connections')
    .select('provider, provider_username, display_name, avatar_url, profile_url, enrichment_data, enrichment_status, last_enriched_at')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('is_active', true)
    .maybeSingle();
}

export async function fetchActiveGoogleConnection(sb: SupabaseClient, userId: string) {
  return sb
    .from('social_connections')
    .select('id, access_token, refresh_token, token_expires_at, scopes, provider_username, connected_at')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .eq('is_active', true)
    .maybeSingle();
}

export async function updateSocialConnectionAccessToken(
  sb: SupabaseClient,
  connectionId: string,
  accessToken: string,
  tokenExpiresAtIso: string,
  updatedAtIso: string,
) {
  return sb
    .from('social_connections')
    .update({
      access_token: accessToken,
      token_expires_at: tokenExpiresAtIso,
      updated_at: updatedAtIso,
    })
    .eq('id', connectionId);
}
