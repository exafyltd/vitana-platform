/**
 * ORB-CONVERSATION-LATENCY (updated by R2 — BOOTSTRAP-ORB-R2-GREETING-POLICY).
 *
 * History: FEATURE_LEAN_SYSTEM_INSTRUCTION was a ship-dark experiment that
 * dropped the legacy `## GREETING POLICY` stack from the Vertex first-connect
 * prompt — the same stack LiveKit already omitted via omitGreetingPolicy.
 *
 * R2 made that experiment permanent and unconditional: the legacy greeting-
 * policy stack (## GREETING POLICY time-buckets + ## HARD ANTI-PATTERNS) is
 * now DELETED from `live-system-instruction.ts` outright. Its temporal
 * fallback pools moved to the priority-80 voice-wake-brief provider, which
 * owns the no-provider fallback path in the Central Continuation Contract.
 *
 * Consequence for this file: the flag is now a no-op and both transports
 * behave identically. These behavioural unit tests (buildLiveSystemInstruction
 * is a pure sync function) now lock the R2 invariants:
 *   1. The legacy greeting-policy stack is ABSENT in every state — flag on/off,
 *      Vertex or LiveKit, first-connect or reconnect.
 *   2. The lean stack (TONE RULES + JOURNEY AWARENESS) plus the behaviour-
 *      critical IDENTITY LOCK + LANGUAGE rule always survive.
 *   3. Reconnect silence is preserved upstream by the top-level GREETING RULES
 *      (VTID-02637 RECONNECT SILENCE RULE), not by the deleted block.
 *   4. Vertex and LiveKit render identical output (the soft transport conflict
 *      is gone), and the lean flag no longer changes the prompt.
 */

import { buildLiveSystemInstruction } from '../../../../src/orb/live/instruction/live-system-instruction';

const H_GREETING = '## GREETING POLICY';
const H_ANTIPATTERN = '## HARD ANTI-PATTERNS';
const H_TONE = '## TONE RULES';
const H_JOURNEY = '## JOURNEY AWARENESS';
const RECONNECT_SILENCE_RULE = 'VTID-02637 RECONNECT SILENCE RULE';
const IDENTITY_LOCK = '=== IDENTITY LOCK ===';
const LANGUAGE_RULE = 'LANGUAGE: Respond ONLY in';

const FLAG = 'FEATURE_LEAN_SYSTEM_INSTRUCTION_ENV';

/** Vertex first-connect call: omitGreetingPolicy undefined, isReconnect false. */
function vertexFirstConnect(): string {
  return buildLiveSystemInstruction(
    'en', 'conversational', '', 'community', '', '', false, null, '/', [], undefined, '@x',
  );
}

/** Vertex transparent reconnect: isReconnect true. */
function vertexReconnect(): string {
  return buildLiveSystemInstruction(
    'en', 'conversational', '', 'community', '', '', true,
    { time: '1 minute ago', wasFailure: false }, '/', [], undefined, '@x',
  );
}

/** LiveKit call: omitGreetingPolicy=true (13th positional). */
function liveKitConnect(): string {
  return buildLiveSystemInstruction(
    'en', 'conversational', '', 'community', '', '', false, null, '/', [], undefined, '@x', true,
  );
}

describe('R2: legacy greeting-policy stack deleted; lean flag is a no-op', () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env[FLAG]; });
  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  describe('flag OFF (default — production behaviour)', () => {
    beforeEach(() => { delete process.env[FLAG]; });

    it('Vertex first-connect NO LONGER renders the legacy greeting-policy stack', () => {
      const out = vertexFirstConnect();
      expect(out).not.toContain(H_GREETING);
      expect(out).not.toContain(H_ANTIPATTERN);
      // The lean stack survives.
      expect(out).toContain(H_TONE);
      expect(out).toContain(H_JOURNEY);
    });

    it('keeps the behaviour-critical IDENTITY LOCK + LANGUAGE rule', () => {
      const out = vertexFirstConnect();
      expect(out).toContain(IDENTITY_LOCK);
      expect(out).toContain(LANGUAGE_RULE);
    });
  });

  describe('flag ON (staging+prod) — now a no-op', () => {
    beforeEach(() => { process.env[FLAG] = 'staging+prod'; });

    it('Vertex first-connect still omits the legacy stack', () => {
      const out = vertexFirstConnect();
      expect(out).not.toContain(H_GREETING);
      expect(out).not.toContain(H_ANTIPATTERN);
      expect(out).toContain(H_TONE);
      expect(out).toContain(H_JOURNEY);
    });

    it('produces a prompt byte-identical to flag-off (the flag is dead)', () => {
      const lean = vertexFirstConnect();
      delete process.env[FLAG];
      const off = vertexFirstConnect();
      expect(lean).toEqual(off);
    });

    it('reconnect silence is preserved upstream by the top-level GREETING RULES', () => {
      const out = vertexReconnect();
      // The deleted RECONNECT FINAL OVERRIDE is no longer needed: reconnect
      // silence is enforced by the top-level GREETING RULES (and by
      // decideGreetingPolicy() returning 'skip' on reconnect).
      expect(out).toContain(RECONNECT_SILENCE_RULE);
      expect(out).not.toContain(H_GREETING);
    });
  });

  describe('Vertex and LiveKit are now identical (omitGreetingPolicy is dead)', () => {
    it('both omit the legacy stack and keep the lean stack (flag OFF)', () => {
      delete process.env[FLAG];
      const vertex = vertexFirstConnect();
      const livekit = liveKitConnect();
      expect(vertex).not.toContain(H_GREETING);
      expect(livekit).not.toContain(H_GREETING);
      expect(vertex).toContain(H_TONE);
      expect(livekit).toContain(H_TONE);
      // Block removal makes both transports render byte-identical output.
      expect(vertex).toEqual(livekit);
    });

    it('still identical with the flag ON (no regression)', () => {
      process.env[FLAG] = 'staging+prod';
      const vertex = vertexFirstConnect();
      const livekit = liveKitConnect();
      expect(vertex).not.toContain(H_GREETING);
      expect(livekit).not.toContain(H_GREETING);
      expect(vertex).toEqual(livekit);
    });
  });
});
