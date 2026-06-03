/**
 * BOOTSTRAP-ORB-RCV-DOUBLEGREET — LiveKit first-turn single-source-of-truth.
 *
 * Regression lock for the dragan3 double-greeting (audit
 * docs/superpowers/plans/2026-05-31-orb-communication-audit.md §E).
 *
 * Root cause: on LiveKit the turn-1 wake line was delivered TWICE —
 *   1. the gateway re-rendered system_instruction with the Vertex
 *      "## SPOKEN FIRST UTTERANCE — REQUIRED VERBATIM" override block
 *      (buildVertexWakeBriefBlock) → the LLM spoke the line, AND
 *   2. the Python agent spoke it again via session.say(user_facing_line)
 *      at room-join.
 * Vertex injects only once (the model speaks from the instruction; no
 * session.say), so Vertex was never affected — this is a LiveKit-only fix.
 *
 * Decision: on LiveKit, session.say() is the single source of truth for
 * the first turn. The gateway therefore injects ONLY the sentinel marker
 * (which still drives stripBrainOpenerSections + SHORT-GAP pool
 * suppression) plus a "DO NOT SPEAK FIRST" directive, so the LLM stays
 * silent until the user replies and the agent's say() owns turn-1.
 *
 * These are source-text wire-up assertions, matching the established
 * pattern in livekit-context-parity.test.ts (full HTTP integration over
 * optionalAuth + Supabase + the dynamic-import spine is heavy; the
 * wire-up is the load-bearing contract).
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVEKIT_PATH = path.resolve(
  __dirname,
  '../../../src/routes/orb-livekit.ts',
);

let source: string;

beforeAll(() => {
  source = fs.readFileSync(ORB_LIVEKIT_PATH, 'utf8');
});

/** Isolate the wake-brief re-render block so assertions target the
 * first-turn composition path and not unrelated mentions elsewhere. */
function wakeRerenderBlock(src: string): string {
  const start = src.indexOf('let wakeOverrideApplied = false;');
  expect(start).toBeGreaterThan(-1);
  // The block ends at the wake-decision snapshot emit that follows it.
  const end = src.indexOf('logWakeDecisionSnapshot(', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('BOOTSTRAP-ORB-RCV-DOUBLEGREET LiveKit first-turn single source of truth', () => {
  it('does NOT inject the Vertex "speak this verbatim" override on LiveKit', () => {
    // The whole double-greeting was the LLM ALSO speaking the line. The
    // LiveKit route must no longer INVOKE buildVertexWakeBriefBlock (that
    // helper emits the SPOKEN-FIRST-UTTERANCE / "speak VERBATIM" directive
    // which the model obeys, doubling the agent's session.say()). We match
    // an actual call site (`buildVertexWakeBriefBlock(`) and a dynamic
    // import of it — a passing mention in a comment is fine.
    expect(source).not.toMatch(/buildVertexWakeBriefBlock\s*\(/);
    expect(source).not.toMatch(/import\([^)]*\)[\s\S]{0,80}buildVertexWakeBriefBlock\s*[,}]/);
  });

  it('injects the wake-brief sentinel marker so brain-opener sections are still stripped', () => {
    // The marker is what triggers stripBrainOpenerSections() +
    // SHORT-GAP pool suppression in live-system-instruction.ts. Without
    // it the competing OPENING SHAPE MATRIX / PROACTIVE OPENER CANDIDATE
    // brain sections would generate a RIVAL opener — a different double.
    expect(source).toMatch(
      /import\s*{\s*VERTEX_WAKE_BRIEF_OVERRIDE_MARKER\s*}\s*from\s*['"]\.\.\/orb\/live\/instruction\/wake-brief-marker['"]/,
    );
    const block = wakeRerenderBlock(source);
    expect(block).toMatch(/\$\{VERTEX_WAKE_BRIEF_OVERRIDE_MARKER\}/);
  });

  it('the injected first-turn block instructs the model to stay silent (not to speak the line)', () => {
    const block = wakeRerenderBlock(source);
    expect(block).toMatch(/DO NOT SPEAK FIRST/i);
    expect(block).toMatch(/MUST NOT produce an opening utterance/i);
    expect(block).toMatch(/WAIT for the user to speak/i);
    // The suppression block must NOT contain a verbatim-speak directive —
    // that is the Vertex-only mechanism and the cause of the double.
    expect(block).not.toMatch(/REQUIRED VERBATIM/);
    expect(block).not.toMatch(/MUST\s+be\s+EXACTLY this text/i);
  });

  it('still gates the first-turn block on a picked line, not reconnect', () => {
    // Reconnect sessions never get a fresh opener; the existing guard
    // (picked && line.length > 0 && !isReconnect) must be preserved so a
    // mid-session reconnect does not inject a spurious silence directive.
    const block = wakeRerenderBlock(source);
    expect(block).toMatch(/picked\s*&&\s*line\s*&&\s*line\.length\s*>\s*0\s*&&\s*!isReconnect/);
  });

  it('still surfaces wake_brief_decision in the response so the agent can session.say() it once', () => {
    // session.say(user_facing_line) is the single source of truth; the
    // agent reads it from this payload field. If this regresses, the
    // LiveKit orb would go SILENT on turn-1 (worse than a double).
    expect(source).toMatch(/wake_brief_decision:\s*wakeBriefDecision/);
    expect(source).toMatch(/user_facing_line:\s*wakeBriefDecision\.selectedContinuation\?\.userFacingLine/);
  });

  it('preserves the proactive-offer lifecycle fields (dedupe_key + source_key)', () => {
    // The agent only sets add_to_chat_ctx=True for a REAL proactive offer
    // (decision_id + dedupe_key present). Those fields must keep flowing
    // through the payload — this fix must not regress the proactive path.
    expect(source).toMatch(/dedupe_key:\s*wakeBriefDecision\.selectedContinuation\?\.dedupeKey/);
    expect(source).toMatch(/source_key:/);
  });

  it('keeps the re-render best-effort (try/catch, non-fatal fallback)', () => {
    // A render failure must never block the bootstrap response; on throw
    // we fall back to the pre-override system_instruction.
    const block = wakeRerenderBlock(source);
    expect(block).toMatch(/try\s*{/);
    const after = source.slice(source.indexOf('let wakeOverrideApplied = false;'));
    expect(after).toMatch(/suppression re-render failed[\s\S]{0,120}non-fatal/);
  });

  it('still passes omitGreetingPolicy=true on the LiveKit system-instruction builds', () => {
    // The LiveKit contract is "session.say() owns the first turn, the LLM
    // never generates it" — omitGreetingPolicy drops the ~37 KB greeting/
    // reconnect/anti-pattern blocks. Both build call sites must keep it.
    const calls = source.match(/buildLiveSystemInstruction\([\s\S]*?\);/g) ?? [];
    const vitanaCalls = calls.filter(
      (c) => c.includes('vitanaContextInstruction') || c.includes('augmentedContext'),
    );
    expect(vitanaCalls.length).toBeGreaterThanOrEqual(2);
    // The final positional arg (omitGreetingPolicy) is `true` on both. It
    // sits after vitana_id and may be trailed by an inline comment, so we
    // assert the vitana_id arg is immediately followed by a `true` literal.
    for (const call of vitanaCalls) {
      expect(call).toMatch(/req\.identity\?\.vitana_id\s*\?\?\s*null,\s*true,/);
    }
  });
});
