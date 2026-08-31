/**
 * VTID-03800 — the guided-topic backstop fires on IDLE, not on elapsed time,
 * so the Well Done drawer opens by itself once the lesson actually ends.
 *
 * Why it is idle and not simply a shorter timer:
 *
 * The pre-existing backstop counted from the TAP. Shortening that is the
 * obvious reading of "make it open sooner" and it is wrong — a short fixed
 * timer fires MID-LESSON. Measured on staging, topic T004 (2026-08-31
 * 12:23): that session was still actively conversing 68s after the tap,
 * with turns at +11s, +40s, +55s and +68s. A 60s fixed backstop would have
 * cut it off between the third and fourth turn — which is exactly the
 * failure VTID-03680 (auto-close cut the lesson short) and VTID-03784
 * (false completion) already cost this chain.
 *
 * So the guarded invariants are:
 *   1. idle is measured from the last sign of life, not from the tap
 *   2. model audio, a completed turn, and the USER speaking all reset it
 *   3. idle cannot fire before turn-1 audio was actually delivered
 *      (silence while connecting/synthesising is not a finished lesson)
 *   4. the absolute 5-minute ceiling still exists as a last resort
 *
 * Static source checks — the widget is a plain IIFE with no export surface.
 */
import * as fs from 'fs';
import * as path from 'path';

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);
const source = fs.readFileSync(WIDGET_PATH, 'utf8');

function extractFunctionBody(src: string, signature: string): string {
  const sigIdx = src.indexOf(signature);
  expect(sigIdx).toBeGreaterThanOrEqual(0);
  const openIdx = src.indexOf('{', sigIdx);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') depth--;
    if (depth === 0) return src.slice(openIdx + 1, i);
  }
  throw new Error(`unclosed: ${signature}`);
}

describe('VTID-03800 guided-topic idle backstop', () => {
  it('declares an idle window distinct from the absolute ceiling', () => {
    expect(source).toMatch(/var GUIDED_TOPIC_IDLE_MS = 45 \* 1000;/);
    // the ceiling is unchanged — idle is additive, not a replacement
    expect(source).toMatch(/var GUIDED_TOPIC_BACKSTOP_MS = 5 \* 60 \* 1000;/);
  });

  it('checks often enough that a 45s idle is detected promptly', () => {
    // A 15s poll would make the observed close land anywhere in 45-60s.
    expect(source).toMatch(/var GUIDED_TOPIC_BACKSTOP_CHECK_MS = 5000;/);
  });

  it('measures idle from the last activity, not from the tap', () => {
    expect(source).toMatch(/_now - _s\._guidedTopicLastActivityAt/);
    // and the ceiling still measures from the tap
    expect(source).toMatch(/_now - _s\._guidedTopicOpenedAt/);
  });

  it('cannot fire on idle before turn-1 audio was delivered', () => {
    // Guard against auto-completing a topic the user never heard (VTID-03784).
    expect(source).toMatch(
      /_idle = \(_s\._guidedTopicAudioDelivered && _s\._guidedTopicLastActivityAt\)/,
    );
  });

  it('still fires on the absolute ceiling, and reports which trigger it was', () => {
    expect(source).toMatch(/_ceilingFired = _elapsed >= GUIDED_TOPIC_BACKSTOP_MS/);
    expect(source).toMatch(/if \(_idleFired \|\| _ceilingFired\)/);
    expect(source).toMatch(/_reason = _idleFired \? 'idle_after_lesson' : 'backstop_timeout'/);
    expect(source).toMatch(/_endGuidedTopicTeaching\(_stuckTopicId, _reason\)/);
  });

  describe('what counts as life', () => {
    it('model audio resets idle', () => {
      expect(source).toMatch(/case 'audio_out':\s*\n\s*_touchGuidedTopicActivity\(\);/);
    });

    it('a completed turn resets idle', () => {
      expect(source).toMatch(/case 'turn_complete':\s*\n\s*_touchGuidedTopicActivity\(\);/);
    });

    it('the USER speaking resets idle — never time someone out mid-thought', () => {
      expect(source).toMatch(/case 'input_transcript':\s*\n\s*_touchGuidedTopicActivity\(\);/);
    });

    it('the toucher no-ops when no guided topic is in flight', () => {
      const body = extractFunctionBody(source, 'function _touchGuidedTopicActivity() {');
      expect(body).toMatch(/if \(!_s\._guidedTopicOpenedAt\) return;/);
      expect(body).toMatch(/_s\._guidedTopicLastActivityAt = Date\.now\(\);/);
    });
  });

  describe('lifecycle', () => {
    it('the idle clock is armed with the tap', () => {
      expect(source).toMatch(/_s\._guidedTopicOpenedAt = Date\.now\(\);\s*\n\s*_s\._guidedTopicLastActivityAt = Date\.now\(\);/);
    });

    it('and cleared by _hide, same lifecycle as the backstop it drives', () => {
      const body = extractFunctionBody(source, 'function _hide() {');
      expect(body).toMatch(/_s\._guidedTopicLastActivityAt = null;/);
      expect(body).toMatch(/_s\._guidedTopicOpenedAt = null;/);
    });

    it('is declared in the initial state', () => {
      expect(source).toMatch(/_guidedTopicLastActivityAt: null,/);
    });
  });
});
