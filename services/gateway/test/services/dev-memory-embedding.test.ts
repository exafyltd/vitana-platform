/**
 * VTID-03889 — Operator Memory embedding client.
 *
 * generateDevMemoryEmbedding() is the fail-loud boundary the whole
 * dev_agent_memory system depends on: the DB column is NOT NULL, so this
 * function returning ok:false must be the ONLY way a caller can learn "we
 * have no real vector" -- it must never happen silently. These tests pin
 * every one of its guard/error paths, mirroring the mocked-network style
 * memory-facts-service-embeddings.test.ts already uses in this suite.
 */

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((input: any) => ({ input })),
}));

import {
  generateDevMemoryEmbedding,
  DEV_MEMORY_EMBEDDING_MODEL,
  DEV_MEMORY_EMBEDDING_DIMENSIONS,
} from '../../src/services/dev-memory-embedding';

function encodeBody(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

describe('generateDevMemoryEmbedding', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, BEDROCK_ROLE_ARN: 'arn:aws:iam::472838866351:role/fake' };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('fails loudly with not_configured when BEDROCK_ROLE_ARN is unset', async () => {
    delete process.env.BEDROCK_ROLE_ARN;
    const result = await generateDevMemoryEmbedding('some text');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('not_configured');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('fails loudly with empty_text on blank input, without ever calling Bedrock', async () => {
    const result = await generateDevMemoryEmbedding('   ');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('empty_text');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns a real embedding array on a valid Titan response', async () => {
    const vec = new Array(DEV_MEMORY_EMBEDDING_DIMENSIONS).fill(0).map((_, i) => i / 1000);
    mockSend.mockResolvedValueOnce({ body: encodeBody({ embedding: vec }) });

    const result = await generateDevMemoryEmbedding('the operator should remember this');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.embedding).toHaveLength(DEV_MEMORY_EMBEDDING_DIMENSIONS);
      expect(result.model).toBe(DEV_MEMORY_EMBEDDING_MODEL);
      expect(typeof result.latency_ms).toBe('number');
    }

    // Requests the exact model this table's column width was built for --
    // a silent model swap would produce vectors of the wrong dimension.
    const { InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
    expect(InvokeModelCommand).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: DEV_MEMORY_EMBEDDING_MODEL }),
    );
  });

  it('fails loudly (never truncates/pads) when Bedrock returns the wrong dimensionality', async () => {
    mockSend.mockResolvedValueOnce({ body: encodeBody({ embedding: [0.1, 0.2, 0.3] }) });
    const result = await generateDevMemoryEmbedding('short vector from a model swap');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('unexpected_response_shape');
  });

  it('fails loudly when the response has no embedding field at all', async () => {
    mockSend.mockResolvedValueOnce({ body: encodeBody({ inputTextTokenCount: 5 }) });
    const result = await generateDevMemoryEmbedding('malformed response case');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('unexpected_response_shape');
  });

  it('fails loudly (never returns a null/zero-vector fallback) when the SDK call throws', async () => {
    mockSend.mockRejectedValueOnce(new Error('NGHTTP2_PROTOCOL_ERROR'));
    const result = await generateDevMemoryEmbedding('network blip');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('invoke_failed');
    expect(!result.ok && result.message).toContain('NGHTTP2_PROTOCOL_ERROR');
  });
});
