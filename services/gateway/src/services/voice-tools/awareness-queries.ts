/**
 * VTID-02778 — Voice Tool Expansion P1p: Awareness engine queries.
 *
 * Read-only voice tools that surface the latest computed signals from
 * the awareness engines (D28/D32/D33/D34/D35/D40). Each tool calls the
 * engine's `<engine>_get_current` RPC. If the RPC isn't deployed in this
 * environment, the tool returns a graceful "not yet computed" response.
 */

import { SupabaseClient } from '@supabase/supabase-js';

async function callGetCurrent(
  sb: SupabaseClient,
  rpcName: string,
  userId: string,
): Promise<{ ok: true; signals: any } | { ok: false; error: string }> {
  // Most engines' get_current RPC takes (p_session_id, p_user_id) or
  // similar. Pass null session and the user_id; engines that need a session
  // will return their own error.
  const { data, error } = await sb.rpc(rpcName, {
    p_session_id: null,
    p_user_id: userId,
  });
  if (error) {
    if (error.message.includes('function') && error.message.includes('does not exist')) {
      return { ok: false, error: 'rpc_unavailable' };
    }
    // Try without p_user_id (some engines auto-resolve from auth.uid)
    const fallback = await sb.rpc(rpcName, { p_session_id: null });
    if (fallback.error) return { ok: false, error: `${rpcName}_failed: ${error.message}` };
    return { ok: true, signals: fallback.data ?? null };
  }
  return { ok: true, signals: data ?? null };
}

export async function getEmotionalState(sb: SupabaseClient, userId: string) {
  return callGetCurrent(sb, 'emotional_cognitive_get_current', userId);
}

export async function getSituationalAwareness(sb: SupabaseClient, userId: string) {
  return callGetCurrent(sb, 'situational_awareness_get_current', userId);
}

export async function getAvailability(sb: SupabaseClient, userId: string) {
  return callGetCurrent(sb, 'availability_readiness_get_current', userId);
}

export async function getEnvironmentalContext(sb: SupabaseClient, userId: string) {
  return callGetCurrent(sb, 'environmental_mobility_get_current', userId);
}

export async function getSocialContext(sb: SupabaseClient, userId: string) {
  return callGetCurrent(sb, 'social_context_get_current', userId);
}

export async function getLifeStageContext(sb: SupabaseClient, userId: string) {
  return callGetCurrent(sb, 'life_stage_get_current', userId);
}
