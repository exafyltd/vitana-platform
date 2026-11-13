// plan sparring-eu-guard, C2 + C3(c): no default AWS region. With neither AWS_BEDROCK_REGION nor AWS_REGION set, the
// Bedrock adapters return not_configured and never build a client (so no request leaves the process).
const constructed: unknown[] = [];
const sent: unknown[] = [];
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation((cfg: unknown) => {
    constructed.push(cfg);
    return { send: jest.fn(async (c: unknown) => { sent.push(c); throw new Error('no network in tests'); }) };
  }),
  InvokeModelCommand: jest.fn().mockImplementation((i: unknown) => i),
}));

import { invokeBedrock } from '../../src/providers/bedrock';
import { generateDevMemoryEmbedding } from '../../src/services/dev-memory-embedding';

const REGION_KEYS = ['AWS_BEDROCK_REGION', 'AWS_REGION'] as const;
const saved: Record<string, string | undefined> = {};

describe('Bedrock region has no default (sparring-eu-guard C2 / C3(c))', () => {
  beforeAll(() => {
    for (const k of [...REGION_KEYS, 'BEDROCK_ROLE_ARN']) saved[k] = process.env[k];
  });
  afterAll(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  beforeEach(() => {
    constructed.length = 0;
    sent.length = 0;
    process.env.BEDROCK_ROLE_ARN = 'arn:aws:iam::472838866351:role/test';
    delete process.env.AWS_BEDROCK_REGION;
    delete process.env.AWS_REGION;
  });

  it('invokeBedrock: no region set -> not_configured, no client, no request', async () => {
    const r = await invokeBedrock({ model: 'eu.anthropic.claude-opus-4-6-v1', messages: [], maxTokens: 8 } as never);
    expect(r).toMatchObject({ ok: false, error: 'not_configured' });
    expect(constructed).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('generateDevMemoryEmbedding: no region set -> not_configured, no client, no request', async () => {
    const r = await generateDevMemoryEmbedding('hello');
    expect(r).toMatchObject({ ok: false, error: 'not_configured' });
    expect(constructed).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('invokeBedrock: AWS_REGION set -> the client is built with that region (no silent default)', async () => {
    process.env.AWS_REGION = 'eu-central-1';
    await invokeBedrock({ model: 'eu.anthropic.claude-opus-4-6-v1', messages: [], maxTokens: 8 } as never);
    expect(constructed[0]).toMatchObject({ region: 'eu-central-1' });
  });
});
