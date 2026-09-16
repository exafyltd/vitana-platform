/**
 * VTID-03824
 *
 * Live-reported bug: the user says "okay du kannst jetzt ausschalten" ("okay
 * you can turn off now") — Vitana correctly speaks a farewell acknowledging
 * it, but the widget then flips into LISTENING mode (mic re-armed, ready
 * beep played) instead of actually closing. Root cause: there was no tool
 * the model could call to signal "the user wants to end the conversation",
 * so turn_complete's default path (see orb-widget-stale-poll-generation-
 * guard.test.ts's sibling coverage of that same function) unconditionally
 * re-armed the mic once the farewell audio finished draining.
 *
 * Fix mirrors the two existing narrowly-scoped end tools
 * (end_teaching_session, end_guided_topic_teaching): a new `end_conversation`
 * tool the model calls after speaking its own farewell, a server-side
 * `orb_directive` dispatch, and a widget-side handler that (1) sets
 * `_s.conversationEnding = true` BEFORE waiting for audio to drain — so
 * `_isClosingForNav()` makes the turn_complete poll bail instead of racing
 * a brief listening flash — and (2) calls `_hide()` once the farewell audio
 * has actually finished (not a fixed delay, so a longer farewell isn't cut
 * off).
 *
 * The widget is a plain IIFE with no export surface, so — same pattern as
 * orb-widget-stale-poll-generation-guard.test.ts and the guided-topic
 * reconnect suite referenced in the platform CHANGE LOG — this is a static
 * source-check test rather than an executed-DOM test.
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
      return source.slice(anchorIdx, i + 1);
    }
  }
  throw new Error(`unclosed block: ${anchor}`);
}

describe('VTID-03824: _isClosingForNav() also suppresses on conversationEnding', () => {
  it('OR-s in _s.conversationEnding alongside signupClosing/navigationPending', () => {
    const block = extractBlock('function _isClosingForNav() {');
    expect(block).toMatch(/_s\.signupClosing === true/);
    expect(block).toMatch(/_s\.navigationPending === true/);
    expect(block).toMatch(/_s\.conversationEnding === true/);
  });
});

describe('VTID-03824: orb_directive end_conversation handler', () => {
  it('exists as its own branch in the orb_directive switch', () => {
    expect(source).toMatch(/msg\.directive === 'end_conversation'/);
  });

  function extractHandlerBlock(): string {
    const idx = source.indexOf("msg.directive === 'end_conversation'");
    expect(idx).toBeGreaterThan(-1);
    // Grab a generous window rather than brace-matching an `else if` — find
    // the next `} else if (msg.directive ===` or the closing of the whole
    // switch's else-chain as the end boundary.
    const nextBranch = source.indexOf("} else {", idx);
    expect(nextBranch).toBeGreaterThan(idx);
    return source.slice(idx, nextBranch);
  }

  it('sets _s.conversationEnding = true BEFORE scheduling the audio-drain wait (so a racing turn_complete poll bails via _isClosingForNav)', () => {
    const block = extractHandlerBlock();
    const flagIdx = block.indexOf('_s.conversationEnding = true;');
    const waitIdx = block.indexOf('_waitForFarewellEnd');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(waitIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeLessThan(waitIdx);
  });

  it('waits for scheduled audio/queue to drain (does not hide on a fixed short delay that could clip a longer farewell)', () => {
    const block = extractHandlerBlock();
    expect(block).toMatch(/var stillPlaying = _s\.audioPlaying \|\|/);
    expect(block).toMatch(/_waitForFarewellEnd\(\);/);
  });

  it('captures and checks _s._sessionGeneration (VTID-03763 stale-poll guard) before hiding', () => {
    const block = extractHandlerBlock();
    expect(block).toMatch(/\(function \(myGen\) \{/);
    expect(block).toMatch(/if \(_s\._sessionGeneration !== myGen\) return;/);
    const genCheckIdx = block.indexOf('if (_s._sessionGeneration !== myGen) return;');
    const hideIdx = block.lastIndexOf('_hide();');
    expect(genCheckIdx).toBeGreaterThan(-1);
    expect(hideIdx).toBeGreaterThan(genCheckIdx);
  });

  it('calls _hide() to actually close the overlay, not just stop audio', () => {
    const block = extractHandlerBlock();
    expect(block).toMatch(/_hide\(\);/);
  });

  it('invokes an optional onConversationEnd host callback, defensively', () => {
    const block = extractHandlerBlock();
    expect(block).toMatch(/typeof _cfg\.onConversationEnd === 'function'/);
  });
});

describe('VTID-03824: conversationEnding flag cannot leak across sessions', () => {
  it('is reset to false inside _hide()', () => {
    const block = extractBlock('function _hide() {');
    expect(block).toMatch(/_s\.conversationEnding = false;/);
  });

  it('is reset to false alongside navigationPending/signupClosing at session start', () => {
    const idx = source.indexOf('_s.navigationPending = false;');
    expect(idx).toBeGreaterThan(-1);
    const nearby = source.slice(idx, idx + 200);
    expect(nearby).toMatch(/_s\.signupClosing = false;/);
    expect(nearby).toMatch(/_s\.conversationEnding = false;/);
  });
});

describe('VTID-03824: turn_complete default path is suppressed via the shared guard', () => {
  it('_waitForAudioEnd (turn_complete) still calls _isClosingForNav() before the default listening transition', () => {
    const block = extractBlock("case 'turn_complete':", '(function (myGen) {');
    expect(block).toMatch(/if \(_isClosingForNav\(\)\) return;/);
  });
});
