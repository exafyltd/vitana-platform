/**
 * VTID-03154 — Slices C + D: journey-greeting block builder tests.
 *
 * Covers:
 *   - todayInTimezone: known TZ vs missing TZ vs invalid TZ
 *   - decideGreetingKind: precedence first_session > daily_morning > null
 *   - buildJourneyGreetingBlock first_session content invariants
 *   - buildJourneyGreetingBlock daily_morning content invariants
 *   - day count + life-compass goal text + anti-repetition memory
 *   - both blocks are structural (no Say-exactly wording)
 */

import {
  todayInTimezone,
  decideGreetingKind,
  buildJourneyGreetingBlock,
} from '../../../../src/orb/live/instruction/journey-greeting';
import type { JourneyState } from '../../../../src/services/journey/user-journey-service';

const FIXED_NOW = new Date('2026-06-15T10:30:00.000Z');

function makeJourney(overrides: Partial<JourneyState> = {}): JourneyState {
  return {
    user_id: 'u1',
    tenant_id: null,
    started_at: new Date(FIXED_NOW.getTime() - 14 * 86_400_000).toISOString(),
    total_days: 90,
    plan_type: 'default',
    plan_summary: null,
    status: 'active',
    is_first_session: false,
    last_session_date: '2026-06-14',
    recent_greeting_openings: [],
    completed_milestone_ids: [],
    last_acknowledged_day: null,
    day_in_journey: 14,
    days_left: 76,
    is_past_total_days: false,
    current_wave: { id: 'wave-2', name: 'Daily Anchors', description: 'Build daily habits', start_day: 1, end_day: 14 },
    fallback_used: false,
    ...overrides,
  };
}

describe('VTID-03154 journey-greeting', () => {
  describe('todayInTimezone', () => {
    it('returns YYYY-MM-DD in the given IANA TZ', () => {
      // UTC 10:30 on June 15 → Berlin is 12:30 → 2026-06-15
      expect(todayInTimezone(FIXED_NOW, 'Europe/Berlin')).toBe('2026-06-15');
    });
    it('handles a TZ where the local date is the next day', () => {
      // UTC 10:30 on June 15 → Sydney is 20:30 → 2026-06-15
      expect(todayInTimezone(FIXED_NOW, 'Australia/Sydney')).toBe('2026-06-15');
    });
    it('handles a TZ where the local date is the previous day', () => {
      // UTC 03:30 on June 15 → LA is 20:30 on June 14
      const earlyUtc = new Date('2026-06-15T03:30:00.000Z');
      expect(todayInTimezone(earlyUtc, 'America/Los_Angeles')).toBe('2026-06-14');
    });
    it('falls back to UTC when TZ is null', () => {
      expect(todayInTimezone(FIXED_NOW, null)).toBe('2026-06-15');
    });
    it('falls back to UTC when TZ is invalid', () => {
      expect(todayInTimezone(FIXED_NOW, 'Not/A_Real_Timezone')).toBe('2026-06-15');
    });
  });

  describe('decideGreetingKind precedence', () => {
    it('returns null when journey is null', () => {
      expect(decideGreetingKind(null, '2026-06-15')).toBeNull();
    });
    it('returns first_session when is_first_session=true (even if last_session_date matches today)', () => {
      const j = makeJourney({ is_first_session: true, last_session_date: '2026-06-15' });
      expect(decideGreetingKind(j, '2026-06-15')).toBe('first_session');
    });
    it('returns daily_morning when last_session_date is null', () => {
      const j = makeJourney({ is_first_session: false, last_session_date: null });
      expect(decideGreetingKind(j, '2026-06-15')).toBe('daily_morning');
    });
    it('returns daily_morning when last_session_date < today', () => {
      const j = makeJourney({ is_first_session: false, last_session_date: '2026-06-14' });
      expect(decideGreetingKind(j, '2026-06-15')).toBe('daily_morning');
    });
    it('returns null when last_session_date === today (same-day repeat session)', () => {
      const j = makeJourney({ is_first_session: false, last_session_date: '2026-06-15' });
      expect(decideGreetingKind(j, '2026-06-15')).toBeNull();
    });
    it('returns null when last_session_date is in the future (clock skew)', () => {
      const j = makeJourney({ is_first_session: false, last_session_date: '2026-06-20' });
      expect(decideGreetingKind(j, '2026-06-15')).toBeNull();
    });
  });

  describe('buildJourneyGreetingBlock — first_session', () => {
    it('returns empty when no trigger fires', () => {
      const j = makeJourney({ is_first_session: false, last_session_date: '2026-06-15' });
      const r = buildJourneyGreetingBlock({
        journey: j, lifeCompassGoalText: null, firstName: 'Dragan', lang: 'en',
        todayDateIso: '2026-06-15',
      });
      expect(r.block).toBe('');
      expect(r.meta).toBeNull();
    });

    it('emits a structural first-session block with all required framings', () => {
      const j = makeJourney({ is_first_session: true });
      const r = buildJourneyGreetingBlock({
        journey: j, lifeCompassGoalText: null, firstName: 'Dragan', lang: 'en',
        todayDateIso: '2026-06-15',
      });
      expect(r.meta).toEqual({ kind: 'first_session', today_date_iso: '2026-06-15' });
      // Required framings present
      expect(r.block).toMatch(/FIRST-SESSION WELCOME/);
      expect(r.block).toMatch(/Dragan/);
      expect(r.block).toMatch(/JOURNEY/);
      expect(r.block).toMatch(/Life Compass/);
      expect(r.block).toMatch(/Vitana Index/);
      expect(r.block).toMatch(/companion/i);
      // Forbidden phrasings called out
      expect(r.block).toMatch(/tour/);
      expect(r.block).toMatch(/feature/);
      // Structural — NOT Say-exactly verbatim
      expect(r.block).not.toMatch(/Speak this VERBATIM/i);
      expect(r.block).not.toMatch(/letter[- ]for[- ]letter/i);
    });

    it('handles missing firstName gracefully', () => {
      const j = makeJourney({ is_first_session: true });
      const r = buildJourneyGreetingBlock({
        journey: j, lifeCompassGoalText: null, firstName: null, lang: 'de',
        todayDateIso: '2026-06-15',
      });
      expect(r.block).toMatch(/without a name/);
      expect(r.block).toMatch(/Speak in DE/);
    });
  });

  describe('buildJourneyGreetingBlock — daily_morning', () => {
    it('emits day-N + phase + goal text + anti-repetition when all present', () => {
      const j = makeJourney({
        day_in_journey: 14,
        total_days: 90,
        current_wave: { id: 'wave-2', name: 'Daily Anchors', description: 'Build daily habits', start_day: 1, end_day: 14 },
        recent_greeting_openings: ['Guten Morgen', 'Good morning'],
      });
      const r = buildJourneyGreetingBlock({
        journey: j,
        lifeCompassGoalText: 'sleep better and reduce back pain',
        firstName: 'Dragan',
        lang: 'en',
        todayDateIso: '2026-06-15',
      });
      expect(r.meta).toEqual({ kind: 'daily_morning', today_date_iso: '2026-06-15' });
      expect(r.block).toMatch(/DAILY MORNING GREETING/);
      expect(r.block).toMatch(/day 14/);
      expect(r.block).toMatch(/90 days total/);
      expect(r.block).toMatch(/Daily Anchors/);
      expect(r.block).toMatch(/in your plan to sleep better and reduce back pain/);
      expect(r.block).toMatch(/Guten Morgen/);
      expect(r.block).toMatch(/Good morning/);
      expect(r.block).toMatch(/Do NOT start the same way today/);
      expect(r.block).toMatch(/Dragan/);
    });

    it('uses phase-based purpose fallback when life-compass goal is null', () => {
      const j = makeJourney({
        day_in_journey: 3,
        current_wave: { id: 'wave-1', name: 'Getting Started', description: 'Set up profile', start_day: 0, end_day: 7 },
      });
      const r = buildJourneyGreetingBlock({
        journey: j,
        lifeCompassGoalText: null,
        firstName: null,
        lang: 'en',
        todayDateIso: '2026-06-15',
      });
      expect(r.block).toMatch(/has not yet set a Life Compass goal/);
      expect(r.block).toMatch(/phase-based purpose/);
      expect(r.block).toMatch(/Getting Started/);
    });

    it('handles missing current_wave (past total_days edge)', () => {
      const j = makeJourney({
        day_in_journey: 95,
        current_wave: null,
        is_past_total_days: true,
      });
      const r = buildJourneyGreetingBlock({
        journey: j,
        lifeCompassGoalText: null,
        firstName: 'Dragan',
        lang: 'en',
        todayDateIso: '2026-06-15',
      });
      expect(r.block).toMatch(/No active phase identified for today/);
    });

    it('omits anti-repetition section when recent_greeting_openings is empty', () => {
      const j = makeJourney({ recent_greeting_openings: [] });
      const r = buildJourneyGreetingBlock({
        journey: j,
        lifeCompassGoalText: 'find my rhythm',
        firstName: 'Dragan',
        lang: 'en',
        todayDateIso: '2026-06-15',
      });
      expect(r.block).toMatch(/Compose a fresh, natural opening/);
      expect(r.block).not.toMatch(/Do NOT start the same way today/);
    });

    it('VTID-03157: requires a preview of what to expect in the COMING DAYS, not just today', () => {
      const j = makeJourney({
        day_in_journey: 5,
        current_wave: { id: 'wave-1', name: 'Getting Started', description: 'Set up profile', start_day: 0, end_day: 7 },
      });
      const r = buildJourneyGreetingBlock({
        journey: j,
        lifeCompassGoalText: 'sleep better',
        firstName: 'Dragan',
        lang: 'en',
        todayDateIso: '2026-06-15',
      });
      expect(r.block).toMatch(/preview of WHAT TO EXPECT in the COMING DAYS/);
      expect(r.block).toMatch(/over the next few days/);
    });

    it('structural — NOT Say-exactly verbatim', () => {
      const j = makeJourney();
      const r = buildJourneyGreetingBlock({
        journey: j,
        lifeCompassGoalText: 'sleep better',
        firstName: 'Dragan',
        lang: 'en',
        todayDateIso: '2026-06-15',
      });
      expect(r.block).not.toMatch(/Speak this VERBATIM/i);
      expect(r.block).not.toMatch(/letter[- ]for[- ]letter/i);
      expect(r.block).not.toMatch(/Say exactly/i);
    });
  });
});
