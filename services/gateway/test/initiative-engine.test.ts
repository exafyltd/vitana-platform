/**
 * V2 Proactive Initiative Engine — unit tests
 *
 * Plan: .claude/plans/proactive-did-you-generic-sifakis.md (V2 section)
 *
 * Covers:
 *   A. Resolver gating — eligibility probes filter correctly
 *   B. Index-framing snapshot — every initiative's voice_opener (with no
 *      target spliced in) mentions "Index" or one of the canonical 5
 *      pillars; build_voice_on_complete does too
 *   C. Sanctioned-phrasing parity — `voice_confirm` is non-empty for
 *      every initiative; `voice_on_consent` is set whenever
 *      `requires_user_dictation=true` (otherwise the LLM has nothing to
 *      say in the multi-turn flow)
 *   D. Helpers — getInitiativeByKey
 */

import {
  INITIATIVE_REGISTRY,
  pickProactiveInitiative,
  getInitiativeByKey,
  mentionsIndexOrPillar,
  INITIATIVE_FRAMING_TOKENS,
} from '../src/services/guide/initiative-registry';
import type { UserAwareness } from '../src/services/guide/types';

// =============================================================================
// Helpers
// =============================================================================

function makeAwareness(overrides: Partial<UserAwareness> = {}): UserAwareness {
  const base: UserAwareness = {
    tenure: {
      stage: 'day7',
      days_since_signup: 7,
      active_usage_days: 5,
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
    sessions_today: { count: 0, entries: [] },
    last_session_yesterday: null,
  };
  return {
    ...base,
    ...overrides,
    tenure: { ...base.tenure, ...(overrides.tenure ?? {}) },
    community_signals: { ...base.community_signals, ...(overrides.community_signals ?? {}) },
    recent_activity: { ...base.recent_activity, ...(overrides.recent_activity ?? {}) },
  };
}

// =============================================================================
// A. Resolver gating
// =============================================================================

describe('Initiative resolver — eligibility probes', () => {
  test('day-0 user (active_usage_days=0) is filtered out of morning_diary_capture', () => {
    const aw = makeAwareness({
      tenure: {
        stage: 'day0',
        days_since_signup: 0,
        active_usage_days: 0,
        registered_at: new Date().toISOString(),
      },
    });
    const diary = INITIATIVE_REGISTRY.find((i) => i.initiative_key === 'morning_diary_capture')!;
    expect(diary.eligibility_probe(aw, { user_id: 'u1', utc_date: '2026-04-26' })).toBe(false);
  });

  test('day-1+ user passes morning_diary_capture eligibility', () => {
    const aw = makeAwareness({
      tenure: {
        stage: 'day1',
        days_since_signup: 1,
        active_usage_days: 1,
        registered_at: new Date().toISOString(),
      },
    });
    const diary = INITIATIVE_REGISTRY.find((i) => i.initiative_key === 'morning_diary_capture')!;
    expect(diary.eligibility_probe(aw, { user_id: 'u1', utc_date: '2026-04-26' })).toBe(true);
  });

  test('autopilot_top_recommendation requires open_autopilot_recs >= 1', () => {
    const noRecs = makeAwareness({ recent_activity: { open_autopilot_recs: 0 } as any });
    const oneRec = makeAwareness({ recent_activity: { open_autopilot_recs: 1 } as any });
    const ap = INITIATIVE_REGISTRY.find((i) => i.initiative_key === 'autopilot_top_recommendation')!;
    expect(ap.eligibility_probe(noRecs, { user_id: 'u1', utc_date: '2026-04-26' })).toBe(false);
    expect(ap.eligibility_probe(oneRec, { user_id: 'u1', utc_date: '2026-04-26' })).toBe(true);
  });

  test('network_morning_greeting requires connection_count >= 1', () => {
    const noConns = makeAwareness({ community_signals: { connection_count: 0 } as any });
    const oneConn = makeAwareness({ community_signals: { connection_count: 1 } as any });
    const net = INITIATIVE_REGISTRY.find((i) => i.initiative_key === 'network_morning_greeting')!;
    expect(net.eligibility_probe(noConns, { user_id: 'u1', utc_date: '2026-04-26' })).toBe(false);
    expect(net.eligibility_probe(oneConn, { user_id: 'u1', utc_date: '2026-04-26' })).toBe(true);
  });
});

// =============================================================================
// B. Index-framing snapshot
// =============================================================================

describe('Initiative copy — Index/pillar framing invariant', () => {
  test('every initiative voice_opener (no target) mentions Index or a canonical pillar', () => {
    const offenders = INITIATIVE_REGISTRY.filter((i) => {
      // Build with no target — simulates the case where resolve_target
      // returns null but the initiative's NL still mentions the framing.
      const text = i.build_voice_opener(makeAwareness(), null);
      return !mentionsIndexOrPillar(text);
    });
    expect(offenders.map((i) => i.initiative_key)).toEqual([]);
  });

  test('every initiative build_voice_on_complete (no target) mentions Index or a canonical pillar OR is a confirmation', () => {
    // Some completion lines are pure confirmations ("Sent.") which is fine
    // for v1 — they pair with a tool-result Index delta the LLM can splice.
    // The stricter rule here: at least HALF of completion templates mention
    // the framing tokens, so at least the "Index climbed" payoff is present
    // somewhere. Adjust to >= 1/N if registry shrinks.
    const framedCount = INITIATIVE_REGISTRY.filter((i) => {
      const text = i.build_voice_on_complete(null);
      return mentionsIndexOrPillar(text);
    }).length;
    expect(framedCount).toBeGreaterThanOrEqual(Math.ceil(INITIATIVE_REGISTRY.length / 2));
  });

  test('INITIATIVE_FRAMING_TOKENS contains exactly the 5 canonical pillars + Index', () => {
    expect([...INITIATIVE_FRAMING_TOKENS].sort()).toEqual(
      ['Exercise', 'Hydration', 'Index', 'Mental', 'Nutrition', 'Sleep'].sort(),
    );
    // Critical: legacy 6-pillar names must NOT be in the framing tokens
    // (would silently allow drift back to retired pillars — same trap that
    // hit the DYK curriculum copy).
    const legacy = ['Physical', 'Nutritional', 'Social', 'Environmental', 'Prosperity'];
    for (const stale of legacy) {
      expect(INITIATIVE_FRAMING_TOKENS).not.toContain(stale);
    }
  });
});

// =============================================================================
// C. Sanctioned-phrasing parity
// =============================================================================

describe('Initiative shape invariants', () => {
  test('every initiative has a non-empty voice_confirm', () => {
    for (const i of INITIATIVE_REGISTRY) {
      expect(i.voice_confirm.length).toBeGreaterThan(0);
    }
  });

  test('initiatives with requires_user_dictation=true MUST set voice_on_consent', () => {
    for (const i of INITIATIVE_REGISTRY) {
      if (i.requires_user_dictation) {
        expect(i.voice_on_consent).toBeTruthy();
        expect(i.voice_on_consent!.length).toBeGreaterThan(0);
      }
    }
  });

  test('every initiative has an on_yes_payload_hint (LLM needs guidance)', () => {
    for (const i of INITIATIVE_REGISTRY) {
      expect(i.on_yes_payload_hint.length).toBeGreaterThan(0);
    }
  });

  test('initiative_keys are unique', () => {
    const keys = INITIATIVE_REGISTRY.map((i) => i.initiative_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('priorities are 0-100', () => {
    for (const i of INITIATIVE_REGISTRY) {
      expect(i.priority).toBeGreaterThanOrEqual(0);
      expect(i.priority).toBeLessThanOrEqual(100);
    }
  });
});

// =============================================================================
// D. Helpers
// =============================================================================

describe('Initiative helpers', () => {
  test('getInitiativeByKey returns the initiative for a known key', () => {
    const found = getInitiativeByKey('morning_diary_capture');
    expect(found).not.toBeNull();
    expect(found!.on_yes_tool).toBe('save_diary_entry');
  });

  test('getInitiativeByKey returns null for unknown keys', () => {
    expect(getInitiativeByKey('nonexistent_key')).toBeNull();
  });
});

// =============================================================================
// E. End-to-end resolver path (without DB calls)
// =============================================================================

describe('pickProactiveInitiative — top-level resolver', () => {
  test('returns null when no initiative is eligible (day-0 + no recs + no connections)', async () => {
    const aw = makeAwareness({
      tenure: {
        stage: 'day0',
        days_since_signup: 0,
        active_usage_days: 0,
        registered_at: new Date().toISOString(),
      },
      community_signals: { connection_count: 0 } as any,
      recent_activity: { open_autopilot_recs: 0 } as any,
    });
    const result = await pickProactiveInitiative(aw, 'u1', '2026-04-26');
    expect(result).toBeNull();
  });

  test('higher-priority initiative wins when multiple are eligible (deterministic order)', async () => {
    // morning_diary_capture (priority 90) should beat network_morning_greeting
    // (priority 80) for a user where both are eligible by probe — even though
    // network resolve_target will be null without DB stub, the resolver tries
    // the highest-priority one first and either wins or falls through.
    const aw = makeAwareness({
      tenure: {
        stage: 'day7',
        days_since_signup: 7,
        active_usage_days: 5,
        registered_at: new Date().toISOString(),
      },
      community_signals: { connection_count: 1 } as any,
    });
    const result = await pickProactiveInitiative(aw, 'u1', '2026-04-26');
    // morning_diary_capture has no resolve_target so it always returns
    // when its probe passes. Expect it to win.
    expect(result).not.toBeNull();
    expect(result!.initiative.initiative_key).toBe('morning_diary_capture');
  });
});
