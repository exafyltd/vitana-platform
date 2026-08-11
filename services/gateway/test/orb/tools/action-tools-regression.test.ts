/**
 * Regression harness for the TRUST-CRITICAL ORB action tools.
 *
 * These two tools are the ones behind the user-reported voice failures:
 *   - resolve_recipient: "I said Maria and you gave me Loreen" — a wrong /
 *     low-confidence match must NEVER be presented as the confident answer.
 *   - send_chat_message: "Vitana says she sent it but nothing arrived" — a DM
 *     that can't be confidently delivered must FAIL LOUDLY (ok:false + a
 *     user-facing line), never silently succeed or go to the wrong person.
 *
 * The existing self-check harness (#2802) explicitly SKIPS both as
 * `needs_args`, so nothing exercised them. This locks their selection /
 * failure contracts deterministically, mocking only the Postgres RPC
 * `resolve_recipient_candidates` (the name-matching SQL) — everything else is
 * the real handler logic from services/orb-tools-shared.ts.
 *
 * If any of these flip, a fast-moving conversation-flow change silently broke a
 * trust-critical action — exactly the class of regression this guards.
 */

// emitChatSendFailure / OASIS telemetry is a fire-and-forget side effect we
// don't want hitting the network in CI. Stub it.
jest.mock('../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => undefined),
}));

import {
  tool_resolve_recipient,
  tool_send_chat_message,
} from '../../../src/services/orb-tools-shared';

const ACTOR_UUID = '11111111-1111-1111-1111-111111111111';
const OTHER_UUID = '22222222-2222-2222-2222-222222222222';

const ID = {
  user_id: ACTOR_UUID,
  tenant_id: '00000000-0000-0000-0000-000000000001',
  role: 'community',
  vitana_id: 'actor7',
  session_id: 'selfcheck-test',
} as any;

type Candidate = { user_id: string; vitana_id: string | null; display_name: string | null; score: number; reason: string };

/** Minimal SupabaseClient stub: only `.rpc()` is reached on these code paths. */
function sbWithCandidates(candidates: Candidate[] | { error: string }) {
  return {
    rpc: jest.fn(async () => {
      if (Array.isArray(candidates)) return { data: candidates, error: null };
      return { data: null, error: { message: candidates.error } };
    }),
  } as any;
}

const cand = (over: Partial<Candidate>): Candidate => ({
  user_id: OTHER_UUID,
  vitana_id: 'maria6',
  display_name: 'Maria Maxina',
  score: 0.95,
  reason: 'name_match',
  ...over,
});

describe('resolve_recipient — never confidently pick the wrong / weak match', () => {
  it('requires a spoken name', async () => {
    const r = await tool_resolve_recipient({}, ID, sbWithCandidates([]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/spoken_name/);
  });

  it('no community match → ambiguous, zero confidence, honest "no one named" text', async () => {
    const r = await tool_resolve_recipient({ spoken_name: 'Nobody' }, ID, sbWithCandidates([]));
    expect(r.ok).toBe(true);
    expect((r.result as any).ambiguous).toBe(true);
    expect((r.result as any).top_confidence).toBe(0);
    expect(r.text).toMatch(/No one named/i);
  });

  it('one strong, well-separated match → confident "best match"', async () => {
    const r = await tool_resolve_recipient(
      { spoken_name: 'Maria' },
      ID,
      sbWithCandidates([cand({ score: 0.95 })]),
    );
    expect((r.result as any).ambiguous).toBe(false);
    expect(r.text).toMatch(/Best match/i);
  });

  it('weak top score (<0.85) → ambiguous, do NOT present it as the answer', async () => {
    const r = await tool_resolve_recipient(
      { spoken_name: 'Maria' },
      ID,
      sbWithCandidates([cand({ score: 0.7 })]),
    );
    expect((r.result as any).ambiguous).toBe(true);
  });

  it('near-tie (Maria 0.95 vs Loreen 0.90) → ambiguous "which one", never an arbitrary pick', async () => {
    const r = await tool_resolve_recipient(
      { spoken_name: 'Maria' },
      ID,
      sbWithCandidates([
        cand({ display_name: 'Maria Maxina', score: 0.95 }),
        cand({ user_id: '33333333-3333-3333-3333-333333333333', display_name: 'Loreen', vitana_id: 'loreen2', score: 0.9 }),
      ]),
    );
    expect((r.result as any).ambiguous).toBe(true);
    expect(r.text).toMatch(/which one/i);
  });
});

describe('send_chat_message — fail loudly, never silent-success or wrong recipient', () => {
  it('missing body → loud failure asking for the message', async () => {
    const r = await tool_send_chat_message(
      { recipient_user_id: OTHER_UUID, body: '' },
      ID,
      sbWithCandidates([]),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('label resolves to NOBODY → loud "couldn\'t find" failure, not a silent send', async () => {
    const r = await tool_send_chat_message(
      { recipient_label: 'Maria', body: 'see you tonight' },
      ID,
      sbWithCandidates([]),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/couldn'?t find Maria/i);
  });

  it('ambiguous label (near-tie) → refuses to send, asks to disambiguate', async () => {
    const r = await tool_send_chat_message(
      { recipient_label: 'Maria', body: 'hi' },
      ID,
      sbWithCandidates([
        cand({ display_name: 'Maria Maxina', score: 0.95 }),
        cand({ user_id: '33333333-3333-3333-3333-333333333333', display_name: 'Loreen', score: 0.9 }),
      ]),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/which|Vitana ID/i);
  });

  it('label match below the stricter 0.90 send threshold → refuses (no fuzzy send)', async () => {
    const r = await tool_send_chat_message(
      { recipient_label: 'Maria', body: 'hi' },
      ID,
      sbWithCandidates([cand({ score: 0.88 })]),
    );
    expect(r.ok).toBe(false);
  });

  it('no recipient at all → loud "who?" failure', async () => {
    const r = await tool_send_chat_message({ body: 'hi' }, ID, sbWithCandidates([]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/who/i);
  });

  it('messaging yourself → rejected', async () => {
    const r = await tool_send_chat_message(
      { recipient_user_id: ACTOR_UUID, body: 'note to self' },
      ID,
      sbWithCandidates([]),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/yourself/i);
  });
});
