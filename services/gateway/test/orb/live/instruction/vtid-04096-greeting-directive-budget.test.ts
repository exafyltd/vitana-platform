/**
 * VTID-04096 — the greeting DIRECTIVE is bounded, and the new-day rung has a
 * compact variant to fall back to.
 *
 * The directive is the third input to the same first generation request as the
 * system instruction (30 KB budget since VTID-04021) and the tool catalog
 * (budgeted since VTID-04026), and on an authenticated session it was the
 * LARGEST of the three at ~19 KB — with no bound at all. Production p50 for
 * `greeting_sent` -> `model_start_speaking` over 30 days, by rung:
 * `newday_overview` 5,805 ms at 19,177 chars (n=42) vs `safe_fast_proactive`
 * 1,545 ms at 551 chars (n=42).
 */

import {
  resolveGreetingDirectiveByteBudget,
  greetingDirectiveExceedsBudget,
  GREETING_DIRECTIVE_BYTE_BUDGET_DEFAULT,
} from '../../../../src/orb/live/instruction/greeting-directive-budget';
import {
  buildNewDayOverviewBlock,
  buildNewDayOverviewOpenerLine,
} from '../../../../src/services/assistant-continuation/providers/new-day-overview-prompt';
import { VERTEX_WAKE_BRIEF_OVERRIDE_MARKER } from '../../../../src/orb/live/instruction/wake-brief-marker';

describe('resolveGreetingDirectiveByteBudget', () => {
  it('defaults to 4 KB', () => {
    expect(resolveGreetingDirectiveByteBudget({})).toBe(GREETING_DIRECTIVE_BYTE_BUDGET_DEFAULT);
  });
  it('honours an explicit override', () => {
    expect(resolveGreetingDirectiveByteBudget({ ORB_GREETING_DIRECTIVE_BYTE_BUDGET: '8192' })).toBe(8192);
  });
  it('treats 0 as "restore the full directive" so rollback needs no deploy', () => {
    expect(resolveGreetingDirectiveByteBudget({ ORB_GREETING_DIRECTIVE_BYTE_BUDGET: '0' })).toBe(0);
  });
  it('falls back to the default on garbage rather than silently disabling itself', () => {
    // The exact failure mode VTID-04098 found live: FEATURE_LATENCY_TELEMETRY_ENV
    // was set to "production", an unrecognised value, and resolved to off.
    expect(resolveGreetingDirectiveByteBudget({ ORB_GREETING_DIRECTIVE_BYTE_BUDGET: 'small' })).toBe(
      GREETING_DIRECTIVE_BYTE_BUDGET_DEFAULT,
    );
  });
});

describe('greetingDirectiveExceedsBudget', () => {
  it('measures UTF-8 bytes, not characters — a German directive is heavier than its length', () => {
    const umlauts = 'ü'.repeat(10); // 10 chars, 20 bytes
    expect(greetingDirectiveExceedsBudget(umlauts, 15)).toBe(true);
    expect(greetingDirectiveExceedsBudget('a'.repeat(10), 15)).toBe(false);
  });
  it('is inert when the budget is disabled', () => {
    expect(greetingDirectiveExceedsBudget('x'.repeat(100_000), 0)).toBe(false);
  });
});

import type { OverviewPayload } from '../../../../src/services/assistant-continuation/providers/new-day-overview-payload';

// Reuse the same complete payload fixture the greeting suites already use,
// rather than hand-rolling a partial one — compactPayloadForPrompt reads
// fields a partial fixture silently lacks.
function payload(over: Partial<OverviewPayload> = {}): OverviewPayload {
  return {
    journey: null,
    vitana_index: {
      state: 'ok',
      today: 200,
      tier: 'Early',
      tier_framing: null,
      trend_7d: 4,
      weakest_pillar: { name: 'nutrition', score: 30 },
      strongest_pillar: null,
      balance_label: 'balanced',
      pillars: null,
      projected_day_90: null,
      projected_day_90_tier: null,
    },
    life_compass: {
      state: 'set',
      primary_goal: 'longer life',
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
    messages_unread: 3,
    reminders_today: { count: 0, next: null },
    diary_last_7d: 3,
    facts_learned_since_last: null,
    guided_journey: null,
    last_session_date_user_tz: null,
    ...over,
  } as OverviewPayload;
}

const args = (over: Record<string, unknown> = {}) =>
  ({ payload: payload(), lang: 'de', firstName: 'Dragan', localHour: 9, timezone: 'Europe/Berlin', ...over }) as never;

describe('buildNewDayOverviewOpenerLine', () => {
  it('is an order of magnitude smaller than the full block, and over the wire that is the point', () => {
    const full = buildNewDayOverviewBlock(args());
    const compact = buildNewDayOverviewOpenerLine(args());
    expect(Buffer.byteLength(compact)).toBeLessThan(Buffer.byteLength(full) / 5);
    expect(greetingDirectiveExceedsBudget(full)).toBe(true);
    expect(greetingDirectiveExceedsBudget(compact)).toBe(false);
  });

  it('keeps the override marker — without it the rung is silently demoted, not shrunk', () => {
    expect(buildNewDayOverviewOpenerLine(args())).toContain(VERTEX_WAKE_BRIEF_OVERRIDE_MARKER);
  });

  it('keeps the payload, because that is the situational half', () => {
    const compact = buildNewDayOverviewOpenerLine(args());
    expect(compact).toContain('weakest_pillar');
    expect(compact).toContain('nutrition');
    expect(compact).toContain('longer life');
  });

  it('drops the static tuition, because that is the half re-sent to every user every day', () => {
    const compact = buildNewDayOverviewOpenerLine(args());
    expect(compact).not.toMatch(/SHAPE EXAMPLE/i);
    expect(compact).not.toMatch(/COVERAGE CHECKLIST/i);
    expect(compact).not.toMatch(/COMPOSITION MOVES/i);
    expect(compact).not.toMatch(/HARD RULES/i);
  });

  it('states the name rule in the session language and never fabricates a name', () => {
    expect(buildNewDayOverviewOpenerLine(args())).toContain('Dragan');
    const noName = buildNewDayOverviewOpenerLine(args({ firstName: null }));
    expect(noName).toMatch(/erfinde keinen/i);
    expect(noName).not.toMatch(/heißt (null|undefined)/i);
    const noNameEn = buildNewDayOverviewOpenerLine(args({ firstName: null, lang: 'en' }));
    expect(noNameEn).toMatch(/do not invent one/i);
  });

  it('keeps already-spoken continuity — repeating a known number is the failure the full block guards', () => {
    const withLedger = buildNewDayOverviewOpenerLine(
      args({
        factDeltas: {
          vitana_index_today: {
            key: 'vitana_index_today', current: 200, previous: 196, delta: 4,
            status: 'changed', spoken_at: '2026-06-29T08:00:00Z',
          },
        },
      }),
    );
    expect(withLedger).toMatch(/Bereits gesprochene Fakten|Already-spoken facts/i);
  });

  it('bounds the continuity ledger so a long history cannot re-inflate the directive', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      many[`fact_${i}`] = {
        key: `a_very_long_fact_key_number_${i}`, current: i + 1, previous: i, delta: 1,
        status: 'changed', spoken_at: '2026-06-29T08:00:00Z',
      };
    }
    const compact = buildNewDayOverviewOpenerLine(args({ factDeltas: many }));
    expect(greetingDirectiveExceedsBudget(compact)).toBe(false);
  });

  it('speaks English for an English session', () => {
    const en = buildNewDayOverviewOpenerLine(args({ lang: 'en' }));
    expect(en).toMatch(/first session of a new day/i);
    expect(en).not.toMatch(/Begrüße/);
  });

  it('never hardcodes a sentence Vitana speaks (Part 1 NEVER rule 41) — it states intent', () => {
    const compact = buildNewDayOverviewOpenerLine(args());
    // An instruction, not a script: no "say exactly", no quoted line to recite.
    expect(compact).not.toMatch(/sage genau|say exactly|verbatim|wörtlich/i);
  });
});
