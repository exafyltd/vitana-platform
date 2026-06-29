/**
 * greeting-gate — pins the session-start greeting decisions changed by
 * BOOTSTRAP-ORB-GREETING-LANG-FIRSTTIME.
 *
 * Regression context: the ORB greeted returning users as first-timers on EVERY
 * session (the full one-time welcome fired on the "needs onboarding" signal
 * alone), and the spoken greeting could be in a different language than the
 * rest of the conversation. These tests lock the corrected behaviour:
 *
 *   1. A user with ANY prior session never gets the full first-time welcome,
 *      even when they never finished guided onboarding.
 *   2. A genuine first-ever user DOES get it.
 *   3. The greeting language prefers the resolved session language so turn 1
 *      matches turn 2.
 */

process.env.NODE_ENV = 'test';

import {
  deriveHasPriorSession,
  shouldFireFirstTimeWelcome,
  resolveGreetingLang,
} from '../src/orb/live/instruction/greeting-gate';

describe('deriveHasPriorSession', () => {
  it('no row → no prior session', () => {
    expect(deriveHasPriorSession(null)).toBe(false);
    expect(deriveHasPriorSession(undefined)).toBe(false);
  });

  it('genuine first session (is_first_session=true, no last_session_date) → no prior session', () => {
    expect(deriveHasPriorSession({ is_first_session: true, last_session_date: null })).toBe(false);
  });

  it('last_session_date set → has prior session', () => {
    expect(deriveHasPriorSession({ is_first_session: true, last_session_date: '2026-06-28' })).toBe(true);
  });

  it('is_first_session already cleared → has prior session even without a date', () => {
    expect(deriveHasPriorSession({ is_first_session: false, last_session_date: null })).toBe(true);
  });
});

describe('shouldFireFirstTimeWelcome', () => {
  it('genuine first-ever session → fires', () => {
    expect(
      shouldFireFirstTimeWelcome({ hasPriorSession: false, needsOnboarding: true, isFirstSession: true }),
    ).toBe(true);
  });

  it('first-ever session by is_first_session only (onboarding already satisfied) → fires', () => {
    expect(
      shouldFireFirstTimeWelcome({ hasPriorSession: false, needsOnboarding: false, isFirstSession: true }),
    ).toBe(true);
  });

  it('REGRESSION: returning user who never finished onboarding → does NOT fire', () => {
    // This is the exact bug: needsOnboarding=true used to force the welcome on
    // every session. With a prior session on record it must NOT re-introduce.
    expect(
      shouldFireFirstTimeWelcome({ hasPriorSession: true, needsOnboarding: true, isFirstSession: false }),
    ).toBe(false);
  });

  it('returning, fully onboarded user → does NOT fire', () => {
    expect(
      shouldFireFirstTimeWelcome({ hasPriorSession: true, needsOnboarding: false, isFirstSession: false }),
    ).toBe(false);
  });

  it('no prior session and no first-time signals → does NOT fire', () => {
    expect(
      shouldFireFirstTimeWelcome({ hasPriorSession: false, needsOnboarding: false, isFirstSession: false }),
    ).toBe(false);
  });
});

describe('resolveGreetingLang', () => {
  it('prefers a non-empty session language over the fallback', () => {
    expect(resolveGreetingLang('de', 'en')).toBe('de');
  });

  it('falls back when session language is missing/empty/non-string', () => {
    expect(resolveGreetingLang(undefined, 'en')).toBe('en');
    expect(resolveGreetingLang('', 'de')).toBe('de');
    expect(resolveGreetingLang(null, 'fr')).toBe('fr');
    expect(resolveGreetingLang(42 as unknown, 'es')).toBe('es');
  });
});
