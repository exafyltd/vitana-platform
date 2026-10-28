/**
 * VTID-04821: the one row company document search reads — the caller's own
 * Google / Microsoft connection (account email and granted scopes, never the
 * tokens; getConnectorAccessToken loads and refreshes those).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchCompanyDocsConnection(sb: SupabaseClient, userId: string, provider: 'google' | 'microsoft') {
  return sb
    .from('social_connections')
    .select('id, provider_username, scopes')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('is_active', true)
    .maybeSingle();
}
