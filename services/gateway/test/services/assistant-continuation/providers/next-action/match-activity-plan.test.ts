/**
 * VTID-03070 (B0d-real Xm) — match / activity-plan source tests.
 *
 * Covers:
 *   - Pure helpers: classifyStage, rankMatches, bandForStage,
 *     renderKindLabel, renderLine
 *   - produceMatchActivityPlan:
 *     * No user_intents → no_eligible_record
 *     * user_intents query error → source_unavailable
 *     * user_intents throws → errored
 *     * intent_matches query error → source_unavailable
 *     * intent_matches throws → errored
 *     * No matching rows → no_eligible_record
 *     * mutual_interest row → priority 78, confidence high
 *     * pending_user_decision wins over mutual_interest when both present
 *     * fresh 'new' row → priority 65
 *     * Privacy: spoken line never includes raw match_id or kind_pairing enum
 */

import {
  produceMatchActivityPlan,
  classifyStage,
  rankMatches,
  bandForStage,
  renderKindLabel,
  renderLine,
} from '../../../../../src/services/assistant-continuation/providers/next-action/sources/match-activity-plan';
import type { MatchRow } from '../../../../../src/services/assistant-continuation/providers/next-action/sources/match-activity-plan';
import type { NextActionSourceContext } from '../../../../../src/services/assistant-continuation/providers/next-action/types';

interface FakeOpts {
  intentRows?: unknown[] | null;
  intentError?: { message: string } | null;
  intentThrows?: boolean;
  matchRows?: unknown[] | null;
  matchError?: { message: string } | null;
  matchThrows?: boolean;
}

function fakeSupabase(opts: FakeOpts): import('@supabase/supabase-js').SupabaseClient {
  let table = '';
  const intentChain: any = {
    eq: () => intentChain,
    order: () => intentChain,
    limit: () =>
      opts.intentThrows
        ? Promise.reject(new Error('boom-intents'))
        : Promise.resolve(
            opts.intentError
              ? { data: null, error: opts.intentError }
              : { data: opts.intentRows ?? null, error: null },
          ),
  };
  const matchChain: any = {
    or: () => matchChain,
    in: () => matchChain,
    order: () => matchChain,
    limit: () =>
      opts.matchThrows
        ? Promise.reject(new Error('boom-matches'))
        : Promise.resolve(
            opts.matchError
              ? { data: null, error: opts.matchError }
              : { data: opts.matchRows ?? null, error: null },
          ),
  };
  return {
    from: (t: string) => {
      table = t;
      return {
        select: () => (table === 'user_intents' ? intentChain : matchChain),
      };
    },
    rpc: async () => ({ data: null, error: null }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

function ctxWith(
  sb: import('@supabase/supabase-js').SupabaseClient,
  lang = 'en',
): NextActionSourceContext {
  return {
    userId: 'u1',
    tenantId: 't1',
    lang,
    nowIso: '2026-05-18T08:00:00Z',
    decisionContext: null,
    supabase: sb,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('match-activity-plan pure helpers', () => {
  test('renderKindLabel — known kinds get a friendly label, unknown stays generic', () => {
    expect(renderKindLabel('hike::hike')).toBe('hike');
    expect(renderKindLabel('chess::chess')).toBe('chess');
    expect(renderKindLabel('language_exchange::language_exchange')).toBe('language exchange');
    expect(renderKindLabel('buddy_seek::buddy_seek')).toBe('buddy');
    expect(renderKindLabel('commercial_buy::product')).toBe('purchase');
    expect(renderKindLabel('mystery_kind::other')).toBe('match'); // safe fallback
    expect(renderKindLabel(null)).toBe('match');
    expect(renderKindLabel('')).toBe('match');
  });

  test('renderLine — EN + DE for all three stages', () => {
    expect(renderLine('pending_user_decision', 'hike', 'en')).toMatch(/responded.+hike/i);
    expect(renderLine('pending_user_decision', 'hike', 'de')).toMatch(/Antwort.+hike/);
    expect(renderLine('mutual_interest', 'chess', 'en')).toMatch(/mutual.+chess/i);
    expect(renderLine('mutual_interest', 'chess', 'de')).toMatch(/gegenseitiges.+chess/);
    expect(renderLine('new', 'match', 'en')).toMatch(/fresh match/i);
    expect(renderLine('new', 'match', 'de')).toMatch(/frisches match/i);
  });

  test('bandForStage — priority + confidence', () => {
    expect(bandForStage('pending_user_decision')).toEqual({ priority: 85, confidence: 'high' });
    expect(bandForStage('mutual_interest')).toEqual({ priority: 78, confidence: 'high' });
    expect(bandForStage('new')).toEqual({ priority: 65, confidence: 'medium' });
  });

  test('classifyStage — mutual_interest always wins regardless of intent ownership', () => {
    const row: MatchRow = {
      match_id: 'm1',
      intent_a_id: 'i-a',
      intent_b_id: 'i-b',
      kind_pairing: 'hike::hike',
      state: 'mutual_interest',
      mutual_reveal_unlocked_at: null,
    };
    expect(classifyStage(row, new Set(['i-a']))).toBe('mutual_interest');
    expect(classifyStage(row, new Set(['i-b']))).toBe('mutual_interest');
  });

  test('classifyStage — pending_user_decision when other side responded', () => {
    const row: MatchRow = {
      match_id: 'm2',
      intent_a_id: 'i-a',
      intent_b_id: 'i-b',
      kind_pairing: 'chess::chess',
      state: 'responded_by_b',
      mutual_reveal_unlocked_at: null,
    };
    // User owns A — B responded, so A (user) owes the decision.
    expect(classifyStage(row, new Set(['i-a']))).toBe('pending_user_decision');
    // User owns B — B already responded, so it's not pending on user.
    expect(classifyStage(row, new Set(['i-b']))).toBeNull();
  });

  test('classifyStage — new fresh match', () => {
    const row: MatchRow = {
      match_id: 'm3',
      intent_a_id: 'i-a',
      intent_b_id: null,
      kind_pairing: 'commercial_buy::product',
      state: 'new',
      mutual_reveal_unlocked_at: null,
    };
    expect(classifyStage(row, new Set(['i-a']))).toBe('new');
  });

  test('classifyStage — declined or unrelated → null', () => {
    const row: MatchRow = {
      match_id: 'm4',
      intent_a_id: 'i-a',
      intent_b_id: 'i-b',
      kind_pairing: 'hike::hike',
      state: 'declined',
      mutual_reveal_unlocked_at: null,
    };
    expect(classifyStage(row, new Set(['i-a']))).toBeNull();
  });

  test('rankMatches — pending beats mutual beats new, stable by match_id', () => {
    const userIntents = new Set(['i-a']);
    const rows: MatchRow[] = [
      {
        match_id: 'b-new',
        intent_a_id: 'i-a',
        intent_b_id: null,
        kind_pairing: 'hike::hike',
        state: 'new',
        mutual_reveal_unlocked_at: null,
      },
      {
        match_id: 'a-mutual',
        intent_a_id: 'i-a',
        intent_b_id: 'i-other',
        kind_pairing: 'hike::hike',
        state: 'mutual_interest',
        mutual_reveal_unlocked_at: null,
      },
      {
        match_id: 'c-pending',
        intent_a_id: 'i-a',
        intent_b_id: 'i-other',
        kind_pairing: 'hike::hike',
        state: 'responded_by_b',
        mutual_reveal_unlocked_at: null,
      },
    ];
    const ranked = rankMatches(rows, userIntents);
    expect(ranked.map((r) => r.row.match_id)).toEqual(['c-pending', 'a-mutual', 'b-new']);
  });
});

// ---------------------------------------------------------------------------
// produceMatchActivityPlan
// ---------------------------------------------------------------------------

describe('produceMatchActivityPlan source', () => {
  test('no user_intents → no_eligible_record', async () => {
    const r = await produceMatchActivityPlan(ctxWith(fakeSupabase({ intentRows: [] })));
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('user_intents query error → source_unavailable', async () => {
    const r = await produceMatchActivityPlan(
      ctxWith(fakeSupabase({ intentError: { message: 'rls denied' } })),
    );
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('source_unavailable');
  });

  test('user_intents throws → errored', async () => {
    const r = await produceMatchActivityPlan(
      ctxWith(fakeSupabase({ intentThrows: true })),
    );
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('errored');
  });

  test('intent_matches query error → source_unavailable', async () => {
    const r = await produceMatchActivityPlan(
      ctxWith(
        fakeSupabase({
          intentRows: [{ intent_id: 'i-a' }],
          matchError: { message: 'rls denied' },
        }),
      ),
    );
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('source_unavailable');
  });

  test('intent_matches throws → errored', async () => {
    const r = await produceMatchActivityPlan(
      ctxWith(
        fakeSupabase({
          intentRows: [{ intent_id: 'i-a' }],
          matchThrows: true,
        }),
      ),
    );
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('errored');
  });

  test('no matching rows → no_eligible_record', async () => {
    const r = await produceMatchActivityPlan(
      ctxWith(
        fakeSupabase({
          intentRows: [{ intent_id: 'i-a' }],
          matchRows: [],
        }),
      ),
    );
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('no_eligible_record');
  });

  test('mutual_interest row → priority 78, confidence high', async () => {
    const r = await produceMatchActivityPlan(
      ctxWith(
        fakeSupabase({
          intentRows: [{ intent_id: 'i-a' }],
          matchRows: [
            {
              match_id: 'm-100',
              intent_a_id: 'i-a',
              intent_b_id: 'i-other',
              kind_pairing: 'hike::hike',
              state: 'mutual_interest',
              mutual_reveal_unlocked_at: null,
            },
          ],
        }),
      ),
    );
    expect(r.candidate).not.toBeNull();
    if (!r.candidate) return;
    expect(r.candidate.priority).toBe(78);
    expect(r.candidate.confidence).toBe('high');
    expect(r.candidate.dedupeKey).toBe('match_activity_plan:m-100:mutual_interest');
    expect(r.candidate.userFacingLine).toMatch(/hike/i);
    expect(r.candidate.cta?.type).toBe('ask_permission');
    expect(r.candidate.reasons[0].kind).toBe('match_mutual_interest_open_conversation');
  });

  test('pending_user_decision wins over mutual_interest when both present', async () => {
    const r = await produceMatchActivityPlan(
      ctxWith(
        fakeSupabase({
          intentRows: [{ intent_id: 'i-a' }],
          matchRows: [
            {
              match_id: 'a-mutual',
              intent_a_id: 'i-a',
              intent_b_id: 'i-other',
              kind_pairing: 'chess::chess',
              state: 'mutual_interest',
              mutual_reveal_unlocked_at: null,
            },
            {
              match_id: 'b-pending',
              intent_a_id: 'i-a',
              intent_b_id: 'i-other',
              kind_pairing: 'hike::hike',
              state: 'responded_by_b',
              mutual_reveal_unlocked_at: null,
            },
          ],
        }),
      ),
    );
    expect(r.candidate?.priority).toBe(85);
    expect(r.candidate?.dedupeKey).toBe('match_activity_plan:b-pending:pending_user_decision');
    expect(r.candidate?.userFacingLine).toMatch(/hike/);
  });

  test("fresh 'new' row → priority 65, confidence medium", async () => {
    const r = await produceMatchActivityPlan(
      ctxWith(
        fakeSupabase({
          intentRows: [{ intent_id: 'i-a' }],
          matchRows: [
            {
              match_id: 'm-new-1',
              intent_a_id: 'i-a',
              intent_b_id: null,
              kind_pairing: 'commercial_buy::product',
              state: 'new',
              mutual_reveal_unlocked_at: null,
            },
          ],
        }),
      ),
    );
    expect(r.candidate?.priority).toBe(65);
    expect(r.candidate?.confidence).toBe('medium');
    expect(r.candidate?.userFacingLine).toMatch(/fresh/i);
    expect(r.candidate?.userFacingLine).toMatch(/purchase/i);
  });

  test('privacy: spoken line never includes match_id or raw kind_pairing enum', async () => {
    const r = await produceMatchActivityPlan(
      ctxWith(
        fakeSupabase({
          intentRows: [{ intent_id: 'i-a' }],
          matchRows: [
            {
              match_id: 'PRIVATE-MATCH-UUID-1234567890',
              intent_a_id: 'i-a',
              intent_b_id: 'i-other',
              kind_pairing: 'commercial_sell::product',
              state: 'mutual_interest',
              mutual_reveal_unlocked_at: null,
            },
          ],
        }),
      ),
    );
    expect(r.candidate).not.toBeNull();
    if (!r.candidate) return;
    expect(r.candidate.userFacingLine).not.toContain('PRIVATE-MATCH-UUID-1234567890');
    expect(r.candidate.userFacingLine).not.toContain('commercial_sell::product');
    expect(r.candidate.userFacingLine).not.toContain('::');
  });

  test('unrelated intent ownership (declined or responded by user) → no_eligible_record', async () => {
    const r = await produceMatchActivityPlan(
      ctxWith(
        fakeSupabase({
          intentRows: [{ intent_id: 'i-a' }],
          matchRows: [
            // User is A; A already responded → not pending on user.
            {
              match_id: 'm-already-responded',
              intent_a_id: 'i-a',
              intent_b_id: 'i-other',
              kind_pairing: 'hike::hike',
              state: 'responded_by_a',
              mutual_reveal_unlocked_at: null,
            },
          ],
        }),
      ),
    );
    expect(r.candidate).toBeNull();
    expect(r.skippedReason).toBe('no_eligible_record');
  });
});
