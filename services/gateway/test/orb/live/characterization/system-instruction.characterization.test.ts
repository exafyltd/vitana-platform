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

  // Per-surface persona switch. Inside the Command Hub the assistant must
  // speak as the engineering co-pilot, NOT the community wellness companion.
  // The signal is derived from currentRoute (mirrors orb-live.ts session
  // bootstrap). These tests assert the divergence at the byte level so a
  // future "simplification" cannot collapse the two surfaces back into one.
  describe('per-surface persona switch', () => {
    const baseArgs = ['en', 'conversational', '', 'developer', '', '', false, null] as const;

    it('Command Hub route swaps the identity-lock role line', () => {
      const community = buildLiveSystemInstruction(...baseArgs, '/', [], undefined, '@x');
      const cmdhub = buildLiveSystemInstruction(...baseArgs, '/command-hub/tasks', [], undefined, '@x');
      expect(community).toContain("Your role is the user's life companion and instruction manual.");
      expect(cmdhub).toContain("Your role is the developer's engineering co-pilot for the Vitana platform team.");
      expect(cmdhub).not.toContain("Your role is the user's life companion and instruction manual.");
    });

    it('Command Hub route swaps base_identity to the engineering co-pilot framing', () => {
      const cmdhub = buildLiveSystemInstruction(...baseArgs, '/command-hub', [], undefined, '@x');
      expect(cmdhub).toContain('engineering co-pilot for the Vitana platform team');
      expect(cmdhub).not.toContain('AI health and wellbeing companion of the Maxina Community');
    });

    it('Command Hub route swaps tools_section to drop community-surface tools', () => {
      const cmdhub = buildLiveSystemInstruction(...baseArgs, '/command-hub/cockpit', [], undefined, '@x');
      // The community voice_live tools_section advertises search_events /
      // search_community / get_recommendations as primary tools. On the
      // developer surface, those must NOT be advertised as primary tools.
      expect(cmdhub).not.toContain('Use search_events to find upcoming events, meetups, and live rooms');
      expect(cmdhub).not.toContain('Use search_community to find groups and community activities');
      expect(cmdhub).not.toContain('Use get_recommendations to get personalized event, group, and match suggestions');
      // And the dev_orb tools_section must explicitly call out platform topics.
      expect(cmdhub).toContain('VTID status');
      expect(cmdhub).toContain('Command Hub Vitana is the engineering assistant');
    });

    it('mobile + Command Hub route still resolves to community (mobile override wins)', () => {
      const mobileCmdhub = buildLiveSystemInstruction(
        ...baseArgs,
        '/command-hub',
        [],
        { ip: '0.0.0.0', isMobile: true },
        '@x',
      );
      expect(mobileCmdhub).toContain("Your role is the user's life companion and instruction manual.");
    });

    // VTID-03183: the trailing community-flavored prose (EVENT LINK SHARING,
    // report_to_specialist / Devon handoff, switch_persona, Knowledge Hub
    // instruction-manual framing) must be GATED OUT of the Command Hub
    // prompt. Locking it here so a future refactor cannot accidentally
    // re-include it.
    it('Command Hub route drops the EVENT LINK SHARING and Devon-handoff trailing blocks', () => {
      const cmdhub = buildLiveSystemInstruction(...baseArgs, '/command-hub', [], undefined, '@x');
      // The community trailing prose in live-system-instruction.ts is gated
      // out for the Command Hub surface. (Note: the tool catalog rendered
      // by renderAvailableToolsSection still mentions report_to_specialist
      // and Devon as tool descriptions — gating the tool catalog itself is
      // a separate slice. The big community-flavored example block
      // "I found a great event!" / EVENT LINK SHARING / "You ARE the
      // instruction manual" is what the user heard and is now gone.)
      expect(cmdhub).not.toContain('EVENT LINK SHARING');
      expect(cmdhub).not.toContain('I found a great event!');
      expect(cmdhub).not.toContain('You ARE the instruction manual');
      expect(cmdhub).not.toContain('HARD RULE — handoff truthfulness');
      expect(cmdhub).not.toContain('HARD RULE — message-send truthfulness');
    });

    it('Community route STILL contains the trailing community blocks (no regression)', () => {
      const community = buildLiveSystemInstruction(...baseArgs, '/', [], undefined, '@x');
      expect(community).toContain('EVENT LINK SHARING');
      expect(community).toContain('report_to_specialist');
      expect(community).toContain('switch_persona');
      expect(community).toContain('You ARE the instruction manual');
    });
  });
});
