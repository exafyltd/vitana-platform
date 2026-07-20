/**
 * BOOTSTRAP-MEMORY-DAILY-LEARNING — server-enforced confirm gate for the
 * send_chat_message ORB tool.
 *
 * Context: send_chat_message previously had NO server-side confirmation
 * gate at all — the "read back and wait" contract existed only as a
 * prompt instruction Gemini could (and occasionally did) skip, sending on
 * the very first call. This mirrors create_community_post's
 * stage:"awaiting_confirmation" -> confirmed=true pattern (orb-live.ts):
 * a call without confirmed=true resolves and validates the recipient
 * (read-only) and returns a preview — no DB write, no quota consumption,
 * no push notification. Only a second call with confirmed=true actually
 * inserts into chat_messages and sends.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import {
  checkVoiceSendQuota,
  _resetSendCountersForTests,
} from '../../src/services/voice-message-guard';
import { tool_send_chat_message } from '../../src/services/orb-tools-shared';
import * as oasisEventService from '../../src/services/oasis-event-service';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  resolveVitanaId: jest.fn(async (userId: string) => `vit_${userId.slice(0, 4)}`),
}));

const SENDER_UUID = '33333333-3333-4333-8333-333333333333';
const RECIPIENT_UUID = '44444444-4444-4444-8444-444444444444';
const SESSION_UUID = '11111111-1111-4111-8111-111111111111';

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
  appUsers?: Record<string, AppUserRow>;
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
                error: null,
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
              single: async () => ({ data: { id: 'msg-stub-id' }, error: null }),
            }),
          };
        },
      } as unknown;
    },
    rpc: async () => ({ data: [], error: null }),
  } as never;
}

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
  };
}

describe('send_chat_message tool — server-enforced confirm gate', () => {
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

  test('first call without confirmed=true previews only — no insert, no notify, no quota consumed', async () => {
    const inserts: CapturedInsert[] = [];
    const sb = makeStubSupabase({ inserts, appUsers: defaultAppUsers() });
    const notifyService = await import('../../src/services/notification-service');
    const notifySpy = jest.spyOn(notifyService, 'notifyUserAsync').mockImplementation(() => {});

    try {
      const result = await tool_send_chat_message(
        { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'When are we meeting again?' },
        {
          user_id: SENDER_UUID,
          tenant_id: 'tenant-1',
          role: 'user',
          vitana_id: 'vit_send',
          session_id: SESSION_UUID,
        },
        sb,
      );

      expect(result.ok).toBe(true);
      if (result.ok === true) {
        expect(result.result).toMatchObject({
          stage: 'awaiting_confirmation',
          recipient_label: 'Dragan Red',
          recipient_user_id: RECIPIENT_UUID,
          message_preview: 'When are we meeting again?',
        });
      }
      expect(inserts).toHaveLength(0);
      expect(notifySpy).not.toHaveBeenCalled();

      // Quota was never consumed by the preview call — a full 5-send cap
      // is still available afterwards.
      const quota = await checkVoiceSendQuota({
        session_id: SESSION_UUID,
        actor_id: SENDER_UUID,
        vitana_id: 'vit_send',
        recipient_user_id: RECIPIENT_UUID,
        recipient_vitana_id: 'vit_recv',
        kind: 'message',
        key_type: 'real_session',
      });
      expect(quota.remaining).toBe(4); // this probe call itself is the 1st of 5
    } finally {
      notifySpy.mockRestore();
    }
  });

  test('explicit false is treated the same as omitted — still previews only', async () => {
    const inserts: CapturedInsert[] = [];
    const sb = makeStubSupabase({ inserts, appUsers: defaultAppUsers() });

    const result = await tool_send_chat_message(
      { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'hi', confirmed: false },
      {
        user_id: SENDER_UUID,
        tenant_id: 'tenant-1',
        role: 'user',
        vitana_id: 'vit_send',
        session_id: SESSION_UUID,
      },
      sb,
    );

    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect((result.result as { stage: string }).stage).toBe('awaiting_confirmation');
    }
    expect(inserts).toHaveLength(0);
  });

  test('second call with confirmed=true actually sends', async () => {
    const inserts: CapturedInsert[] = [];
    const sb = makeStubSupabase({ inserts, appUsers: defaultAppUsers() });
    const identity = {
      user_id: SENDER_UUID,
      tenant_id: 'tenant-1',
      role: 'user',
      vitana_id: 'vit_send',
      session_id: SESSION_UUID,
    };
    const args = { recipient_user_id: RECIPIENT_UUID, recipient_label: 'Dragan Red', body: 'Ready to go?' };

    const preview = await tool_send_chat_message(args, identity, sb);
    expect(preview.ok).toBe(true);
    if (preview.ok === true) {
      expect((preview.result as { stage: string }).stage).toBe('awaiting_confirmation');
    }
    expect(inserts).toHaveLength(0);

    const sent = await tool_send_chat_message({ ...args, confirmed: true }, identity, sb);
    expect(sent.ok).toBe(true);
    if (sent.ok === true) {
      expect(sent.result).toMatchObject({ recipient_label: 'Dragan Red' });
    }
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row.content).toBe('Ready to go?');
  });

  test('recipient resolution failures (receiver not found) still fire on the unconfirmed preview call', async () => {
    // The confirm gate must not mask real validation failures — a bad
    // recipient should fail immediately, not silently "preview" a send
    // that can never succeed.
    const inserts: CapturedInsert[] = [];
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
        session_id: SESSION_UUID,
      },
      sb,
    );

    expect(result.ok).toBe(false);
    expect(inserts).toHaveLength(0);
  });
});
