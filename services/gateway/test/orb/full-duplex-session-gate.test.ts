/**
 * VTID-03706 — ORB full-duplex voice.
 *
 * The defect these tests exist to prevent coming back: the mic was gated
 * SHUT while the model spoke, in both the client and the server, so Nova
 * Sonic received literal silence during its own turn and its native
 * barge-in (`contentEnd.stopReason: "INTERRUPTED"`) could never fire.
 *
 * Two properties are pinned here, and the second matters as much as the
 * first because it is what the old gate was protecting:
 *
 *   1. Real speech passes through IMMEDIATELY — no confirmation delay, at
 *      any volume above the echo floor.
 *   2. AEC residue does NOT pass through — otherwise Nova's own VAD sees
 *      Vitana's voice and interrupts itself in a loop, which is a worse
 *      regression than the bug being fixed (the widget carries measured
 *      evidence: a 0.015 threshold "triggered on echo, causing constant
 *      interruptions").
 */

import {
  DUPLEX_GATE,
  FULL_DUPLEX_ENV_VAR,
  evaluateDuplexGateFrame,
  isFullDuplexEnabled,
  initialDuplexGateState,
  shouldDropMicForPostTurnCooldown,
  shouldDropMicWhileModelSpeaking,
  type DuplexGateState,
} from '../../src/orb/live/duplex/full-duplex-gate';

/** Measured bands from the widget's own comments. */
const ECHO_RMS = 0.03; // AEC residue: 0.01-0.04
const SPEECH_RMS = 0.2; // conversational speech: 0.1-0.3
const QUIET_SPEECH_RMS = 0.055; // the "nein"/"warte" case the old gate ate

/** Frame duration at 1024 samples / 16kHz. */
const FRAME_MS = 64;

/**
 * Push frames through the gate the way the capture handler does, starting
 * well past the AEC warm-up so these cases exercise the gate itself.
 */
function runFrames(
  rmsSequence: number[],
  opts: { playbackStartedAtMs?: number; startMs?: number } = {},
) {
  const startMs = opts.startMs ?? 100_000;
  const playbackStartedAtMs = opts.playbackStartedAtMs ?? startMs - 10_000;

  let state: DuplexGateState = initialDuplexGateState();
  let bargeAlreadySent = false;
  const decisions = rmsSequence.map((rms, i) => {
    const d = evaluateDuplexGateFrame({
      rms,
      nowMs: startMs + i * FRAME_MS,
      playbackStartedAtMs,
      bargeAlreadySent,
      state,
    });
    state = d.next;
    if (d.triggerBarge) bargeAlreadySent = true;
    return d;
  });
  return { decisions, state };
}

describe('VTID-03706 evaluateDuplexGateFrame — speech gets through', () => {
  it('passes real speech on the VERY FIRST frame (no confirmation delay)', () => {
    const { decisions } = runFrames([SPEECH_RMS]);
    expect(decisions[0].passthrough).toBe(true);
  });

  it('passes quiet speech that the legacy 0.06 threshold discarded forever', () => {
    // This is the user-visible failure: "nein", "warte", "stopp" sat under
    // the old barge threshold and were dropped, so they could not interrupt
    // at any point, ever — not late, never.
    expect(QUIET_SPEECH_RMS).toBeLessThan(0.06);
    const { decisions } = runFrames([QUIET_SPEECH_RMS]);
    expect(decisions[0].passthrough).toBe(true);
  });

  it('keeps the gate open through a mid-word amplitude dip (hysteresis)', () => {
    // A single threshold would chatter here and shred the utterance. The dip
    // is below openRms but above closeRms, so the gate must sustain.
    const dip = (DUPLEX_GATE.openRms + DUPLEX_GATE.closeRms) / 2;
    expect(dip).toBeLessThan(DUPLEX_GATE.openRms);
    expect(dip).toBeGreaterThan(DUPLEX_GATE.closeRms);

    const { decisions } = runFrames([SPEECH_RMS, dip, dip, SPEECH_RMS]);
    expect(decisions.map((d) => d.passthrough)).toEqual([true, true, true, true]);
  });

  it('holds the gate open across a short silent gap, then closes after the hangover', () => {
    const gapFrames = Math.ceil(DUPLEX_GATE.hangoverMs / FRAME_MS) + 2;
    const seq = [SPEECH_RMS, ...new Array(gapFrames).fill(0)];
    const { decisions } = runFrames(seq);

    // Still open immediately after speech stops — trailing consonants and
    // inter-word gaps must not be clipped.
    expect(decisions[1].passthrough).toBe(true);
    // Closed by the end of the hangover.
    expect(decisions[decisions.length - 1].passthrough).toBe(false);
  });
});

describe('VTID-03706 evaluateDuplexGateFrame — echo does NOT get through', () => {
  it('blocks sustained AEC residue across the whole band (0.01-0.04)', () => {
    for (const rms of [0.01, 0.02, 0.03, 0.04]) {
      const { decisions } = runFrames(new Array(20).fill(rms));
      expect(decisions.some((d) => d.passthrough)).toBe(false);
      expect(decisions.some((d) => d.triggerBarge)).toBe(false);
    }
  });

  it('never fires barge-in on echo alone, however long playback runs', () => {
    const { decisions } = runFrames(new Array(200).fill(ECHO_RMS));
    expect(decisions.some((d) => d.triggerBarge)).toBe(false);
  });

  it('holds shut during the AEC warm-up even if residue spikes above openRms', () => {
    // Before AEC converges on a new render stream, residue can briefly clear
    // the open threshold. Treating that as speech is the self-interrupt loop.
    const startMs = 50_000;
    const { decisions } = runFrames([SPEECH_RMS, SPEECH_RMS, SPEECH_RMS], {
      startMs,
      playbackStartedAtMs: startMs, // playback just began
    });
    expect(decisions.every((d) => d.passthrough === false)).toBe(true);
    expect(decisions.every((d) => d.triggerBarge === false)).toBe(true);
  });

  it('does not let warm-up frames accumulate toward barge confirmation', () => {
    // Regression guard: if warm-up merely suppressed the OUTPUT but still
    // counted frames, the first post-warm-up frame would instantly barge on
    // what was echo.
    const startMs = 50_000;
    const warmupFrames = Math.ceil(DUPLEX_GATE.aecWarmupMs / FRAME_MS);
    const seq = new Array(warmupFrames).fill(SPEECH_RMS);

    let state = initialDuplexGateState();
    for (let i = 0; i < seq.length; i++) {
      state = evaluateDuplexGateFrame({
        rms: seq[i],
        nowMs: startMs + i * FRAME_MS,
        playbackStartedAtMs: startMs,
        bargeAlreadySent: false,
        state,
      }).next;
    }
    expect(state.openFrames).toBe(0);
  });

  it('opens normally once the warm-up window has elapsed', () => {
    const startMs = 50_000;
    const d = evaluateDuplexGateFrame({
      rms: SPEECH_RMS,
      nowMs: startMs + DUPLEX_GATE.aecWarmupMs + 1,
      playbackStartedAtMs: startMs,
      bargeAlreadySent: false,
      state: initialDuplexGateState(),
    });
    expect(d.passthrough).toBe(true);
  });
});

describe('VTID-03706 evaluateDuplexGateFrame — barge confirmation', () => {
  it('confirms barge-in within the sub-200ms budget', () => {
    const { decisions } = runFrames(new Array(6).fill(SPEECH_RMS));
    const firstBarge = decisions.findIndex((d) => d.triggerBarge);
    expect(firstBarge).toBeGreaterThanOrEqual(0);
    // Frame index -> elapsed ms. Industry target for barge-in stop latency
    // is under 200ms; the legacy path needed 6 frames (~384ms) minimum.
    expect((firstBarge + 1) * FRAME_MS).toBeLessThan(200);
  });

  it('rejects a single-frame transient (cough, door slam)', () => {
    const { decisions } = runFrames([SPEECH_RMS, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(decisions.some((d) => d.triggerBarge)).toBe(false);
  });

  it('forwards audio from frame 1 even though barge confirms later', () => {
    // The confirmation delay must bound only the LOCAL playback stop. If it
    // gated transmission too, the opening syllable would be lost upstream —
    // which is precisely the old bug.
    const { decisions } = runFrames([SPEECH_RMS, SPEECH_RMS]);
    expect(decisions[0].passthrough).toBe(true);
    expect(decisions[0].triggerBarge).toBe(false);
    expect(decisions[1].triggerBarge).toBe(true);
  });

  it('does not re-fire barge-in once already sent for this burst', () => {
    const { decisions } = runFrames(new Array(20).fill(SPEECH_RMS));
    expect(decisions.filter((d) => d.triggerBarge)).toHaveLength(1);
  });
});

describe('VTID-03706 shouldDropMicWhileModelSpeaking', () => {
  it('LEGACY: drops mic audio while the model speaks (unchanged)', () => {
    expect(
      shouldDropMicWhileModelSpeaking({ fullDuplex: false, isModelSpeaking: true }),
    ).toBe(true);
  });

  it('LEGACY: forwards when the model is silent (unchanged)', () => {
    expect(
      shouldDropMicWhileModelSpeaking({ fullDuplex: false, isModelSpeaking: false }),
    ).toBe(false);
  });

  it('FULL DUPLEX: forwards even while the model speaks — this is the fix', () => {
    // Without this, Nova receives silence during its own turn and its native
    // barge-in can never fire, no matter what the client does.
    expect(
      shouldDropMicWhileModelSpeaking({ fullDuplex: true, isModelSpeaking: true }),
    ).toBe(false);
  });
});

describe('VTID-03706 shouldDropMicForPostTurnCooldown', () => {
  const now = 1_000_000;

  it('LEGACY: drops inside the cooldown window (unchanged)', () => {
    expect(
      shouldDropMicForPostTurnCooldown({
        fullDuplex: false,
        turnCompleteAt: now - 100,
        nowMs: now,
        cooldownMs: 300,
      }),
    ).toBe(true);
  });

  it('LEGACY: forwards once the window has elapsed (unchanged)', () => {
    expect(
      shouldDropMicForPostTurnCooldown({
        fullDuplex: false,
        turnCompleteAt: now - 400,
        nowMs: now,
        cooldownMs: 300,
      }),
    ).toBe(false);
  });

  it('LEGACY: forwards when no turn has completed yet', () => {
    expect(
      shouldDropMicForPostTurnCooldown({
        fullDuplex: false,
        turnCompleteAt: 0,
        nowMs: now,
        cooldownMs: 300,
      }),
    ).toBe(false);
  });

  it('FULL DUPLEX: never drops — the per-frame gate replaces the time window', () => {
    expect(
      shouldDropMicForPostTurnCooldown({
        fullDuplex: true,
        turnCompleteAt: now - 1,
        nowMs: now,
        cooldownMs: 300,
      }),
    ).toBe(false);
  });
});

describe('VTID-03706 constants stay physically coherent', () => {
  it('open threshold sits above the measured AEC residue band', () => {
    expect(DUPLEX_GATE.openRms).toBeGreaterThan(0.04);
  });

  it('open threshold sits below conversational speech', () => {
    expect(DUPLEX_GATE.openRms).toBeLessThan(0.1);
  });

  it('close threshold is strictly below open (Schmitt trigger, not a single edge)', () => {
    expect(DUPLEX_GATE.closeRms).toBeLessThan(DUPLEX_GATE.openRms);
  });

  it('barge confirmation stays inside the sub-200ms budget', () => {
    expect(DUPLEX_GATE.bargeConfirmFrames * FRAME_MS).toBeLessThan(200);
  });

  it('AEC warm-up is short enough not to create a perceptible dead zone', () => {
    // LiveKit's 3.0s default is tuned for telephony; at that length the user
    // could not interrupt the first three seconds of every turn, which is
    // the complaint this VTID exists to fix.
    expect(DUPLEX_GATE.aecWarmupMs).toBeLessThanOrEqual(500);
  });
});

describe('VTID-03706 isFullDuplexEnabled — exact-true opt-in', () => {
  const VAR = FULL_DUPLEX_ENV_VAR;
  const original = process.env[VAR];

  afterEach(() => {
    if (original === undefined) delete process.env[VAR];
    else process.env[VAR] = original;
  });

  it('is ON only for the exact string "true"', () => {
    process.env[VAR] = 'true';
    expect(isFullDuplexEnabled()).toBe(true);
  });

  it.each(['false', 'TRUE', 'True', '1', 'yes', 'on', 'staging-only', '', '  true  '])(
    'is OFF for %p',
    (value) => {
      // A feature that changes live audio for every voice session must
      // require someone to say yes. Near-misses — a casing slip, a leftover
      // 'staging-only' from the previous flag convention, a stray space —
      // must land OFF, never on.
      process.env[VAR] = value;
      expect(isFullDuplexEnabled()).toBe(false);
    },
  );

  it('is OFF when unset', () => {
    delete process.env[VAR];
    expect(isFullDuplexEnabled()).toBe(false);
  });

  it('reads the env at call time, so an operator flip needs no restart', () => {
    delete process.env[VAR];
    expect(isFullDuplexEnabled()).toBe(false);
    process.env[VAR] = 'true';
    expect(isFullDuplexEnabled()).toBe(true);
  });
});
