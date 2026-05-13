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

interface AppUserRow {
  user_id: string;
  tenant_id?: string | null;
  display_name?: string | null;
  vitana_id?: string | null;
  email?: string | null;
}

function makeStubSupabase(opts: {
  inserts: CapturedInsert[];
  rpcResponses?: Record<string, { data: unknown; error?: unknown }>;
  /**
   * Map of user_id → app_users row. Each call to
   * `app_users.select().eq('user_id', X).maybeSingle()` returns
   * `appUsers[X] ?? null`. Tests that need the receiver-exists guard to
   * pass must populate the receiver's row.
   */
  appUsers?: Record<string, AppUserRow>;
  appUsersError?: { message: string } | null;
  insertError?: { message: string } | null;
  insertedId?: string;
}) {
  const inserts = opts.inserts;
  return {
    from(table: string) {
      if (table === 'app_users') {
        return {
          select: () => ({
            eq: (_col: string, value: string) => ({
              maybeSingle: async () => ({
                data: opts.appUsers?.[value] ?? null,
                error: opts.appUsersError ?? null,
              }),
            }),
          }),
        } as unknown;
      }
      return {
        insert: (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return {
            select: () => ({
              single: async () => ({
                data: opts.insertError ? null : { id: opts.insertedId ?? 'msg-stub-id' },
                error: opts.insertError ?? null,
              }),
            }),
          };
        },
      } as unknown;
    },
    rpc: async (name: string) => {
      const resp = opts.rpcResponses?.[name] ?? { data: [], error: null };
      return resp;
    },
  } as never;
}

/**
 * Sensible default receiver row keyed on RECIPIENT_UUID — used by tests
 * that just want the happy path through the receiver-exists guard.
 */
function defaultAppUsers(): Record<string, AppUserRow> {
  return {
    [SENDER_UUID]: {
      user_id: SENDER_UUID,
      tenant_id: 'tenant-1',
      display_name: 'Test Sender',
      vitana_id: 'vit_send',
      email: 'sender@vitana.test',
    },
    [RECIPIENT_UUID]: {
      user_id: RECIPIENT_UUID,
      tenant_id: 'tenant-1',
      display_name: 'Dragan Red',
      vitana_id: 'dragan_red',
    },
    [RECIPIENT_UUID_2]: {
      user_id: RECIPIENT_UUID_2,
      tenant_id: 'tenant-1',
      display_name: 'Another User',
      vitana_id: 'another_user',
    },
  };
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
    const sb = makeStubSupabase({ inserts, appUsers: defaultAppUsers() });

    const result = await tool_send_chat_message(
      { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'hello' },
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
    const sb = makeStubSupabase({ inserts, appUsers: defaultAppUsers() });

    const result = await tool_send_chat_message(
      { recipient_user_id: RECIPIENT_UUID_2, recipient_label: 'Another User', body: 'hello' },
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
        appUsers: defaultAppUsers(),
        rpcResponses: {
          resolve_recipient_candidates: {
            data: [{ user_id: RECIPIENT_UUID, vitana_id: 'dragan_red', score: 0.95 }],
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
      // Sender's tenant_id is what we want backfilled; receiver row also
      // populated so the receiver-exists guard (VTID-02966) passes.
      const appUsers = defaultAppUsers();
      appUsers[SENDER_UUID] = {
        user_id: SENDER_UUID,
        tenant_id: 'tenant-backfilled',
        display_name: 'Test Sender',
        vitana_id: 'vit_send',
      };
      const sb = makeStubSupabase({ inserts, appUsers });

      const result = await tool_send_chat_message(
        { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'hi' },
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
        appUsers: defaultAppUsers(),
        insertError: { message: 'simulated db failure' },
      });

      const result = await tool_send_chat_message(
        { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'hi' },
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

// ─────────────────────────────────────────────────────────────────────────
// VTID-02966 — Parity with REST /chat: receiver-exists guard + label/id
// consistency check + push notification + post-send proactive directive.
// ─────────────────────────────────────────────────────────────────────────

describe('VTID-02966 — receiver guard + push notification parity', () => {
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

  // ─── Issue #1a: receiver_user_id that doesn't exist → "Unknown User" bug ─
  test('receiver_not_found fails with voice-friendly text + send_failed OASIS', async () => {
    const inserts: CapturedInsert[] = [];
    // appUsers map has sender but NO receiver row — Gemini hallucinated a
    // UUID that doesn't map to any account. Previously this would insert
    // a chat_messages row with an orphan receiver_id and the user would
    // see "Unknown User" in their chat history.
    const sb = makeStubSupabase({
      inserts,
      appUsers: {
        [SENDER_UUID]: {
          user_id: SENDER_UUID,
          tenant_id: 'tenant-1',
          display_name: 'Test Sender',
          vitana_id: 'vit_send',
        },
      },
    });

    const result = await tool_send_chat_message(
      { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'hi' },
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
      expect(result.error).toMatch(/Dragan Red/);
      expect(result.error).toMatch(/community/);
    }
    expect(inserts).toHaveLength(0); // CRITICAL — no row written

    const failEvents = emitSpy.mock.calls
      .map((c) => c[0])
      .filter((e: { type?: string }) => e.type === 'voice.chat_message.send_failed');
    const reasons = failEvents.map((e: { payload: { reason: string } }) => e.payload.reason);
    expect(reasons).toContain('receiver_not_found');
  });

  // ─── Issue #1b: label says one person, UUID points to another ──────────
  test('label_id_mismatch fails when recipient_label does not match receiver display_name or vitana_id', async () => {
    const inserts: CapturedInsert[] = [];
    // Receiver EXISTS but is a completely different person from the
    // label the user spoke. Voice should refuse to send rather than
    // deliver the message to the wrong inbox.
    const sb = makeStubSupabase({
      inserts,
      appUsers: {
        [SENDER_UUID]: {
          user_id: SENDER_UUID,
          tenant_id: 'tenant-1',
          display_name: 'Test Sender',
          vitana_id: 'vit_send',
        },
        [RECIPIENT_UUID]: {
          user_id: RECIPIENT_UUID,
          tenant_id: 'tenant-1',
          display_name: 'Completely Different Name',
          vitana_id: 'totally_unrelated',
        },
      },
    });

    const result = await tool_send_chat_message(
      { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'hi' },
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
      expect(result.error).toMatch(/not sure I got the right person/);
    }
    expect(inserts).toHaveLength(0); // no message sent to wrong person

    const failEvents = emitSpy.mock.calls
      .map((c) => c[0])
      .filter((e: { type?: string }) => e.type === 'voice.chat_message.send_failed');
    const reasons = failEvents.map((e: { payload: { reason: string } }) => e.payload.reason);
    expect(reasons).toContain('label_id_mismatch');
  });

  // ─── Issue #3: push notification mirrors chat.ts REST path ─────────────
  test('successful send dispatches push notification with correct payload', async () => {
    const inserts: CapturedInsert[] = [];
    const sb = makeStubSupabase({ inserts, appUsers: defaultAppUsers(), insertedId: 'msg-uuid-42' });

    // Spy on notifyUserAsync — it's dynamically imported inside the tool.
    const notifyService = await import('../src/services/notification-service');
    const notifySpy = jest.spyOn(notifyService, 'notifyUserAsync').mockImplementation(() => {});

    try {
      const result = await tool_send_chat_message(
        { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'Good evening' },
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
      expect(notifySpy).toHaveBeenCalledTimes(1);
      const [recvId, tenantId, type, payload] = notifySpy.mock.calls[0];
      expect(recvId).toBe(RECIPIENT_UUID);
      expect(tenantId).toBe('tenant-1');
      expect(type).toBe('new_chat_message');
      expect(payload).toMatchObject({
        title: 'Test Sender',
        body: 'Good evening',
        data: {
          type: 'new_chat_message',
          sender_id: SENDER_UUID,
          sender_name: 'Test Sender',
          message_id: 'msg-uuid-42',
          thread_id: SENDER_UUID,
          url: `/inbox?thread=${SENDER_UUID}&context=global`,
          source: 'voice',
        },
      });
    } finally {
      notifySpy.mockRestore();
    }
  });

  test('notification body is truncated to 100 chars (with ellipsis at 97)', async () => {
    const inserts: CapturedInsert[] = [];
    const sb = makeStubSupabase({ inserts, appUsers: defaultAppUsers(), insertedId: 'm1' });

    const notifyService = await import('../src/services/notification-service');
    const notifySpy = jest.spyOn(notifyService, 'notifyUserAsync').mockImplementation(() => {});

    const longBody = 'X'.repeat(150);
    try {
      await tool_send_chat_message(
        { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: longBody },
        {
          user_id: SENDER_UUID,
          tenant_id: 'tenant-1',
          role: 'user',
          vitana_id: 'vit_send',
          session_id: REAL_UUID_A,
        },
        sb,
      );

      const [, , , payload] = notifySpy.mock.calls[0];
      expect((payload as { body: string }).body).toBe('X'.repeat(97) + '...');
      expect((payload as { body: string }).body.length).toBe(100);
    } finally {
      notifySpy.mockRestore();
    }
  });

  // ─── Vitana bot recipient: no push, matches chat.ts behavior ───────────
  test('Vitana bot recipient is excluded from push notification', async () => {
    const inserts: CapturedInsert[] = [];
    const { VITANA_BOT_USER_ID } = await import('../src/lib/vitana-bot');
    const sb = makeStubSupabase({
      inserts,
      appUsers: {
        [SENDER_UUID]: {
          user_id: SENDER_UUID,
          tenant_id: 'tenant-1',
          display_name: 'Test Sender',
          vitana_id: 'vit_send',
        },
        [VITANA_BOT_USER_ID]: {
          user_id: VITANA_BOT_USER_ID,
          tenant_id: 'tenant-1',
          display_name: 'Vitana',
          vitana_id: 'vitana',
        },
      },
      insertedId: 'm-bot',
    });

    const notifyService = await import('../src/services/notification-service');
    const notifySpy = jest.spyOn(notifyService, 'notifyUserAsync').mockImplementation(() => {});

    try {
      const result = await tool_send_chat_message(
        { recipient_user_id: VITANA_BOT_USER_ID, recipient_label: 'Vitana', body: 'hi' },
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
      expect(notifySpy).not.toHaveBeenCalled(); // Vitana bot bypass
    } finally {
      notifySpy.mockRestore();
    }
  });

  // VTID-02966 strengthened (per user instruction): prove production uses
  // the real sender app_users.display_name lookup — never a hardcoded /
  // test-fixture string. We use an unusual unique display_name and assert
  // it propagates verbatim to the notification title; also assert the
  // 'New message' fallback only fires when there's nothing to look up.
  describe('notification sender display_name is sourced from app_users (not hardcoded)', () => {
    test('production path uses real sender display_name from app_users', async () => {
      const inserts: CapturedInsert[] = [];
      // Unusual unique value — if production hardcoded any sender name,
      // this assertion would fail.
      const unusualName = 'Dejan-Stevanović-Unicode-€©®';
      const appUsers = defaultAppUsers();
      appUsers[SENDER_UUID] = {
        user_id: SENDER_UUID,
        tenant_id: 'tenant-1',
        display_name: unusualName,
        vitana_id: 'vit_send',
        email: 'real.sender@vitana.test',
      };
      const sb = makeStubSupabase({ inserts, appUsers, insertedId: 'm1' });
      const notifyService = await import('../src/services/notification-service');
      const notifySpy = jest.spyOn(notifyService, 'notifyUserAsync').mockImplementation(() => {});

      try {
        await tool_send_chat_message(
          { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'hi' },
          {
            user_id: SENDER_UUID,
            tenant_id: 'tenant-1',
            role: 'user',
            vitana_id: 'vit_send',
            session_id: REAL_UUID_A,
          },
          sb,
        );

        expect(notifySpy).toHaveBeenCalledTimes(1);
        const [, , , payload] = notifySpy.mock.calls[0];
        const title = (payload as { title: string }).title;
        const senderNameInData = (payload as { data: { sender_name: string } }).data.sender_name;

        // Strong assertion — the title is the ACTUAL looked-up name.
        expect(title).toBe(unusualName);
        expect(senderNameInData).toBe(unusualName);

        // Negative assertions — must NOT be any hardcoded common value.
        expect(title).not.toBe('Test Sender');
        expect(title).not.toBe('New message');
        expect(title).not.toBe('Sender');
        expect(title).not.toBe('Anonymous');
        expect(title).not.toBe('Vitana');
      } finally {
        notifySpy.mockRestore();
      }
    });

    test('email-prefix fallback fires when display_name is null', async () => {
      const inserts: CapturedInsert[] = [];
      const appUsers = defaultAppUsers();
      appUsers[SENDER_UUID] = {
        user_id: SENDER_UUID,
        tenant_id: 'tenant-1',
        display_name: null,
        vitana_id: 'vit_send',
        email: 'jane.doe@example.com',
      };
      const sb = makeStubSupabase({ inserts, appUsers, insertedId: 'm1' });
      const notifyService = await import('../src/services/notification-service');
      const notifySpy = jest.spyOn(notifyService, 'notifyUserAsync').mockImplementation(() => {});

      try {
        await tool_send_chat_message(
          { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'hi' },
          {
            user_id: SENDER_UUID,
            tenant_id: 'tenant-1',
            role: 'user',
            vitana_id: 'vit_send',
            session_id: REAL_UUID_A,
          },
          sb,
        );

        const [, , , payload] = notifySpy.mock.calls[0];
        expect((payload as { title: string }).title).toBe('jane.doe');
        // 'New message' fallback only when even email is missing — not here.
        expect((payload as { title: string }).title).not.toBe('New message');
      } finally {
        notifySpy.mockRestore();
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// VTID-02969 — Voice send next_actions sourced from existing autopilot
// recommendations system. The prompt-band-aid from VTID-02966 is replaced
// with structured next_actions on the tool result. Gemini is instructed
// to verbalize only tool-provided next_actions, never to invent one.
// ─────────────────────────────────────────────────────────────────────────

describe('VTID-02969 — voice send next_actions from existing autopilot system', () => {
  let emitSpy: jest.SpyInstance;
  let nextActionsSpy: jest.SpyInstance;

  beforeEach(() => {
    _resetSendCountersForTests();
    emitSpy = jest
      .spyOn(oasisEventService, 'emitOasisEvent')
      .mockResolvedValue({ ok: true, event_id: 'evt-stub' });
  });

  afterEach(() => {
    emitSpy.mockRestore();
    if (nextActionsSpy) nextActionsSpy.mockRestore();
  });

  // Acceptance #1: recommendation available — next_actions populated.
  test('recommendation available → next_actions returned on tool result', async () => {
    const inserts: CapturedInsert[] = [];
    const sb = makeStubSupabase({ inserts, appUsers: defaultAppUsers(), insertedId: 'm1' });

    const nextActions = await import('../src/services/autopilot-voice-next-actions');
    nextActionsSpy = jest.spyOn(nextActions, 'getTopAutopilotNextActions').mockResolvedValue([
      {
        id: 'rec-uuid-1',
        type: 'activate_recommendation',
        label: 'Log your evening walk',
        source: 'autopilot',
      },
    ]);

    const result = await tool_send_chat_message(
      { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'hi' },
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
    if (result.ok === true) {
      const r = result.result as { next_actions: Array<{ id: string; type: string; label: string; source: string }> };
      expect(r.next_actions).toHaveLength(1);
      expect(r.next_actions[0]).toEqual({
        id: 'rec-uuid-1',
        type: 'activate_recommendation',
        label: 'Log your evening walk',
        source: 'autopilot',
      });
    }
    // Helper was called with the sender's id + community role.
    expect(nextActionsSpy).toHaveBeenCalledTimes(1);
    expect(nextActionsSpy.mock.calls[0][0]).toMatchObject({
      user_id: SENDER_UUID,
      role: 'user',
      limit: 1,
    });
  });

  // Acceptance #2: no recommendation available — next_actions is empty,
  // tool still succeeds, Gemini will fall through to plain acknowledgement.
  test('no recommendation available → next_actions is empty, send still succeeds', async () => {
    const inserts: CapturedInsert[] = [];
    const sb = makeStubSupabase({ inserts, appUsers: defaultAppUsers(), insertedId: 'm2' });

    const nextActions = await import('../src/services/autopilot-voice-next-actions');
    nextActionsSpy = jest.spyOn(nextActions, 'getTopAutopilotNextActions').mockResolvedValue([]);

    const result = await tool_send_chat_message(
      { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'hi' },
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
    if (result.ok === true) {
      const r = result.result as { next_actions: unknown[] };
      expect(r.next_actions).toEqual([]);
    }
  });

  // Acceptance #3: recommendation fetch error — send still succeeds with
  // empty next_actions (degrade silently, never fail the message).
  test('recommendation fetch error → next_actions empty, send still succeeds', async () => {
    const inserts: CapturedInsert[] = [];
    const sb = makeStubSupabase({ inserts, appUsers: defaultAppUsers(), insertedId: 'm3' });

    const nextActions = await import('../src/services/autopilot-voice-next-actions');
    nextActionsSpy = jest
      .spyOn(nextActions, 'getTopAutopilotNextActions')
      .mockRejectedValue(new Error('simulated autopilot service outage'));

    const result = await tool_send_chat_message(
      { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'hi' },
      {
        user_id: SENDER_UUID,
        tenant_id: 'tenant-1',
        role: 'user',
        vitana_id: 'vit_send',
        session_id: REAL_UUID_A,
      },
      sb,
    );

    expect(result.ok).toBe(true); // CRITICAL — message still sent
    if (result.ok === true) {
      const r = result.result as { next_actions: unknown[]; recipient_label: string };
      expect(r.next_actions).toEqual([]);
      expect(r.recipient_label).toBe('Dragan Red');
    }
    // Row was still inserted — the send is real, not skipped.
    expect(inserts).toHaveLength(1);
  });

  // Acceptance #4: notification still fires when next_actions are returned.
  test('notification still dispatches when next_actions are populated', async () => {
    const inserts: CapturedInsert[] = [];
    const sb = makeStubSupabase({ inserts, appUsers: defaultAppUsers(), insertedId: 'm4' });

    const nextActions = await import('../src/services/autopilot-voice-next-actions');
    nextActionsSpy = jest.spyOn(nextActions, 'getTopAutopilotNextActions').mockResolvedValue([
      { id: 'rec-x', type: 'activate_recommendation', label: 'Try this', source: 'autopilot' },
    ]);

    const notifyService = await import('../src/services/notification-service');
    const notifySpy = jest.spyOn(notifyService, 'notifyUserAsync').mockImplementation(() => {});

    try {
      const result = await tool_send_chat_message(
        { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'hi' },
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
      expect(notifySpy).toHaveBeenCalledTimes(1);
      // Notification path is unchanged and unrelated to next_actions.
      const [recvId, , type] = notifySpy.mock.calls[0];
      expect(recvId).toBe(RECIPIENT_UUID);
      expect(type).toBe('new_chat_message');
    } finally {
      notifySpy.mockRestore();
    }
  });
});
