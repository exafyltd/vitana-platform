/**
 * VTID-03706 — ORB full-duplex voice: the mic stays open while Vitana speaks.
 *
 * WHAT WAS WRONG
 * --------------
 * Barge-in shipped (BOOTSTRAP-ORB-BARGEIN) but was built inside-out: the mic
 * was gated SHUT while the model spoke, in two independent places, and only a
 * loudness heuristic could re-open it.
 *
 *   1. Client (`orb-widget.js` `_startAudioCapture`): frames captured during
 *      playback went into an 8-frame ring buffer and `return`ed — never sent.
 *      Only RMS > 0.06 sustained for 6 consecutive frames (~384 ms) flushed
 *      the buffer and fired an `interrupt`.
 *   2. Server (`orb-live.ts` `handleWsAudioMessage`, and its SSE mirror in
 *      `live-session-controller.ts`): `if (session.isModelSpeaking) return;`
 *      hard-dropped every mic chunk.
 *
 * The consequence that matters: Nova Sonic handles barge-in natively —
 * it stops generating, switches to listening, and emits
 * `contentEnd.stopReason: "INTERRUPTED"`, which `nova-sonic-protocol.ts`
 * already normalizes to `{kind:'interrupted'}`. That path has never once
 * fired in production, because gate (2) meant Nova received literally no
 * audio during its own turn. Nova's `endpointingSensitivity` was configured
 * against a stream that was silent by construction.
 *
 * Two user-visible failures fell out of that:
 *   - Anything quieter than 0.06 RMS could never interrupt. "Nein", "warte",
 *     "stopp", a normal-volume question — discarded, permanently.
 *   - ~384 ms of confirmation before anything happened, plus an
 *     interrupt/ack round trip. Industry target for barge-in stop latency
 *     is under 200 ms.
 *
 * WHY THE GATES EXISTED (and why "just always forward the mic" is not enough)
 * --------------------------------------------------------------------------
 * This is not cargo-culted defensiveness — the widget carries MEASURED
 * evidence. Speaker output leaking back through the mic survives browser AEC
 * at roughly 0.01-0.04 RMS, against 0.1-0.3 for real speech. A previous
 * threshold of 0.015 "triggered on echo, causing constant interruptions" —
 * Nova interrupting ITSELF in a loop. Forwarding every raw frame during
 * playback feeds that residue straight to Nova's server-side VAD and
 * reproduces exactly that regression.
 *
 * THE FIX: a noise gate, not a shutter
 * ------------------------------------
 * The mic stream never stops and a frame is emitted for every capture
 * callback, unconditionally. What changes is the CONTENT of frames captured
 * while the model is speaking:
 *
 *   - below the echo floor  -> transmitted as digital silence
 *   - above the echo floor  -> transmitted verbatim, from the first syllable
 *
 * That gives all three properties at once:
 *   - Nova receives a continuous, correctly-timed stream, so its turn
 *     detection state machine keeps ticking and its native barge-in can
 *     finally engage.
 *   - AEC residue is zeroed rather than forwarded, so Nova cannot
 *     self-interrupt — the regression the old gate was protecting against.
 *   - Real speech reaches Nova with ZERO confirmation delay and zero
 *     reconstruction gymnastics. The pre-roll ring buffer that existed only
 *     to un-destroy the first 384 ms becomes unnecessary and is deleted.
 *
 * Hysteresis (open high, close low, plus a hangover) keeps the gate from
 * chattering mid-utterance and lets trailing quiet syllables through — a
 * single threshold would clip the tail of every sentence.
 *
 * DUAL SIGNAL, DIFFERENT JOBS
 * ---------------------------
 * Nova's `INTERRUPTED` event is the AUTHORITY on whether the turn yielded.
 * The client's own gate-open detection is a LATENCY optimization: it stops
 * local playback within ~128 ms so the interruption FEELS instant, well
 * before the upstream round trip could confirm it. Both converge on the same
 * `{type:'interrupted'}` client handling that already exists.
 *
 * SCOPE / SAFETY
 * --------------
 * Everything here is inert unless `FEATURE_ORB_FULL_DUPLEX_ENV` is set.
 * Unset resolves to `'off'` and every predicate returns the pre-existing
 * behavior byte-for-byte. Staging sets `'staging-only'`; production is a
 * separate, later decision.
 */

import { isFeatureLive } from '../../../services/feature-flags';

/** Feature-flag name (the env var is `FEATURE_ORB_FULL_DUPLEX_ENV`). */
export const FULL_DUPLEX_FLAG = 'ORB_FULL_DUPLEX';

/**
 * Tuning constants for the client-side echo-aware noise gate.
 *
 * These are the SINGLE SOURCE OF TRUTH. `orb-widget.js` is a plain IIFE
 * served as a static asset and cannot import from here, so it mirrors these
 * numbers literally — and `full-duplex-gate.widget-parity.test.ts` reads the
 * widget source and fails if any of them drift. Change a value here and the
 * test tells you exactly which widget literal to update; it cannot silently
 * desync the way five copies of a language map did in VTID-03644.
 */
export const DUPLEX_GATE = {
  /**
   * RMS at which the gate OPENS during model playback.
   *
   * Sits above the measured AEC-residue band (0.01-0.04) with margin, and
   * well below conversational speech (0.1-0.3). Deliberately a touch below
   * the legacy 0.06 barge threshold: a false open now leaks one 64 ms frame
   * of near-silence, whereas under the old design it committed to a full
   * interruption — so the cost of being wrong dropped by an order of
   * magnitude and the threshold can afford to be more sensitive.
   */
  openRms: 0.05,

  /**
   * RMS below which the gate begins CLOSING. Lower than `openRms` on
   * purpose (Schmitt trigger): a single threshold chatters open/closed
   * across the natural amplitude dips inside a word and shreds the audio
   * Nova is trying to transcribe.
   */
  closeRms: 0.025,

  /**
   * How long the gate stays open after energy drops below `closeRms`.
   * Covers inter-word gaps and stop consonants so a sentence arrives as one
   * continuous utterance rather than a burst of clipped fragments.
   */
  hangoverMs: 400,

  /**
   * Grace window after playback STARTS during which the gate is held shut.
   *
   * Browser AEC needs a moment to converge on a newly-started render stream;
   * until it does, residue can briefly exceed `openRms`. LiveKit ships the
   * same idea as `aec_warmup_duration` at 3.0 s, but that default is tuned
   * for telephony — at 3 s here the user could not interrupt the first three
   * seconds of every single turn, which is precisely the complaint this VTID
   * exists to fix. 250 ms covers convergence without a perceptible dead zone.
   */
  aecWarmupMs: 250,

  /**
   * Consecutive gate-open frames before the CLIENT stops local playback and
   * sends `interrupt`. At 1024 samples / 16 kHz a frame is 64 ms, so 2
   * frames is ~128 ms — inside the sub-200 ms barge-in budget, while still
   * rejecting a single-frame cough or door slam.
   *
   * Note this bounds only the LOCAL playback stop. Audio itself reaches Nova
   * from the very first gate-open frame regardless of this value, so a
   * conservative number here costs perceived snappiness, never fidelity.
   */
  bargeConfirmFrames: 2,
} as const;

/** True when full-duplex voice is active on this process's environment. */
export function isFullDuplexEnabled(): boolean {
  return isFeatureLive(FULL_DUPLEX_FLAG);
}

/**
 * Should an inbound mic chunk be dropped because the model is speaking?
 *
 * Legacy (`fullDuplex: false`) keeps the VTID-VOICE-INIT echo gate exactly
 * as it was. Under full duplex the answer is always no: the client has
 * already replaced echo with digital silence, so forwarding is safe, and
 * forwarding is the whole point — it is what lets Nova hear the
 * interruption and fire its own barge-in.
 */
export function shouldDropMicWhileModelSpeaking(input: {
  fullDuplex: boolean;
  isModelSpeaking: boolean;
}): boolean {
  if (input.fullDuplex) return false;
  return input.isModelSpeaking;
}

/**
 * Should an inbound mic chunk be dropped by the post-turn echo cooldown?
 *
 * The cooldown exists to cover the client's playback queue still draining
 * after `turn_complete`. Under full duplex the client gates that draining
 * audio itself, frame by frame, so the blanket time-based drop is pure
 * dead air — it silently discards the user's first words after every model
 * turn, which is the same class of bug as the gate above.
 */
export function shouldDropMicForPostTurnCooldown(input: {
  fullDuplex: boolean;
  turnCompleteAt: number;
  nowMs: number;
  cooldownMs: number;
}): boolean {
  if (input.fullDuplex) return false;
  if (input.turnCompleteAt <= 0) return false;
  return input.nowMs - input.turnCompleteAt < input.cooldownMs;
}

/** State the client gate carries between capture callbacks. */
export interface DuplexGateState {
  /** Gate currently passing audio through. */
  open: boolean;
  /** Timestamp of the last frame whose energy exceeded `closeRms`. */
  lastVoiceMs: number;
  /** Consecutive gate-open frames observed in the current burst. */
  openFrames: number;
}

export interface DuplexGateDecision {
  /** Emit the captured frame verbatim (false ⇒ emit a silent frame). */
  passthrough: boolean;
  /** This frame completed the barge confirmation — stop playback, interrupt. */
  triggerBarge: boolean;
  next: DuplexGateState;
}

export function initialDuplexGateState(): DuplexGateState {
  return { open: false, lastVoiceMs: 0, openFrames: 0 };
}

/**
 * Decide what to do with one captured mic frame while the model is speaking.
 *
 * Pure so the behavior can be exercised frame-by-frame in tests instead of
 * only against a live microphone. `orb-widget.js` mirrors this algorithm;
 * the parity test pins the constants, and these tests pin the logic.
 *
 * Callers only invoke this DURING playback — when the model is silent the
 * gate does not apply at all and frames pass through unconditionally.
 */
export function evaluateDuplexGateFrame(input: {
  rms: number;
  nowMs: number;
  /** When the current playback burst began, for the AEC warm-up window. */
  playbackStartedAtMs: number;
  /** Already interrupted this burst — don't re-fire. */
  bargeAlreadySent: boolean;
  state: DuplexGateState;
}): DuplexGateDecision {
  const { rms, nowMs, playbackStartedAtMs, bargeAlreadySent, state } = input;

  // AEC warm-up: hold shut and do not accumulate confirmation. Residue in
  // this window is not evidence of speech, and treating it as such is the
  // self-interrupt loop all over again.
  if (
    playbackStartedAtMs > 0 &&
    nowMs - playbackStartedAtMs < DUPLEX_GATE.aecWarmupMs
  ) {
    return {
      passthrough: false,
      triggerBarge: false,
      next: { open: false, lastVoiceMs: state.lastVoiceMs, openFrames: 0 },
    };
  }

  const aboveOpen = rms > DUPLEX_GATE.openRms;
  const aboveClose = rms > DUPLEX_GATE.closeRms;

  let open = state.open;
  let lastVoiceMs = state.lastVoiceMs;

  if (open) {
    // Sustain on anything above the LOW threshold; fall closed only once the
    // hangover has elapsed with no such energy.
    if (aboveClose) {
      lastVoiceMs = nowMs;
    } else if (nowMs - lastVoiceMs >= DUPLEX_GATE.hangoverMs) {
      open = false;
    }
  } else if (aboveOpen) {
    open = true;
    lastVoiceMs = nowMs;
  }

  // Confirmation counts VOICED frames, not merely open ones. The gate stays
  // open through the hangover with no energy in it, and counting those would
  // mean a single loud transient — a cough, a door slam, a chair scrape —
  // reached the confirmation threshold purely by the hangover ticking over
  // in silence. Frames inside the hangover neither add to the count nor
  // reset it, so a natural mid-word dip does not restart confirmation.
  let openFrames: number;
  if (!open) {
    openFrames = 0;
  } else if (aboveClose) {
    openFrames = state.openFrames + 1;
  } else {
    openFrames = state.openFrames;
  }

  const triggerBarge =
    open && !bargeAlreadySent && openFrames >= DUPLEX_GATE.bargeConfirmFrames;

  return {
    passthrough: open,
    triggerBarge,
    next: { open, lastVoiceMs, openFrames },
  };
}
