import * as fs from 'fs';
import * as path from 'path';

// VTID-03781 — idempotency guard on guided-topic teaching completion.
//
// Full lifecycle audit against a detailed platform-owner spec ("Fix My
// Journey Session Lifecycle — Strict Behavioral Requirement") found that
// the vast majority of the required state machine already exists and is
// correct, built up across VTID-03762/03763/03771/03774/03776/03778:
//   - two independent completion signals (model tool call
//     `end_guided_topic_teaching`, and the GUIDED_TOPIC_BACKSTOP_MS
//     5-minute safety-net timeout) both funnel into one shared teardown,
//     _endGuidedTopicTeaching()
//   - a session-generation guard stops a stale poll from a prior session
//     mutating a newer one
//   - focusGuidedTopic() clears any prior topic's backstop interval
//     synchronously before arming a new one, so an old topic's timer
//     cannot fire against a replacement topic
//   - completion is step-scoped (completePractice(topicId) in
//     vitana-v1's GuidedJourneyCatalog.tsx), not session-scoped
//   - _hide() (used by both the X button and every close path) stops
//     audio and closes the overlay synchronously, before any async
//     network teardown — the X button does not depend on Vitana
//     voluntarily stopping
//
// One real, verified gap: nothing stopped _endGuidedTopicTeaching() from
// running twice concurrently for the same teaching session — e.g. the
// model calls the tool right as the backstop's periodic check also trips
// (both read the same _guidedTopicOpenedAt/_sessionGeneration state, nothing
// serializes them), or a flaky transport delivers the directive twice. Each
// run drains audio then calls _hide() and fires the onGuidedTopicTeachingEnd
// host callback (-> vitana-v1's completePractice(topicId)) — a second
// concurrent run would fire that callback, and therefore the completion
// side effects, a second time for the same topic.
//
// Fix: a single boolean guard (_guidedTopicTeachingEnded), checked and set
// as the very first synchronous statement in _endGuidedTopicTeaching(),
// before any async poll starts. Every signal after the first becomes a
// no-op. Reset only on a fresh tap (focusGuidedTopic) — a new teaching
// session gets its own single completion.
//
// Static source checks — same pattern as the sibling
// guided-topic-teaching-complete-signal.test.ts (the widget is a plain
// browser IIFE with no export surface).

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

describe('orb-widget guided-topic completion idempotency guard (VTID-03781)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('declares the _guidedTopicTeachingEnded state flag, defaulting false', () => {
    expect(source).toMatch(/_guidedTopicTeachingEnded:\s*false,/);
  });

  it('_endGuidedTopicTeaching() checks the guard and returns before any async work if already ended', () => {
    const body = extractFunctionBody(
      source,
      'function _endGuidedTopicTeaching(topicId, reason) {',
    );
    const guardIdx = body.indexOf('if (_s._guidedTopicTeachingEnded)');
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    const returnIdx = body.indexOf('return;', guardIdx);
    expect(returnIdx).toBeGreaterThan(guardIdx);
    // The guard (check + set) must precede any async scheduling —
    // setTimeout is how the audio-drain poll is scheduled.
    const setIdx = body.indexOf('_s._guidedTopicTeachingEnded = true;');
    expect(setIdx).toBeGreaterThan(guardIdx);
    const firstSetTimeoutIdx = body.indexOf('setTimeout(');
    expect(firstSetTimeoutIdx).toBeGreaterThan(setIdx);
  });

  it('the guard set happens unconditionally on entry — not nested inside the audio-drain poll', () => {
    const body = extractFunctionBody(
      source,
      'function _endGuidedTopicTeaching(topicId, reason) {',
    );
    // Everything up to and including the guard-set must appear before the
    // function declares its `attempts` counter (the poll's own state),
    // confirming the guard runs first, synchronously, every single call.
    const setIdx = body.indexOf('_s._guidedTopicTeachingEnded = true;');
    const attemptsIdx = body.indexOf('var attempts = 0;');
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(attemptsIdx).toBeGreaterThan(setIdx);
  });

  it('focusGuidedTopic() resets the guard for a fresh tap, so a new teaching session gets its own completion', () => {
    const body = extractFunctionBody(source, 'focusGuidedTopic: function (topicId) {');
    expect(body).toMatch(/_s\._guidedTopicTeachingEnded = false;/);
  });

  it('_hide() does not also reset the guard mid-teaching (only a fresh tap re-arms it)', () => {
    // _hide() is called from WITHIN _endGuidedTopicTeaching() itself (after
    // the guard is already set) — if _hide() also reset the flag, a
    // concurrent second call could race back in after the first call's own
    // _hide() ran but before onGuidedTopicTeachingEnd fired.
    const body = extractFunctionBody(source, 'function _hide() {');
    expect(body).not.toMatch(/_guidedTopicTeachingEnded = false/);
  });
});
