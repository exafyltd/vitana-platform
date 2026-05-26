/**
 * VTID-03152 — Slice F: My Journey goal-centric North Star.
 *
 * Covers the time-based goal-progress math in buildGoalBlock():
 *   - goal with a deadline computes days_to_deadline / goal_total_days /
 *     goal_day / goal_progress_pct
 *   - goal without a deadline yields null goal-progress fields (has_deadline false)
 *   - deadline today clamps days_to_deadline to 0 and progress to 100
 *   - goal-target passthrough (value/unit/text/pillar) is preserved
 */

import { buildGoalBlock } from '../../src/routes/my-journey';
import type { LifeCompassSnapshot } from '../../src/services/user-context-profiler';

const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

function compass(overrides: Partial<LifeCompassSnapshot> = {}): LifeCompassSnapshot {
  return {
    primary_goal: 'Lose 10 kg',
    category: 'health',
    confidence_score: 80,
    target_date: null,
    target_value: null,
    target_unit: null,
    starting_value: null,
    set_at: null,
    ...overrides,
  };
}

describe('VTID-03152 my-journey buildGoalBlock', () => {
  it('computes time-based progress for a goal with a deadline', () => {
    // Set 30 days ago, deadline 60 days from now -> total 90, day 30, 33%.
    const block = buildGoalBlock(
      compass({
        set_at: '2026-05-02T12:00:00.000Z', // 30 days before FIXED_NOW
        target_date: '2026-07-31', // 60 days after FIXED_NOW
        target_value: 10,
        target_unit: 'kg',
      }),
      FIXED_NOW,
    );
    expect(block.has_deadline).toBe(true);
    expect(block.days_to_deadline).toBe(60);
    expect(block.goal_total_days).toBe(90);
    expect(block.goal_day).toBe(30);
    expect(block.goal_progress_pct).toBe(33);
    expect(block.target_value).toBe(10);
    expect(block.target_unit).toBe('kg');
    expect(block.active_goal_text).toBe('Lose 10 kg');
    expect(block.pillar_focus).toBe('health');
  });

  it('returns null goal-progress fields when no deadline is set', () => {
    const block = buildGoalBlock(compass({ set_at: '2026-05-02T12:00:00.000Z' }), FIXED_NOW);
    expect(block.has_deadline).toBe(false);
    expect(block.days_to_deadline).toBeNull();
    expect(block.goal_total_days).toBeNull();
    expect(block.goal_day).toBeNull();
    expect(block.goal_progress_pct).toBeNull();
    // Goal text/pillar still pass through.
    expect(block.active_goal_text).toBe('Lose 10 kg');
  });

  it('clamps a deadline that is today to 0 days left and 100% progress', () => {
    const block = buildGoalBlock(
      compass({
        set_at: '2026-05-02T12:00:00.000Z', // 30 days before
        target_date: '2026-06-01', // same calendar day as FIXED_NOW
      }),
      FIXED_NOW,
    );
    expect(block.days_to_deadline).toBe(0);
    expect(block.goal_progress_pct).toBe(100);
  });

  it('clamps a past deadline to 0 days left without going negative', () => {
    const block = buildGoalBlock(
      compass({
        set_at: '2026-04-01T12:00:00.000Z',
        target_date: '2026-05-15', // already passed
      }),
      FIXED_NOW,
    );
    expect(block.days_to_deadline).toBe(0);
    expect(block.goal_progress_pct).toBe(100);
  });
});
