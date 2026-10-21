/**
 * Speakable text for the "improve my Index" coaching tools.
 *
 * THE BUGS (operator screenshots):
 *  - "wie ich meinen Vital-Index verbessern kann" → "Das konnte ich gerade nicht
 *    abschließen": get_index_improvement_suggestions returned raw JSON with an
 *    empty list when the user had no queued recommendations.
 *  - The plan tool wrote 6 calendar events but only said "Scheduled 6 actions",
 *    leaving the user with "keine Ahnung, was du da einträgst".
 *
 * These pin: suggestions are never empty/never JSON/never a fake-fail, and the
 * plan confirmation NAMES every scheduled activity.
 */

import {
  buildIndexSuggestionsText,
  buildIndexPlanText,
} from '../../../src/services/orb-index-coach-text';

const ANTI_FAIL = /Do NOT say you could not do it/i;

describe('buildIndexSuggestionsText', () => {
  it('with items → speakable, enumerated, never raw JSON, anti-fake-fail', () => {
    const t = buildIndexSuggestionsText('nutrition', [
      { title: 'Meal planning block', description: '15 minutes to plan balanced meals.' },
      { title: 'Mindful eating session', description: 'One slow, phone-free meal.' },
    ]);
    expect(t).toMatch(/Meal planning block/);
    expect(t).toMatch(/Mindful eating session/);
    expect(t).toMatch(/nutrition/);
    expect(t.trim().startsWith('{')).toBe(false);
    expect(t).toMatch(ANTI_FAIL);
  });

  it('with NO items → still positive + actionable, never a fake-fail', () => {
    const t = buildIndexSuggestionsText('nutrition', []);
    expect(t).toMatch(/HANDLED/);
    expect(t).toMatch(/starter nutrition plan/i);
    expect(t).toMatch(ANTI_FAIL);
  });
});

describe('buildIndexPlanText', () => {
  it('names every scheduled activity with its date (transparency)', () => {
    const t = buildIndexPlanText('nutrition', 14, [
      { title: 'Meal planning block', start_time: '2026-06-29T10:00:00.000Z' },
      { title: 'Mindful eating session', start_time: '2026-07-02T10:00:00.000Z' },
    ]);
    expect(t).toMatch(/2 nutrition actions/);
    expect(t).toMatch(/14 days/);
    expect(t).toMatch(/Meal planning block \(2026-06-29\)/);
    expect(t).toMatch(/Mindful eating session \(2026-07-02\)/);
    expect(t).toMatch(/name each one/i);
  });

  it('singular wording for a single action', () => {
    const t = buildIndexPlanText('sleep', 7, [{ title: 'Wind-down routine', start_time: '2026-06-29T20:00:00Z' }]);
    expect(t).toMatch(/1 sleep action added/);
    expect(t).not.toMatch(/1 sleep actions/);
  });
});
