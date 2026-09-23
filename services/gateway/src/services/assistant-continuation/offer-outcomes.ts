/**
 * VTID-04355 (WS-0.5) — one lifecycle for every action Vitana offers.
 *
 * Four places store a `pending_cta` (offer_action, the two navigator offer
 * branches, the wake brief's onYesTool). Before this module each wrote the row
 * directly, so nothing recorded that an offer was made, a replaced offer
 * vanished without a trace, and a "no" left the offer live for its whole TTL.
 *
 * Lifecycle, every step an OASIS event carrying offer_id, source, key and tool:
 *
 *   recordPendingOffer()    → conversation.offer.made
 *                             (+ conversation.offer.ignored for a still-open
 *                              offer it replaces)
 *   acceptance gate, "yes"  → conversation.offer.accepted (exactly once)
 *   acceptance gate, "no"   → conversation.offer.declined, offer cleared
 *
 * An offer that simply expires unanswered produces no event of its own; the
 * metrics rollup counts it as ignored (made minus accepted/declined/ignored).
 *
 * Clearing: the gate clears an offer it runs itself before dispatching it (the
 * one-shot guard against a second "ja"). An offer the MODEL runs is marked
 * accepted and cleared only after the offered tool succeeds
 * (settleOfferOnToolSuccess), so a failed call keeps it for a retry.
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export type OfferSource = 'offer_action' | 'navigator_ambiguous' | 'navigator_reopened' | 'wake_brief';
export type OfferOutcome = 'made' | 'accepted' | 'declined' | 'ignored';

/** Stored under orb_session_state.key='pending_cta'. Older rows lack the ids. */
export interface PendingOffer {
  tool: string;
  payload?: Record<string, unknown>;
  offered_at?: string;
  offer_id?: string;
  source?: OfferSource | string;
  /** The provider that produced the offer (continuation kind for the wake brief). */
  provider?: string | null;
  key?: string | null;
  accepted_at?: string;
}

export interface OfferEventDetail {
  auto_runs?: boolean;
  reason?: string;
  replaced_by?: string;
}

export type EmitOfferEventFn = (
  outcome: OfferOutcome,
  userId: string,
  offer: PendingOffer,
  detail?: OfferEventDetail,
) => Promise<unknown>;

export const defaultEmitOfferEvent: EmitOfferEventFn = async (outcome, userId, offer, detail = {}) => {
  const { emitOasisEvent } = await import('../oasis-event-service');
  return emitOasisEvent({
    vtid: 'VTID-04355',
    type: `conversation.offer.${outcome}` as 'conversation.offer.accepted',
    source: 'orb-offer',
    status: 'info',
    message: `offer ${outcome}: ${offer.tool}`,
    payload: {
      offer_id: offer.offer_id ?? null,
      source: offer.source ?? 'unknown',
      provider: offer.provider ?? offer.source ?? 'unknown',
      key: offer.key ?? null,
      tool: offer.tool,
      offered_at: offer.offered_at ?? null,
      ...detail,
    },
    actor_id: userId,
    actor_role: 'user',
    surface: 'orb',
  });
};

/** Fire-and-forget emit: an event failure never touches the conversation. */
export function emitOfferEventSafely(
  emit: EmitOfferEventFn,
  outcome: OfferOutcome,
  userId: string,
  offer: PendingOffer,
  detail?: OfferEventDetail,
): void {
  try {
    void Promise.resolve(emit(outcome, userId, offer, detail)).catch((err) =>
      console.warn(`[VTID-04355] offer ${outcome} event failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  } catch (err) {
    console.warn(`[VTID-04355] offer ${outcome} event failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Decline detection — the counterpart of detectAcceptance().
// ---------------------------------------------------------------------------

// Space-delimited, not \b: \b does not treat umlauts as word characters, so
// "nö" or "überspringen" would never match a \b-bounded pattern.
const DECLINE_RE =
  /(?:^| )(nein|nee|nö|no|nope|nah|nicht jetzt|not now|lieber nicht|rather not|später|later|kein bedarf|keine lust|no thanks|nein danke|nicht nötig|not needed|skip|überspring\S*)(?= |$)/;

/**
 * True when `text` is a short refusal of the prior offer ("nein", "nicht
 * jetzt", "no thanks", "später"). A longer sentence is a fresh request, not a
 * reply to the offer, and is left alone — the same length rule as
 * detectAcceptance(). "zeig mir lieber X" carries no refusal word and is not a
 * decline: it is a redirect the model handles.
 */
export function detectDecline(text: string | null | undefined): boolean {
  if (!text) return false;
  const norm = text.toLowerCase().replace(/[.!,;:¿?]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return false;
  if ((norm.match(/\S+/g)?.length ?? 0) > 6) return false;
  return DECLINE_RE.test(norm);
}

// ---------------------------------------------------------------------------
// Producing an offer.
// ---------------------------------------------------------------------------

export interface RecordPendingOfferInput {
  tool: string;
  payload?: Record<string, unknown>;
  source: OfferSource;
  provider?: string | null;
  key?: string | null;
  ttlMinutes: number;
}

export interface RecordPendingOfferDeps {
  read?: (sb: SupabaseClient, userId: string) => Promise<PendingOffer | null>;
  write?: (sb: SupabaseClient, userId: string, value: PendingOffer, ttlMinutes: number) => Promise<{ ok: boolean; reason?: string }>;
  emit?: EmitOfferEventFn;
  now?: () => Date;
  newId?: () => string;
}

async function defaultReadOffer(sb: SupabaseClient, userId: string): Promise<PendingOffer | null> {
  const { readOrbSessionState } = await import('../orb/orb-session-state');
  const rec = await readOrbSessionState<PendingOffer>(sb, userId, 'pending_cta');
  const v = rec?.value;
  return v && typeof v.tool === 'string' && v.tool.trim() ? v : null;
}

async function defaultWriteOffer(sb: SupabaseClient, userId: string, value: PendingOffer, ttl: number) {
  const { writeOrbSessionState } = await import('../orb/orb-session-state');
  return writeOrbSessionState(sb, userId, 'pending_cta', value, ttl);
}

/**
 * The single writer for pending_cta. Never throws; returns ok=false with the
 * storage reason on a failed write (callers decide whether that is fatal).
 */
export async function recordPendingOffer(
  sb: SupabaseClient,
  userId: string,
  input: RecordPendingOfferInput,
  deps: RecordPendingOfferDeps = {},
): Promise<{ ok: boolean; reason?: string; offer?: PendingOffer }> {
  if (!userId) return { ok: false, reason: 'missing_user' };
  const emit = deps.emit ?? defaultEmitOfferEvent;
  const offer: PendingOffer = {
    tool: input.tool,
    payload: input.payload ?? {},
    offered_at: (deps.now ?? (() => new Date()))().toISOString(),
    offer_id: (deps.newId ?? randomUUID)(),
    source: input.source,
    provider: input.provider ?? input.source,
    key: input.key ?? null,
  };

  let previous: PendingOffer | null = null;
  try {
    previous = await (deps.read ?? defaultReadOffer)(sb, userId);
  } catch {
    previous = null; // the replaced-offer event is best-effort
  }

  let res: { ok: boolean; reason?: string };
  try {
    res = await (deps.write ?? defaultWriteOffer)(sb, userId, offer, input.ttlMinutes);
  } catch (err) {
    res = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { ok: false, reason: res.reason ?? 'write_failed' };

  forgetAwaitingOffer(userId);
  // A still-open offer that was never answered is replaced now: that is its
  // outcome. One already accepted has had its outcome and is not re-counted.
  if (previous && !previous.accepted_at) {
    emitOfferEventSafely(emit, 'ignored', userId, previous, { reason: 'replaced', replaced_by: offer.offer_id });
  }
  emitOfferEventSafely(emit, 'made', userId, offer);
  return { ok: true, offer };
}

// ---------------------------------------------------------------------------
// Offers the model runs itself: clear only after the tool succeeds.
// ---------------------------------------------------------------------------

/**
 * userId → the accepted offer the model is expected to run. In-process on
 * purpose: the gate and the tool dispatch for one live session run in the same
 * gateway process, and this avoids a Supabase read on every tool call.
 */
const awaitingModelRun = new Map<string, { tool: string; offer_id: string | null; at: number }>();
const AWAITING_TTL_MS = 10 * 60_000;

export function markAwaitingModelRun(userId: string, offer: PendingOffer, nowMs: number = Date.now()): void {
  if (!userId) return;
  awaitingModelRun.set(userId, { tool: offer.tool, offer_id: offer.offer_id ?? null, at: nowMs });
}

export function forgetAwaitingOffer(userId: string): void {
  awaitingModelRun.delete(userId);
}

export function getAwaitingOffer(userId: string, nowMs: number = Date.now()) {
  const e = awaitingModelRun.get(userId);
  if (!e) return null;
  if (nowMs - e.at > AWAITING_TTL_MS) {
    awaitingModelRun.delete(userId);
    return null;
  }
  return e;
}

/**
 * Called after a tool call returns ok. When it is the accepted offer the model
 * was expected to run, the stored offer is cleared now — not before, so a
 * failed call leaves it in place for the user's retry.
 */
export async function settleOfferOnToolSuccess(
  sb: SupabaseClient | null | undefined,
  userId: string | null | undefined,
  toolName: string,
  deps: { clear?: (sb: SupabaseClient, userId: string) => Promise<unknown>; nowMs?: number } = {},
): Promise<boolean> {
  if (!sb || !userId) return false;
  const e = getAwaitingOffer(userId, deps.nowMs);
  if (!e || e.tool !== toolName) return false;
  awaitingModelRun.delete(userId);
  try {
    if (deps.clear) await deps.clear(sb, userId);
    else {
      const { clearOrbSessionState } = await import('../orb/orb-session-state');
      await clearOrbSessionState(sb, userId, 'pending_cta');
    }
  } catch {
    /* the offer then expires on its own TTL */
  }
  return true;
}

export function __resetOfferOutcomesForTest(): void {
  awaitingModelRun.clear();
}
