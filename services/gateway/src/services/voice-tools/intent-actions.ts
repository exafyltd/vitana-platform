/**
 * VTID-02777 — Voice Tool Expansion P1o: Find Partner / Intent extensions.
 *
 * Backs voice tools that go beyond post_intent / list_my_intents /
 * view_intent_matches / respond_to_match. Adds update/close intent,
 * decline/dispute match, update partner-prefs.
 */

import { SupabaseClient } from '@supabase/supabase-js';

export async function updateIntent(
  sb: SupabaseClient,
  userId: string,
  args: { intent_id: string; description?: string; structured_fields?: Record<string, unknown> },
): Promise<{ ok: true; intent_id: string } | { ok: false; error: string }> {
  if (!args.intent_id) return { ok: false, error: 'intent_id_required' };
  const updates: Record<string, unknown> = {};
  if (typeof args.description === 'string') updates.description = args.description;
  if (args.structured_fields) updates.structured_fields = args.structured_fields;
  if (Object.keys(updates).length === 0) return { ok: false, error: 'no_fields' };
  const { error } = await sb
    .from('intents')
    .update(updates)
    .eq('id', args.intent_id)
    .eq('user_id', userId);
  if (error) return { ok: false, error: `update_failed: ${error.message}` };
  return { ok: true, intent_id: args.intent_id };
}

export async function closeIntent(
  sb: SupabaseClient,
  userId: string,
  args: { intent_id: string; reason?: string },
): Promise<{ ok: true; intent_id: string } | { ok: false; error: string }> {
  if (!args.intent_id) return { ok: false, error: 'intent_id_required' };
  const { error } = await sb
    .from('intents')
    .update({ status: 'closed', closed_at: new Date().toISOString(), close_reason: args.reason ?? null })
    .eq('id', args.intent_id)
    .eq('user_id', userId);
  if (error) return { ok: false, error: `close_failed: ${error.message}` };
  return { ok: true, intent_id: args.intent_id };
}

export async function declineMatch(
  sb: SupabaseClient,
  userId: string,
  args: { match_id: string; reason?: string },
): Promise<{ ok: true; match_id: string } | { ok: false; error: string }> {
  if (!args.match_id) return { ok: false, error: 'match_id_required' };
  // Match is owned by either side of the relationship; we mark it declined
  // for this user only.
  const { error } = await sb
    .from('intent_matches')
    .update({ user_state_decline_reason: args.reason ?? null, user_state: 'declined' })
    .eq('id', args.match_id)
    .or(`user_id.eq.${userId},matched_user_id.eq.${userId}`);
  if (error) return { ok: false, error: `decline_failed: ${error.message}` };
  return { ok: true, match_id: args.match_id };
}

export async function disputeMatch(
  sb: SupabaseClient,
  userId: string,
  args: { match_id: string; reason: string },
): Promise<{ ok: true; match_id: string } | { ok: false; error: string }> {
  if (!args.match_id) return { ok: false, error: 'match_id_required' };
  if (!args.reason || args.reason.trim().length < 5) return { ok: false, error: 'reason_required' };
  const { error } = await sb
    .from('intent_match_disputes')
    .insert({
      match_id: args.match_id,
      user_id: userId,
      reason: args.reason.trim(),
      status: 'open',
    });
  if (error) return { ok: false, error: `dispute_failed: ${error.message}` };
  return { ok: true, match_id: args.match_id };
}

export async function updatePartnerPreferences(
  sb: SupabaseClient,
  userId: string,
  args: { preferences: Record<string, unknown> },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!args.preferences || typeof args.preferences !== 'object') {
    return { ok: false, error: 'preferences_required' };
  }
  const { error } = await sb
    .from('profiles')
    .update({ partner_preferences: args.preferences, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (error) return { ok: false, error: `update_failed: ${error.message}` };
  return { ok: true };
}
