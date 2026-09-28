import * as fs from 'fs';
import * as path from 'path';
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
 * VTID-04601
 *
 * VTID-03520 fired a `new_chat_message` push for every Vitana voice turn on
 * the legacy (Vertex / Serbian bridge) turn_complete path — so a member in a
 * live Serbian conversation got each spoken reply on their lock screen while
 * hearing it. The shared Nova/cascade path never did. No turn_complete path
 * may notify: the user is in the conversation, and the bridged row already
 * carries read_at.
 */
describe('voice transcript bridge never notifies (VTID-04601)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../../src/orb/live/session/upstream-message-handler.ts'),
    'utf8',
  );

  it('does not import or call the notification service', () => {
    expect(src).not.toMatch(/notification-service/);
    expect(src).not.toMatch(/notifyUserAsync\s*\(/);
    expect(src).not.toMatch(/notifyOrbVoiceBridgeWrite/);
  });

  it('still bridges the Vitana leg into chat_messages on both paths, marked read', () => {
    const vitanaLegs = src.match(/'vitana_to_user', session\.sessionId\)/g) || [];
    expect(vitanaLegs.length).toBe(2);
    const readAt = src.match(/read_at: assistantMsgTime\.toISOString\(\)/g) || [];
    expect(readAt.length).toBe(2);
  });

  it('bridgeVoiceTranscript itself never calls notifyUserAsync', async () => {
    const insert = jest.fn().mockResolvedValue({ error: null });
    await bridgeVoiceTranscript(makeSupabase(insert), makeRow(), 'vitana_to_user', 'sess-n');
    expect(mockNotifyUserAsync).not.toHaveBeenCalled();
  });
});
