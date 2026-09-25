/**
 * VTID-04540 — typed conversation turns learn facts.
 *
 * Found in the staging end-to-end memory test: POST /api/v1/conversation/turn
 * with the brain flag on returned through processConversationTurn, which wrote
 * the raw message but never ran fact extraction, and meta.model_used was a
 * hardcoded 'gemini-2.5-pro'. These tests pin the two helpers and the wiring.
 */
import * as fs from 'fs';
import * as path from 'path';

process.env.NODE_ENV = 'test';

const mockExtract = jest.fn();
jest.mock('../src/services/extraction-dedup-manager', () => ({
  deduplicatedExtract: (...a: unknown[]) => mockExtract(...a),
}));

import { extractTypedTurnFacts, servedModelLabel } from '../src/services/conversation-client';

const SRC = fs.readFileSync(path.join(__dirname, '../src/services/conversation-client.ts'), 'utf8');
const ERROR_REPLY = 'I apologize, but I encountered an error processing your request. Please try again.';

const base = {
  message: 'Meine Schwester Mila wohnt in Graz.',
  reply: 'Notiert.',
  tenant_id: 't1',
  user_id: 'u1',
  thread_id: 'th1',
  turn_count: 1,
};

beforeEach(() => mockExtract.mockReset().mockReturnValue({ extracted: true }));

describe('extractTypedTurnFacts', () => {
  it('extracts on the first turn of a thread (force skips the 3-turn / 60 s throttle)', () => {
    expect(extractTypedTurnFacts(base)).toEqual({ extracted: true });
    expect(mockExtract).toHaveBeenCalledTimes(1);
    const arg = mockExtract.mock.calls[0][0];
    expect(arg).toMatchObject({ tenant_id: 't1', user_id: 'u1', session_id: 'th1', turn_count: 1, force: true });
    expect(arg.conversationText).toBe('User: Meine Schwester Mila wohnt in Graz.\nAssistant: Notiert.');
  });

  it('never extracts from the canned error reply', () => {
    expect(extractTypedTurnFacts({ ...base, reply: ERROR_REPLY })).toEqual({ extracted: false, skip_reason: 'error_reply' });
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it('skips an empty message', () => {
    expect(extractTypedTurnFacts({ ...base, message: '   ' }).extracted).toBe(false);
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it('never throws when the extractor throws', () => {
    mockExtract.mockImplementation(() => { throw new Error('boom'); });
    expect(extractTypedTurnFacts(base)).toEqual({ extracted: false, skip_reason: 'error' });
  });
});

describe('servedModelLabel', () => {
  it('reports provider/model from the operator loop meta', () => {
    expect(servedModelLabel({ provider: 'deepseek', model: 'deepseek-flash' })).toBe('deepseek/deepseek-flash');
    expect(servedModelLabel({ model: 'm' })).toBe('m');
  });
  it('prefers the call that wrote the reply on a tool-assisted turn', () => {
    expect(servedModelLabel({ provider: 'deepseek', model: 'deepseek-flash', reply_provider: 'bedrock', reply_model: 'eu.anthropic.claude-sonnet-4-6' }))
      .toBe('bedrock/eu.anthropic.claude-sonnet-4-6');
  });
  it('returns null without a model', () => {
    expect(servedModelLabel(undefined)).toBeNull();
    expect(servedModelLabel({ provider: 'x' })).toBeNull();
  });
});

describe('processConversationTurn wiring', () => {
  it('no longer hardcodes gemini-2.5-pro as the model label', () => {
    expect(SRC).not.toMatch(/modelUsed = 'gemini-2\.5-pro'/);
    expect(SRC).toMatch(/modelUsed = servedModelLabel\(geminiResult\.meta\) \?\? modelUsed/);
  });
  it('runs typed-turn extraction after the memory write', () => {
    const write = SRC.indexOf('await writeMemoryItemWithIdentity(');
    const extract = SRC.indexOf('extractTypedTurnFacts({');
    expect(write).toBeGreaterThan(0);
    expect(extract).toBeGreaterThan(write);
  });
  it('runs typed-turn extraction for typed turns only, never for voice transcripts', () => {
    expect(SRC).toMatch(/if \(input\.message_type !== 'voice_transcript'\) extractTypedTurnFacts\(\{/);
  });
});

describe('the operator loop reports the model that wrote the reply', () => {
  const OP = fs.readFileSync(path.join(__dirname, '../src/services/gemini-operator.ts'), 'utf8');
  it('tool-assisted turns carry reply_provider / reply_model from the final call', () => {
    expect(OP).toMatch(/reply_provider: finalResponse\.provider \?\? vertexResponse\.provider/);
    expect(OP).toMatch(/reply_model: finalResponse\.model \?\? vertexResponse\.model/);
  });
});
