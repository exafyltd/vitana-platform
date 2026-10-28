/**
 * Regression test for VTID-03933 — guessAreaFromText() ordering bug.
 *
 * Bug: 'Auth' was checked 2nd in the keyword array (right after ORB), and
 * its keyword list includes the bare word "session" — a word that shows
 * up in plenty of text that has nothing to do with authentication (e.g.
 * "change the task or session title"). First-match-wins meant a text
 * containing BOTH "session" and a far more specific area keyword (like
 * "command hub") was mis-tagged 'Auth' instead of the specific area.
 *
 * Observed live (VTID-03931, an Operator Console test task): the text
 * "Command Hub Operator Console... task or session title..." produced
 * title "Auth: Feature: Inline title editing in the Command Hub" instead
 * of a Command-Hub/Operator-tagged title.
 *
 * Fix: 'Auth' now runs LAST in the keyword array, after every other,
 * more specific category has had a chance to match. A genuine Auth-only
 * text (login/token/jwt/bare "session" with no other category keyword
 * present) still classifies as 'Auth' via the same array, just later.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || 'test-service-role';

import { guessAreaFromText } from '../src/utils/task-title';

describe('guessAreaFromText — Auth-vs-specific-area ordering (VTID-03933)', () => {
  it('classifies the exact reproduced live failure as Command Hub, not Auth', () => {
    const text =
      'build for the Command Hub Operator Console to be able to change the ' +
      'Task or session title by double click and editing the text, same ' +
      'like in claude code is possible to edit the task or session title.';
    expect(guessAreaFromText(text)).toBe('Command Hub');
  });

  it('still classifies genuine Auth-only text as Auth (bare "session", no other area keyword)', () => {
    expect(guessAreaFromText('Fix login token expiring too fast during a user session')).toBe('Auth');
    expect(guessAreaFromText('JWT validation fails on password reset')).toBe('Auth');
    expect(guessAreaFromText('Provision a new auth token for the service account')).toBe('Auth');
  });

  it('lets a more specific area win over "session" appearing elsewhere in the text', () => {
    expect(guessAreaFromText('Add a new OASIS event for every session start')).toBe('OASIS');
    expect(guessAreaFromText('Operator console should remember the last session tab')).toBe('Operator');
    expect(guessAreaFromText('Pipeline scheduling should resume the session after a restart')).toBe('Pipeline');
  });

  it('ORB keeps priority over Auth for voice/session text (ORB stays first)', () => {
    expect(guessAreaFromText('Voice session drops audio after 30 seconds')).toBe('ORB');
  });

  it('falls back to Gateway when nothing matches, unchanged from before', () => {
    expect(guessAreaFromText('Improve the onboarding illustration colors')).toBe('Gateway');
  });

  it('mutation check: reverting Auth to 2nd position reproduces the live bug', () => {
    // Not a real mutation test (no source import trick needed) — this
    // documents the exact assertion that failed before the fix, so a
    // future regression on this file is caught immediately by the first
    // test above rather than needing this comment to be re-derived.
    const text =
      'build for the Command Hub Operator Console to be able to change the ' +
      'Task or session title by double click and editing the text';
    expect(guessAreaFromText(text)).not.toBe('Auth');
  });
});
