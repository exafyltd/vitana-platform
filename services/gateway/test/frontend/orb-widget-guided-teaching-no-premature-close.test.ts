import * as fs from 'fs';
import * as path from 'path';

// VTID-03685 — the guided-topic overlay closed itself before Vitana ever
// taught anything.
//
// Live report (topics T252 "Dein Plan", T253 "Dein erster Schritt"): "First,
// it says 'einen Moment, ich verbinde mich neu'. And then it connects. And
// then Vitana Assistant says 'Hallo Dragan. Ich zeige dir jetzt deinen
// Plan.' And then it opens a screen instead of reading the session... What's
// completely missing is reading the session."
//
// Traced live via oasis_events: both sessions sent `upstream_closed
// reason:"user_stop"` at `turn_count:1`, ~5s after `turn_complete` for turn
// 1 (the ~1s opener line) — the CLIENT told the server to stop right after
// the opener, before the multi-paragraph voice_script content (delivered
// conversationally across turns 2+ per the GUIDE-MODE system-instruction
// block) ever had a chance to be spoken.
//
// Root cause: VTID-03294's guidedAutoClose called _hide() (which sends the
// stop) the instant turn 1's audio finished — correct back when turn 1 WAS
// the whole lesson (VTID-03293), stale ever since VTID-03650/03665 shrank
// turn 1 to a short opener and moved the real teaching to turns 2+.
//
// Static source checks (same approach as the sibling orb-widget suites): the
// widget is a plain browser IIFE with no export surface, so the invariants
// are asserted against the source text.

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);

function extractBlock(source: string, marker: string): string {
  const idx = source.indexOf(marker);
  expect(idx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', idx);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return source.slice(idx, i + 1);
  }
  throw new Error(`unclosed block: ${marker}`);
}

describe('orb-widget guided teaching does not close before it starts (VTID-03685)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('the turn-1-complete handler never calls _hide() or _sessionStop() for a guided open', () => {
    const block = extractBlock(source, "if (_s.guidedAutoClose && !_s.greetingComplete) {");
    expect(block).not.toMatch(/_hide\(\)/);
    expect(block).not.toMatch(/_sessionStop\(\)/);
  });

  it('a NON-narrated guided open still falls through to the listening transition', () => {
    // The VTID-03685 regression was a `return` right after the guided branch,
    // which skipped the mic-arming code below entirely and killed the lesson
    // after the opener.
    //
    // VTID-03800 re-recorded this deliberately. There is now a SECOND early
    // return here — the one-shot terminal close for a topic whose whole
    // authored lesson was already delivered as pre-rendered Polly audio. That
    // is a real behaviour change, requested by the platform owner after a
    // staging session replayed the lesson three times.
    //
    // What this test still protects, and why it is not weakened: the new
    // return is GATED ON `_guidedTopicNarrated`. On the Polly-failure path
    // (VTID-03665) turn 1 is only a short opener and the teaching happens
    // across turns 2+, so that path must still fall through — an ungated
    // return would reintroduce VTID-03685/VTID-03680 exactly. So: the count
    // may be two, but the second one must carry that gate.
    const startIdx = source.indexOf("if (_s.guidedAutoClose && !_s.greetingComplete) {");
    const micStartIdx = source.indexOf('_afterBeepStartMic', startIdx);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(micStartIdx).toBeGreaterThan(startIdx);
    const between = source.slice(startIdx, micStartIdx);

    const returns = between.match(/\breturn;/g) || [];
    expect(returns.length).toBe(2);

    // (a) the pre-existing "overlay already torn down some other way" guard
    expect(between).toMatch(/if \(!_s\.active \|\| _s\._userRequestedClose \|\| !_s\.overlayVisible\) return;/);

    // (b) the narrated one-shot close — and it MUST be conditioned on the
    // narration flag, never on _guidedTopicInFlight alone.
    expect(between).toMatch(/_s\._guidedTopicNarrated &&/);
    const narratedIdx = between.indexOf('_s._guidedTopicNarrated &&');
    const closeIdx = between.indexOf("_endGuidedTopicTeaching(_narratedTopicId, 'narration_complete');");
    expect(closeIdx).toBeGreaterThan(narratedIdx);
  });

  it('still clears guidedAutoClose/guidedTopic so a later reconnect does not resend a delivered topic', () => {
    const block = extractBlock(source, "if (_s.guidedAutoClose && !_s.greetingComplete) {");
    expect(block).toMatch(/_s\.guidedAutoClose = false/);
    expect(block).toMatch(/_s\.guidedTopic = null/);
  });
});
