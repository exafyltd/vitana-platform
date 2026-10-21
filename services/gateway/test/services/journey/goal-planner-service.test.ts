/**
 * VTID-03152 — goal-planner pure helper tests (no DB/LLM).
 *   - addDaysIso / calendarDaysBetween calendar math
 *   - mapPlanToSteps: dated milestones/checkpoints clamped + dated, habits dateless,
 *     chronological ordering, day_offset clamp to [0, totalDays]
 */

import {
  addDaysIso,
  calendarDaysBetween,
  mapPlanToSteps,
  type LLMPlan,
} from '../../../src/services/journey/goal-planner-service';

describe('VTID-03152 goal-planner helpers', () => {
  describe('addDaysIso', () => {
    it('adds calendar days in UTC and returns YYYY-MM-DD', () => {
      expect(addDaysIso('2026-05-02T12:00:00.000Z', 30)).toBe('2026-06-01');
      expect(addDaysIso('2026-05-02', 0)).toBe('2026-05-02');
    });
  });

  describe('calendarDaysBetween', () => {
    it('counts whole calendar days regardless of time-of-day', () => {
      expect(calendarDaysBetween('2026-05-02T12:00:00.000Z', '2026-07-31')).toBe(90);
      expect(calendarDaysBetween('2026-06-01T23:00:00.000Z', '2026-06-01T01:00:00.000Z')).toBe(0);
    });
  });

  describe('mapPlanToSteps', () => {
    const plan: LLMPlan = {
      plan_summary: 'You will get there.',
      milestones: [
        { day_offset: 60, title: 'Halfway check', description: 'Halfway there' },
        { day_offset: 0, title: 'Kickoff' },
        { day_offset: 200, title: 'Final push' }, // beyond totalDays → clamps to 90
      ],
      weekly_checkpoints: [{ day_offset: 7, title: 'Week 1 review' }],
      daily_habits: [
        { title: '20-min walk', description: 'Every day' },
        { title: 'Log meals' },
        { title: '' }, // dropped
      ],
    };

    it('dates milestones/checkpoints, clamps offsets, keeps habits dateless, sorts chronologically', () => {
      const steps = mapPlanToSteps(plan, '2026-05-02T00:00:00.000Z', 90);

      const habits = steps.filter((s) => s.kind === 'habit');
      expect(habits).toHaveLength(2);
      expect(habits.every((h) => h.scheduled_date === null && h.day_offset === null)).toBe(true);

      const final = steps.find((s) => s.title === 'Final push')!;
      expect(final.day_offset).toBe(90); // clamped from 200
      expect(final.scheduled_date).toBe(addDaysIso('2026-05-02', 90));

      const kickoff = steps.find((s) => s.title === 'Kickoff')!;
      expect(kickoff.day_offset).toBe(0);
      expect(kickoff.scheduled_date).toBe('2026-05-02');

      // Dated steps are chronological; sort_order is reassigned 0..n-1.
      const dated = steps.filter((s) => s.scheduled_date);
      const dates = dated.map((s) => s.scheduled_date);
      expect([...dates]).toEqual([...dates].sort());
      expect(steps.map((s) => s.sort_order)).toEqual(steps.map((_, i) => i));
    });
  });
});
