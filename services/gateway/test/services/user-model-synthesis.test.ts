/**
 * user-model-synthesis — unit tests (BOOTSTRAP-MEMORY-DAILY-LEARNING)
 *
 * Contract under test:
 *   - computeInputsHash is stable for identical inputs, order-independent
 *     for facts/routines
 *   - synthesizeUserModel skips users below MIN_FACTS_FOR_NARRATIVE
 *   - synthesizeUserModel skips when the inputs hash is unchanged
 *   - DeepSeek is called as the PRIMARY provider (staging verification
 *     showed Vertex returning nothing at runtime); falls to Vertex/Gemini
 *     on DeepSeek failure
 *   - a successful narrative is upserted with the inputs hash stamped
 */

process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
delete process.env.GOOGLE_GEMINI_API_KEY;

jest.mock('@google-cloud/vertexai', () => ({
  VertexAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: jest.fn().mockResolvedValue({
        response: { candidates: [{ content: { parts: [{ text: '' }] } }] },
      }),
    }),
  })),
}));

const fetchCalls: Array<{ url: string; body: any }> = [];
let deepseekNarrative = 'Dragan is planning his wedding to Sarah in September and has been focusing on evening walks, which seem to correlate with his improving sleep pillar.';
let deepseekOk = true;

global.fetch = jest.fn(async (url: any, opts: any) => {
  const body = opts?.body ? JSON.parse(opts.body) : undefined;
  fetchCalls.push({ url: String(url), body });
  if (String(url).includes('api.deepseek.com')) {
    if (!deepseekOk) return { ok: false, status: 500, text: async () => 'down' } as any;
    return { ok: true, json: async () => ({ choices: [{ message: { content: deepseekNarrative } }] }) } as any;
  }
  return { ok: false, status: 404, text: async () => 'not found' } as any;
}) as any;

import {
  computeInputsHash,
  synthesizeUserModel,
  gatherSynthesisInputs,
  MIN_FACTS_FOR_NARRATIVE,
  SIGNAL_PROFILE_NARRATIVE,
} from '../../src/services/user-model-synthesis';

function makeInputs(overrides: Partial<Parameters<typeof computeInputsHash>[0]> = {}) {
  return {
    facts: [{ fact_key: 'user_name', fact_value: 'Dragan', provenance_source: 'user_stated' }],
    routines: [],
    goal: null,
    index: null,
    ...overrides,
  };
}

function makeSupabaseStub(opts: {
  factCount: number;
  existingNarrativeHash?: string;
}) {
  const facts = Array.from({ length: opts.factCount }, (_, i) => ({
    fact_key: `fact_${i}`,
    fact_value: `value_${i}`,
    provenance_source: 'user_stated',
  }));
  const upserts: any[] = [];
  const client: any = {
    from: (table: string) => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'is', 'order', 'limit']) chain[m] = () => chain;
      if (table === 'memory_facts') {
        chain.then = (res: any) => Promise.resolve({ data: facts, error: null }).then(res);
      } else if (table === 'user_routines' || table === 'life_compass' || table === 'vitana_index_scores') {
        chain.then = (res: any) => Promise.resolve({ data: [], error: null }).then(res);
      } else if (table === 'user_assistant_state') {
        chain.maybeSingle = () =>
          Promise.resolve({
            data: opts.existingNarrativeHash
              ? { value: { narrative: 'old', inputs_hash: opts.existingNarrativeHash } }
              : null,
            error: null,
          });
        chain.upsert = (row: any) => {
          upserts.push(row);
          return Promise.resolve({ error: null });
        };
      }
      return chain;
    },
  };
  return { client, upserts };
}

describe('computeInputsHash', () => {
  it('is stable for identical inputs', () => {
    const a = makeInputs();
    const b = makeInputs();
    expect(computeInputsHash(a)).toBe(computeInputsHash(b));
  });

  it('is order-independent for facts and routines', () => {
    const a = makeInputs({
      facts: [
        { fact_key: 'x', fact_value: '1', provenance_source: 'user_stated' },
        { fact_key: 'y', fact_value: '2', provenance_source: 'user_stated' },
      ],
    });
    const b = makeInputs({
      facts: [
        { fact_key: 'y', fact_value: '2', provenance_source: 'user_stated' },
        { fact_key: 'x', fact_value: '1', provenance_source: 'user_stated' },
      ],
    });
    expect(computeInputsHash(a)).toBe(computeInputsHash(b));
  });

  it('changes when a fact value changes', () => {
    const a = makeInputs();
    const b = makeInputs({ facts: [{ fact_key: 'user_name', fact_value: 'Someone Else', provenance_source: 'user_stated' }] });
    expect(computeInputsHash(a)).not.toBe(computeInputsHash(b));
  });
});

describe('synthesizeUserModel', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    deepseekOk = true;
    deepseekNarrative =
      'Dragan is planning his wedding to Sarah in September and has been focusing on evening walks, which seem to correlate with his improving sleep pillar.';
  });

  it(`skips users below MIN_FACTS_FOR_NARRATIVE (${MIN_FACTS_FOR_NARRATIVE})`, async () => {
    const { client } = makeSupabaseStub({ factCount: MIN_FACTS_FOR_NARRATIVE - 1 });
    const result = await synthesizeUserModel(client, 't1', 'u1');
    expect(result).toEqual({ ok: true, written: false, reason: 'too_few_facts' });
    expect(fetchCalls.length).toBe(0);
  });

  it('calls DeepSeek as the primary provider and writes the narrative with its inputs hash', async () => {
    const { client, upserts } = makeSupabaseStub({ factCount: 5 });
    const result = await synthesizeUserModel(client, 't1', 'u1');
    expect(result).toEqual({ ok: true, written: true });

    const dsCall = fetchCalls.find((c) => c.url.includes('api.deepseek.com'));
    expect(dsCall).toBeDefined();
    expect(dsCall!.body.model).toBe('deepseek-chat');

    expect(upserts).toHaveLength(1);
    expect(upserts[0].signal_name).toBe(SIGNAL_PROFILE_NARRATIVE);
    expect(upserts[0].value.narrative).toBe(deepseekNarrative);
    expect(typeof upserts[0].value.inputs_hash).toBe('string');
  });

  it('skips re-synthesis when the inputs hash matches the stored one', async () => {
    const inputs = await gatherSynthesisInputs(makeSupabaseStub({ factCount: 5 }).client, 't1', 'u1');
    const hash = computeInputsHash(inputs);
    const { client } = makeSupabaseStub({ factCount: 5, existingNarrativeHash: hash });
    const result = await synthesizeUserModel(client, 't1', 'u1');
    expect(result).toEqual({ ok: true, written: false, reason: 'inputs_unchanged' });
    expect(fetchCalls.length).toBe(0);
  });

  it('reports model_failed when DeepSeek errors and no Vertex/Gemini narrative is produced', async () => {
    deepseekOk = false;
    const { client } = makeSupabaseStub({ factCount: 5 });
    const result = await synthesizeUserModel(client, 't1', 'u1');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('model_failed');
  });
});
