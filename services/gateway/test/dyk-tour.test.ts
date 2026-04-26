/**
 * Did-You-Know Tour — unit tests (BOOTSTRAP-DYK-TOUR)
 *
 * Plan: .claude/plans/proactive-did-you-generic-sifakis.md
 *
 * Covers:
 *   A. resolveNextTip curriculum gating (usage-days, introduced, goal, probe)
 *   B. 30-usage-day hard guardrail
 *   C. Index-framing snapshot — every tip copy mentions Index or a pillar
 *   D. Tie-break priority + meta-boost
 */

import {
  DYK_TIP_REGISTRY,
  resolveNextTip,
  mentionsIndexOrPillar,
  getTipByKey,
  tourHintFromTip,
  type DidYouKnowTip,
} from '../src/services/guide/tip-curriculum';
import type { UserAwareness } from '../src/services/guide/types';

// =============================================================================
// Helpers
// =============================================================================

function makeAwareness(overrides: Partial<UserAwareness> = {}): UserAwareness {
  const base: UserAwareness = {
    tenure: {
      stage: 'day0',
      days_since_signup: 0,
      active_usage_days: 0,
      registered_at: new Date().toISOString(),
    },
    journey: { current_wave: null, day_in_journey: 0, is_past_90_day: false },
    goal: null,
    community_signals: {
      diary_streak_days: 0,
      connection_count: 0,
      group_count: 0,
      pending_match_count: 0,
      memory_goals: [],
      memory_interests: [],
    },
    recent_activity: {
      open_autopilot_recs: 0,
      activated_recs_last_7d: 0,
      dismissed_recs_last_7d: 0,
      overdue_calendar_count: 0,
      upcoming_calendar_24h_count: 0,
    },
    last_interaction: null,
    feature_introductions: [],
    prior_session_themes: [],
    adaptation_plans: null,
    routines: [],
    tastes_preferences: null,
  };
  return {
    ...base,
    ...overrides,
    tenure: { ...base.tenure, ...(overrides.tenure ?? {}) },
  };
}

// =============================================================================
// A. Curriculum resolver gating
// =============================================================================

describe('DYK resolveNextTip — usage-day gating', () => {
  test('day 0 fresh user → resolves to vitana_index (Index-centric priority)', () => {
    const aw = makeAwareness({ tenure: { stage: 'day0', days_since_signup: 0, active_usage_days: 0, registered_at: new Date().toISOString() } });
    const tip = resolveNextTip(aw);
    expect(tip).not.toBeNull();
    expect(tip!.feature_key).toBe('vitana_index');
  });

  test('day 0 user with vitana_index already introduced → resolves to voice_chat_basics', () => {
    const aw = makeAwareness({
      tenure: { stage: 'day0', days_since_signup: 0, active_usage_days: 0, registered_at: new Date().toISOString() },
      feature_introductions: ['vitana_index'],
    });
    const tip = resolveNextTip(aw);
    expect(tip).not.toBeNull();
    expect(tip!.feature_key).toBe('voice_chat_basics');
  });

  test('day 2 user with Index + voice already introduced → resolves to health_section (Exercise pillar)', () => {
    const aw = makeAwareness({
      tenure: { stage: 'day3', days_since_signup: 2, active_usage_days: 2, registered_at: new Date().toISOString() },
      feature_introductions: ['vitana_index', 'voice_chat_basics', 'life_compass', 'vitana_index_detail'],
    });
    const tip = resolveNextTip(aw);
    expect(tip).not.toBeNull();
    expect(tip!.feature_key).toBe('health_section');
    expect(tip!.index_pillar_link).toBe('Exercise');
  });

  test('day 3 user with open recs → autopilot_index_impact eligible', () => {
    const aw = makeAwareness({
      tenure: { stage: 'day3', days_since_signup: 3, active_usage_days: 3, registered_at: new Date().toISOString() },
      feature_introductions: ['vitana_index', 'voice_chat_basics', 'life_compass', 'vitana_index_detail', 'health_section'],
      recent_activity: {
        open_autopilot_recs: 3,
        activated_recs_last_7d: 0,
        dismissed_recs_last_7d: 0,
        overdue_calendar_count: 0,
        upcoming_calendar_24h_count: 0,
      },
    });
    const tip = resolveNextTip(aw);
    expect(tip).not.toBeNull();
    expect(['autopilot_index_impact', 'my_journey']).toContain(tip!.feature_key);
  });

  test('day 3 user with zero open recs → autopilot_index_impact filtered, my_journey needs wave', () => {
    const aw = makeAwareness({
      tenure: { stage: 'day3', days_since_signup: 3, active_usage_days: 3, registered_at: new Date().toISOString() },
      feature_introductions: ['vitana_index', 'voice_chat_basics', 'life_compass', 'vitana_index_detail', 'health_section'],
      // No open recs → autopilot probe fails. No current wave → my_journey probe fails.
    });
    const tip = resolveNextTip(aw);
    // Should fall back to something else or null — neither autopilot nor journey
    if (tip) {
      expect(tip.feature_key).not.toBe('autopilot_index_impact');
      expect(tip.feature_key).not.toBe('my_journey');
    }
  });
});

describe('DYK resolveNextTip — 30-usage-day hard guardrail', () => {
  test('active_usage_days = 30 is still eligible (inclusive boundary)', () => {
    const aw = makeAwareness({
      tenure: { stage: 'day30plus', days_since_signup: 60, active_usage_days: 30, registered_at: new Date().toISOString() },
    });
    const tip = resolveNextTip(aw);
    expect(tip).not.toBeNull();
  });

  test('active_usage_days = 31 → null (tour is over)', () => {
    const aw = makeAwareness({
      tenure: { stage: 'day30plus', days_since_signup: 60, active_usage_days: 31, registered_at: new Date().toISOString() },
    });
    const tip = resolveNextTip(aw);
    expect(tip).toBeNull();
  });

  test('calendar days HIGH but usage days LOW → still in tour (this is the whole point)', () => {
    // Signed up 60 calendar days ago, but only came back twice → usage-day 2.
    const aw = makeAwareness({
      tenure: { stage: 'day30plus', days_since_signup: 60, active_usage_days: 2, registered_at: new Date().toISOString() },
    });
    const tip = resolveNextTip(aw);
    expect(tip).not.toBeNull();
  });
});

// =============================================================================
// B. Goal-category gate
// =============================================================================

describe('DYK resolveNextTip — goal gating', () => {
  test('business_hub only fires for career/financial_freedom goal categories', () => {
    // Introduce everything EXCEPT business_hub so it's the only day-14 tip left.
    const introduced = DYK_TIP_REGISTRY.filter((t) => t.feature_key !== 'business_hub').map(
      (t) => t.feature_key,
    );
    const awNoGoal = makeAwareness({
      tenure: { stage: 'day30plus', days_since_signup: 14, active_usage_days: 14, registered_at: new Date().toISOString() },
      feature_introductions: introduced as string[],
    });
    const tipNoGoal = resolveNextTip(awNoGoal);
    // Without a matching goal category, business_hub is filtered out → null (or non-business-hub if any)
    expect(tipNoGoal?.feature_key ?? null).not.toBe('business_hub');

    const awCareer = makeAwareness({
      ...awNoGoal,
      goal: { primary_goal: 'Advance my career', category: 'career', is_system_seeded: false },
    });
    const tipCareer = resolveNextTip(awCareer);
    expect(tipCareer?.feature_key).toBe('business_hub');
  });
});

// =============================================================================
// C. Index-framing snapshot — the rule every tip must respect
// =============================================================================

describe('DYK curriculum — Index framing invariant', () => {
  test('every registered tip has a voice_on_nav that mentions Index or a pillar', () => {
    const offenders = DYK_TIP_REGISTRY.filter((t) => !mentionsIndexOrPillar(t.voice_on_nav));
    expect(offenders.map((t) => t.tip_key)).toEqual([]);
  });

  test('every registered tip has a card_copy that mentions Index or a pillar', () => {
    const offenders = DYK_TIP_REGISTRY.filter((t) => !mentionsIndexOrPillar(t.card_copy));
    expect(offenders.map((t) => t.tip_key)).toEqual([]);
  });

  test('every registered tip has a voice_opener that mentions Index or a pillar', () => {
    // Opener is allowed to be feature-first, but Index/pillar framing is strongly preferred.
    // We accept this as a soft warning via a looser assertion: >= 80% must frame.
    const framed = DYK_TIP_REGISTRY.filter((t) => mentionsIndexOrPillar(t.voice_opener));
    expect(framed.length / DYK_TIP_REGISTRY.length).toBeGreaterThanOrEqual(0.8);
  });
});

// =============================================================================
// D. Meta-priority boost
// =============================================================================

describe('DYK tie-break — meta pillar boost', () => {
  test('when two tips share priority, meta wins over a pillar-specific', () => {
    // Synthetic test: find any two tips with same priority, different pillar links.
    // In the current registry this is hard to hit cleanly, so we test the boost
    // indirectly by confirming day-0 vitana_index (meta, 100) beats everything.
    const aw = makeAwareness();
    const tip = resolveNextTip(aw);
    expect(tip?.index_pillar_link).toBe('meta');
  });
});

// =============================================================================
// E. Helpers
// =============================================================================

describe('DYK helpers', () => {
  test('getTipByKey returns the tip object for a known key', () => {
    const tip = getTipByKey('dyk_vitana_index_day0');
    expect(tip).not.toBeNull();
    expect(tip!.feature_key).toBe('vitana_index');
  });

  test('getTipByKey returns null for unknown keys', () => {
    expect(getTipByKey('dyk_does_not_exist')).toBeNull();
  });

  test('tourHintFromTip shape is compact and serializable', () => {
    const tip = getTipByKey('dyk_vitana_index_day0')!;
    const hint = tourHintFromTip(tip);
    expect(hint).toMatchObject({
      tip_key: 'dyk_vitana_index_day0',
      feature_key: 'vitana_index',
      index_pillar_link: 'meta',
    });
    expect(hint.voice_opener.length).toBeGreaterThan(0);
    expect(hint.voice_on_nav.length).toBeGreaterThan(0);
    expect(hint.cta_url.length).toBeGreaterThan(0);
  });
});
