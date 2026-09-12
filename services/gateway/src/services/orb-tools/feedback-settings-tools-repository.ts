/**
 * orb-tools/feedback-settings-tools.ts — Aurora migration B1 data-access
 * seam (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in orb-tools/feedback-settings-tools.ts
 * now goes through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same conditional-filter logic, same
 * return shapes — no behavior change today. Client-agnostic (takes `sb` as
 * a param) — tools receive their client per-call, not a module-level
 * singleton.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== feedback_tickets ====================

export async function insertUnroutedFeedbackTicket(sb: SupabaseClient, row: Record<string, unknown>) {
  return sb.from('feedback_tickets').insert(row).select('id, ticket_number').single();
}

export async function fetchOpenFeedbackTickets(sb: SupabaseClient, userId: string, closedStatuses: string[]) {
  return sb
    .from('feedback_tickets')
    .select('id, ticket_number, kind, status, created_at')
    .eq('user_id', userId)
    .not('status', 'in', `(${closedStatuses.join(',')})`)
    .order('created_at', { ascending: false })
    .limit(8);
}

// ==================== user_preferences ====================

export async function upsertLanguagePreference(sb: SupabaseClient, userId: string, sttLanguage: string, nowIso: string) {
  return sb.from('user_preferences').upsert(
    { user_id: userId, stt_language: sttLanguage, updated_at: nowIso },
    { onConflict: 'user_id' },
  );
}

export async function upsertVoicePreferences(sb: SupabaseClient, update: Record<string, unknown>) {
  return sb.from('user_preferences').upsert(update, { onConflict: 'user_id' });
}

// ==================== app_users ====================

export async function updateUserLocale(sb: SupabaseClient, userId: string, locale: string, nowIso: string) {
  return sb.from('app_users').update({ locale, updated_at: nowIso }).eq('user_id', userId);
}

// ==================== user_connections ====================

export async function fetchActiveAiConnections(sb: SupabaseClient, userId: string) {
  return sb
    .from('user_connections')
    .select('connector_id, connected_at')
    .eq('user_id', userId)
    .eq('category', 'ai_assistant')
    .eq('is_active', true);
}

export async function fetchActiveAiConnectionRow(sb: SupabaseClient, userId: string, connectorId: string) {
  return sb
    .from('user_connections')
    .select('id')
    .eq('user_id', userId)
    .eq('connector_id', connectorId)
    .eq('category', 'ai_assistant')
    .eq('is_active', true)
    .maybeSingle();
}

export async function deactivateAiConnection(sb: SupabaseClient, connectionId: string, nowIso: string) {
  return sb.from('user_connections').update({ is_active: false, disconnected_at: nowIso }).eq('id', connectionId);
}

// ==================== social_connections ====================

export async function fetchActiveSocialConnectionRow(sb: SupabaseClient, userId: string, provider: string) {
  return sb
    .from('social_connections')
    .select('id')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('is_active', true)
    .maybeSingle();
}

// ==================== ai_assistant_credentials ====================

export async function purgeAiAssistantCredential(sb: SupabaseClient, connectionId: string) {
  return sb
    .from('ai_assistant_credentials')
    .update({
      encrypted_key: `\\x${'00'.repeat(32)}`,
      encryption_iv: `\\x${'00'.repeat(12)}`,
      encryption_tag: `\\x${'00'.repeat(16)}`,
      last_verify_status: 'purged',
    })
    .eq('connection_id', connectionId);
}
