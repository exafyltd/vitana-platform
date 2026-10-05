/**
 * VTID-04826: the calendar prioritizer reads the Vitana Index — events that
 * work on the user's weakest pillars rank higher. Its header promised a
 * "declining index" input that was never implemented.
 */
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import { eventPillar, pillarBoost, reprioritizeUserEvents } from '../src/services/calendar-prioritizer';

const SCORES = { sleep: 12, nutrition: 30, exercise: 18, hydration: 40, mental: 35 }; // weakest sleep, then exercise

describe('VTID-04826 pillar of an event', () => {
  test.each([
    [{ wellness_tags: ['movement'] }, 'exercise'],
    [{ wellness_tags: ['Sleep'] }, 'sleep'],
    [{ wellness_tags: ['meetup', 'walk'] }, 'mental'],
    [{ wellness_tags: ['unknown'], event_type: 'workout' }, 'exercise'],
    [{ event_type: 'nutrition' }, 'nutrition'],
    [{ event_type: 'meeting', wellness_tags: [] }, null],
    [{}, null],
  ])('%j → %s', (ev, pillar) => {
    expect(eventPillar(ev as any)).toBe(pillar);
  });
});

describe('VTID-04826 pillar boost', () => {
  test('weakest +10, second weakest +5, others 0', () => {
    expect(pillarBoost('sleep', SCORES)).toBe(10);
    expect(pillarBoost('exercise', SCORES)).toBe(5);
    expect(pillarBoost('hydration', SCORES)).toBe(0);
  });
  test('no boost without a pillar, without scores, with under three pillars known, or when the pillars are level', () => {
    expect(pillarBoost(null, SCORES)).toBe(0);
    expect(pillarBoost('sleep', null)).toBe(0);
    expect(pillarBoost('sleep', { sleep: 5, exercise: 40 })).toBe(0);
    expect(pillarBoost('sleep', { sleep: 20, nutrition: 22, exercise: 21, hydration: 23, mental: 24 })).toBe(0);
  });
});

describe('VTID-04826 reprioritizeUserEvents', () => {
  const realFetch = global.fetch;
  const env = { ...process.env };
  let patches: Array<{ id: string; score: number }>;
  let indexRows: any[];

  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://sb.test';
    process.env.SUPABASE_SERVICE_ROLE = 'svc';
    patches = [];
    indexRows = [{ score_sleep: 12, score_nutrition: 30, score_exercise: 18, score_hydration: 40, score_mental: 35 }];
    const inThreeDays = new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString();
    const events = [
      { id: 'sleep-ev', start_time: inThreeDays, event_type: 'health', wellness_tags: ['sleep'], reschedule_count: 0, priority_score: 50 },
      { id: 'walk-ev', start_time: inThreeDays, event_type: 'health', wellness_tags: ['movement'], reschedule_count: 0, priority_score: 50 },
      { id: 'water-ev', start_time: inThreeDays, event_type: 'health', wellness_tags: ['hydration'], reschedule_count: 0, priority_score: 50 },
    ];
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      if (init?.method === 'PATCH') {
        patches.push({ id: url.split('id=eq.')[1], score: JSON.parse(init.body).priority_score });
        return { ok: true, json: async () => ({}) };
      }
      if (url.includes('/vitana_index_scores?')) {
        expect(url).toContain('user_id=eq.u1');
        expect(url).toContain('order=date.desc&limit=1');
        return { ok: true, json: async () => indexRows };
      }
      return { ok: true, json: async () => events };
    });
  });
  afterEach(() => {
    (global as any).fetch = realFetch;
    process.env = { ...env };
  });

  test('the weakest pillar ranks first, the second weakest next, the rest keep the base', async () => {
    await reprioritizeUserEvents('u1');
    // base 50 + health type 5 (more than 3 days out: no urgency boost)
    expect(patches).toEqual([
      { id: 'sleep-ev', score: 65 },
      { id: 'walk-ev', score: 60 },
      { id: 'water-ev', score: 55 },
    ]);
  });

  test('without index data the old flat +3 for movement stays', async () => {
    indexRows = [];
    await reprioritizeUserEvents('u1');
    expect(patches).toEqual([
      { id: 'sleep-ev', score: 55 },
      { id: 'walk-ev', score: 58 },
      { id: 'water-ev', score: 55 },
    ]);
  });
});
