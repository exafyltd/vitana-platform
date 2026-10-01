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
  writeOrbSessionState,
} from '../orb/orb-session-state';
import {
  detectDecline,
  defaultEmitOfferEvent,
  emitOfferEventSafely,
  markAwaitingModelRun,
  forgetAwaitingOffer,
  type EmitOfferEventFn,
  type PendingOffer,
} from './offer-outcomes';

/**
 * The shape stored under orb_session_state.key='pending_cta'. Written only
 * through recordPendingOffer() (VTID-04355), which adds offer_id/source/key.
 */
export type PendingCtaValue = PendingOffer;

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
// Which offers the gate runs itself (VTID-04355).
// ---------------------------------------------------------------------------

/**
 * True when the gate itself can execute this offer on a bare "yes".
 *
 * Only a well-formed navigate_to_screen qualifies: both turn-loop call sites
 * dispatch nothing else. Every other offer (activate_recommendation, a tool
 * recorded via offer_action, …) is left in orb_session_state for the model's
 * own tool call and for the tools that read pending_cta as their fallback —
 * consuming it here and then doing nothing is exactly how an accepted
 * non-navigation offer used to vanish.
 */
export function isAutoRunnableOffer(cta: { tool?: unknown; payload?: unknown } | null | undefined): boolean {
  if (!cta || cta.tool !== 'navigate_to_screen') return false;
  const p = (cta.payload ?? {}) as { screen_id?: unknown; route?: unknown };
  return typeof p.screen_id === 'string' && p.screen_id.trim() !== '' &&
    typeof p.route === 'string' && p.route.trim() !== '';
}

// ---------------------------------------------------------------------------
// Pending-CTA resolution (one-shot).
// ---------------------------------------------------------------------------

/** Indirection so the gate is unit-testable without a live Supabase chain. */
export interface AcceptanceGateDeps {
  readPendingCta: (userId: string, now: number) => Promise<PendingCtaValue | null>;
  clearPendingCta: (userId: string) => Promise<void>;
  /**
   * VTID-04355: record that an offer the model runs itself was accepted, so a
   * second "ja" neither re-counts it nor re-fires. Optional for older callers.
   */
  markAccepted?: (userId: string, cta: PendingCtaValue, now: number) => Promise<void>;
  /** VTID-04355: outcome events. Optional; absent means no events. */
  emitOutcome?: EmitOfferEventFn;
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
    markAccepted: async (userId, cta, now) => {
      markAwaitingModelRun(userId, cta, now);
      // Short TTL: long enough for the model's tool call in the same turn.
      await writeOrbSessionState(supabase, userId, 'pending_cta', { ...cta, accepted_at: new Date(now).toISOString() }, 5, now);
    },
    emitOutcome: defaultEmitOfferEvent,
  };
}

export interface MaybeBindInput {
  /** The user's latest utterance / transcript for this turn. */
  userText: string | null | undefined;
  userId: string | null | undefined;
  now?: number;
}

/**
 * The keystone: if `userText` is an acceptance AND a live pending_cta exists
 * that the gate can run itself (isAutoRunnableOffer), return the exact stored
 * action to execute (and consume it, so a second "ja" can't re-fire).
 * Otherwise null and the offer is left untouched — the caller proceeds
 * normally (LLM turn), and the model runs a non-navigation offer itself.
 *
 * Fails open: any error → null (never blocks the conversation).
 */
export async function maybeBindAcceptance(
  input: MaybeBindInput,
  deps: AcceptanceGateDeps,
): Promise<BoundAcceptance | null> {
  const { userText, userId } = input;
  if (!userId) return null;
  const accepted = detectAcceptance(userText);
  // detectAcceptance() already refuses anything with a refusal word, so the
  // two never both fire on one utterance.
  const declined = !accepted && detectDecline(userText);
  if (!accepted && !declined) return null;
  const now = input.now ?? Date.now();
  try {
    const cta = await deps.readPendingCta(userId, now);
    if (!cta) return null;

    if (declined) {
      // VTID-04355: a "no" ends the offer now instead of leaving it live for
      // its whole TTL, where a later unrelated "ja" could still fire it.
      await deps.clearPendingCta(userId);
      forgetAwaitingOffer(userId);
      if (deps.emitOutcome) emitOfferEventSafely(deps.emitOutcome, 'declined', userId, cta);
      return null;
    }

    // Already accepted (the model is running it): a second "ja" is not a new
    // acceptance and must not re-count or re-fire.
    if (cta.accepted_at) return null;

    const autoRuns = isAutoRunnableOffer(cta);
    if (deps.emitOutcome) emitOfferEventSafely(deps.emitOutcome, 'accepted', userId, cta, { auto_runs: autoRuns });

    // VTID-04355: never consume an offer the gate will not run. The model runs
    // it; the offer is cleared after that tool succeeds
    // (settleOfferOnToolSuccess), or expires.
    if (!autoRuns) {
      if (deps.markAccepted) await deps.markAccepted(userId, cta, now);
      return null;
    }
    // One-shot: consume before returning so the acceptance can't double-execute
    // (e.g. user says "ja" twice while the action is already running).
    await deps.clearPendingCta(userId);
    return { tool: cta.tool, payload: cta.payload ?? {}, source: 'pending_cta' };
  } catch {
    return null;
  }
}
