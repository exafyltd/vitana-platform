/**
 * VTID-04702: save first, then answer.
 *
 * Live B-PROF-01 (staging, 2026-09-28): the member said "Merk dir bitte, mein
 * Geburtstag ist der neunte September 1969". Nova answered "Ich habe dein
 * Geburtsdatum notiert" without calling any tool — the member heard a save
 * that never happened. The turn_complete backstop then ran the save logic
 * (a birthday belongs in the profile) and Vitana corrected herself, but the
 * false sentence had already played.
 *
 * Nova writes the reply itself; the gateway only forwards its audio to the
 * member. The member's words reach the gateway before Nova's first audio
 * (B-PROF-01: 14:44:09.5 transcript, 14:44:15.2 first audio), so the gateway
 * holds the reply of a remember turn back:
 *
 *   - armed when the member asks Vitana to remember something, or when the
 *     reply text (which runs ahead of the audio) claims a save while no
 *     remember/forget tool has been called;
 *   - while armed, the reply's audio and text are buffered, not forwarded;
 *   - Nova called remember_fact/forget_fact → the save ran; the held reply is
 *     released once the tool result is sent;
 *   - no tool call → at turn_complete the backstop does the save and tells
 *     Nova the result; its next reply is the one the member hears, and the
 *     held one is dropped;
 *   - the backstop did not run, found nothing, or took too long → the held
 *     reply is released, late rather than never. A remember turn never ends
 *     in silence.
 *
 * Nova only (the one provider the backstop covers). `ORB_REMEMBER_HOLD_ENABLED=false`
 * turns it off.
 */

import { writeSseEvent } from '../transport/sse-handler';
import { detectRememberClaim, detectRememberIntent, REMEMBER_BACKSTOP_MARKER } from '../../../services/memory/remember-backstop';

export interface RememberHold {
  reason: 'remember_request' | 'save_claim';
  armedAt: number;
  audio: Array<{ dataB64: string; mimeType?: string }>;
  text: string[];
}

type EmitDiag = (session: any, stage: string, payload?: Record<string, unknown>) => void;

export interface RememberHoldCtx {
  session: any;
  callbacks: { onAudioResponse: (audioB64: string, mimeType?: string) => void };
  deps: { emitDiag: EmitDiag };
}

/** Held audio beyond this is released: nothing may hang a reply indefinitely. */
export const REMEMBER_HOLD_MAX_MS = 15_000;
/** How long turn_complete waits for the backstop before releasing the reply. */
export const REMEMBER_HOLD_BACKSTOP_WAIT_MS = 6_000;

export function isRememberHoldEnabled(): boolean {
  return (process.env.ORB_REMEMBER_HOLD_ENABLED ?? 'true') !== 'false';
}

function eligible(session: any): boolean {
  return (
    isRememberHoldEnabled() &&
    session?.upstreamProvider === 'nova_sonic' &&
    Boolean(session?.identity?.user_id && session?.identity?.tenant_id) &&
    session.memoryWriteToolCalledThisTurn !== true
  );
}

function arm(ctx: RememberHoldCtx, reason: RememberHold['reason']): void {
  const { session } = ctx;
  if (session.rememberHold) return;
  session.rememberHold = { reason, armedAt: Date.now(), audio: [], text: [] } as RememberHold;
  ctx.deps.emitDiag(session, 'remember_hold_armed', { reason });
}

/** Member speech arrived: arm when the turn so far asks Vitana to remember something. */
export function maybeArmOnMemberSpeech(ctx: RememberHoldCtx): void {
  const { session } = ctx;
  if (!eligible(session)) return;
  const said = String(session.inputTranscriptBuffer || '');
  if (!said || said.trimStart().startsWith(REMEMBER_BACKSTOP_MARKER)) return;
  if (detectRememberIntent(said)) arm(ctx, 'remember_request');
}

/** Reply text arrived: arm when it claims a save and no remember tool was called. */
export function maybeArmOnReplyText(ctx: RememberHoldCtx): void {
  const { session } = ctx;
  if (session.rememberHold || !eligible(session)) return;
  const said = String(session.inputTranscriptBuffer || '');
  if (!said || said.trimStart().startsWith(REMEMBER_BACKSTOP_MARKER)) return;
  if (detectRememberClaim(String(session.outputTranscriptBuffer || ''))) arm(ctx, 'save_claim');
}

/** Buffer an audio chunk while armed. Returns true when the chunk was held. */
export function holdAudio(ctx: RememberHoldCtx, dataB64: string, mimeType?: string): boolean {
  const hold = ctx.session.rememberHold as RememberHold | undefined;
  if (!hold) return false;
  if (Date.now() - hold.armedAt > REMEMBER_HOLD_MAX_MS) {
    releaseRememberHold(ctx, 'max_hold');
    return false;
  }
  hold.audio.push({ dataB64, mimeType });
  return true;
}

/** Buffer reply text while armed. Returns true when the text was held. */
export function holdText(ctx: RememberHoldCtx, text: string): boolean {
  const hold = ctx.session.rememberHold as RememberHold | undefined;
  if (!hold) return false;
  hold.text.push(text);
  return true;
}

function flush(ctx: RememberHoldCtx, hold: RememberHold): void {
  const { session } = ctx;
  for (const t of hold.text) {
    if (session.sseResponse) writeSseEvent(session.sseResponse, { type: 'output_transcript', text: t });
  }
  for (const a of hold.audio) ctx.callbacks.onAudioResponse(a.dataB64, a.mimeType);
}

/** Forward what was held and stop holding (the save ran, or it will not run). */
export function releaseRememberHold(ctx: RememberHoldCtx, outcome: string): void {
  const hold = ctx.session.rememberHold as RememberHold | undefined;
  if (!hold) return;
  ctx.session.rememberHold = undefined;
  flush(ctx, hold);
  ctx.deps.emitDiag(ctx.session, 'remember_hold_released', {
    reason: hold.reason,
    outcome,
    audio_chunks: hold.audio.length,
    held_ms: Date.now() - hold.armedAt,
  });
}

/** Stop holding without forwarding: a corrected reply replaces the held one. */
export function dropRememberHold(ctx: RememberHoldCtx, hold: RememberHold, outcome: string): void {
  ctx.deps.emitDiag(ctx.session, 'remember_hold_dropped', {
    reason: hold.reason,
    outcome,
    audio_chunks: hold.audio.length,
    held_ms: Date.now() - hold.armedAt,
  });
}

/**
 * turn_complete: detach the hold so the next turn (the corrected reply) is
 * forwarded live, then decide what the member hears once the backstop is done.
 */
export function takeRememberHold(session: any): RememberHold | undefined {
  const hold = session.rememberHold as RememberHold | undefined;
  session.rememberHold = undefined;
  // Read by the backstop note built during this same turn_complete.
  session.rememberReplyHeld = Boolean(hold);
  return hold;
}

export async function settleRememberHold(
  ctx: RememberHoldCtx,
  hold: RememberHold | undefined,
  backstop: Promise<unknown[]> | null,
  waitMs = REMEMBER_HOLD_BACKSTOP_WAIT_MS,
): Promise<'dropped' | 'released' | 'none'> {
  if (!hold) return 'none';
  const restore = () => {
    // Forward what was held on its own, even if a new hold armed meanwhile.
    const current = ctx.session.rememberHold;
    ctx.session.rememberHold = hold;
    releaseRememberHold(ctx, 'backstop_did_not_answer');
    ctx.session.rememberHold = current;
  };
  if (!backstop) {
    restore();
    return 'released';
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), waitMs);
  });
  const results = await Promise.race([backstop.catch(() => [] as unknown[]), timeout]);
  if (timer) clearTimeout(timer);
  const noteSentAt = Number(ctx.session.rememberNoteSentAt || 0);
  if (results !== 'timeout' && noteSentAt >= hold.armedAt) {
    // The backstop saved (or refused) and told Nova; the next reply says so.
    dropRememberHold(ctx, hold, 'backstop_answered');
    return 'dropped';
  }
  restore();
  return 'released';
}
