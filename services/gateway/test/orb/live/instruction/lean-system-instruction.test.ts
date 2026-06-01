/**
 * ORB-CONVERSATION-LATENCY — lean system_instruction experiment (ship-dark).
 *
 * FEATURE_LEAN_SYSTEM_INSTRUCTION, when live, drops the ~20-25 KB greeting-policy
 * stack (## GREETING POLICY time-buckets + ## HARD ANTI-PATTERNS) from the Vertex
 * first-connect prompt — the same stack LiveKit already omits in production via
 * omitGreetingPolicy — trading prompt-ingestion time for a faster first token.
 * It ships dark: default off => byte-identical to today, rollback = flip the env
 * var with no redeploy.
 *
 * These are behavioural unit tests (buildLiveSystemInstruction is a pure sync
 * function), so they assert the ACTUAL rendered output, not source structure.
 * They lock four invariants the experiment must never violate:
 *   1. Flag OFF: the full greeting stack is present (no silent behaviour change).
 *   2. Flag ON: the greeting stack is dropped but TONE RULES + JOURNEY AWARENESS
 *      (and the identity lock + LANGUAGE rule) survive.
 *   3. Reconnect is NEVER slimmed — the RECONNECT FINAL OVERRIDE (silence on a
 *      transparent resume) is preserved even with the flag on.
 *   4. LiveKit (omitGreetingPolicy=true) is unaffected by the flag.
 */

import { buildLiveSystemInstruction } from '../../../../src/orb/live/instruction/live-system-instruction';

const H_GREETING = '## GREETING POLICY';
const H_ANTIPATTERN = '## HARD ANTI-PATTERNS';
const H_TONE = '## TONE RULES';
const H_JOURNEY = '## JOURNEY AWARENESS';
const H_RECONNECT = '## RECONNECT FINAL OVERRIDE';
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

describe('ORB-CONVERSATION-LATENCY: lean system_instruction flag', () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env[FLAG]; });
  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  describe('flag OFF (default — production behaviour today)', () => {
    beforeEach(() => { delete process.env[FLAG]; });

    it('Vertex first-connect renders the FULL greeting-policy stack', () => {
      const out = vertexFirstConnect();
      expect(out).toContain(H_GREETING);
      expect(out).toContain(H_ANTIPATTERN);
      expect(out).toContain(H_TONE);
    });
  });

  describe('flag ON (staging+prod)', () => {
    beforeEach(() => { process.env[FLAG] = 'staging+prod'; });

    it('Vertex first-connect DROPS the greeting-policy stack', () => {
      const out = vertexFirstConnect();
      expect(out).not.toContain(H_GREETING);
      expect(out).not.toContain(H_ANTIPATTERN);
    });

    it('still keeps TONE RULES + JOURNEY AWARENESS (the lean greeting guidance)', () => {
      const out = vertexFirstConnect();
      expect(out).toContain(H_TONE);
      expect(out).toContain(H_JOURNEY);
    });

    it('still keeps the behaviour-critical IDENTITY LOCK + LANGUAGE rule', () => {
      const out = vertexFirstConnect();
      expect(out).toContain(IDENTITY_LOCK);
      expect(out).toContain(LANGUAGE_RULE);
    });

    it('produces a strictly shorter prompt than flag-off (the latency win)', () => {
      const lean = vertexFirstConnect();
      delete process.env[FLAG];
      const full = vertexFirstConnect();
      expect(lean.length).toBeLessThan(full.length);
    });

    it('NEVER slims a reconnect — RECONNECT FINAL OVERRIDE is preserved', () => {
      const out = vertexReconnect();
      expect(out).toContain(H_RECONNECT);
      // The reconnect path keeps the full temporal stack, so the greeting
      // section header is still present on reconnect even with the flag on.
      expect(out).toContain(H_GREETING);
    });
  });

  describe('LiveKit (omitGreetingPolicy=true) is independent of the flag', () => {
    it('omits the greeting stack with the flag OFF (unchanged behaviour)', () => {
      delete process.env[FLAG];
      const out = liveKitConnect();
      expect(out).not.toContain(H_GREETING);
      expect(out).toContain(H_TONE);
    });

    it('still omits the greeting stack with the flag ON (no regression)', () => {
      process.env[FLAG] = 'staging+prod';
      const out = liveKitConnect();
      expect(out).not.toContain(H_GREETING);
      expect(out).toContain(H_TONE);
    });
  });
});
