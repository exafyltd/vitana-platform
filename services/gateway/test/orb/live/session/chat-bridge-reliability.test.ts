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

import { bridgeVoiceTranscript } from '../../../../src/orb/live/session/upstream-message-handler';
import { emitOasisEvent } from '../../../../src/services/oasis-event-service';

jest.mock('../../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

const mockEmitOasisEvent = emitOasisEvent as jest.MockedFunction<typeof emitOasisEvent>;

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
});
