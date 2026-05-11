/**
 * A0.1 — Characterization test for buildLiveSystemInstruction.
 *
 * Purpose: lock the current system-instruction output as a contract before
 * the orb-live.ts refactor moves the function into
 * services/gateway/src/orb/live/instruction/live-system-instruction.ts (step A3).
 *
 * If a snapshot fails, the refactor is changing prompt text. Either:
 *   (a) the change was unintentional — fix the refactor, OR
 *   (b) the change is intentional — call it out in the PR description and
 *       run `jest -u` to update the snapshot.
 *
 * What this test does NOT do:
 * - Verify the prompt is "correct" (LLM behavior is judged elsewhere).
 * - Mock heavy dependencies — buildLiveSystemInstruction is pure-ish, its
 *   only external call is getPersonalityConfigSync('voice_live') which
 *   reads from an in-memory cache + hardcoded defaults.
 */

import { buildLiveSystemInstruction } from '../../../../src/routes/orb-live';
import { ALL_PERSONAS } from './personas';

describe('A0.1 characterization: buildLiveSystemInstruction', () => {
  it.each(ALL_PERSONAS)('renders a stable system instruction for persona "$name"', ({ name, input }) => {
    const instruction = buildLiveSystemInstruction(
      input.lang,
      input.voiceStyle,
      input.bootstrapContext,
      input.activeRole,
      input.conversationSummary,
      input.conversationHistory,
      input.isReconnect,
      input.lastSessionInfo,
      input.currentRoute,
      input.recentRoutes,
      undefined, // clientContext — intentionally undefined (see personas.ts)
      input.vitanaId,
    );

    expect(typeof instruction).toBe('string');
    expect(instruction.length).toBeGreaterThan(0);

    // Snapshot the full rendered prompt. The snapshot file becomes the
    // contract that A3 (instruction extraction) must preserve byte-for-byte
    // unless intentional prompt changes are flagged.
    expect(instruction).toMatchSnapshot(`persona:${name}`);
  });

  it('produces a different instruction when isReconnect flips', () => {
    // Sanity check: the function must respond to its own inputs. If a
    // future "optimization" makes isReconnect a no-op, this catches it.
    const fresh = buildLiveSystemInstruction('en', 'conversational', '', 'community', '', '', false, null, '/', [], undefined, '@x');
    const reconnect = buildLiveSystemInstruction('en', 'conversational', '', 'community', '', '', true, { time: '1 minute ago', wasFailure: false }, '/', [], undefined, '@x');
    expect(fresh).not.toEqual(reconnect);
  });

  it('produces a different instruction when activeRole changes', () => {
    const community = buildLiveSystemInstruction('en', 'conversational', '', 'community', '', '', false, null, '/', [], undefined, '@x');
    const admin = buildLiveSystemInstruction('en', 'conversational', '', 'admin', '', '', false, null, '/', [], undefined, '@x');
    expect(community).not.toEqual(admin);
  });

  it('produces a different instruction when language changes', () => {
    const en = buildLiveSystemInstruction('en', 'conversational', '', 'community', '', '', false, null, '/', [], undefined, '@x');
    const de = buildLiveSystemInstruction('de', 'conversational', '', 'community', '', '', false, null, '/', [], undefined, '@x');
    expect(en).not.toEqual(de);
  });
});
