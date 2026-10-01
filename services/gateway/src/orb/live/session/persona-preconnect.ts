/**
 * VTID-04549 — ORB latency G: pre-connect the specialist's Nova stream.
 *
 * Today a Vitana → Devon hand-off on Nova works like this:
 *   1. `report_to_specialist` / `switch_persona` QUEUES the swap
 *      (session.pendingPersonaSwap + the specialist's prompt override).
 *   2. Vitana speaks one bridge sentence.
 *   3. At turn complete the old stream is closed with reason `persona_swap`.
 *      `NovaSonicLiveClient.close()` waits up to 1 s for its response loop
 *      to drain, then its onClose runs attemptTransparentReconnect(), which
 *      runs the full connectToLiveAPI(): provider selection, envelope build,
 *      and a brand new Bedrock stream (sessionStart + chunked system prompt +
 *      tool catalog). Only then is the greeting nudge sent.
 *   That is several seconds of silence between the bridge and Devon.
 *
 * With `ORB_DEVON_PRECONNECT_ENABLED=true` the Bedrock stream for the
 * specialist is opened in the background at step 1, while Vitana is still
 * speaking the bridge. At step 3 the route claims it instead of connecting
 * fresh. Only the TIME at which Devon's stream is opened changes:
 *   - the envelope is built by the same builder the swap uses, and at claim
 *     time the route builds it again exactly as today's swap would and
 *     compares instruction, tool catalog and voice. Any difference → the
 *     pre-connected stream is closed and the normal connect runs;
 *   - the greeting nudge, the persona prompt, the voice, the tool list and
 *     every memory/ticket write are untouched (none of them live here).
 *
 * Scope: Nova sessions and specialist targets only. A swap BACK to Vitana is
 * not pre-connected: Vitana's instruction embeds the rolling transcript, so
 * the specialist's goodbye line (spoken after the swap is queued) always
 * changes it and the claim-time compare would always fail. The cascade swaps
 * persona in process and never reaches this module.
 *
 * Keep-alive: an unclaimed Nova stream is closed by Bedrock after ~15 s
 * without audio input ("Premature close", see nova-session-prewarm.ts and the
 * Nova keepalive comments in orb-live.ts). The pre-connected stream therefore
 * gets the same one-silence-frame-every-5 s keepalive the login prewarm uses
 * (VTID-03779, proven on staging), and its lifetime is bounded by a TTL
 * (default 60 s — a bridge sentence takes a few seconds). Opening it "late
 * enough" instead was rejected: the bridge length is not known in advance,
 * and a late open gives back most of the latency this exists to remove.
 *
 * This module holds only the lifecycle (start / check / claim / discard);
 * it never builds an envelope or opens a client itself — the route passes a
 * connect function that does both with its own builder.
 */

import { SILENCE_AUDIO_B64 } from '../../upstream/constants';
import type { UpstreamConnectionState } from '../upstream/types';

/** The persona that never gets pre-connected (see the header). Same literal
 *  as persona-registry's RECEPTIONIST_KEY; not imported to keep this module
 *  free of the registry's database dependencies. */
const RECEPTIONIST_PERSONA = 'vitana';

export const PERSONA_PRECONNECT_ENV = 'ORB_DEVON_PRECONNECT_ENABLED';

/** Exact string `'true'` enables — anything else (unset, 'TRUE', '1') is off,
 *  same activation convention as NOVA_SONIC_GLOBAL_ENABLED. */
export function isPersonaPreconnectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PERSONA_PRECONNECT_ENV] === 'true';
}

/** Well under Bedrock's ~15 s no-audio close; same cadence as the prewarm. */
export const PERSONA_PRECONNECT_KEEPALIVE_MS = 5_000;
/** How often the pending stream checks that it is still wanted. */
export const PERSONA_PRECONNECT_TICK_MS = 1_000;
/** Upper bound on an unclaimed pre-connected stream's lifetime. */
export const PERSONA_PRECONNECT_TTL_MS = 60_000;

/** The slice of a Nova client this module touches. */
export interface PreconnectClient {
  getState(): UpstreamConnectionState;
  sendAudioChunk(audioB64: string, mimeType?: string): boolean;
  close(reason?: string): Promise<void>;
}

export interface PreconnectedUpstream<C extends PreconnectClient = PreconnectClient> {
  client: C;
  /** Exact system instruction the stream was opened with (post-sanitize). */
  systemInstruction: string;
  /** Exact tool catalog the stream was opened with. */
  tools: Array<Record<string, unknown>>;
  /** Nova voice id the stream was opened with. */
  voiceId: string;
}

export type PendingPersonaUpstreamState = 'connecting' | 'ready' | 'failed' | 'closed';

export interface PendingPersonaUpstream<C extends PreconnectClient = PreconnectClient> {
  persona: string;
  /** Serialized session inputs the envelope depends on (personaPreconnectKey). */
  key: string;
  createdAt: number;
  state: PendingPersonaUpstreamState;
  result: PreconnectedUpstream<C> | null;
  failReason: string | null;
  /** Settles with the opened stream, or null when the connect failed. */
  ready: Promise<PreconnectedUpstream<C> | null>;
  timer: ReturnType<typeof setInterval> | null;
  /** Ticks since start — the keepalive frame goes out every Nth tick. */
  ticks: number;
  /** Set while the swap's connect is waiting to claim this stream. */
  claiming: boolean;
}

export type PreconnectDiag = (session: any, stage: string, extra?: Record<string, unknown>) => void;

export interface PersonaPreconnectDeps {
  emitDiag: PreconnectDiag;
  now?: () => number;
  ttlMs?: number;
  tickMs?: number;
  keepaliveMs?: number;
}

function pending(session: any): PendingPersonaUpstream | null {
  return (session?.pendingPersonaUpstream as PendingPersonaUpstream | undefined) ?? null;
}

/**
 * The session inputs the specialist's Nova envelope is computed from. Two
 * sessions with the same key build the same instruction and tool catalog;
 * the claim still compares the built envelope itself, this key only lets the
 * turn-complete decision be made synchronously.
 */
export function personaPreconnectKey(session: any, persona: string): string {
  const s = session ?? {};
  return JSON.stringify({
    persona,
    lang: s.lang ?? null,
    provider: s.upstreamProvider ?? null,
    user: s.identity?.user_id ?? null,
    tenant: s.identity?.tenant_id ?? null,
    anonymous: !!s.isAnonymous,
    route: s.current_route ?? null,
    mobile: !!s.clientContext?.isMobile,
    role: s.active_role ?? s.identity?.role ?? null,
    prompt: s.personaSystemOverride ?? null,
    voice: s.personaVoiceOverride ?? null,
    forced: s.personaForcedFirstMessage ?? null,
    firstDelivered: !!s.personaFirstUtteranceDelivered,
  });
}

/**
 * Which persona to pre-connect for right now, or null. Called after every
 * tool result on a Nova session; returns a persona only when a specialist
 * swap is queued and nothing matching is already pending.
 */
export function personaToPreconnect(session: any, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isPersonaPreconnectEnabled(env)) return null;
  if (!session?.active) return null;
  if (session.upstreamProvider !== 'nova_sonic') return null;
  const target = session.pendingPersonaSwap;
  if (typeof target !== 'string' || !target || target === RECEPTIONIST_PERSONA) return null;
  // The specialist envelope is the prompt override wholesale; without it the
  // swap would build Vitana's instruction, which is not pre-connectable.
  if (typeof session.personaSystemOverride !== 'string' || !session.personaSystemOverride) return null;
  const existing = pending(session);
  if (
    existing &&
    existing.persona === target &&
    existing.key === personaPreconnectKey(session, target) &&
    (existing.state === 'connecting' || existing.state === 'ready')
  ) {
    return null;
  }
  return target;
}

function stopTimer(entry: PendingPersonaUpstream): void {
  if (entry.timer) {
    clearInterval(entry.timer);
    entry.timer = null;
  }
}

/**
 * Close and forget the pending stream. `reason` is reported as
 * persona_preconnect_fallback (a pre-connect that was not used).
 */
export function discardPersonaPreconnect(session: any, reason: string, deps: PersonaPreconnectDeps): void {
  const entry = pending(session);
  if (!entry) return;
  session.pendingPersonaUpstream = null;
  stopTimer(entry);
  const wasOpen = entry.state === 'ready' || entry.state === 'connecting';
  entry.state = 'closed';
  deps.emitDiag(session, 'persona_preconnect_fallback', {
    reason,
    persona: entry.persona,
    age_ms: (deps.now ?? Date.now)() - entry.createdAt,
    was_open: wasOpen,
  });
  const client = entry.result?.client;
  if (client) {
    void client.close(`persona_preconnect_${reason}`).catch(() => { /* best-effort */ });
  }
  // A connect still in flight is closed when it lands (see startPersonaPreconnect).
}

/**
 * Start opening the specialist's stream in the background. Any previous
 * pending stream is discarded first. Never throws; a failed connect leaves a
 * `failed` entry the swap reads as "fall back to today's path".
 */
export function startPersonaPreconnect<C extends PreconnectClient>(
  session: any,
  persona: string,
  connect: () => Promise<PreconnectedUpstream<C>>,
  deps: PersonaPreconnectDeps,
): PendingPersonaUpstream<C> {
  if (pending(session)) discardPersonaPreconnect(session, 'superseded', deps);
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? PERSONA_PRECONNECT_TTL_MS;
  const tickMs = deps.tickMs ?? PERSONA_PRECONNECT_TICK_MS;
  const keepaliveEvery = Math.max(1, Math.round((deps.keepaliveMs ?? PERSONA_PRECONNECT_KEEPALIVE_MS) / tickMs));

  const entry: PendingPersonaUpstream<C> = {
    persona,
    key: personaPreconnectKey(session, persona),
    createdAt: now(),
    state: 'connecting',
    result: null,
    failReason: null,
    ready: Promise.resolve(null),
    timer: null,
    ticks: 0,
    claiming: false,
  };

  entry.ready = (async () => {
    try {
      const result = await connect();
      if (session.pendingPersonaUpstream !== entry || entry.state !== 'connecting') {
        // Discarded while connecting — the stream is not wanted any more.
        void result.client.close('persona_preconnect_discarded').catch(() => { /* best-effort */ });
        return null;
      }
      entry.result = result;
      entry.state = 'ready';
      return result;
    } catch (err) {
      entry.failReason = (err as Error)?.message ?? String(err);
      if (session.pendingPersonaUpstream === entry && entry.state === 'connecting') {
        entry.state = 'failed';
        console.warn(`[VTID-04549] pre-connect for ${persona} failed on ${session.sessionId}: ${entry.failReason}`);
      }
      return null;
    }
  })();

  entry.timer = setInterval(() => {
    if (session.pendingPersonaUpstream !== entry) {
      stopTimer(entry);
      return;
    }
    if (!session.active) {
      discardPersonaPreconnect(session, 'session_ended', deps);
      return;
    }
    // Swap no longer queued for this persona (cancelled or replaced) and the
    // turn-complete hand-over has not taken it.
    if (
      session.pendingPersonaSwap !== persona &&
      session._personaPreconnectClaimArmed !== true &&
      !entry.claiming
    ) {
      discardPersonaPreconnect(session, 'swap_cancelled', deps);
      return;
    }
    if (now() - entry.createdAt >= ttlMs) {
      discardPersonaPreconnect(session, 'expired', deps);
      return;
    }
    entry.ticks += 1;
    const client = entry.result?.client;
    if (entry.state === 'ready' && client && entry.ticks % keepaliveEvery === 0 && client.getState() === 'open') {
      try {
        client.sendAudioChunk(SILENCE_AUDIO_B64, 'audio/pcm;rate=16000');
      } catch {
        /* closing under us — the claim notices the state */
      }
    }
  }, tickMs);
  (entry.timer as any).unref?.();

  session.pendingPersonaUpstream = entry;
  console.log(`[VTID-04549] pre-connecting ${persona} for session ${session.sessionId}`);
  return entry;
}

export type PersonaPreconnectCheck = { ok: true } | { ok: false; reason: string };

/**
 * Synchronous turn-complete decision: may the swap to `persona` take the
 * pre-connected path? A connect still in flight counts (the claim waits for
 * it); a failed or closed one does not.
 */
export function checkPersonaPreconnectForSwap(
  session: any,
  persona: string,
  env: NodeJS.ProcessEnv = process.env,
): PersonaPreconnectCheck {
  if (!isPersonaPreconnectEnabled(env)) return { ok: false, reason: 'disabled' };
  if (!persona || persona === RECEPTIONIST_PERSONA) return { ok: false, reason: 'target_not_specialist' };
  if (session?.upstreamProvider !== 'nova_sonic') return { ok: false, reason: 'not_nova' };
  const entry = pending(session);
  if (!entry) return { ok: false, reason: 'no_preconnect' };
  if (entry.persona !== persona) return { ok: false, reason: 'persona_mismatch' };
  if (entry.state === 'failed') return { ok: false, reason: 'connect_failed' };
  if (entry.state === 'closed') return { ok: false, reason: 'preconnect_closed' };
  if (entry.state === 'ready' && entry.result?.client.getState() !== 'open') {
    return { ok: false, reason: 'preconnect_closed' };
  }
  if (entry.key !== personaPreconnectKey(session, persona)) return { ok: false, reason: 'session_changed' };
  return { ok: true };
}

/** Compare the pre-connected envelope with the one the swap just built. */
export function comparePreconnectedEnvelope(
  preconnected: Pick<PreconnectedUpstream, 'systemInstruction' | 'tools' | 'voiceId'>,
  fresh: Pick<PreconnectedUpstream, 'systemInstruction' | 'tools' | 'voiceId'>,
): string | null {
  if (preconnected.voiceId !== fresh.voiceId) return 'voice_mismatch';
  if (preconnected.systemInstruction !== fresh.systemInstruction) return 'instruction_mismatch';
  if (JSON.stringify(preconnected.tools) !== JSON.stringify(fresh.tools)) return 'tools_mismatch';
  return null;
}

/**
 * Claim the pre-connected stream for the swap now being connected. Returns
 * the client only when the turn-complete hand-over armed the claim, the
 * connect succeeded and the envelope is byte-identical to `fresh` (what the
 * swap would send today). Otherwise the pending stream is closed and null is
 * returned — the caller connects fresh, exactly as today.
 *
 * A reconnect that was not armed by the hand-over (a Nova retry, a rotation)
 * never claims and never disturbs the pending stream.
 */
export async function claimPersonaPreconnect<C extends PreconnectClient>(
  session: any,
  fresh: { persona: string } & Pick<PreconnectedUpstream, 'systemInstruction' | 'tools' | 'voiceId'>,
  deps: PersonaPreconnectDeps,
): Promise<C | null> {
  if (session?._personaPreconnectClaimArmed !== true) return null;
  session._personaPreconnectClaimArmed = false;
  const entry = pending(session) as PendingPersonaUpstream<C> | null;
  if (!entry) {
    deps.emitDiag(session, 'persona_preconnect_fallback', { reason: 'no_preconnect', persona: fresh.persona });
    return null;
  }
  if (entry.persona !== fresh.persona) {
    discardPersonaPreconnect(session, 'persona_mismatch', deps);
    return null;
  }
  const now = deps.now ?? Date.now;
  const waitStart = now();
  entry.claiming = true;
  const result = await entry.ready;
  const waitedMs = now() - waitStart;
  if (pending(session) !== entry) {
    // Discarded while we waited (session ended, expired).
    return null;
  }
  if (!result) {
    discardPersonaPreconnect(session, 'connect_failed', deps);
    return null;
  }
  if (result.client.getState() !== 'open') {
    discardPersonaPreconnect(session, 'preconnect_closed', deps);
    return null;
  }
  const mismatch = comparePreconnectedEnvelope(result, fresh);
  if (mismatch) {
    discardPersonaPreconnect(session, mismatch, deps);
    return null;
  }
  session.pendingPersonaUpstream = null;
  stopTimer(entry);
  entry.state = 'closed';
  deps.emitDiag(session, 'persona_preconnect_used', {
    persona: entry.persona,
    age_ms: now() - entry.createdAt,
    waited_ms: waitedMs,
    instruction_chars: result.systemInstruction.length,
    tool_entry_count: result.tools.length,
    voice: result.voiceId,
  });
  return result.client;
}

/** The handler-registration slice of an upstream client. */
export interface RetirableClient {
  onAudioOutput(h: (e: any) => void): void;
  onTranscript(h: (e: any) => void): void;
  onToolCall(h: (e: any) => void): void;
  onTurnComplete(h: (e: any) => void): void;
  onInterrupted(h: (e: any) => void): void;
  onUsage?(h: (e: any) => void): void;
  onError(h: (e: any) => void): void;
  onClose(h: (e: any) => void): void;
  close(reason?: string): Promise<void>;
}

/**
 * Detach every session handler from the outgoing stream and close it in the
 * background. After this nothing the old stream emits — audio, transcript, a
 * tool call, its close — reaches the session; `onClosed` is told about the
 * close for diagnostics only.
 */
export function retireSupersededClient(
  client: RetirableClient,
  reason: string,
  onClosed: (event: { reason?: string | null; initiatedLocally?: boolean }) => void,
): void {
  const noop = () => { /* superseded stream — ignored */ };
  client.onAudioOutput(noop);
  client.onTranscript(noop);
  client.onToolCall(noop);
  client.onTurnComplete(noop);
  client.onInterrupted(noop);
  client.onUsage?.(noop);
  client.onError(noop);
  client.onClose((event) => {
    try { onClosed(event ?? {}); } catch { /* diagnostics only */ }
  });
  void client.close(reason).catch(() => { /* best-effort */ });
}

export interface PersonaSwapTakeoverArgs {
  session: any;
  persona: string;
  /** The stream the current persona is speaking on. */
  oldClient: RetirableClient;
  emitDiag: PreconnectDiag;
  /** Stops the silence keepalive feeding the old stream. */
  clearKeepalive: (session: any) => void;
  /** Today's transparent reconnect (its connect claims the pre-connect). */
  reconnect: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Turn complete with a persona swap queued (activePersona already set to the
 * target, `_personaSwapInFlight` already true — exactly as today). Returns
 * false when there is no usable pre-connected stream; the caller then closes
 * the upstream exactly as before. Returns true after:
 *   1. arming the claim for the swap's connect,
 *   2. retiring the old stream — handlers detached so nothing it still emits
 *      reaches the session, keepalive stopped, closed in the background (its
 *      1 s drain no longer precedes the new stream),
 *   3. running today's transparent reconnect, whose connect builds the
 *      envelope exactly as today, claims the pre-connected stream only when
 *      it is byte-identical, and sends today's greeting nudge.
 * The bookkeeping after the reconnect mirrors the persona-swap branch of the
 * Nova onClose handler this path replaces.
 */
export function takeOverPersonaSwapWithPreconnect(args: PersonaSwapTakeoverArgs): boolean {
  const { session, persona, oldClient, emitDiag, clearKeepalive, reconnect } = args;
  const env = args.env ?? process.env;
  if (!isPersonaPreconnectEnabled(env)) return false;
  const check: PersonaPreconnectCheck = session?._novaRotationInFlight === true
    ? { ok: false, reason: 'rotation_in_flight' }
    : checkPersonaPreconnectForSwap(session, persona, env);
  if (!check.ok) {
    if (pending(session)) {
      discardPersonaPreconnect(session, check.reason, { emitDiag });
    } else {
      emitDiag(session, 'persona_preconnect_fallback', { reason: check.reason, persona });
    }
    return false;
  }

  session._personaPreconnectClaimArmed = true;
  clearKeepalive(session);
  if (session.upstreamClient === oldClient) {
    session.upstreamClient = null;
  }
  retireSupersededClient(oldClient, 'persona_swap', (closeEvent) => {
    emitDiag(session, 'upstream_closed', {
      provider: 'nova_sonic',
      reason: closeEvent.reason ?? null,
      initiated_locally: closeEvent.initiatedLocally,
      superseded_by_preconnect: true,
    });
  });

  let reconnecting: Promise<boolean>;
  try {
    reconnecting = reconnect();
  } catch (err) {
    reconnecting = Promise.reject(err);
  }
  void reconnecting
    .then((ok) => {
      session._personaSwapInFlight = false;
      if (!ok) console.warn(`[VTID-04549] persona-swap reconnect to ${persona} failed`);
    })
    .catch((err) => {
      session._personaSwapInFlight = false;
      console.warn(`[VTID-04549] persona-swap reconnect to ${persona} failed: ${(err as Error)?.message ?? String(err)}`);
    })
    .finally(() => {
      session._personaPreconnectClaimArmed = false;
      // The connect never reached the claim (reconnect cap, provider
      // changed, session ended) — close what was opened.
      if (pending(session)) discardPersonaPreconnect(session, 'not_claimed', { emitDiag });
    });
  return true;
}

/**
 * After a tool result: start pre-connecting when a specialist swap has just
 * been queued. No-op with the flag off.
 */
export function maybeStartPersonaPreconnect<C extends PreconnectClient>(
  session: any,
  connect: (persona: string) => Promise<PreconnectedUpstream<C>>,
  deps: PersonaPreconnectDeps,
  env: NodeJS.ProcessEnv = process.env,
): PendingPersonaUpstream<C> | null {
  const persona = personaToPreconnect(session, env);
  if (!persona) return null;
  return startPersonaPreconnect(session, persona, () => connect(persona), deps);
}
