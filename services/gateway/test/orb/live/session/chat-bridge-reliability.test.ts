/**
 * BOOTSTRAP-CHAT-BRIDGE-RELIABILITY
 *
 * `bridgeVoiceTranscript` is the ONLY path that copies a voice-session turn
 * into `chat_messages` so it shows up in the user's "Vitana" Inbox thread.
 * Before this fix a failed insert was fire-and-forget with just a
 * console.warn — a transient DB/network blip silently and permanently
 * dropped that turn from the user's chat history with no trace anywhere
 * (user-reported: "I had several conversations with Vitana and none show
 * up in my chat history"). This suite pins the retry + failure-telemetry
 * behavior directly, independent of the wider WS message-handler tests
 * (which mock `getSupabase()` to `null` and deliberately keep this branch
 * out of scope).
 */

import { bridgeVoiceTranscript, notifyOrbVoiceBridgeWrite } from '../../../../src/orb/live/session/upstream-message-handler';
import { emitOasisEvent } from '../../../../src/services/oasis-event-service';
import { notifyUserAsync } from '../../../../src/services/notification-service';

jest.mock('../../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../../../../src/services/notification-service', () => ({
  notifyUserAsync: jest.fn(),
}));

const mockEmitOasisEvent = emitOasisEvent as jest.MockedFunction<typeof emitOasisEvent>;
const mockNotifyUserAsync = notifyUserAsync as jest.MockedFunction<typeof notifyUserAsync>;

function makeRow() {
  return {
    tenant_id: 'tenant-1',
    sender_id: 'user-1',
    receiver_id: 'vitana-bot',
    content: 'hello vitana',
    message_type: 'voice_transcript',
    metadata: {},
    created_at: new Date().toISOString(),
  };
}

function makeSupabase(insertMock: jest.Mock) {
  return {
    from: jest.fn().mockReturnValue({ insert: insertMock }),
  } as any;
}

describe('bridgeVoiceTranscript', () => {
  beforeEach(() => {
    mockEmitOasisEvent.mockClear();
  });

  it('writes once and returns on first-attempt success', async () => {
    const insert = jest.fn().mockResolvedValue({ error: null });
    const supabase = makeSupabase(insert);

    await bridgeVoiceTranscript(supabase, makeRow(), 'user_to_vitana', 'sess-1');

    expect(insert).toHaveBeenCalledTimes(1);
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('retries once on a transient failure and does not emit a failure event if the retry succeeds', async () => {
    const insert = jest
      .fn()
      .mockResolvedValueOnce({ error: { message: 'connection reset' } })
      .mockResolvedValueOnce({ error: null });
    const supabase = makeSupabase(insert);

    await bridgeVoiceTranscript(supabase, makeRow(), 'vitana_to_user', 'sess-2');

    expect(insert).toHaveBeenCalledTimes(2);
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('emits a durable OASIS event after exhausting retries, instead of silently dropping the turn', async () => {
    const insert = jest.fn().mockResolvedValue({ error: { message: 'db unavailable' } });
    const supabase = makeSupabase(insert);

    await bridgeVoiceTranscript(supabase, makeRow(), 'user_to_vitana', 'sess-3');

    expect(insert).toHaveBeenCalledTimes(2);
    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    const [event] = mockEmitOasisEvent.mock.calls[0];
    expect(event).toMatchObject({
      status: 'error',
      payload: expect.objectContaining({
        orb_session_id: 'sess-3',
        direction: 'user_to_vitana',
        error: 'db unavailable',
      }),
    });
  });

  it('resolves true on first-attempt success (needed by the caller to gate the push notification)', async () => {
    const insert = jest.fn().mockResolvedValue({ error: null });
    const supabase = makeSupabase(insert);

    await expect(bridgeVoiceTranscript(supabase, makeRow(), 'vitana_to_user', 'sess-4')).resolves.toBe(true);
  });

  it('resolves false after exhausting retries', async () => {
    const insert = jest.fn().mockResolvedValue({ error: { message: 'db unavailable' } });
    const supabase = makeSupabase(insert);

    await expect(bridgeVoiceTranscript(supabase, makeRow(), 'vitana_to_user', 'sess-5')).resolves.toBe(false);
  });
});

/**
 * VTID-03520
 *
 * Before this fix, a successful `bridgeVoiceTranscript()` write was the end
 * of the line — nothing told the client a new message existed, so an ORB
 * voice reply only showed up in the Messenger whenever the user happened to
 * reopen it (reported live as "nothing shown in 24 hours"). This pins the
 * gating logic in isolation: notify only on a confirmed write, and only for
 * the Vitana→user leg.
 */
describe('notifyOrbVoiceBridgeWrite', () => {
  beforeEach(() => {
    mockNotifyUserAsync.mockClear();
  });

  it('fires a new_chat_message notification when the write succeeded', () => {
    const supabase = {} as any;
    notifyOrbVoiceBridgeWrite(true, 'user-1', 'tenant-1', 'Dein aktueller Vitana-Index liegt bei 200 Punkten.', supabase);

    expect(mockNotifyUserAsync).toHaveBeenCalledTimes(1);
    const [userId, tenantId, type, payload, passedSupabase] = mockNotifyUserAsync.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(tenantId).toBe('tenant-1');
    expect(type).toBe('new_chat_message');
    expect(payload).toMatchObject({
      title: 'Vitana',
      body: 'Dein aktueller Vitana-Index liegt bei 200 Punkten.',
      data: expect.objectContaining({
        type: 'new_chat_message',
        thread_id: '00000000-0000-0000-0000-000000000001',
        url: '/inbox/u/00000000-0000-0000-0000-000000000001',
      }),
    });
    expect(passedSupabase).toBe(supabase);
  });

  it('does not fire a notification when the write failed', () => {
    notifyOrbVoiceBridgeWrite(false, 'user-1', 'tenant-1', 'some reply', {} as any);

    expect(mockNotifyUserAsync).not.toHaveBeenCalled();
  });

  it('truncates a long reply to a 100-char preview with an ellipsis', () => {
    const longText = 'a'.repeat(150);
    notifyOrbVoiceBridgeWrite(true, 'user-1', 'tenant-1', longText, {} as any);

    const [, , , payload] = mockNotifyUserAsync.mock.calls[0];
    expect((payload as any).body).toBe('a'.repeat(97) + '...');
    expect((payload as any).body.length).toBe(100);
  });
});
