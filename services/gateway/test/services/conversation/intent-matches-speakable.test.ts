/**
 * view_intent_matches — the result text the live model speaks must be PRESENTABLE
 * content, never a navigation announcement or raw JSON, and must never invite a
 * "couldn't complete" narration.
 *
 * THE BUG (operator report): Vitana offered "soll ich dir die Matches zeigen?",
 * the user said "Ja", and she answered "Das konnte ich leider nicht abschließen."
 * On a conversational surface the matches tool's old text was "Opening your
 * matches screen" (a no-op there) or raw JSON — so the model had nothing real to
 * say and improvised a failure. These tests pin that every branch now returns
 * speakable content and explicitly forbids the fake-fail.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

// viewAllMyMatches builds its own client; mock the user_intents query chain.
let MOCK_INTENTS: Array<{ intent_id: string }> = [];
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.order = () => chain;
      chain.limit = () => Promise.resolve({ data: MOCK_INTENTS, error: null });
      return chain;
    },
  }),
}));

let MOCK_MATCHES: Array<Record<string, unknown>> = [];
jest.mock('../../../src/services/intent-matcher', () => ({
  surfaceTopMatches: jest.fn(async () => MOCK_MATCHES),
}));
jest.mock('../../../src/services/intent-mutual-reveal', () => ({
  redactMatchForReader: jest.fn(async (m: unknown) => m),
}));

import { tool_view_intent_matches } from '../../../src/services/orb-tools-shared';

const id = { user_id: 'u1', tenant_id: 't1', role: 'community', session_id: 's1' } as never;
// Every branch frames the result positively (SUCCESS/HANDLED) and carries the
// explicit guard telling the model NOT to claim it couldn't do it.
const POSITIVE = /SUCCESS|HANDLED/;
const ANTI_FAIL_GUARD = /Do NOT say you could not|Do NOT say you could not complete/i;

beforeEach(() => {
  MOCK_INTENTS = [];
  MOCK_MATCHES = [];
});

describe('view_intent_matches — speakable, never a fake-fail', () => {
  it('aggregate (no intent_id) with matches → speakable list, fit %, no "couldn\'t"', async () => {
    MOCK_INTENTS = [{ intent_id: 'i1' }];
    MOCK_MATCHES = [
      { match_id: 'm1', vitana_id_b: null, score: 0.82, kind_pairing: 'partner_seek', state: 'new', redacted: true, match_reasons: { tier: 'gold' } },
      { match_id: 'm2', vitana_id_b: null, score: 0.61, kind_pairing: 'activity', state: 'new', redacted: true, match_reasons: { tier: 'silver' } },
    ];
    const r = await tool_view_intent_matches({}, id);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/2 matches/);
    expect(r.text).toMatch(/82% fit/);
    expect(r.text).toMatch(/Present them/i);
    expect(r.text).toMatch(POSITIVE);
    expect(r.text).toMatch(ANTI_FAIL_GUARD);
    expect(r.text!.trim().startsWith('{')).toBe(false); // never raw JSON
  });

  it('aggregate with OPEN posts but zero matches → "nothing yet", not a failure', async () => {
    MOCK_INTENTS = [{ intent_id: 'i1' }];
    MOCK_MATCHES = [];
    const r = await tool_view_intent_matches({}, id);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/nothing has come in yet|no matches/i);
    expect(r.text).toMatch(POSITIVE);
  });

  it('aggregate with NO open posts → invite to post a wish, not a failure', async () => {
    MOCK_INTENTS = [];
    const r = await tool_view_intent_matches({}, id);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/post a wish/i);
    expect(r.text).toMatch(POSITIVE);
  });

  it('single-intent list_only → speakable summary, never raw JSON, no fake-fail', async () => {
    // Two near-tied scores → not "dominant", so it stays list_only (the branch
    // that used to return JSON.stringify as the spoken text).
    MOCK_MATCHES = [
      { match_id: 'm1', vitana_id_b: null, score: 0.80, kind_pairing: 'partner_seek', state: 'new', redacted: true, match_reasons: { tier: 'gold' } },
      { match_id: 'm2', vitana_id_b: null, score: 0.79, kind_pairing: 'partner_seek', state: 'new', redacted: true, match_reasons: { tier: 'gold' } },
    ];
    const r = await tool_view_intent_matches({ intent_id: 'i1' }, id);
    expect(r.ok).toBe(true);
    expect(r.text!.trim().startsWith('{')).toBe(false);
    expect(r.text).toMatch(/Present them|for this post/i);
    expect(r.text).toMatch(ANTI_FAIL_GUARD);
  });
});
