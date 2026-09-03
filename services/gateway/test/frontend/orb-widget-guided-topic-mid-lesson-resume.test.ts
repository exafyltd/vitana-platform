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

  // RE-RECORDED (VTID-03799). This assertion used to pin the literal
  // condition `if (_s._guidedTopicInFlight && !_s.guidedTopic)`. That
  // condition was correct but INCOMPLETE — it never asked whether the lesson
  // had already finished, so a post-lesson reconnect re-armed the topic and
  // replayed the whole narration (live, T005, staging 2026-08-31). Both of
  // its conjuncts now live inside _shouldResumeGuidedTopic() alongside the
  // missing teaching-ended check, and the test below pins them there, so
  // this re-record relocates the guard without weakening it.
  it('_attemptReconnect re-arms _s.guidedTopic from _guidedTopicInFlight only when _shouldResumeGuidedTopic() allows it', () => {
    const body = extractFunctionBody(source, 'function _attemptReconnect() {');
    expect(body).toMatch(
      /if \(_shouldResumeGuidedTopic\(\)\) {\s*\n[\s\S]*?_s\.guidedTopic = _s\._guidedTopicInFlight;/,
    );
    // The superseded literal must not survive anywhere in this function —
    // a second, ungated re-arm would reopen the replay loop.
    expect(body).not.toMatch(/if \(_s\._guidedTopicInFlight && !_s\.guidedTopic\)/);
    // Must run BEFORE _sessionStart() is called in the retry, not after.
    const armIdx = body.indexOf('_s.guidedTopic = _s._guidedTopicInFlight;');
    const startIdx = body.indexOf('_sessionStart().then(');
    expect(armIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(-1);
    expect(armIdx).toBeLessThan(startIdx);
  });

  // The guard the three call sites delegate to. This is where the two
  // conjuncts the old literal spelled out now live — asserted here so the
  // re-records above cannot quietly stand on a predicate that dropped one.
  it('_shouldResumeGuidedTopic() keeps both original conjuncts and adds the teaching-ended check', () => {
    const pred = extractFunctionBody(source, 'function _shouldResumeGuidedTopic() {');
    expect(pred).toMatch(/if \(!_s\._guidedTopicInFlight\) return false;/); // nothing to resume
    expect(pred).toMatch(/if \(_s\.guidedTopic\) return false;/);           // already armed
    expect(pred).toMatch(/if \(_s\._guidedTopicTeachingEnded\) return false;/); // lesson is over
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

  // RE-RECORDED (VTID-03799) — see the note on the _attemptReconnect test
  // above. "Same condition as _attemptReconnect" is now literally true by
  // construction: both call the one predicate rather than each spelling the
  // condition out, which is what let the teaching-ended check go missing
  // from all three copies at once.
  it('re-arms _s.guidedTopic from _guidedTopicInFlight only when _shouldResumeGuidedTopic() allows it — same predicate as _attemptReconnect', () => {
    expect(body).toMatch(
      /if \(_shouldResumeGuidedTopic\(\)\) {\s*\n[\s\S]*?_s\.guidedTopic = _s\._guidedTopicInFlight;/,
    );
    expect(body).not.toMatch(/if \(_s\._guidedTopicInFlight && !_s\.guidedTopic\)/);
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

  // RE-RECORDED (VTID-03799): the send-site literal
  // `if (!_s.guidedTopic && _s._guidedTopicInFlight)` is the same guard as
  // the other two, written in the other order, and it too never asked
  // whether the lesson was already over. This site is the one that can
  // never be bypassed, so it is also the one that replayed the narration on
  // every post-lesson reconnect. The ordering requirement below — restore
  // BEFORE the payload read — is unchanged and still the point of the test.
  it('restores guidedTopic from _guidedTopicInFlight via _shouldResumeGuidedTopic(), immediately before the payload read', () => {
    expect(body).toMatch(
      /if \(_shouldResumeGuidedTopic\(\)\) {\s*\n[\s\S]*?_s\.guidedTopic = _s\._guidedTopicInFlight;/,
    );
    expect(body).not.toMatch(/if \(!_s\.guidedTopic && _s\._guidedTopicInFlight\)/);
    const restoreIdx = body.indexOf('_s.guidedTopic = _s._guidedTopicInFlight;');
    const payloadReadIdx = body.indexOf('startPayload.guided_topic_id = _s.guidedTopic;');
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(payloadReadIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeLessThan(payloadReadIdx);
  });

  it('does not touch guidedTopic when it is already set (no-op on a fresh, non-reconnect open)', () => {
    // Unchanged invariant, now enforced inside the predicate: a truthy
    // guidedTopic must short-circuit before _guidedTopicInFlight is read.
    const pred = extractFunctionBody(source, 'function _shouldResumeGuidedTopic() {');
    expect(pred).toMatch(/if \(_s\.guidedTopic\) return false;/);
  });

  it('logs the restore for future diagnosability', () => {
    expect(body).toMatch(/restoring at send site \(VTID-03774\)/);
  });

  it('logs guidedTopic/guidedTopicInFlight/preDisconnectStage state on every _sessionStart call', () => {
    expect(body).toMatch(/_sessionStart: guidedTopic=.*guidedTopicInFlight=.*preDisconnectStage=/s);
  });

  it('the existing _attemptReconnect/_resetAndReconnect restore-guards are still present (this is additive, not a replacement)', () => {
    // RE-RECORDED (VTID-03799): all three sites now share one predicate, so
    // "the other two are unchanged" is asserted as "the other two still
    // guard their re-arm at all" — the property this test exists for. A
    // site that lost its guard entirely still fails here.
    const attemptBody = extractFunctionBody(source, 'function _attemptReconnect() {');
    const resetBody = extractFunctionBody(source, 'function _resetAndReconnect() {');
    expect(attemptBody).toMatch(/if \(_shouldResumeGuidedTopic\(\)\) {/);
    expect(resetBody).toMatch(/if \(_shouldResumeGuidedTopic\(\)\) {/);
  });
});

// VTID-03774 (Codex review follow-up on VTID-03774's own reconnect fix) —
// Codex flagged: once the client reliably resends guided_topic_id on ANY
// qualifying reconnect (this file's own VTID-03774 block above), a reconnect
// AFTER real teaching audio has already played would re-synthesize and
// replay the FULL narration from the beginning and re-inject the verbatim
// "say this opener" instruction — restarting/duplicating already-heard
// content instead of resuming. Fix: a new _guidedTopicAudioDelivered flag,
// armed false on a fresh tap and flipped true at the exact point turn-1
// audio is known delivered (the same point that nulls _s.guidedTopic per
// VTID-03675), sent to the server as `guided_topic_resume` whenever it's
// true — so the server can skip re-synthesis/re-opening while still
// bundling the topic context (see guided-topic-narration.ts's isResume).
describe('orb-widget guided-topic resume signal — _guidedTopicAudioDelivered (VTID-03774)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('is declared in the initial _s state, defaulting to false', () => {
    expect(source).toMatch(/_guidedTopicAudioDelivered:\s*false,/);
  });

  it('focusGuidedTopic resets it to false on every fresh tap', () => {
    const body = extractFunctionBody(source, 'focusGuidedTopic: function (topicId) {');
    expect(body).toMatch(/_s\._guidedTopicAudioDelivered = false;/);
    // Must run AFTER _guidedTopicInFlight is armed, in the same fresh-tap block.
    const inFlightIdx = body.indexOf('_s._guidedTopicInFlight = _s.guidedTopic;');
    const resetIdx = body.indexOf('_s._guidedTopicAudioDelivered = false;');
    expect(inFlightIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeGreaterThan(inFlightIdx);
  });

  // RE-RECORDED (VTID-03799). This used to require the flag be flipped
  // INSIDE the `if (_s.guidedAutoClose && !_s.greetingComplete)` block — and
  // that nesting was the bug. guidedAutoClose is a one-shot: it is cleared
  // on the first turn-complete and re-armed only by a fresh tap, so every
  // LATER turn-complete left the delivered flag unset. A reconnect after the
  // lesson then told the server "fresh open" instead of "resume", which is
  // what replayed the entire Polly narration (live, T005, 2026-08-31).
  // The flag is still flipped at the same turn-complete point, immediately
  // before that block — just no longer gated by a one-shot that has nothing
  // to do with whether audio was delivered.
  it('is flipped true at the turn-complete point, on its own condition, OUTSIDE the one-shot guidedAutoClose block', () => {
    const autoCloseIdx = source.indexOf('if (_s.guidedAutoClose && !_s.greetingComplete) {');
    expect(autoCloseIdx).toBeGreaterThanOrEqual(0);
    const openIdx = source.indexOf('{', autoCloseIdx);
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < source.length; i++) {
      const c = source[i];
      if (c === '{') depth++;
      if (c === '}') depth--;
      if (depth === 0) { closeIdx = i; break; }
    }
    const autoCloseBlock = source.slice(autoCloseIdx, closeIdx + 1);

    // The auto-close block still nulls guidedTopic (VTID-03675, unchanged)
    // and must NOT be what governs the delivered flag any more.
    expect(autoCloseBlock).toMatch(/_s\.guidedTopic = null/);
    expect(autoCloseBlock).not.toMatch(/_guidedTopicAudioDelivered/);

    // The flag has its own gate — a guided topic is in flight and turn-1
    // audio just finished — and it sits immediately before the auto-close.
    const flagIdx = source.indexOf(
      'if (_s._guidedTopicInFlight && !_s.greetingComplete) {\n              _s._guidedTopicAudioDelivered = true;',
    );
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(flagIdx).toBeLessThan(autoCloseIdx);
  });

  it('_hide() clears it — a real close ends the overlay session', () => {
    const body = extractFunctionBody(source, 'function _hide() {');
    expect(body).toMatch(/_s\._guidedTopicAudioDelivered = false;/);
  });

  it('_sessionStart sends guided_topic_resume only when both guidedTopic AND the delivered flag are set', () => {
    const body = extractFunctionBody(source, 'async function _sessionStart() {');
    expect(body).toMatch(
      /if \(_s\.guidedTopic\) {\s*\n\s*startPayload\.guided_topic_id = _s\.guidedTopic;[\s\S]*?if \(_s\._guidedTopicAudioDelivered\) {\s*\n\s*startPayload\.guided_topic_resume = true;/,
    );
  });

  it('the resume field is nested inside the guidedTopic block, so it can never be sent without guided_topic_id', () => {
    const body = extractFunctionBody(source, 'async function _sessionStart() {');
    const outerIdx = body.indexOf('if (_s.guidedTopic) {\n        startPayload.guided_topic_id');
    expect(outerIdx).toBeGreaterThan(-1);
    // Find the matching close brace of the outer `if (_s.guidedTopic) {` block.
    const openIdx = body.indexOf('{', outerIdx);
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < body.length; i++) {
      const c = body[i];
      if (c === '{') depth++;
      if (c === '}') depth--;
      if (depth === 0) { closeIdx = i; break; }
    }
    const outerBlock = body.slice(outerIdx, closeIdx + 1);
    expect(outerBlock).toMatch(/startPayload\.guided_topic_resume = true;/);
  });
});
