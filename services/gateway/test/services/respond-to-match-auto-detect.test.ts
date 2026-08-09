/**
 * respond_to_match — VTID-VOICE-RESPOND-MATCH-ID.
 *
 * THE BUG: view_intent_matches's speech summary (formatMatchesForSpeech)
 * never speaks match_id, so the model calling respond_to_match right after
 * hearing the matches list had no match_id to pass — the tool always failed
 * with "match_id and response required". Unlike its sibling dispute_match,
 * respond_to_match had no fallback to resolve the match server-side.
 *
 * These tests pin the fix: when match_id is omitted, respond_to_match looks
 * up the user's own matches still awaiting their response and auto-picks
 * when there is exactly one; it asks (never guesses) when there is more than
 * one, and reports "nothing pending" when there are none. The resolved
 * match_id is always echoed back in the awaiting_confirmation payload so a
 * follow-up confirmed=true call can carry it forward explicitly.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import { tool_respond_to_match } from '../../src/services/orb-tools-shared';

const id = { user_id: 'u1', tenant_id: 't1', role: 'community' } as never;

interface IntentRow {
  intent_id: string;
}
interface MatchRow {
  match_id: string;
  intent_a_id: string;
  intent_b_id: string;
  state: string | null;
  kind_pairing: string | null;
  score: number | null;
}

function makeStubSupabase(opts: { intents: IntentRow[]; matches: MatchRow[] }) {
  return {
    from(table: string) {
      if (table === 'user_intents') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: opts.intents, error: null }),
              }),
            }),
          }),
        } as unknown;
      }
      if (table === 'intent_matches') {
        return {
          select: () => ({
            or: () => ({
              order: () => ({
                limit: async () => ({ data: opts.matches, error: null }),
              }),
            }),
          }),
        } as unknown;
      }
      throw new Error(`unexpected table in stub: ${table}`);
    },
  } as never;
}

describe('respond_to_match — auto-detect match_id when omitted', () => {
  it('exactly one pending match → auto-picks it and echoes match_id back for confirmation', async () => {
    const sb = makeStubSupabase({
      intents: [{ intent_id: 'i1' }],
      matches: [
        { match_id: 'm1', intent_a_id: 'i1', intent_b_id: 'i2', state: 'new', kind_pairing: 'partner_seek', score: 0.85 },
      ],
    });
    const r = await tool_respond_to_match({ response: 'express_interest' }, id, sb);
    expect(r.ok).toBe(true);
    expect((r.result as { stage: string }).stage).toBe('awaiting_confirmation');
    expect((r.result as { match_id: string }).match_id).toBe('m1');
  });

  it('multiple pending matches → asks which one instead of guessing, never auto-picks', async () => {
    const sb = makeStubSupabase({
      intents: [{ intent_id: 'i1' }],
      matches: [
        { match_id: 'm1', intent_a_id: 'i1', intent_b_id: 'i2', state: 'new', kind_pairing: 'partner_seek', score: 0.85 },
        { match_id: 'm2', intent_a_id: 'i1', intent_b_id: 'i3', state: 'new', kind_pairing: 'activity', score: 0.7 },
      ],
    });
    const r = await tool_respond_to_match({ response: 'express_interest' }, id, sb);
    expect(r.ok).toBe(true);
    expect((r.result as { ambiguous: boolean }).ambiguous).toBe(true);
    expect((r.result as { candidates: string[] }).candidates).toEqual(['m1', 'm2']);
    expect(r.text).toMatch(/which one/i);
  });

  it('already responded by this user (isA, responded_by_a) is excluded from candidates', async () => {
    const sb = makeStubSupabase({
      intents: [{ intent_id: 'i1' }],
      matches: [
        { match_id: 'm1', intent_a_id: 'i1', intent_b_id: 'i2', state: 'responded_by_a', kind_pairing: 'partner_seek', score: 0.85 },
        { match_id: 'm2', intent_a_id: 'i1', intent_b_id: 'i3', state: 'new', kind_pairing: 'activity', score: 0.7 },
      ],
    });
    const r = await tool_respond_to_match({ response: 'express_interest' }, id, sb);
    expect(r.ok).toBe(true);
    expect((r.result as { match_id: string }).match_id).toBe('m2');
  });

  it('resolved (mutual_interest / declined) matches are excluded — reports nothing pending', async () => {
    const sb = makeStubSupabase({
      intents: [{ intent_id: 'i1' }],
      matches: [
        { match_id: 'm1', intent_a_id: 'i1', intent_b_id: 'i2', state: 'mutual_interest', kind_pairing: 'partner_seek', score: 0.85 },
        { match_id: 'm2', intent_a_id: 'i1', intent_b_id: 'i3', state: 'declined', kind_pairing: 'activity', score: 0.7 },
      ],
    });
    const r = await tool_respond_to_match({ response: 'express_interest' }, id, sb);
    expect(r.ok).toBe(true);
    expect((r.result as { found: boolean }).found).toBe(false);
  });

  it('no posts at all → found:false, never a hard error', async () => {
    const sb = makeStubSupabase({ intents: [], matches: [] });
    const r = await tool_respond_to_match({ response: 'decline' }, id, sb);
    expect(r.ok).toBe(true);
    expect((r.result as { found: boolean }).found).toBe(false);
  });

  it('explicit match_id still bypasses auto-detect entirely (no DB lookup)', async () => {
    const sb = {
      from() {
        throw new Error('should not query when match_id is already provided');
      },
    } as never;
    const r = await tool_respond_to_match({ match_id: 'm9', response: 'decline' }, id, sb);
    expect(r.ok).toBe(true);
    expect((r.result as { match_id: string }).match_id).toBe('m9');
  });

  it('missing response is still a hard error (unchanged contract)', async () => {
    const sb = makeStubSupabase({ intents: [], matches: [] });
    const r = await tool_respond_to_match({ match_id: 'm1' }, id, sb);
    expect(r.ok).toBe(false);
  });
});
