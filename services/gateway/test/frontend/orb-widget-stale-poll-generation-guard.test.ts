/**
 * VTID-03763 — stale-poll clobber on a fresh guided-topic tap.
 *
 * Live-reported regression (My Journey tap): a real, deliberate tap on a
 * guided-topic session sometimes never reached the server with
 * guided_topic_id at all — confirmed via two independent server-side
 * signals in oasis_events (the wake-brief candidate list showing
 * all_sources_skipped, and live-session-controller.ts's isGuidedTopicSession
 * fast-path selecting the slow bootstrap path instead) — so Vitana opened
 * generic new-day conversation instead of teaching the tapped topic.
 *
 * Root cause: several polling loops in this file
 * (_waitForAudioEnd/_waitForGoodbyeEnd/_waitForNavReady, and the VTID-03762
 * backstop's _endGuidedTopicTeaching) recheck `_s.active` on every tick as
 * their ONLY staleness guard. `_s.active` is a module-level flag shared by
 * every session, not scoped to the poll's own session — so a poll spawned
 * by session N's turn-complete can survive past session N's teardown, and
 * by the time its next 300ms tick fires, session N+1 (a genuinely fresh
 * tap) has already flipped `_s.active` back to true. The stale poll then
 * misreads "a session is active" as "my session is still active" and goes
 * on to clobber the NEW session's freshly-armed `_s.guidedTopic` /
 * `_s.guidedAutoClose` (in _waitForAudioEnd's turn-complete branch) — or,
 * in the other three loops, to _hide()/navigate/end-teaching a session
 * that isn't even the one it was polling for.
 *
 * Fix: a monotonic `_s._sessionGeneration` counter, bumped at both
 * `_s.active = true` sites (SSE and WS session-start success). Each poll
 * loop captures the generation at creation and bails — before touching
 * ANY `_s.*` state — the moment it no longer matches.
 */

import * as fs from 'fs';
import * as path from 'path';

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);
const source = fs.readFileSync(WIDGET_PATH, 'utf8');

function extractBlock(anchor: string, openBraceSearchStart?: string): string {
  const anchorIdx = source.indexOf(anchor);
  expect(anchorIdx).toBeGreaterThan(-1);
  const searchFrom = openBraceSearchStart ? source.indexOf(openBraceSearchStart, anchorIdx) : anchorIdx;
  expect(searchFrom).toBeGreaterThan(-1);
  const openIdx = source.indexOf('{', searchFrom);
  expect(openIdx).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) {
      let end = i + 1;
      // Include a trailing IIFE invocation, e.g. `})(_s._sessionGeneration);`,
      // if the matched brace is immediately followed by one.
      const tail = source.slice(end, end + 40);
      const invocationMatch = tail.match(/^\)\(_s\._sessionGeneration\);/);
      if (invocationMatch) end += invocationMatch[0].length;
      return source.slice(anchorIdx, end);
    }
  }
  throw new Error(`unclosed block: ${anchor}`);
}

describe('VTID-03763: _s._sessionGeneration exists and is bumped on every real session start', () => {
  it('is declared on the initial _s state, starting at 0', () => {
    expect(source).toMatch(/_sessionGeneration:\s*0,/);
  });

  it('is incremented at the SSE session-start success site (right after _s.active = true)', () => {
    const idx = source.indexOf("_s.sessionId = data.session_id;");
    expect(idx).toBeGreaterThan(-1);
    const nearby = source.slice(idx, idx + 400);
    expect(nearby).toMatch(/_s\.active = true;/);
    const activeIdx = nearby.indexOf('_s.active = true;');
    const genIdx = nearby.indexOf('_s._sessionGeneration++;');
    expect(genIdx).toBeGreaterThan(-1);
    expect(genIdx).toBeGreaterThan(activeIdx);
  });

  it('is incremented at the WS session-start success site (right after _s.active = true)', () => {
    const idx = source.indexOf("_s.sessionId = msg.session_id;");
    expect(idx).toBeGreaterThan(-1);
    const nearby = source.slice(idx, idx + 400);
    expect(nearby).toMatch(/_s\.active = true;/);
    const activeIdx = nearby.indexOf('_s.active = true;');
    const genIdx = nearby.indexOf('_s._sessionGeneration++;');
    expect(genIdx).toBeGreaterThan(-1);
    expect(genIdx).toBeGreaterThan(activeIdx);
  });
});

describe('VTID-03763: _waitForAudioEnd (turn_complete) bails on a stale generation before touching any _s.* state', () => {
  it('captures myGen from _s._sessionGeneration at IIFE invocation', () => {
    const block = extractBlock("case 'turn_complete':", '(function (myGen) {');
    expect(block).toMatch(/\(function \(myGen\) \{/);
    expect(block).toMatch(/\}\)\(_s\._sessionGeneration\);\s*$/);
  });

  it('checks the generation guard as the FIRST statement in the poll tick, before the pre-existing !_s.active check', () => {
    const block = extractBlock("case 'turn_complete':", '(function (myGen) {');
    const genCheckIdx = block.indexOf('if (_s._sessionGeneration !== myGen) return;');
    const activeCheckIdx = block.indexOf('if (!_s.active) return;');
    expect(genCheckIdx).toBeGreaterThan(-1);
    expect(activeCheckIdx).toBeGreaterThan(-1);
    expect(genCheckIdx).toBeLessThan(activeCheckIdx);
  });

  it('the generation guard precedes the guidedAutoClose/guidedTopic clobber this bug actually caused', () => {
    const block = extractBlock("case 'turn_complete':", '(function (myGen) {');
    const genCheckIdx = block.indexOf('if (_s._sessionGeneration !== myGen) return;');
    const clobberIdx = block.indexOf('_s.guidedTopic = null;');
    expect(genCheckIdx).toBeGreaterThan(-1);
    expect(clobberIdx).toBeGreaterThan(-1);
    expect(genCheckIdx).toBeLessThan(clobberIdx);
  });
});

describe('VTID-03763: _waitForGoodbyeEnd (signup/login close) bails on a stale generation', () => {
  it('captures myGen and checks it before either scheduled _hide()/redirect', () => {
    const block = extractBlock("_signupCloseAttempts = 0;", '(function (myGen) {');
    expect(block).toMatch(/\(function \(myGen\) \{/);
    expect(block).toMatch(/\}\)\(_s\._sessionGeneration\);\s*$/);
    const firstGenCheckIdx = block.indexOf('if (_s._sessionGeneration !== myGen) return;');
    const hideIdx = block.indexOf('_hide();');
    expect(firstGenCheckIdx).toBeGreaterThan(-1);
    expect(hideIdx).toBeGreaterThan(-1);
    expect(firstGenCheckIdx).toBeLessThan(hideIdx);
    // Guarded twice: once before the re-poll decision, once before the final
    // hide/redirect grace-period callback (a second setTimeout).
    const occurrences = (block.match(/if \(_s\._sessionGeneration !== myGen\) return;/g) || []).length;
    expect(occurrences).toBe(2);
  });
});

describe('VTID-03763: _waitForNavReady (orb_directive navigate) bails on a stale generation', () => {
  it('captures myGen and checks it before tearing down audio/navigating/hiding', () => {
    const block = extractBlock("_navAttempts = 0;", '(function (myGen) {');
    expect(block).toMatch(/\(function \(myGen\) \{/);
    expect(block).toMatch(/\}\)\(_s\._sessionGeneration\);\s*$/);
    const firstGenCheckIdx = block.indexOf('if (_s._sessionGeneration !== myGen) return;');
    const teardownIdx = block.indexOf('_s.audioQueue = [];');
    expect(firstGenCheckIdx).toBeGreaterThan(-1);
    expect(teardownIdx).toBeGreaterThan(-1);
    expect(firstGenCheckIdx).toBeLessThan(teardownIdx);
    const occurrences = (block.match(/if \(_s\._sessionGeneration !== myGen\) return;/g) || []).length;
    expect(occurrences).toBe(2);
  });
});

describe('VTID-03763: _endGuidedTopicTeaching (VTID-03762 shared helper) bails on a stale generation', () => {
  it('pins myGen at function entry, before the poll IIFE is even created', () => {
    const block = extractBlock('function _endGuidedTopicTeaching(topicId, reason) {');
    const myGenIdx = block.indexOf('var myGen = _s._sessionGeneration;');
    const iifeIdx = block.indexOf('(function _waitForGuidedTeachingAudioDrained()');
    expect(myGenIdx).toBeGreaterThan(-1);
    expect(iifeIdx).toBeGreaterThan(-1);
    expect(myGenIdx).toBeLessThan(iifeIdx);
  });

  it('checks the generation guard before _hide() / the onGuidedTopicTeachingEnd callback', () => {
    const block = extractBlock('function _endGuidedTopicTeaching(topicId, reason) {');
    const firstGenCheckIdx = block.indexOf('if (_s._sessionGeneration !== myGen) return;');
    const hideIdx = block.indexOf('_hide();');
    expect(firstGenCheckIdx).toBeGreaterThan(-1);
    expect(hideIdx).toBeGreaterThan(-1);
    expect(firstGenCheckIdx).toBeLessThan(hideIdx);
    const occurrences = (block.match(/if \(_s\._sessionGeneration !== myGen\) return;/g) || []).length;
    expect(occurrences).toBe(2);
  });
});
