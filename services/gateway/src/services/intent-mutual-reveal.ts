/**
 * VTID-01973: Mutual-reveal protocol (P2-A surface).
 *
 * For partner_seek (and any future kind with requires_mutual_reveal=true):
 * vitana_id_b on intent_matches rows is REDACTED in API responses until
 * BOTH parties have explicitly expressed interest, at which point
 * mutual_reveal_unlocked_at is set and both vitana_ids surface.
 *
 * P2-A provides:
 *   - redactMatchForReader(match, readerUserId)  — applied at the route layer
 *     to nullify counterparty vitana_id while pre-reveal.
 *   - tryUnlockReveal(matchId)  — called by intent-matches.ts state-transition
 *     handler. If both sides have expressed interest, set unlocked_at and
 *     emit OASIS event.
 *
 * The DB-level helper intent_match_should_redact() (migration 8/9)
 * complements this for support tooling that bypasses the gateway.
 */

import { createClient } from '@supabase/supabase-js';
import { emitOasisEvent } from './oasis-event-service';
import type { MatchRow } from './intent-matcher';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
}

const MUTUAL_REVEAL_KINDS = new Set(['partner_seek']);

export interface RedactedMatch extends Omit<MatchRow, 'vitana_id_a' | 'vitana_id_b'> {
  vitana_id_a: string | null;
  vitana_id_b: string | null;
  redacted: boolean;
  // E6 — counterparty profile fields populated by enrichMatchesWithCounterpartyProfiles.
  // null when redacted, when the counterparty is hidden (global_community_profiles.is_visible=false),
  // or when the field is unset in profiles.
  partner_display_name?: string | null;
  partner_avatar_url?: string | null;
  partner_gender?: 'male' | 'female' | null;
  // BOOTSTRAP-INTENT-COVER-GEN — landscape cover photo for the
  // counterparty's intent. User-uploaded or auto-generated.
  partner_match_cover_url?: string | null;
  // Counterparty intent fields surfaced for the Find-a-Match card body
  // (kind pill / title / scope mirror My Posts). All optional and
  // null-on-redaction; the frontend has defensive fallbacks.
  partner_intent_title?: string | null;
  partner_intent_scope?: string | null;
  partner_intent_kind?: string | null;
  partner_intent_status?: string | null;
}

/**
 * Given a match and a reader's user_id, decide whether to redact the
 * counterparty vitana_id. Returns a copy of the match with redaction
 * applied. Never mutates the input.
 */
export async function redactMatchForReader(
  match: MatchRow,
  readerUserId: string,
): Promise<RedactedMatch> {
  const kindA = match.kind_pairing.split('::')[0];
  const kindB = match.kind_pairing.split('::')[1];
  const involvesMutualReveal =
    MUTUAL_REVEAL_KINDS.has(kindA) || MUTUAL_REVEAL_KINDS.has(kindB);

  if (!involvesMutualReveal) {
    return { ...match, redacted: false };
  }

  // Already unlocked: no redaction.
  // (We check via a fresh read of the unlock timestamp because the cached
  // match passed in might be stale.)
  const supabase = getSupabase();
  const { data: fresh } = await supabase
    .from('intent_matches')
    .select('mutual_reveal_unlocked_at, intent_a_id, intent_b_id')
    .eq('match_id', match.match_id)
    .maybeSingle();
  const unlocked = fresh && (fresh as any).mutual_reveal_unlocked_at !== null;

  if (unlocked) return { ...match, redacted: false };

  // Pre-reveal: figure out which side the reader is on, hide the other vitana_id.
  const { data: aOwner } = await supabase
    .from('user_intents')
    .select('requester_user_id')
    .eq('intent_id', match.intent_a_id)
    .maybeSingle();
  const isReaderA = aOwner && (aOwner as any).requester_user_id === readerUserId;

  return {
    ...match,
    vitana_id_a: isReaderA ? match.vitana_id_a : null,
    vitana_id_b: isReaderA ? null : match.vitana_id_b,
    redacted: true,
  };
}

/**
 * Called when a state transitions to provider_responded / requester_engaged.
 * If BOTH sides have engaged, set mutual_reveal_unlocked_at and emit audit.
 */
export async function tryUnlockReveal(matchId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data: m } = await supabase
    .from('intent_matches')
    .select('match_id, kind_pairing, state, mutual_reveal_unlocked_at, vitana_id_a, vitana_id_b')
    .eq('match_id', matchId)
    .maybeSingle();

  if (!m) return false;
  if ((m as any).mutual_reveal_unlocked_at) return true;

  const kindA = (m as any).kind_pairing.split('::')[0];
  const kindB = (m as any).kind_pairing.split('::')[1];
  if (!MUTUAL_REVEAL_KINDS.has(kindA) && !MUTUAL_REVEAL_KINDS.has(kindB)) return false;

  // Both sides must have responded: state in mutual_interest signals both
  // engaged. The state transition path in intent-matches.ts is the source
  // of truth — any time it sets mutual_interest we call this.
  if ((m as any).state !== 'mutual_interest') return false;

  const { error } = await supabase
    .from('intent_matches')
    .update({ mutual_reveal_unlocked_at: new Date().toISOString() })
    .eq('match_id', matchId);

  if (error) {
    console.warn(`[VTID-01973] tryUnlockReveal update failed: ${error.message}`);
    return false;
  }

  await emitOasisEvent({
    vtid: 'VTID-01973',
    type: 'voice.message.sent', // P2-B introduces 'intent_partner_reciprocal_revealed'
    source: 'intent-mutual-reveal',
    status: 'success',
    message: `Mutual reveal unlocked for match ${matchId}`,
    payload: {
      match_id: matchId,
      vitana_id_a: (m as any).vitana_id_a,
      vitana_id_b: (m as any).vitana_id_b,
      protocol: 'partner_seek_reciprocal',
    },
    surface: 'api',
    vitana_id: (m as any).vitana_id_a ?? undefined,
  });

  return true;
}
