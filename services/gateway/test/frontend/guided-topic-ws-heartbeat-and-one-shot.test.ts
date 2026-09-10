/**
 * VTID-03800 — two defects behind one report: "3 times it repeated teaching
 * and then started with the new day greeting and repeated that 5 or more
 * times."
 *
 * (1) THE ENGINE: the WS keepalive was a protocol-level `ws.ping()`. Browsers
 *     answer those in the network layer; they never reach `onmessage`. The
 *     widget's watchdog (WATCHDOG_TIMEOUT = 30_000) resets ONLY from
 *     `onmessage`, so 30s of application silence read as a dead connection on
 *     a perfectly healthy socket — and after a lesson finishes, neither side
 *     speaks, so that silence is guaranteed.
 *
 *     Measured on staging 2026-08-31, seven consecutive sessions, every one
 *     `turns=1`, every one torn down 33.8-34.2s after `turn_complete`
 *     (30s watchdog + up to 5s poll granularity) and restarted ~1.5s later,
 *     re-firing `guided_topic_audio_bridge_sent` each cycle.
 *
 *     Corollary worth stating because it invalidated the previous fix: ANY
 *     client-side timer longer than 30s was structurally unreachable,
 *     GUIDED_TOPIC_IDLE_MS (45s) included.
 *
 * (2) THE UX: a narrated guided topic is now one-shot and terminal — lesson,
 *     then Well Done drawer, done. This deliberately re-adds an auto-close
 *     VTID-03685 removed, and the ONLY reason that is safe is
 *     `_guidedTopicNarrated`: with the Polly bridge, turn 1 IS the whole
 *     authored lesson, whereas on the VTID-03665 Polly-failure fallback turn 1
 *     is a short opener and the teaching happens across turns 2+. Closing on
 *     the fallback path would amputate a live lesson — VTID-03680 exactly.
 *
 * Static source checks — the widget is a plain IIFE with no export surface.
 */
import * as fs from 'fs';
import * as path from 'path';

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);
const ORB_LIVE_PATH = path.resolve(__dirname, '../../src/routes/orb-live.ts');

const widget = fs.readFileSync(WIDGET_PATH, 'utf8');
const orbLive = fs.readFileSync(ORB_LIVE_PATH, 'utf8');

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

describe('VTID-03800 (1) the WS keepalive reaches onmessage', () => {
  it('sends a data heartbeat, not only a protocol ping', () => {
    // The ping alone is invisible to the client — that was the whole bug.
    expect(orbLive).toMatch(
      /ws\.send\(JSON\.stringify\(\{ type: 'heartbeat', ts: Date\.now\(\) \}\)\)/,
    );
  });

  it('keeps the protocol ping as well — proxies need it, clients cannot see it', () => {
    // The ALB idle timeout (VTID-03794) is a separate concern from the
    // client watchdog. Replacing the ping rather than adding to it would
    // trade this bug for that one.
    const pingIdx = orbLive.indexOf('ws.ping();');
    const beatIdx = orbLive.indexOf("type: 'heartbeat', ts: Date.now()");
    expect(pingIdx).toBeGreaterThanOrEqual(0);
    expect(beatIdx).toBeGreaterThan(pingIdx);
  });

  it('uses the same shape SSE already sends, which the widget already handles', () => {
    // sse-handler.ts emits { type: 'heartbeat', ts }. Diverging here would
    // need a second client-side handler for no reason.
    expect(widget).toMatch(/case 'heartbeat':/);
  });

  it('heartbeats on the same 10s cadence as the ping it rides with', () => {
    const beatIdx = orbLive.indexOf("type: 'heartbeat', ts: Date.now()");
    // The interval literal closes the same setInterval block.
    expect(orbLive.slice(beatIdx, beatIdx + 400)).toMatch(/\}, 10_000\);/);
  });

  it('a send failure cannot kill the session', () => {
    const beatIdx = orbLive.indexOf("type: 'heartbeat', ts: Date.now()");
    expect(orbLive.slice(beatIdx - 200, beatIdx + 300)).toMatch(/try \{[\s\S]*catch/);
  });
});

describe('VTID-03800 (2) a narrated guided topic is one-shot and terminal', () => {
  it('records that the authored lesson was delivered as pre-rendered audio', () => {
    expect(widget).toMatch(
      /if \(msg\.source === 'guided_topic_narration'\) \{\s*\n\s*_s\._guidedTopicNarrated = true;/,
    );
  });

  it('ends teaching at turn-1 complete ONLY when it was actually narrated', () => {
    // Without the _guidedTopicNarrated conjunct this fires on the
    // Polly-failure path too and cuts a live lesson short (VTID-03680).
    expect(widget).toMatch(
      /if \(\s*\n\s*_s\._guidedTopicInFlight &&\s*\n\s*_s\._guidedTopicNarrated &&\s*\n\s*!_s\._guidedTopicTeachingEnded\s*\n\s*\)/,
    );
  });

  it('routes the close through the one shared teardown, not a second copy', () => {
    // _endGuidedTopicTeaching owns the completion signal, the flag clearing
    // and the backstop-interval cleanup. A hand-rolled _hide() here would
    // drift from the other end paths.
    expect(widget).toMatch(
      /_endGuidedTopicTeaching\(_narratedTopicId, 'narration_complete'\);/,
    );
  });

  it('the shared teardown still hides the overlay and credits completion', () => {
    const body = extractFunctionBody(
      widget,
      'function _endGuidedTopicTeaching(topicId, reason) {',
    );
    expect(body).toMatch(/_hide\(\);/);
    expect(body).toMatch(/_cfg\.onGuidedTopicTeachingEnd\(topicId, reason\)/);
  });

  it('cannot replay: the shared teardown marks teaching ended synchronously', () => {
    const body = extractFunctionBody(
      widget,
      'function _endGuidedTopicTeaching(topicId, reason) {',
    );
    const guardIdx = body.indexOf('if (_s._guidedTopicTeachingEnded)');
    const setIdx = body.indexOf('_s._guidedTopicTeachingEnded = true;');
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(setIdx).toBeGreaterThan(guardIdx);
    // and the resume predicate consults exactly that flag
    const resume = extractFunctionBody(
      widget,
      'function _shouldResumeGuidedTopic() {',
    );
    expect(resume).toMatch(/if \(_s\._guidedTopicTeachingEnded\) return false;/);
  });

  it('does not fall through to the conversational path once it has closed', () => {
    const idx = widget.indexOf("_endGuidedTopicTeaching(_narratedTopicId, 'narration_complete');");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(widget.slice(idx, idx + 200)).toMatch(/return;/);
  });
});

describe('VTID-03800 narration flag lifecycle', () => {
  it('is declared in the initial state', () => {
    expect(widget).toMatch(/_guidedTopicNarrated: false,/);
  });

  it('resets on a fresh tap — a previous topic must not close this one early', () => {
    const body = extractFunctionBody(widget, 'focusGuidedTopic: function (topicId) {');
    expect(body).toMatch(/_s\._guidedTopicNarrated = false;/);
  });

  it('is cleared by _hide, same lifecycle as _guidedTopicInFlight', () => {
    const body = extractFunctionBody(widget, 'function _hide() {');
    expect(body).toMatch(/_s\._guidedTopicNarrated = false;/);
  });
});
