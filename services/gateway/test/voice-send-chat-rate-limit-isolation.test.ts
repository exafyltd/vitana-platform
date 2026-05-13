/**
 * VTID-02963: per-voice-session rate-limit isolation for tool_send_chat_message.
 *
 * Regression: PR B-6 (VTID-02817) lifted send_chat_message from
 * orb-live.ts into the shared dispatcher and replaced `session.sessionId`
 * with the synthetic key `${id.user_id}:send_chat_message`. That made the
 * 5-send cap shared across every orb open for a user until the 30-min
 * TTL expired. Users who hit the cap once couldn't voice-send again for
 * half an hour, even from a brand-new session — symptom was a generic
 * apology from Gemini.
 *
 * These tests pin the contract so the regression cannot reappear silently:
 *   1. Two different real session_id values for the same user do not
 *      share the 5-message counter.
 *   2. Same session_id still rate-limits after 5 sends.
 *   3. Missing session_id path is explicit and tested (synthetic key
 *      with key_type='missing_session_fallback' + OASIS event emitted).
 *   4. Regression guard: rate-limit key is NOT the literal
 *      `${user_id}:send_chat_message` when session_id is present.
 *   5. Existing #2086 fixes remain green:
 *      - UUID-invalid recipient_user_id triggers label recovery.
 *      - Tenant backfill from app_users when identity.tenant_id is null.
 *      - Voice-friendly error text on insert failure.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import {
  checkVoiceSendQuota,
  _resetSendCountersForTests,
} from '../src/services/voice-message-guard';
import { tool_send_chat_message } from '../src/services/orb-tools-shared';
import * as oasisEventService from '../src/services/oasis-event-service';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  resolveVitanaId: jest.fn(async (userId: string) => `vit_${userId.slice(0, 4)}`),
}));

const REAL_UUID_A = '11111111-1111-4111-8111-111111111111';
const REAL_UUID_B = '22222222-2222-4222-8222-222222222222';
const SENDER_UUID = '33333333-3333-4333-8333-333333333333';
const RECIPIENT_UUID = '44444444-4444-4444-8444-444444444444';
const RECIPIENT_UUID_2 = '55555555-5555-4555-8555-555555555555';

interface CapturedInsert {
  table: string;
  row: Record<string, unknown>;
}

function makeStubSupabase(opts: {
  inserts: CapturedInsert[];
  rpcResponses?: Record<string, { data: unknown; error?: unknown }>;
  appUsersTenantId?: string | null;
  insertError?: { message: string } | null;
}) {
  const inserts = opts.inserts;
  return {
    from(table: string) {
      if (table === 'app_users') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.appUsersTenantId ? { tenant_id: opts.appUsersTenantId } : null,
              }),
            }),
          }),
        } as unknown;
      }
      return {
        insert: async (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return { error: opts.insertError ?? null };
        },
      } as unknown;
    },
    rpc: async (name: string) => {
      const resp = opts.rpcResponses?.[name] ?? { data: [], error: null };
      return resp;
    },
  } as never;
}

describe('VTID-02963 — send_chat_message rate-limit key uses real session id', () => {
  let emitSpy: jest.SpyInstance;

  beforeEach(() => {
    _resetSendCountersForTests();
    emitSpy = jest
      .spyOn(oasisEventService, 'emitOasisEvent')
      .mockResolvedValue({ ok: true, event_id: 'evt-stub' });
  });

  afterEach(() => {
    emitSpy.mockRestore();
  });

  // ─── Test 1: two real session ids do not share the counter ───────────────
  test('two different real session_id values for the same user do not share the cap', async () => {
    const baseArgs = {
      actor_id: SENDER_UUID,
      vitana_id: 'vit_send',
      recipient_user_id: RECIPIENT_UUID,
      recipient_vitana_id: 'vit_recv',
      kind: 'message' as const,
    };
    // Fill session A to the cap (5 sends).
    for (let i = 0; i < 5; i++) {
      const r = await checkVoiceSendQuota({ ...baseArgs, session_id: REAL_UUID_A, key_type: 'real_session' });
      expect(r.allowed).toBe(true);
    }
    // 6th send on A must be rate-limited.
    const sixthA = await checkVoiceSendQuota({ ...baseArgs, session_id: REAL_UUID_A, key_type: 'real_session' });
    expect(sixthA.allowed).toBe(false);
    expect(sixthA.reason).toBe('rate_limited');

    // First send on B must STILL be allowed — separate counter.
    const firstB = await checkVoiceSendQuota({ ...baseArgs, session_id: REAL_UUID_B, key_type: 'real_session' });
    expect(firstB.allowed).toBe(true);
    expect(firstB.remaining).toBe(4);
  });

  // ─── Test 2: same session id rate-limits after 5 ────────────────────────
  test('same session_id rate-limits after 5 sends', async () => {
    const args = {
      session_id: REAL_UUID_A,
      actor_id: SENDER_UUID,
      vitana_id: 'vit_send',
      recipient_user_id: RECIPIENT_UUID,
      recipient_vitana_id: 'vit_recv',
      kind: 'message' as const,
      key_type: 'real_session' as const,
    };
    const remainings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await checkVoiceSendQuota(args);
      expect(r.allowed).toBe(true);
      remainings.push(r.remaining);
    }
    expect(remainings).toEqual([4, 3, 2, 1, 0]);

    const sixth = await checkVoiceSendQuota(args);
    expect(sixth.allowed).toBe(false);
    expect(sixth.reason).toBe('rate_limited');
    expect(sixth.remaining).toBe(0);
  });

  // ─── Test 3: missing session_id path is explicit ───────────────────────
  test('missing session_id triggers explicit fallback path + telemetry', async () => {
    const inserts: CapturedInsert[] = [];
    const sb = makeStubSupabase({ inserts });

    const result = await tool_send_chat_message(
      { recipient_user_id: RECIPIENT_UUID, recipient_label: 'recv', body: 'hello' },
      {
        user_id: SENDER_UUID,
        tenant_id: 'tenant-1',
        role: 'user',
        vitana_id: 'vit_send',
        // session_id intentionally omitted
      },
      sb,
    );

    expect(result.ok).toBe(true);
    // OASIS missing_session_fallback event must fire.
    const fallbackEvents = emitSpy.mock.calls
      .map((c) => c[0])
      .filter((e: { type?: string }) => e.type === 'voice.chat_message.missing_session_fallback');
    expect(fallbackEvents.length).toBe(1);
    expect(fallbackEvents[0]).toMatchObject({
      status: 'warning',
      payload: {
        fallback_key: `${SENDER_UUID}:send_chat_message:no_session`,
        tool: 'send_chat_message',
      },
    });

    // The persisted chat_messages row records key_type='missing_session_fallback'
    // so analysts can see whether a send was scoped to a real voice session
    // or to the degraded synthetic key.
    expect(inserts).toHaveLength(1);
    expect((inserts[0].row.metadata as { key_type: string }).key_type).toBe('missing_session_fallback');
  });

  // ─── Test 4: regression guard — key MUST be real session when present ──
  test('regression: rate-limit key is NOT `${user_id}:send_chat_message` when session_id is present', async () => {
    const inserts: CapturedInsert[] = [];
    const sb = makeStubSupabase({ inserts });

    const result = await tool_send_chat_message(
      { recipient_user_id: RECIPIENT_UUID_2, recipient_label: 'recv', body: 'hello' },
      {
        user_id: SENDER_UUID,
        tenant_id: 'tenant-1',
        role: 'user',
        vitana_id: 'vit_send',
        session_id: REAL_UUID_A,
      },
      sb,
    );

    expect(result.ok).toBe(true);
    expect(inserts).toHaveLength(1);
    const meta = inserts[0].row.metadata as { session_id: string; key_type: string };
    // The metadata.session_id must equal the real session UUID, not the
    // synthetic per-user constant from the regression.
    expect(meta.session_id).toBe(REAL_UUID_A);
    expect(meta.session_id).not.toBe(`${SENDER_UUID}:send_chat_message`);
    expect(meta.key_type).toBe('real_session');

    // The voice-message-guard event must also carry key_type='real_session'.
    const sentEvents = emitSpy.mock.calls
      .map((c) => c[0])
      .filter((e: { type?: string }) => e.type === 'voice.message.sent');
    expect(sentEvents.length).toBeGreaterThanOrEqual(1);
    expect((sentEvents[0].payload as { session_id: string; key_type: string }).session_id).toBe(REAL_UUID_A);
    expect((sentEvents[0].payload as { session_id: string; key_type: string }).key_type).toBe('real_session');

    // Belt-and-suspenders: no fallback event should fire on the happy path.
    const fallbackEvents = emitSpy.mock.calls
      .map((c) => c[0])
      .filter((e: { type?: string }) => e.type === 'voice.chat_message.missing_session_fallback');
    expect(fallbackEvents.length).toBe(0);
  });

  // ─── Test 5: existing #2086 defensive layers remain green ──────────────
  describe('PR #2086 fixes remain green', () => {
    test('UUID-invalid recipient triggers label recovery via resolve_recipient_candidates', async () => {
      const inserts: CapturedInsert[] = [];
      const sb = makeStubSupabase({
        inserts,
        rpcResponses: {
          resolve_recipient_candidates: {
            data: [{ user_id: RECIPIENT_UUID, vitana_id: 'vit_recv', score: 0.95 }],
            error: null,
          },
        },
      });

      const result = await tool_send_chat_message(
        // recipient_user_id is a spoken name, NOT a UUID — Gemini dropped it.
        { recipient_user_id: 'Dragan Red', recipient_label: 'Dragan Red', body: 'hi' },
        {
          user_id: SENDER_UUID,
          tenant_id: 'tenant-1',
          role: 'user',
          vitana_id: 'vit_send',
          session_id: REAL_UUID_A,
        },
        sb,
      );

      expect(result.ok).toBe(true);
      expect(inserts).toHaveLength(1);
      expect(inserts[0].row.receiver_id).toBe(RECIPIENT_UUID);
    });

    test('tenant backfill from app_users when identity.tenant_id is null', async () => {
      const inserts: CapturedInsert[] = [];
      const sb = makeStubSupabase({ inserts, appUsersTenantId: 'tenant-backfilled' });

      const result = await tool_send_chat_message(
        { recipient_user_id: RECIPIENT_UUID, recipient_label: 'recv', body: 'hi' },
        {
          user_id: SENDER_UUID,
          tenant_id: null,
          role: 'user',
          vitana_id: 'vit_send',
          session_id: REAL_UUID_A,
        },
        sb,
      );

      expect(result.ok).toBe(true);
      expect(inserts[0].row.tenant_id).toBe('tenant-backfilled');
    });

    test('chat_messages insert error returns voice-friendly text + send_failed OASIS', async () => {
      const inserts: CapturedInsert[] = [];
      const sb = makeStubSupabase({
        inserts,
        insertError: { message: 'simulated db failure' },
      });

      const result = await tool_send_chat_message(
        { recipient_user_id: RECIPIENT_UUID, recipient_label: 'recv', body: 'hi' },
        {
          user_id: SENDER_UUID,
          tenant_id: 'tenant-1',
          role: 'user',
          vitana_id: 'vit_send',
          session_id: REAL_UUID_A,
        },
        sb,
      );

      expect(result.ok).toBe(false);
      if (result.ok === false) {
        // Voice-friendly error, NOT the raw db error string.
        expect(result.error).toMatch(/try once more/);
        expect(result.error).not.toMatch(/simulated db failure/);
      }
      const failEvents = emitSpy.mock.calls
        .map((c) => c[0])
        .filter((e: { type?: string }) => e.type === 'voice.chat_message.send_failed');
      expect(failEvents.length).toBe(1);
      expect((failEvents[0].payload as { reason: string }).reason).toBe('chat_messages_insert_error');
    });
  });
});
