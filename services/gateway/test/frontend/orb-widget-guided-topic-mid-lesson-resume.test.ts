import * as fs from 'fs';
import * as path from 'path';

// VTID-03746 — two defects live-reproduced on staging via a real guided-topic
// tap (topic T007, oasis_events trace 2026-08-26 08:45-08:46 UTC), both
// distinct from VTID-03727's earlier caption/cadence fixes:
//
// 1. _announceDisconnect() plays a spoken alert clip ("Einen Moment, ich
//    verbinde mich neu...") completely UNCONDITIONALLY — no gating on
//    whether anything has been heard yet, unlike every other reconnect cue
//    in this file (VTID-03685's WS-error suppression, VTID-03727's caption
//    fix). Reported verbatim: "first thing i hear is: einen moment die
//    verbindung wird wieder hergestellt."
//
// 2. The session actually won T007 and taught it for real (44s, 497 audio
//    chunks per oasis_events — VTID-03727's fixes are working). The
//    connection then dropped MID-LESSON. By that point the turn-complete
//    handler had already nulled _s.guidedTopic (VTID-03675's "delivered,
//    don't re-offer" rule, which assumed turn-1-complete == fully taught).
//    The reconnect had nothing to resume and fell through to a generic
//    greeting instead of continuing the SAME topic. Reported verbatim:
//    "then vitana starts talking and its a new day greeting instead of
//    reading the session."
//
// Static source checks (same approach as the sibling orb-widget suites): the
// widget is a plain browser IIFE with no export surface.

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);

function extractFunctionBody(source: string, signature: string): string {
  const sigIdx = source.indexOf(signature);
  expect(sigIdx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', sigIdx);
  expect(openIdx).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return source.slice(openIdx + 1, i);
  }
  throw new Error(`unclosed function body: ${signature}`);
}

describe('orb-widget _announceDisconnect spoken alert gating (VTID-03746)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');
  const body = extractFunctionBody(source, 'function _announceDisconnect(reason) {');

  it('does not call _playAlert unconditionally', () => {
    // The old regression: a bare, unconditional call right after _setStatus.
    expect(body).not.toMatch(/_updateUI\(\);\s*\n\s*_playAlert\(/);
  });

  it('gates the spoken alert clip on _audioEverHeardThisOpen', () => {
    expect(body).toMatch(/if \(_s\._audioEverHeardThisOpen\) {\s*\n\s*_playAlert\('disconnect-' \+ reason \+ '-' \+ clipLang\);/);
  });

  it('still plays the alert once real audio has been heard (no regression to the normal case)', () => {
    // The gate must be a real if/else, not a silent drop — the else branch
    // exists and is the ONLY thing suppressed; a genuine mid-conversation
    // disconnect (real audio already played) must still get the spoken cue.
    expect(body).toMatch(/} else {\s*\n\s*console\.log\('\[VTOrb\] _announceDisconnect: suppressing spoken alert clip/);
  });

  it('the visual status label (_setStatus) is unaffected by this gate — still set every time', () => {
    expect(body).toMatch(/_setStatus\(label\);/);
  });
});

describe('orb-widget guided-topic mid-lesson resume via _guidedTopicInFlight (VTID-03746)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('is declared in the initial _s state, defaulting to null', () => {
    expect(source).toMatch(/_guidedTopicInFlight:\s*null,/);
  });

  it('focusGuidedTopic arms it alongside _s.guidedTopic', () => {
    const body = extractFunctionBody(source, 'focusGuidedTopic: function (topicId) {');
    expect(body).toMatch(/_s\.guidedTopic = \(typeof topicId === 'string' && topicId\) \? topicId : null/);
    expect(body).toMatch(/_s\._guidedTopicInFlight = _s\.guidedTopic;/);
    // Must be set AFTER guidedTopic, from its final value, not independently.
    expect(body.indexOf('_s.guidedTopic = (typeof topicId'))
      .toBeLessThan(body.indexOf('_s._guidedTopicInFlight = _s.guidedTopic;'));
  });

  it('is NOT cleared at the first-turn-complete point that nulls _s.guidedTopic', () => {
    // This is the entire point of the fix: guidedTopic gets nulled once the
    // opener turn completes (VTID-03675's "delivered" signal), but
    // _guidedTopicInFlight must survive THAT specific clear so a later
    // mid-lesson disconnect can still resume the topic.
    const idx = source.indexOf('if (_s.guidedAutoClose && !_s.greetingComplete) {');
    expect(idx).toBeGreaterThanOrEqual(0);
    const openIdx = source.indexOf('{', idx);
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < source.length; i++) {
      const c = source[i];
      if (c === '{') depth++;
      if (c === '}') depth--;
      if (depth === 0) { closeIdx = i; break; }
    }
    const block = source.slice(idx, closeIdx + 1);
    expect(block).toMatch(/_s\.guidedTopic = null/);
    expect(block).not.toMatch(/_guidedTopicInFlight/);
  });

  it('_attemptReconnect re-arms _s.guidedTopic from _guidedTopicInFlight only when guidedTopic was already cleared', () => {
    const body = extractFunctionBody(source, 'function _attemptReconnect() {');
    expect(body).toMatch(
      /if \(_s\._guidedTopicInFlight && !_s\.guidedTopic\) {\s*\n[\s\S]*?_s\.guidedTopic = _s\._guidedTopicInFlight;/,
    );
    // Must run BEFORE _sessionStart() is called in the retry, not after.
    const armIdx = body.indexOf('_s.guidedTopic = _s._guidedTopicInFlight;');
    const startIdx = body.indexOf('_sessionStart().then(');
    expect(armIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(-1);
    expect(armIdx).toBeLessThan(startIdx);
  });

  it('_hide() clears _guidedTopicInFlight — a real close ends the overlay session', () => {
    const body = extractFunctionBody(source, 'function _hide() {');
    expect(body).toMatch(/_s\._guidedTopicInFlight = null;/);
  });
});

// VTID-03770 — _attemptReconnect() got the VTID-03746 restore guard above,
// but _resetAndReconnect() (the 5s health-probe watchdog's reconnect path,
// and the tap-to-reconnect stuck-state button) did not: it rebuilt the
// session via a plain _sessionStart() with no restore at all. Live-
// reproduced again (staging, topic T005, same shape as the VTID-03746 T007
// report this file already documents above): a guided-topic session
// delivered its opener, ran a real 37.7s/335-chunk conversational turn, the
// underlying connection dropped, and the reconnected session carried no
// guided_topic_id (every wake-brief candidate came back
// "all_sources_skipped") — falling through to a generic opener instead of
// resuming T005. Reported again, verbatim: "you can hear that sound like
// Orb is again switched on, and it just continues with the New Day
// Greeting."
describe('orb-widget _resetAndReconnect guided-topic resume + reconnect mutex (VTID-03770)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');
  const body = extractFunctionBody(source, 'function _resetAndReconnect() {');

  it('re-arms _s.guidedTopic from _guidedTopicInFlight only when guidedTopic was already cleared — same condition as _attemptReconnect', () => {
    expect(body).toMatch(
      /if \(_s\._guidedTopicInFlight && !_s\.guidedTopic\) {\s*\n[\s\S]*?_s\.guidedTopic = _s\._guidedTopicInFlight;/,
    );
    // Must run BEFORE _sessionStart() is called, not after.
    const armIdx = body.indexOf('_s.guidedTopic = _s._guidedTopicInFlight;');
    const startIdx = body.indexOf('_sessionStart().then(');
    expect(armIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(-1);
    expect(armIdx).toBeLessThan(startIdx);
  });

  it('sets _isReconnecting = true before starting the reconnect — the health-probe watchdog\'s own "if (_s._isReconnecting) return;" guard is otherwise inert', () => {
    // The old regression: this function set _isReconnecting = FALSE at its
    // own top, so a second 5s probe tick landing while _sessionStart() was
    // still in flight could fire a second, concurrent _resetAndReconnect().
    expect(body).toMatch(/_s\._isReconnecting = true;/);
    expect(body).not.toMatch(/_s\._reconnectCount = 0;\s*\n\s*_s\._isReconnecting = false;/);
  });

  it('resets _isReconnecting = false once _sessionStart() settles, on both the success and failure branch', () => {
    const thenIdx = body.indexOf('_sessionStart().then(function () {');
    expect(thenIdx).toBeGreaterThanOrEqual(0);
    const thenBranch = body.slice(thenIdx, body.indexOf('.catch(function (err) {'));
    expect(thenBranch).toMatch(/_s\._isReconnecting = false;/);
    const catchBranch = body.slice(body.indexOf('.catch(function (err) {'));
    expect(catchBranch).toMatch(/_s\._isReconnecting = false;/);
  });

  it('the guided-topic re-arm runs before the _isReconnecting reset in the settle handlers (arm is a pre-start setup step, not a settle step)', () => {
    const armIdx = body.indexOf('_s.guidedTopic = _s._guidedTopicInFlight;');
    const startIdx = body.indexOf('_sessionStart().then(');
    const settleResetIdx = body.indexOf('_s._isReconnecting = false;', startIdx);
    expect(armIdx).toBeGreaterThan(-1);
    expect(settleResetIdx).toBeGreaterThan(-1);
    expect(armIdx).toBeLessThan(settleResetIdx);
  });
});

// VTID-03774 — despite _attemptReconnect() and _resetAndReconnect() both
// carrying the VTID-03746/03770 restore-guard, a real staging trace (topic
// T003, real account, SSE transport) still showed a mid-lesson reconnect
// going out with NO guided_topic_id. Server-side proof: the reconnected
// session's wake-timeline recorded guided_topic_narration's own decision as
// `reason:"no_topic_tapped"` — the field never reached the server, from a
// reconnect whose disconnect-stage also came through "idle" rather than the
// "speaking" the in-flight narration audio should have produced, i.e. this
// particular reconnect did not visibly originate from either restore-guarded
// caller. Rather than keep chasing which (possibly still-undiscovered)
// caller has the gap, the restore is now ALSO applied at the one place that
// can never be bypassed: _sessionStart() itself, immediately before the
// field is read into the outgoing payload — structurally closing the gap
// regardless of which function got the widget there.
describe('orb-widget _sessionStart restores guidedTopic from _guidedTopicInFlight at the send site (VTID-03774)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');
  const body = extractFunctionBody(source, 'async function _sessionStart() {');

  it('restores guidedTopic from _guidedTopicInFlight when guidedTopic is empty, immediately before the payload read', () => {
    expect(body).toMatch(
      /if \(!_s\.guidedTopic && _s\._guidedTopicInFlight\) {\s*\n[\s\S]*?_s\.guidedTopic = _s\._guidedTopicInFlight;/,
    );
    const restoreIdx = body.indexOf('_s.guidedTopic = _s._guidedTopicInFlight;');
    const payloadReadIdx = body.indexOf('startPayload.guided_topic_id = _s.guidedTopic;');
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(payloadReadIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeLessThan(payloadReadIdx);
  });

  it('does not touch guidedTopic when it is already set (no-op on a fresh, non-reconnect open)', () => {
    // The guard is `!_s.guidedTopic && ...` — a truthy guidedTopic must
    // short-circuit before ever reading _guidedTopicInFlight.
    const restoreLineMatch = body.match(/if \(!_s\.guidedTopic && _s\._guidedTopicInFlight\) {/);
    expect(restoreLineMatch).not.toBeNull();
  });

  it('logs the restore for future diagnosability', () => {
    expect(body).toMatch(/restoring at send site \(VTID-03774\)/);
  });

  it('logs guidedTopic/guidedTopicInFlight/preDisconnectStage state on every _sessionStart call', () => {
    expect(body).toMatch(/_sessionStart: guidedTopic=.*guidedTopicInFlight=.*preDisconnectStage=/s);
  });

  it('the existing _attemptReconnect/_resetAndReconnect restore-guards are unchanged (this is additive, not a replacement)', () => {
    const attemptBody = extractFunctionBody(source, 'function _attemptReconnect() {');
    const resetBody = extractFunctionBody(source, 'function _resetAndReconnect() {');
    expect(attemptBody).toMatch(/if \(_s\._guidedTopicInFlight && !_s\.guidedTopic\) {/);
    expect(resetBody).toMatch(/if \(_s\._guidedTopicInFlight && !_s\.guidedTopic\) {/);
  });
});
