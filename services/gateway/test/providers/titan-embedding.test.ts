/**
 * Amazon Titan Text Embeddings V1 provider tests.
 *
 * Mirrors test/providers/titan-image.test.ts's pattern: the interesting,
 * CI-provable behavior is the not_configured gate (importing/deploying this
 * changes nothing until BEDROCK_ROLE_ARN is set) and the fixed 1536-dim
 * contract this whole fix depends on — the live invoke against
 * amazon.titan-embed-text-v1 in eu-central-1 was verified manually against
 * the real Bedrock API (not mocked here), returning exactly 1536 dimensions.
 */

import {
  getTitanEmbeddingRegion,
  getTitanEmbeddingModelId,
  generateTitanEmbedding,
  resetTitanEmbeddingClientForTests,
  TITAN_EMBEDDING_DIMENSIONS,
} from '../../src/providers/titan-embedding';

describe('Titan embedding dimension contract', () => {
  it('is fixed at 1536 — matches memory_items.embedding vector(1536) natively', () => {
    // Unlike Titan V2 (256/512/1024, configurable), V1 has always emitted a
    // fixed 1536-dim vector — verified live 2026-08-28. This constant is the
    // whole reason V1 was chosen over V2; a change here needs a real
    // re-verification against the live API, not just a doc update.
    expect(TITAN_EMBEDDING_DIMENSIONS).toBe(1536);
  });

  it('defaults to amazon.titan-embed-text-v1, not V2', () => {
    delete process.env.TITAN_EMBEDDING_MODEL_ID;
    expect(getTitanEmbeddingModelId()).toBe('amazon.titan-embed-text-v1');
  });
});

describe('Titan embedding region resolution', () => {
  const keys = ['AWS_TITAN_EMBEDDING_REGION', 'AWS_BEDROCK_REGION', 'AWS_REGION'] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) original[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it('falls back through AWS_TITAN_EMBEDDING_REGION -> AWS_BEDROCK_REGION -> AWS_REGION -> us-east-1', () => {
    for (const k of keys) delete process.env[k];
    expect(getTitanEmbeddingRegion()).toBe('us-east-1');

    process.env.AWS_REGION = 'eu-west-1';
    expect(getTitanEmbeddingRegion()).toBe('eu-west-1');

    process.env.AWS_BEDROCK_REGION = 'eu-central-1';
    expect(getTitanEmbeddingRegion()).toBe('eu-central-1');

    process.env.AWS_TITAN_EMBEDDING_REGION = 'ap-south-1';
    expect(getTitanEmbeddingRegion()).toBe('ap-south-1');
  });
});

describe('Titan embedding not_configured gate (VTID-03579/GATEWAY-GOOGLE-DEPENDENCY-AUDIT)', () => {
  const original = process.env.BEDROCK_ROLE_ARN;
  afterEach(() => {
    if (original === undefined) delete process.env.BEDROCK_ROLE_ARN;
    else process.env.BEDROCK_ROLE_ARN = original;
    resetTitanEmbeddingClientForTests();
  });

  it('reports not_configured without BEDROCK_ROLE_ARN — importing this changes nothing until configured', async () => {
    delete process.env.BEDROCK_ROLE_ARN;
    const res = await generateTitanEmbedding('hello world');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not_configured');
  });

  it('does not attempt a network call when not_configured', async () => {
    delete process.env.BEDROCK_ROLE_ARN;
    // No AWS SDK mock is installed in this file at all — if the gate didn't
    // short-circuit before the client is constructed, this would throw on
    // missing credentials instead of returning a typed not_configured error.
    await expect(generateTitanEmbedding('test')).resolves.toMatchObject({
      ok: false,
      error: 'not_configured',
    });
  });
});
