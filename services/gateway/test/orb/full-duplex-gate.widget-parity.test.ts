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
  // orb-duplex-test.js is the ONLY way to establish that this device's echo
  // stays below the open threshold — a property no unit test can reach,
  // since there is no acoustic path in CI. A harness running different
  // thresholds than the shipped gate would return a green result that means
  // nothing, which is worse than having no harness at all.
  const harness = readFileSync(
    join(__dirname, '../../src/frontend/command-hub/orb-duplex-test.js'),
    'utf8',
  );

  function harnessConst(key: string): number {
    const m = harness.match(new RegExp(`${key}:\\s*([0-9.]+)\\s*,`));
    if (!m) throw new Error(`harness constant ${key} not found in orb-duplex-test.js`);
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
