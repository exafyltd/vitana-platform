/**
 * VTID-03184 — endless-journey plan_phase branching characterization tests.
 *
 * Re-applied under BOOTSTRAP-ORB-R5-REAPPLY (Phase R5). The original change
 * (PR #2390, sha 6f37bcdd) was reverted on 2026-05-29 on a MISDIAGNOSIS — the
 * real cause was the R0 Vertex instruction-size bug (diagnosed + fixed in a
 * separate lane). The behavior is back on main; these tests lock it so it
 * cannot silently regress / be re-reverted again.
 *
 * The journey is endless. The default 90-day plan is scaffolding for users
 * WITHOUT a personalized goal — not a universal cap. `buildNewDayOverviewBlock`
 * must branch its JOURNEY CONTEXT framing + COVERAGE CHECKLIST on
 * `journey.plan_phase`:
 *
 *   - default_active            → "Tag X von Y" + wave framing kept.
 *   - default_finished_no_goal  → starter-plan-complete → invite first goal.
 *   - on_personalized_goal      → DROP "X von 90"; anchor on the goal arc.
 */

import { buildNewDayOverviewBlock } from '../../../../src/services/assistant-continuation/providers/new-day-overview-prompt';
import type { OverviewPayload, JourneyPlanPhase } from '../../../../src/services/assistant-continuation/providers/new-day-overview-payload';

type Journey = NonNullable<OverviewPayload['journey']>;

function makePayload(journey: OverviewPayload['journey']): OverviewPayload {
  return {
    journey,
    vitana_index: {
      state: 'not_set_up',
      today: null,
      tier: null,
      tier_framing: null,
      trend_7d: null,
      weakest_pillar: null,
      strongest_pillar: null,
      balance_label: null,
      pillars: null,
      projected_day_90: null,
      projected_day_90_tier: null,
    },
    life_compass: {
      state: 'not_set',
      primary_goal: null,
      category: null,
      target_date: null,
      target_value: null,
      target_unit: null,
      starting_value: null,
      set_at: null,
      days_to_deadline: null,
      goal_progress_pct: null,
    },
    calendar_today: { count: 0, next: null },
    calendar_passed: { count: 0, most_recent: null },
    autopilot: { state: 'none_yet', today_checkpoint: null, this_week: [], pending_total: 0 },
    matches_unread: 0,
    messages_unread: 0,
    reminders_today: { count: 0, next: null },
    diary_last_7d: 0,
    facts_learned_since_last: null,
    guided_journey: null,
    last_session_date_user_tz: '2026-05-31',
  };
}

const baseJourney: Journey = {
  plan_phase: 'default_active',
  day_in_journey: 23,
  is_first_session: false,
  plan_type: 'default',
  default_plan_total_days: 90,
  current_wave: {
    name: 'Exploration',
    description: 'Getting to know the platform',
    day_in_wave: 3,
    days_to_next_wave: 7,
  },
  current_goal_day: null,
  days_past_deadline: null,
  previous_goals_count: 0,
};

function buildFor(journey: Journey): string {
  return buildNewDayOverviewBlock({
    payload: makePayload(journey),
    lang: 'de',
    firstName: 'Anna',
    localHour: 9,
    timezone: 'Europe/Berlin',
  });
}

describe('VTID-03184 plan_phase branching — buildNewDayOverviewBlock', () => {
  it('default_active: keeps the "Tag X von Y" starter-plan + wave framing', () => {
    const block = buildFor({ ...baseJourney, plan_phase: 'default_active' });
    expect(block).toContain("plan_phase='default_active'");
    // Starter-plan day-of-total framing with the wave named.
    expect(block).toContain('Day 23 of 90 in the starter plan');
    expect(block).toContain('"Exploration" phase');
  });

  it('default_finished_no_goal: invites the first personalized goal, no "X of Y" cap', () => {
    const block = buildFor({
      ...baseJourney,
      plan_phase: 'default_finished_no_goal',
      day_in_journey: 152, // past the 90-day default — the bug case ("Day 152 of 90")
      current_wave: null,
    });
    expect(block).toContain("plan_phase='default_finished_no_goal'");
    expect(block).toContain('completed the 90-day starter plan');
    expect(block).toContain('NOT set a personalized goal');
    // The endless-journey contract: never frame the finished default as a dead end.
    expect(block).not.toContain('Day 152 of 90');
  });

  it('on_personalized_goal: drops the 90-day frame and anchors on the goal arc', () => {
    const block = buildFor({
      ...baseJourney,
      plan_phase: 'on_personalized_goal',
      day_in_journey: 132,
      default_plan_total_days: null,
      current_wave: null,
      current_goal_day: 40,
      previous_goals_count: 1,
    });
    expect(block).toContain("plan_phase='on_personalized_goal'");
    expect(block).toContain('Day 132 with Vitana');
    // previous_goals_count=1 → this is goal number 2 in the arc.
    expect(block).toContain('This is goal number 2 in the user arc.');
    expect(block).toContain('Day 40 on this goal.');
    // The hard rule: no scaffolding "Tag X von 90" framing on a personalized goal.
    expect(block).toContain('DO NOT use "Tag X von 90" framing.');
  });

  it('on_personalized_goal: surfaces a past deadline gently (never as failure)', () => {
    const block = buildFor({
      ...baseJourney,
      plan_phase: 'on_personalized_goal',
      day_in_journey: 200,
      default_plan_total_days: null,
      current_wave: null,
      current_goal_day: 95,
      days_past_deadline: 12,
      previous_goals_count: 0,
    });
    expect(block).toContain('Target date passed 12 days ago');
    expect(block).toContain('never as failure');
    expect(block).toContain('This is the first personalized goal for this user.');
  });
});
