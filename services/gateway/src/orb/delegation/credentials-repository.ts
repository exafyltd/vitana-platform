// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note: no
// test file references orb/delegation/credentials.ts — zero coverage
// today.
/**
 * orb/delegation/credentials.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb/delegation/credentials.ts now
 * goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 *
 * Security note (unchanged by this move): callers must not log or
 * persist the decrypted key material these queries feed into — that
 * contract lives in credentials.ts, not here; this file only moves the
 * raw row fetches.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchLatestActiveUserConnection(sb: SupabaseClient, userId: string, connectorId: string) {
  return sb
    .from('user_connections')
    .select('id, is_active')
    .eq('user_id', userId)
    .eq('connector_id', connectorId)
    .eq('category', 'ai_assistant')
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function fetchAiAssistantCredentialByConnectionId(sb: SupabaseClient, connectionId: string) {
  return sb
    .from('ai_assistant_credentials')
    .select('encrypted_key, encryption_iv, encryption_tag')
    .eq('connection_id', connectionId)
    .maybeSingle();
}

export async function fetchActiveAiAssistantConnectorIds(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_connections')
    .select('connector_id')
    .eq('user_id', userId)
    .eq('category', 'ai_assistant')
    .eq('is_active', true);
}
