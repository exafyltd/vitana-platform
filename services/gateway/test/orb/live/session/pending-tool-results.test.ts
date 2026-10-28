/**
 * BOOTSTRAP-ORB-TOOL-CARRYOVER: an unconsumed tool result must survive a
 * stall-recovery reconnect.
 *
 * Reproduces the production failure (session live-3577c2fa, 2026-07-30) where
 * `narrate_guided_session` returned successfully, the model then emitted
 * nothing for 20s, the text_stall watchdog force-closed the upstream, and the
 * rebuilt session came back with no idea it had been asked to narrate — what
 * the user described as "she answers as if it's the first time".
 */

import {
  recordPendingToolResult,
  clearPendingToolResults,
  getPendingToolResults,
  buildPendingToolResumeBlock,
  MAX_PENDING_TOOL_RESULTS,
  MAX_PENDING_OUTPUT_CHARS,
} from '../../../../src/orb/live/session/pending-tool-results';

/** The real directive shape returned to a non-German session. */
const NARRATION = 'The text below is this session\'s real narration, authored in German. Deliver it NOW…';

describe('pending tool-result carry-over', () => {
  it('records a result that was actually sent', () => {
    const s: any = {};
    recordPendingToolResult(s, 'narrate_guided_session', NARRATION);
    const pending = getPendingToolResults(s);
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe('narrate_guided_session');
    expect(pending[0].output).toBe(NARRATION);
  });

  it('clears on turn_complete, because a completed turn means it was consumed', () => {
    const s: any = {};
    recordPendingToolResult(s, 'narrate_guided_session', NARRATION);
    expect(clearPendingToolResults(s)).toBe(1);
    expect(getPendingToolResults(s)).toHaveLength(0);
    // Idempotent — a second turn_complete must not report phantom clears.
    expect(clearPendingToolResults(s)).toBe(0);
  });

  it('survives when the turn NEVER completes — the actual production case', () => {
    // Tool succeeds…
    const s: any = { sessionId: 'live-3577c2fa', resumptionHandle: 'handle-issued-8s-earlier' };
    recordPendingToolResult(s, 'narrate_guided_session', NARRATION);
    // …model emits nothing, watchdog fires, upstream closes. No turn_complete.
    // The rebuilt session must still see the unfinished work.
    const carried = getPendingToolResults(s);
    expect(carried).toHaveLength(1);
    const block = buildPendingToolResumeBlock(carried);
    expect(block).toContain('narrate_guided_session');
    expect(block).toContain(NARRATION);
  });

  it('ignores an empty result — nothing to continue means nothing to carry', () => {
    const s: any = {};
    recordPendingToolResult(s, 'some_tool', '');
    recordPendingToolResult(s, 'some_tool', '   ');
    recordPendingToolResult(s, 'some_tool', undefined);
    recordPendingToolResult(s, 'some_tool', null);
    expect(getPendingToolResults(s)).toHaveLength(0);
  });

  it('tells the model to CONTINUE, never to re-call the tool', () => {
    // narrate_guided_session marks the topic complete on every call, so a
    // replay would silently advance the journey past a session the user
    // never heard. The block must not read as "call it again".
    const block = buildPendingToolResumeBlock([
      { toolName: 'narrate_guided_session', output: NARRATION, recordedAt: 0 },
    ]);
    expect(block).toMatch(/do NOT call them\s*\n?\s*again|do NOT call them again/i);
    expect(block).toMatch(/ALREADY/);
    // And it must not re-greet — that was the other half of the complaint.
    expect(block).toMatch(/without re-greeting/i);
  });

  it('bounds how many results are carried', () => {
    const s: any = {};
    for (let i = 0; i < MAX_PENDING_TOOL_RESULTS + 4; i++) {
      recordPendingToolResult(s, `tool_${i}`, `output ${i}`);
    }
    const pending = getPendingToolResults(s);
    expect(pending).toHaveLength(MAX_PENDING_TOOL_RESULTS);
    // Keeps the MOST RECENT — the oldest are the least likely to be what the
    // model was mid-way through when the connection died.
    expect(pending[pending.length - 1].toolName).toBe(`tool_${MAX_PENDING_TOOL_RESULTS + 3}`);
  });

  it('bounds a single oversized result', () => {
    const s: any = {};
    recordPendingToolResult(s, 'big_tool', 'x'.repeat(MAX_PENDING_OUTPUT_CHARS * 3));
    expect(getPendingToolResults(s)[0].output).toHaveLength(MAX_PENDING_OUTPUT_CHARS);
    // Real guided narrations (max 2588 chars in prod) must fit untruncated.
    expect(MAX_PENDING_OUTPUT_CHARS).toBeGreaterThan(2588);
  });

  it('returns an empty block when nothing is pending, so callers can concat blindly', () => {
    expect(buildPendingToolResumeBlock([])).toBe('');
    expect(buildPendingToolResumeBlock(getPendingToolResults({}))).toBe('');
  });

  it('is safe against a missing/!object session', () => {
    expect(() => recordPendingToolResult(null, 't', 'o')).not.toThrow();
    expect(() => recordPendingToolResult(undefined, 't', 'o')).not.toThrow();
    expect(getPendingToolResults(null)).toEqual([]);
    expect(clearPendingToolResults(undefined)).toBe(0);
  });
});

describe('carry-over wiring invariants (source-level)', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const handler = fs.readFileSync(
    path.join(__dirname, '../../../../src/orb/live/session/upstream-message-handler.ts'),
    'utf8',
  );
  const route = fs.readFileSync(
    path.join(__dirname, '../../../../src/routes/orb-live.ts'),
    'utf8',
  );

  it('records ONLY when the result was actually sent', () => {
    // Recording an unsent result would make her narrate something the user
    // never triggered. Both send sites (Vertex + Nova) must be gated.
    const recordLines = handler
      .split('\n')
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes('recordPendingToolResult(session'));
    expect(recordLines.length).toBeGreaterThanOrEqual(2);
    const lines = handler.split('\n');
    for (const { i } of recordLines) {
      // The nearest preceding control line must be an `if (sent)` guard.
      const preceding = lines.slice(Math.max(0, i - 3), i).join('\n');
      expect(preceding).toMatch(/if \(sent\)/);
    }
  });

  it('clears at turn_complete', () => {
    expect(handler).toMatch(/clearPendingToolResults\(session\)/);
  });

  it('injects into the rebuilt instruction REGARDLESS of resumption handle', () => {
    // The whole defect: the handle is a checkpoint predating the tool call, so
    // gating the carry-over on `!resumptionHandle` (the way reconnectHistory
    // is gated) would restore exactly nothing on Vertex.
    const idx = route.indexOf('BOOTSTRAP-ORB-TOOL-CARRYOVER');
    expect(idx).toBeGreaterThan(-1);
    const block = route.slice(idx, idx + 2200);
    expect(block).toMatch(/getPendingToolResults\(session\)/);
    expect(block).toMatch(/buildPendingToolResumeBlock/);
    // Must NOT be conditioned on the handle being absent.
    expect(block).not.toMatch(/if\s*\(\s*!session\.resumptionHandle/);
  });

  it('never breaks the handshake if the carry-over throws', () => {
    const idx = route.indexOf('BOOTSTRAP-ORB-TOOL-CARRYOVER');
    const block = route.slice(idx, idx + 2200);
    expect(block).toMatch(/try\s*\{/);
    expect(block).toMatch(/catch/);
  });
});
