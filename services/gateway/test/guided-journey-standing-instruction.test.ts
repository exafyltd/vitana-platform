/**
 * buildGuidedJourneyStandingInstruction — the STANDING system-instruction block
 * that makes Vitana aware of the user's current guided-journey session on EVERY
 * turn (not just the greeting), so she never defaults to "the first lesson"
 * mid-conversation.
 *
 * Pins the contract:
 *   1. A user with real progress (session 10) → block names session 10 + title,
 *      and explicitly forbids restarting at session 1.
 *   2. A brand-new user (session 1, nothing completed) → empty string (handled
 *      by the NEW-USER bias; must not be told "you are on session 1").
 *   3. null progress → empty string.
 */

process.env.NODE_ENV = 'test';

import { buildGuidedJourneyStandingInstruction } from '../src/services/assistant-continuation/providers/new-day-overview-payload';

describe('buildGuidedJourneyStandingInstruction', () => {
  it('user on session 10 → standing block names the current session and forbids restarting at 1', () => {
    const block = buildGuidedJourneyStandingInstruction({
      sessions_completed: 9,
      topics_learned: 12,
      topics_total: 254,
      next_session_title: 'Schlaf optimieren',
      last_session_recall: 'Atemübungen für besseren Schlaf',
    });
    expect(block).toContain('Current session: 10');
    expect(block).toContain('Schlaf optimieren');
    expect(block).toContain('Sessions completed: 9');
    expect(block).toContain('Where you left off: "Atemübungen für besseren Schlaf"');
    expect(block).toMatch(/NEVER restart at session 1/i);
  });

  it('brand-new user (session 1, nothing completed) → empty (handled by NEW-USER bias)', () => {
    const block = buildGuidedJourneyStandingInstruction({
      sessions_completed: 0,
      topics_learned: 0,
      topics_total: 254,
      next_session_title: 'Starte deine Longevity-Reise',
      last_session_recall: null,
    });
    expect(block).toBe('');
  });

  it('null progress → empty string (never blocks / never fabricates)', () => {
    expect(buildGuidedJourneyStandingInstruction(null)).toBe('');
  });

  it('derives the current session as sessions_completed + 1', () => {
    const block = buildGuidedJourneyStandingInstruction({
      sessions_completed: 4,
      topics_learned: 5,
      topics_total: 254,
      next_session_title: null,
      last_session_recall: null,
    });
    expect(block).toContain('Current session: 5');
    // No title/recall available → those lines are omitted, but the session line stays.
    expect(block).not.toContain('Where you left off');
  });
});
