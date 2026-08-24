/**
 * VTID-03716 — unit tests for the automated audio-timing verification
 * program, added in response to a Codex review finding (P2, PR #3173):
 *
 *   "The script invokes the extracted `_pcmRateFromMime` helper directly,
 *    but never verifies that the widget's playback path actually passes
 *    its result to `createBuffer`. If that call is regressed to
 *    `createBuffer(..., 24000)` while the now-unused helper remains
 *    intact, every check here still passes, so the permanent regression
 *    program reports success for the exact playback-speed defect it is
 *    intended to catch."
 *
 * `verifyWidgetWiringIsConnected()` was added to close that gap. These
 * tests exercise the REAL function (imported directly, not reimplemented)
 * against both the real shipped widget and a deliberately regressed one.
 */
import { readFileSync } from 'node:fs';

jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return {
    ...actual,
    readFileSync: jest.fn(actual.readFileSync),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  verifyWidgetWiringIsConnected,
} = require('../../../../scripts/tts/verify-cascade-audio-timing');

const mockedReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const actualReadFileSync = jest.requireActual('node:fs').readFileSync as typeof readFileSync;

describe('VTID-03716 — verifyWidgetWiringIsConnected (Codex P2 fix)', () => {
  afterEach(() => {
    mockedReadFileSync.mockReset();
    mockedReadFileSync.mockImplementation(actualReadFileSync);
  });

  it('passes against the real, currently-shipped orb-widget.js', () => {
    expect(() => verifyWidgetWiringIsConnected()).not.toThrow();
  });

  it('throws if createBuffer() is regressed back to a hardcoded rate — the exact VTID-03711 defect', () => {
    mockedReadFileSync.mockImplementation(((path: any, enc: any) => {
      if (typeof path === 'string' && path.includes('orb-widget.js')) {
        // The VTID-03711 bug, reproduced: the parser still exists and is
        // still assigned, but createBuffer() no longer reads it.
        return [
          'var pcmRate = _pcmRateFromMime(chunk.mime);',
          'var buf = ctx.createBuffer(1, floats.length, 24000);',
        ].join('\n');
      }
      return actualReadFileSync(path, enc);
    }) as typeof readFileSync);

    expect(() => verifyWidgetWiringIsConnected()).toThrow(/createBuffer\(\) is not called with 'pcmRate'/);
  });

  it('throws with a clear message if the assignment pattern itself is gone (refactor, not just a regression)', () => {
    mockedReadFileSync.mockImplementation(((path: any, enc: any) => {
      if (typeof path === 'string' && path.includes('orb-widget.js')) {
        return 'var buf = ctx.createBuffer(1, floats.length, 24000);';
      }
      return actualReadFileSync(path, enc);
    }) as typeof readFileSync);

    expect(() => verifyWidgetWiringIsConnected()).toThrow(/could not find "var X = _pcmRateFromMime/);
  });

  it('does not throw when createBuffer() correctly reads the parsed-rate variable under a different name', () => {
    mockedReadFileSync.mockImplementation(((path: any, enc: any) => {
      if (typeof path === 'string' && path.includes('orb-widget.js')) {
        return [
          'var declaredRate = _pcmRateFromMime(chunk.mime);',
          'var buf = ctx.createBuffer(1, floats.length, declaredRate);',
        ].join('\n');
      }
      return actualReadFileSync(path, enc);
    }) as typeof readFileSync);

    expect(() => verifyWidgetWiringIsConnected()).not.toThrow();
  });
});
