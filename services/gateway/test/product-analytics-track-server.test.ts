/**
 * BOOTSTRAP-PRODUCT-ANALYTICS: server-side tracker tests.
 *
 *  - trackServerEvent hashes the user id and never persists it raw
 *  - forbidden raw-text keys (message/prompt/raw_text/transcript/answer)
 *    are stripped even if a caller passes them
 *  - detectTopic maps text onto the controlled topic vocabulary
 *  - classifyIntent yields the coarse four-bucket label
 */

process.env.NODE_ENV = 'test';

const mockInsert = jest.fn().mockResolvedValue({ error: null });
jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn().mockReturnValue({ from: jest.fn(() => ({ insert: mockInsert })) }),
}));

import {
  trackServerEvent,
  detectTopic,
  classifyIntent,
  hashUserId,
} from '../src/services/product-analytics/track-server';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('trackServerEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('hashes the user id and persists metadata only', async () => {
    await trackServerEvent({
      event_name: 'topic_detected',
      tenant_id: TENANT,
      user_id: 'user-123',
      conversation_id: 'convo-1',
      properties: { topic: 'sleep', confidence: 0.6 },
    });

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const row = mockInsert.mock.calls[0][0];
    expect(row.user_id_hash).toBe(hashUserId('user-123'));
    expect(row.user_id_hash).not.toBe('user-123');
    expect(JSON.stringify(row)).not.toContain('user-123');
    expect(row.tenant_id).toBe(TENANT);
    expect(row.properties).toEqual({ topic: 'sleep', confidence: 0.6 });
  });

  it('strips raw message text keys even when a caller passes them', async () => {
    await trackServerEvent({
      event_name: 'user_message_sent',
      tenant_id: TENANT,
      user_id: 'user-123',
      conversation_id: 'convo-1',
      properties: {
        message: 'raw health question',
        prompt: 'sys prompt',
        raw_text: 'text',
        transcript: 'voice',
        answer: 'reply',
        message_length: 19,
      },
    });

    const row = mockInsert.mock.calls[0][0];
    expect(row.properties).toEqual({ message_length: 19 });
  });

  it('never throws when the DB write fails', async () => {
    mockInsert.mockResolvedValueOnce({ error: { message: 'down' } });
    await expect(
      trackServerEvent({ event_name: 'tool_called', tenant_id: TENANT, properties: { tool_name: 'x' } }),
    ).resolves.toBeUndefined();
  });
});

describe('detectTopic', () => {
  it('maps text onto the controlled vocabulary', () => {
    expect(detectTopic('I cannot sleep at night')).toBe('sleep');
    expect(detectTopic('Wie viel kostet das Abo?')).toBe('pricing');
    expect(detectTopic('my magnesium supplement')).toBe('supplements');
    expect(detectTopic('xyzzy plugh')).toBeNull();
  });
});

describe('classifyIntent', () => {
  it('classifies questions, actions, feedback, and statements', () => {
    expect(classifyIntent('What is the Vitana Index?').intent).toBe('question');
    expect(classifyIntent('Open my health tracker').intent).toBe('request_action');
    expect(classifyIntent('Thanks, that was great').intent).toBe('feedback');
    expect(classifyIntent('I went for a run today').intent).toBe('statement');
  });
});
