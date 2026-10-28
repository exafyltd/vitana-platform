/**
 * VTID-03706 — the widget mirrors the gate; this test makes the mirror honest.
 *
 * `orb-widget.js` is a plain IIFE served as a static asset, so it cannot
 * import `DUPLEX_GATE` and has to repeat the tuning constants as literals.
 * That is a drift hazard with a bad failure mode: nothing crashes, the gate
 * just silently runs at different thresholds on the client than the ones
 * `full-duplex-gate.test.ts` proves are safe — and the symptom (Vitana
 * interrupting herself, or the user unable to interrupt) looks like a
 * mystery rather than a desync.
 *
 * This repo has been bitten by exactly this before: five copies of a
 * language-name map drifted apart in VTID-03644, and VTID-03696 had to add a
 * test that reads a workflow's own `paths:` list because the same class of
 * desync went unnoticed for 30+ CI runs. Same remedy here — read the widget
 * source, assert the numbers match, fail the build if they do not.
 *
 * The rest of the suite pins the BEHAVIOUR that made the old design fail, so
 * a future edit cannot quietly reinstate a gate that destroys audio.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DUPLEX_GATE } from '../../src/orb/live/duplex/full-duplex-gate';

const WIDGET_PATH = join(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);
const widget = readFileSync(WIDGET_PATH, 'utf8');

/** Read a `var NAME = <number>;` literal out of the widget source. */
function widgetConst(name: string): number {
  const m = widget.match(new RegExp(`var\\s+${name}\\s*=\\s*([0-9.]+)\\s*;`));
  if (!m) throw new Error(`widget constant ${name} not found in orb-widget.js`);
  return Number(m[1]);
}

describe('VTID-03706 widget mirrors DUPLEX_GATE exactly', () => {
  const cases: Array<[string, number]> = [
    ['DUPLEX_OPEN_RMS', DUPLEX_GATE.openRms],
    ['DUPLEX_CLOSE_RMS', DUPLEX_GATE.closeRms],
    ['DUPLEX_HANGOVER_MS', DUPLEX_GATE.hangoverMs],
    ['DUPLEX_AEC_WARMUP_MS', DUPLEX_GATE.aecWarmupMs],
    ['DUPLEX_BARGE_CONFIRM_FRAMES', DUPLEX_GATE.bargeConfirmFrames],
  ];

  it.each(cases)('%s matches the TypeScript source of truth', (name, expected) => {
    expect(widgetConst(name)).toBe(expected);
  });
});

describe('VTID-03706 the device test harness mirrors DUPLEX_GATE too', () => {
  // orb-voice-bench.js is the ONLY way to establish that this device's echo
  // stays below the open threshold — a property no unit test can reach,
  // since there is no acoustic path in CI. A harness running different
  // thresholds than the shipped gate would return a green result that means
  // nothing, which is worse than having no harness at all.
  const harness = readFileSync(
    join(__dirname, '../../src/frontend/command-hub/orb-voice-bench.js'),
    'utf8',
  );

  function harnessConst(key: string): number {
    const m = harness.match(new RegExp(`${key}:\\s*([0-9.]+)\\s*,`));
    if (!m) throw new Error(`harness constant ${key} not found in orb-voice-bench.js`);
    return Number(m[1]);
  }

  const cases: Array<[string, number]> = [
    ['openRms', DUPLEX_GATE.openRms],
    ['closeRms', DUPLEX_GATE.closeRms],
    ['hangoverMs', DUPLEX_GATE.hangoverMs],
    ['aecWarmupMs', DUPLEX_GATE.aecWarmupMs],
    ['bargeConfirmFrames', DUPLEX_GATE.bargeConfirmFrames],
  ];

  it.each(cases)('%s matches the TypeScript source of truth', (key, expected) => {
    expect(harnessConst(key)).toBe(expected);
  });

  it('uses the same getUserMedia constraints as the widget', () => {
    // Different constraints would exercise a different echo canceller, so a
    // pass here would say nothing about the real ORB session.
    for (const c of ['echoCancellation: true', 'noiseSuppression: true', 'autoGainControl: true']) {
      expect(harness).toContain(c);
      expect(widget).toContain(c);
    }
  });

  it('never routes the mic back to the speaker (that would be feedback, not echo)', () => {
    expect(harness).toContain('sink.gain.value = 0;');
  });
});

describe('VTID-03706 the widget actually keeps the mic open', () => {
  it('emits a silent frame instead of returning early when the gate is shut', () => {
    // THE regression guard. If a future edit replaces `_sendAudio(_silentFrame(...))`
    // with a bare `return`, the mic is closed again, Nova receives nothing
    // during its turn, and native barge-in silently dies — the exact bug
    // this VTID fixed, with no visible error anywhere.
    expect(widget).toContain('_sendAudio(_silentFrame(input.length));');
  });

  it('defines _silentFrame as real digital silence, not a dropped frame', () => {
    expect(widget).toMatch(/function\s+_silentFrame\s*\(/);
    expect(widget).toContain('new Uint8Array(sampleCount * 2)');
  });

  it('forwards the captured frame verbatim once the gate is open', () => {
    const duplexBlock = widget.slice(
      widget.indexOf('full-duplex path'),
      widget.indexOf('end full-duplex path'),
    );
    expect(duplexBlock).toContain('_sendAudio(_encodeFrame(input));');
  });

  it('sends the interrupt AFTER forwarding audio, not instead of it', () => {
    // Ordering matters: if the interrupt short-circuited the send, Nova would
    // be told "the user is talking" without ever receiving what they said.
    const duplexBlock = widget.slice(
      widget.indexOf('full-duplex path'),
      widget.indexOf('end full-duplex path'),
    );
    expect(duplexBlock.indexOf('_sendAudio(_encodeFrame(input));')).toBeLessThan(
      duplexBlock.indexOf('_sendInterrupt();'),
    );
  });
});

describe('VTID-03706 legacy behaviour is preserved when the flag is off', () => {
  it('reads full duplex from the server, defaulting to false', () => {
    expect(widget).toContain('_s.fullDuplex = msg.full_duplex === true;');
  });

  it('reads full duplex on BOTH transports, not just WS', () => {
    // VTID-03706 follow-up: the widget defaults to the SSE transport
    // (_sessionStart's transport preference), but the original fix only
    // wired `_s.fullDuplex = msg.full_duplex === true;` into the WS
    // `session_started` handler. SSE never sends a `session_started`-typed
    // message at all (it sends `ready`/`live_api_ready`/`audio`/...), so
    // `_s.fullDuplex` stayed at its false default on every SSE session,
    // full duplex or not — confirmed live against staging, where the
    // .vtorb-mic-live class never appeared during playback on a real SSE
    // session. A single occurrence here would mean one of the two
    // transports lost its wiring again; there must be exactly two:
    // the WS `session_started` handler and the SSE `live_api_ready` case
    // in `_handleMessage`.
    const occurrences = widget.split('_s.fullDuplex = msg.full_duplex === true;').length - 1;
    expect(occurrences).toBe(2);

    const liveApiReadyBlock = widget.slice(
      widget.indexOf("case 'live_api_ready':"),
      widget.indexOf('case ', widget.indexOf("case 'live_api_ready':") + 1),
    );
    expect(liveApiReadyBlock).toContain('_s.fullDuplex = msg.full_duplex === true;');
  });

  it('still declares fullDuplex:false in the initial state', () => {
    expect(widget).toMatch(/fullDuplex:\s*false/);
  });

  it('keeps the pre-roll buffer for flag-off sessions', () => {
    // The legacy path must stay intact so a rollback is a flag flip, not a
    // revert. Deleting the pre-roll before full duplex graduates would make
    // flag-off strictly worse than it was.
    expect(widget).toContain('preRollFrames.push(_encodeFrame(input));');
    expect(widget).toContain('_flushPreRollOrdered(preRollFrames, _interruptAck);');
  });

  it('gates both client cooldowns on the flag rather than deleting them', () => {
    expect(widget).toContain('!_s.fullDuplex && _s.turnCompleteAt > 0');
    expect(widget).toContain('!_s.fullDuplex && _s.lastAudioEndTime > 0');
  });
});

describe('VTID-03706 AEC warm-up is anchored to the playback burst', () => {
  it('stamps the start time only on the false->true edge', () => {
    // Re-stamping on every chunk would slide the warm-up window forward for
    // the whole turn, making the user permanently uninterruptible — a silent
    // reintroduction of the original bug wearing a different hat.
    expect(widget).toMatch(
      /if\s*\(!_s\.audioPlaying\)\s*\{\s*\n\s*_s\.audioPlayStartedAt = Date\.now\(\);/,
    );
  });
});

// ---------------------------------------------------------------------------
// VTID-03706 — the TTS half of the bench.
//
// Nothing in this repo produces an audible sound to check.
// `/api/v1/voice-lab/nova/tests/run` checks Nova config, the selector table,
// codecs and stream latency; `/tests/eval` checks tool selection;
// `runVoiceProbe()` GETs `/api/v1/orb/health` and asserts booleans — its own
// comment records that the audio-path probe was never built. So the failure
// that actually reaches a user — a 200 OK carrying silent, undecodable or
// wrong-language audio — had no check anywhere.
//
// These pin the properties that make the bench worth trusting. They are
// source assertions, not behaviour tests: the page needs a real browser,
// speaker and network, which is the whole point of it existing.
// ---------------------------------------------------------------------------

describe('VTID-03706 TTS bench checks what a status code cannot', () => {
  const bench = readFileSync(
    join(__dirname, '../../src/frontend/command-hub/orb-voice-bench.js'),
    'utf8',
  );

  it('calls the real gateway TTS route, not a mock', () => {
    expect(bench).toContain("'/api/v1/orb/tts'");
    expect(bench).toContain("method: 'POST'");
  });

  it('decodes the audio rather than trusting the response envelope', () => {
    // decodeAudioData both proves the bytes are really decodable audio (not
    // an error body wearing an audio mime) and yields samples to measure.
    expect(bench).toContain('decodeAudioData');
  });

  it('measures peak amplitude, so silent-but-well-formed audio fails', () => {
    expect(bench).toMatch(/TTS_SILENCE_PEAK\s*=\s*0?\.\d+/);
    expect(bench).toContain('FAIL silent');
  });

  it('fails when the gateway serves a different language than requested', () => {
    // Fluent audio in the wrong language sounds like a working system.
    expect(bench).toContain('langMismatch');
    expect(bench).toContain('FAIL served lang=');
  });

  it('sweeps every locale the TTS layer claims to serve, including the broken one', () => {
    // A bench that lists only the languages known to work cannot tell you
    // when one of them stops working.
    for (const lang of ['de', 'en', 'es', 'fr', 'pt', 'pl', 'ru', 'zh', 'ar', 'sr']) {
      expect(bench).toContain(`'${lang}'`);
    }
  });

  it('treats Serbian as a KNOWN GAP, not a passing test and not a mystery failure', () => {
    // Polly has no sr voice in any engine (verified live: 106 voices, 42
    // language codes). Silently excluding it would hide the gap; failing the
    // whole sweep on it would train people to ignore a red result.
    expect(bench).toContain('TTS_EXPECTED_FAIL');
    expect(bench).toMatch(/sr:\s*'no Polly voice/);
    expect(bench).toContain('EXPECTED FAIL');
  });

  it('reports it as NEWS when an expected-fail locale starts working', () => {
    // Otherwise adding a provider looks identical to the gap persisting.
    expect(bench).toContain('surprises');
    expect(bench).toContain('update TTS_EXPECTED_FAIL');
  });

  it('plays languages serially so the measurements stay meaningful', () => {
    // Overlapping playback would make peak and duration meaningless.
    expect(bench).toContain('await runOneTts(');
  });

  it('defaults to same-origin so the bench tests the gateway serving it', () => {
    expect(bench).toContain("'' => same origin");
  });
});
