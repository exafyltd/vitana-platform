/**
 * NAV_CONTINUATION_BIND — design invariant #10: continuation acceptance binding.
 *
 * When Vitana OFFERS an action ("Soll ich dir zeigen, wo du in deinem Guided
 * Journey stehst?") and the user ACCEPTS ("Ja", "zeig mir", "mach das"), the
 * system must execute the EXACT action Vitana offered — the stored canonical
 * `pending_cta` — instead of re-interpreting the bare "yes" as a fresh
 * navigation/search request (which is what misfires today: "Ja" goes straight
 * to the LLM as a new turn and gets resolved wrongly).
 *
 * This module is the PURE decision core:
 *   1. detectAcceptance(text)        — is this utterance an affirmation?
 *   2. maybeBindAcceptance(...)      — affirmation + a live pending_cta → the
 *                                       exact { tool, payload } to execute.
 *
 * It is transport-agnostic (Vertex Live + LiveKit) and has NO realtime
 * dependencies, so it is fully unit-testable. The turn-loop wiring that calls
 * maybeBindAcceptance() — and on a hit, dispatches the stored tool instead of
 * forwarding "yes" to the LLM — lives in the upstream message handler, behind
 * the NAV_CONTINUATION_BIND flag. The pending_cta itself is produced by the
 * continuation layer (wake-brief-wiring.ts today; mid-conversation offers next)
 * via writeOrbSessionState(userId, 'pending_cta', { tool, payload, offered_at }).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  readOrbSessionState,
  clearOrbSessionState,
} from '../orb/orb-session-state';

/** The shape stored under orb_session_state.key='pending_cta' (see wake-brief-wiring.ts). */
export interface PendingCtaValue {
  tool: string;
  payload?: Record<string, unknown>;
  offered_at?: string;
}

/** What an accepted continuation resolves to — the exact action to execute. */
export interface BoundAcceptance {
  tool: string;
  payload: Record<string, unknown>;
  source: 'pending_cta';
}

// ---------------------------------------------------------------------------
// Affirmation detection (DE + EN), with negation / redirect guards.
// ---------------------------------------------------------------------------

// Whole-word affirmation tokens. Kept deliberately tight: a continuation
// acceptance is a SHORT confirming utterance, not a fresh request that merely
// happens to contain "ja".
const AFFIRM = [
  // German
  'ja', 'jo', 'joa', 'jepp', 'jap', 'klar', 'na klar', 'klaro', 'gerne', 'gern',
  'sicher', 'okay', 'ok', 'oki', 'passt', 'einverstanden', 'mach', 'machs',
  'mach das', 'mach es', 'tu das', 'tu es', 'zeig', 'zeig mir', 'zeig es',
  'zeig es mir', 'zeig mal', 'leg los', 'los', 'bitte', 'jawohl', 'auf jeden',
  'auf jeden fall', 'unbedingt', 'perfekt',
  // English
  'yes', 'yeah', 'yep', 'yup', 'sure', 'okay', 'ok', 'please', 'please do',
  'go ahead', 'do it', 'show me', 'show it', "let's go", 'lets go', 'sounds good',
  'sound good', 'perfect', 'absolutely', 'definitely', 'go for it',
];

// If any of these appear, it is NOT a clean acceptance: an explicit refusal,
// or a redirect ("ja, aber zeig mir lieber X" → user is steering elsewhere).
const NEGATE_OR_REDIRECT =
  /\b(nein|nee|n[öo]|nope|no|not now|nicht jetzt|nicht|kein|keine|stop|stopp|abbrechen|cancel|sp[äa]ter|warte|aber|lieber|stattdessen|eigentlich|doch lieber|instead|rather)\b/;

const AFFIRM_RE = new RegExp(
  `(^|\\b)(${AFFIRM.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|')})(\\b|$)`,
  'i',
);

const WORD = /\S+/g;

/**
 * True when `text` is a clean affirmation accepting the prior offer.
 *
 * Guards (in order):
 *  - empty → false
 *  - contains a negation OR redirect word → false ("nein", "aber", "lieber")
 *  - longer than 6 words → false (a real sentence is a fresh request, not a
 *    bare "yes" — even if it contains "zeig mir")
 *  - contains an affirmation token as a whole word → true
 */
export function detectAcceptance(text: string | null | undefined): boolean {
  if (!text) return false;
  const norm = text.toLowerCase().replace(/[.!,;:¿?]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return false;
  if (NEGATE_OR_REDIRECT.test(norm)) return false;
  const wordCount = norm.match(WORD)?.length ?? 0;
  if (wordCount > 6) return false;
  return AFFIRM_RE.test(norm);
}

// ---------------------------------------------------------------------------
// Pending-CTA resolution (one-shot).
// ---------------------------------------------------------------------------

/** Indirection so the gate is unit-testable without a live Supabase chain. */
export interface AcceptanceGateDeps {
  readPendingCta: (userId: string, now: number) => Promise<PendingCtaValue | null>;
  clearPendingCta: (userId: string) => Promise<void>;
}

/** Real deps backed by orb_session_state. The reader already drops expired rows. */
export function makeSupabaseAcceptanceDeps(supabase: SupabaseClient): AcceptanceGateDeps {
  return {
    readPendingCta: async (userId, now) => {
      const rec = await readOrbSessionState<PendingCtaValue>(supabase, userId, 'pending_cta', now);
      const v = rec?.value;
      if (!v || typeof v.tool !== 'string' || v.tool.trim() === '') return null;
      return v;
    },
    clearPendingCta: async (userId) => {
      await clearOrbSessionState(supabase, userId, 'pending_cta');
    },
  };
}

export interface MaybeBindInput {
  /** The user's latest utterance / transcript for this turn. */
  userText: string | null | undefined;
  userId: string | null | undefined;
  now?: number;
}

/**
 * The keystone: if `userText` is an acceptance AND a live pending_cta exists,
 * return the exact stored action to execute (and consume it, so a second "ja"
 * can't re-fire). Otherwise null — the caller proceeds normally (LLM turn).
 *
 * Fails open: any error → null (never blocks the conversation).
 */
export async function maybeBindAcceptance(
  input: MaybeBindInput,
  deps: AcceptanceGateDeps,
): Promise<BoundAcceptance | null> {
  const { userText, userId } = input;
  if (!userId) return null;
  if (!detectAcceptance(userText)) return null;
  try {
    const cta = await deps.readPendingCta(userId, input.now ?? Date.now());
    if (!cta) return null;
    // One-shot: consume before returning so the acceptance can't double-execute
    // (e.g. user says "ja" twice while the action is already running).
    await deps.clearPendingCta(userId);
    return { tool: cta.tool, payload: cta.payload ?? {}, source: 'pending_cta' };
  } catch {
    return null;
  }
}
