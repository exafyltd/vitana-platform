import * as fs from 'fs';
import * as path from 'path';

// VTID-03675 — a guided-topic tap lost its topic on client-side reconnect.
//
// Live report (2026-08-18, prod mobile): tapping a My Journey session ("Profile
// Basics" / T017) opened the orb, which said "Let's continue from where we
// left off" instead of teaching the topic, then immediately showed the
// session-completed drawer as if the lesson had happened.
//
// Traced live via oasis_events: focusGuidedTopic() set the one-shot
// `_s.guidedTopic`, and _sessionStart() nulled it the instant it read it into
// the FIRST session-start payload — before knowing whether that attempt would
// even succeed. That first session (live-92addc94...) got the guided-topic
// candidate correctly (wake_opener=override_v2), but Nova rejected it twice
// with `nova_validation` and the server gave up retrying internally. The
// widget's OWN _attemptReconnect() then tore the dead connection down and
// called _sessionStart() again — twice, as two more distinct session_ids
// (live-0a895ab4..., live-e0ae5329...) — and because `_s.guidedTopic` was
// already null, NEITHER retry requested a guided-topic candidate at all. The
// session that finally succeeded (live-e0ae5329...) fell back to a generic,
// much longer prompt (partly why it's a different rung entirely, not
// override_v2) that produced the "let's continue" line — while
// `_s.guidedAutoClose`, armed at the same moment as the now-lost
// `_s.guidedTopic`, still fired on that turn's completion and auto-closed
// the overlay to reveal the "session completed" drawer.
//
// Static source checks (same approach as the sibling orb-widget suites): the
// widget is a plain browser IIFE with no export surface, so the invariants
// are asserted against the source text.

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

/** The `if (_s.guidedTopic) { ... }` block inside _sessionStart. */
function guidedTopicPayloadBlock(source: string): string {
  const body = extractFunctionBody(source, 'async function _sessionStart()');
  const idx = body.indexOf('if (_s.guidedTopic) {');
  expect(idx).toBeGreaterThanOrEqual(0);
  const openIdx = body.indexOf('{', idx);
  let depth = 0;
  for (let i = openIdx; i < body.length; i++) {
    const c = body[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return body.slice(idx, i + 1);
  }
  throw new Error('unclosed guidedTopic payload block');
}

describe('orb-widget guided-topic reconnect (VTID-03675)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('reads guided_topic_id into the start payload without nulling _s.guidedTopic', () => {
    const block = guidedTopicPayloadBlock(source);
    expect(block).toMatch(/startPayload\.guided_topic_id = _s\.guidedTopic/);
    // The regression: this block used to immediately null the field it just
    // read, so a failed first attempt could never be retried with the topic
    // intact.
    expect(block).not.toMatch(/_s\.guidedTopic = null/);
  });

  it('a client-side reconnect (_attemptReconnect -> _sessionStart) can still see a pending guided topic', () => {
    // _attemptReconnect must not itself clear _s.guidedTopic before calling
    // _sessionStart again — if it did, the fix above would be moot.
    const body = extractFunctionBody(source, 'function _attemptReconnect(');
    expect(body).not.toMatch(/_s\.guidedTopic\s*=\s*null/);
  });

  it('clears guidedTopic in the SAME place guidedAutoClose is cleared on a completed guided turn', () => {
    const idx = source.indexOf("if (_s.guidedAutoClose && !_s.greetingComplete) {");
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
    expect(closeIdx).toBeGreaterThan(openIdx);
    const block = source.slice(idx, closeIdx + 1);
    expect(block).toMatch(/_s\.guidedAutoClose = false/);
    expect(block).toMatch(/_s\.guidedTopic = null/);
    // Order matters: both must be cleared BEFORE _hide() tears the session
    // down, not after (dead code) or only inside _hide() (too late for a
    // caller that reads guidedTopic between here and the _hide() call).
    const autoCloseIdx = block.indexOf('_s.guidedAutoClose = false');
    const guidedTopicIdx = block.indexOf('_s.guidedTopic = null');
    const hideIdx = block.indexOf('_hide()');
    expect(guidedTopicIdx).toBeGreaterThan(autoCloseIdx);
    expect(hideIdx).toBeGreaterThan(guidedTopicIdx);
  });

  it('_hide() also clears a never-delivered guided topic so it cannot leak into a later session', () => {
    const body = extractFunctionBody(source, 'function _hide()');
    expect(body).toMatch(/_s\.guidedAutoClose = false/);
    expect(body).toMatch(/_s\.guidedTopic = null/);
  });

  it('focusGuidedTopic still arms both flags together (unchanged contract)', () => {
    const body = extractFunctionBody(source, 'focusGuidedTopic: function (topicId) {');
    expect(body).toMatch(/_s\.guidedTopic = \(typeof topicId === 'string' && topicId\) \? topicId : null/);
    expect(body).toMatch(/_s\.guidedAutoClose = true/);
  });
});
