/**
 * VTID-04339 — the assistant routes through the Vitana brain only with a
 * verified identity, never with the session id standing in for user_id or a
 * tenant taken from the request body.
 */
const mockProcessBrainTurn = jest.fn();
const mockIsBrainEnabled = jest.fn();
const mockCallViaRouter = jest.fn();

jest.mock('../../src/services/vitana-brain', () => ({
  processBrainTurn: (...a: unknown[]) => mockProcessBrainTurn(...a),
}));
jest.mock('../../src/services/system-controls-service', () => ({
  isVitanaBrainEnabled: () => mockIsBrainEnabled(),
}));
jest.mock('../../src/services/llm-router', () => ({
  callViaRouter: (...a: unknown[]) => mockCallViaRouter(...a),
}));
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'evt-1' }),
}));
jest.mock('../../src/services/ai-personality-service', () => ({
  getPersonalityConfigSync: () => ({}),
}));

import { processAssistantMessage } from '../../src/services/assistant-service';

beforeEach(() => {
  jest.clearAllMocks();
  mockIsBrainEnabled.mockResolvedValue(true);
  mockProcessBrainTurn.mockResolvedValue({
    ok: true,
    reply: 'brain reply',
    oasis_ref: 'ref-1',
    meta: { model_used: 'm', tokens_used: { prompt: 1, completion: 2 } },
  });
  mockCallViaRouter.mockResolvedValue({
    ok: true,
    text: 'stateless reply',
    provider: 'bedrock',
    model: 'eu.anthropic.claude-sonnet-4-6',
    usage: { inputTokens: 3, outputTokens: 4 },
  });
});

describe('processAssistantMessage — brain identity (VTID-04339)', () => {
  it('uses the verified identity, not the session id or body tenant, on the brain path', async () => {
    const res = await processAssistantMessage(
      'hi', 'sess-1', 'DEV', 'Vitana-Dev', '/x', '',
      { user_id: 'user-uuid', tenant_id: 'tenant-uuid' },
    );

    expect(res.reply).toBe('brain reply');
    expect(mockProcessBrainTurn).toHaveBeenCalledTimes(1);
    const arg = mockProcessBrainTurn.mock.calls[0][0];
    expect(arg.user_id).toBe('user-uuid');
    expect(arg.tenant_id).toBe('tenant-uuid');
    expect(arg.user_id).not.toBe('sess-1');
    expect(mockCallViaRouter).not.toHaveBeenCalled();
  });

  it('never calls the brain without an identity, even with the brain flag on', async () => {
    const res = await processAssistantMessage('hi', 'sess-2', 'DEV', 'Vitana-Dev', '/x', '');

    expect(mockProcessBrainTurn).not.toHaveBeenCalled();
    expect(mockCallViaRouter).toHaveBeenCalledTimes(1);
    expect(res.reply).toBe('stateless reply');
  });

  it('never calls the brain when the identity has no tenant', async () => {
    await processAssistantMessage(
      'hi', 'sess-3', 'DEV', 'Vitana-Dev', '/x', '',
      { user_id: 'user-uuid', tenant_id: null },
    );

    expect(mockProcessBrainTurn).not.toHaveBeenCalled();
    expect(mockCallViaRouter).toHaveBeenCalledTimes(1);
  });

  it('takes the stateless path when the brain flag is off', async () => {
    mockIsBrainEnabled.mockResolvedValue(false);
    await processAssistantMessage(
      'hi', 'sess-4', 'DEV', 'Vitana-Dev', '/x', '',
      { user_id: 'user-uuid', tenant_id: 'tenant-uuid' },
    );

    expect(mockProcessBrainTurn).not.toHaveBeenCalled();
    expect(mockCallViaRouter).toHaveBeenCalledTimes(1);
  });
});
