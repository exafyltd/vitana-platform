/**
 * VTID-03092 (Teacher PR 2) — pure tests for the greeting + invitation pools.
 */

import {
  pickTeacherGreeting,
  listTeacherGreetings,
} from '../../../../../src/services/assistant-continuation/providers/teacher/teacher-greeting-pool';
import {
  pickTeacherInvitation,
  listTeacherInvitations,
} from '../../../../../src/services/assistant-continuation/providers/teacher/teacher-invitation-pool';

// Deterministic RNG factory — produces 0, then increments by step,
// wrapping at 1. Lets a test sweep through every index of the pool.
function rngSeq(start: number) {
  let v = start;
  return () => {
    const out = v;
    v = (v + 1e-9) % 1;
    return out;
  };
}

describe('VTID-03092 — teacher-greeting-pool', () => {
  test('substitutes firstName when provided', () => {
    // Pick index 0 — the de pool starts with "Willkommen zurück, {firstName}."
    const out = pickTeacherGreeting({
      lang: 'de',
      firstName: 'Dragan',
      rng: () => 0,
    });
    expect(out).toBe('Willkommen zurück, Dragan.');
  });

  test('falls back to no-name phrases when firstName missing', () => {
    // Sweep many indices; the result must NEVER contain "{firstName}".
    for (let i = 0; i < 50; i++) {
      const r = (i / 50) % 1;
      const out = pickTeacherGreeting({ lang: 'de', firstName: null, rng: () => r });
      expect(out).not.toContain('{firstName}');
      expect(out.length).toBeGreaterThan(0);
    }
  });

  test('every named entry contains exactly one firstName slot', () => {
    for (const lang of ['en', 'de']) {
      for (const phrase of listTeacherGreetings(lang)) {
        const matches = phrase.match(/\{firstName\}/g) ?? [];
        expect(matches.length).toBeLessThanOrEqual(1);
      }
    }
  });

  test('no dismissive openers leak in (banned-phrase guard)', () => {
    const banned = [
      /\byes\?/i,
      /\bja bitte\b/i,
      /\bwas gibt's neues\b/i,
      /\bgo ahead\b/i,
      /\bworum geht\b/i,
      /\bbereit\./i,
      /\bja\?/i,
    ];
    for (const lang of ['en', 'de']) {
      for (const phrase of listTeacherGreetings(lang)) {
        for (const re of banned) {
          expect(phrase).not.toMatch(re);
        }
      }
    }
  });

  test('unknown language falls back to English pool', () => {
    const out = pickTeacherGreeting({ lang: 'xx', firstName: 'Alice', rng: () => 0 });
    expect(out).toBe('Welcome back, Alice.');
  });

  test('variety floor: at least 16 phrases per supported lang', () => {
    for (const lang of ['en', 'de']) {
      expect(listTeacherGreetings(lang).length).toBeGreaterThanOrEqual(16);
    }
  });
});

describe('VTID-03092 — teacher-invitation-pool', () => {
  test('substitutes featureLabel when provided', () => {
    // de pool index 2: "Magst du, dass ich dir {featureLabel} zeige?"
    const out = pickTeacherInvitation({
      lang: 'de',
      featureLabel: 'den Life Compass',
      rng: () => 2 / 20,
    });
    expect(out).toContain('den Life Compass');
    expect(out).not.toContain('{featureLabel}');
  });

  test('falls back to no-label phrases when label missing', () => {
    for (let i = 0; i < 50; i++) {
      const r = (i / 50) % 1;
      const out = pickTeacherInvitation({ lang: 'de', featureLabel: null, rng: () => r });
      expect(out).not.toContain('{featureLabel}');
      expect(out.length).toBeGreaterThan(0);
    }
  });

  test('NO "Wie kann ich dir helfen" / "How can I help" anywhere', () => {
    // Hard rule from the user: the Teacher must NEVER ask
    // "how can I help you" as a standalone phrase. It only invites.
    const banned = [/wie kann ich dir helfen/i, /how can i help/i];
    for (const lang of ['en', 'de']) {
      for (const phrase of listTeacherInvitations(lang)) {
        for (const re of banned) {
          expect(phrase).not.toMatch(re);
        }
      }
    }
  });

  test('every phrase contains a question mark (permission-asking)', () => {
    // Phrases may have a question + explanatory follow-up
    // ("Do you have a moment? I would like to introduce something."),
    // so we only require AT LEAST one '?' in the phrase, not that it
    // ends with one.
    for (const lang of ['en', 'de']) {
      for (const phrase of listTeacherInvitations(lang)) {
        expect(phrase.includes('?')).toBe(true);
      }
    }
  });

  test('every featureLabel slot appears at most once per phrase', () => {
    for (const lang of ['en', 'de']) {
      for (const phrase of listTeacherInvitations(lang)) {
        const matches = phrase.match(/\{featureLabel\}/g) ?? [];
        expect(matches.length).toBeLessThanOrEqual(1);
      }
    }
  });

  test('unknown language falls back to English pool', () => {
    const out = pickTeacherInvitation({ lang: 'xx', featureLabel: null, rng: () => 0 });
    expect(out.length).toBeGreaterThan(0);
    // First English no-label entry is "May I show you something?"
    expect(out).toBe('May I show you something?');
  });

  test('variety floor: at least 16 phrases per supported lang', () => {
    for (const lang of ['en', 'de']) {
      expect(listTeacherInvitations(lang).length).toBeGreaterThanOrEqual(16);
    }
  });
});

describe('VTID-03092 — combined greeting + invitation render', () => {
  test('concatenation produces a clean two-sentence utterance', () => {
    const greeting = pickTeacherGreeting({
      lang: 'de',
      firstName: 'Dragan',
      rng: () => 0,
    });
    const invitation = pickTeacherInvitation({
      lang: 'de',
      featureLabel: null,
      rng: () => 0,
    });
    const full = `${greeting} ${invitation}`;
    expect(full).toBe('Willkommen zurück, Dragan. Darf ich dir kurz etwas zeigen?');
  });
});
