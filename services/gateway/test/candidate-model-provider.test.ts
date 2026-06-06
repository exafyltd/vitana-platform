/**
 * Candidate-model provider (BOOTSTRAP-SHADOW-REAL-CANDIDATE, Day-4 G4).
 *
 * The shadow candidate must be the REAL fine-tuned model when an endpoint is
 * configured, and an HONESTLY-TAGGED simulation otherwise — never a silent
 * fallback, and never simulated evidence masquerading as real. These pin that.
 */
process.env.NODE_ENV = 'test';

import {
  candidateEnvKey,
  candidateEndpointFor,
  extractToolName,
  vertexPredictToolName,
  resolveCandidateRunner,
  type ToolChoice,
} from '../src/services/candidate-model-provider';

describe('candidate endpoint resolution', () => {
  test('env key is feature-namespaced and normalized', () => {
    expect(candidateEnvKey('voice-tool-router')).toBe('CANDIDATE_ENDPOINT__voice_tool_router');
    expect(candidateEnvKey('intent-kind')).toBe('CANDIDATE_ENDPOINT__intent_kind');
  });

  test('returns the endpoint when set, null when unset/blank', () => {
    expect(candidateEndpointFor('voice-tool-router', { CANDIDATE_ENDPOINT__voice_tool_router: 'https://ep' })).toBe('https://ep');
    expect(candidateEndpointFor('voice-tool-router', {})).toBeNull();
    expect(candidateEndpointFor('voice-tool-router', { CANDIDATE_ENDPOINT__voice_tool_router: '   ' })).toBeNull();
  });
});

describe('extractToolName — tolerant parsing', () => {
  test('reads tool_name off a Vertex predictions envelope', () => {
    expect(extractToolName({ predictions: [{ tool_name: 'get_weather' }] })).toBe('get_weather');
  });
  test('reads tool_call.name fallback', () => {
    expect(extractToolName({ predictions: [{ tool_call: { name: 'send_message' } }] })).toBe('send_message');
  });
  test('reads a bare prediction body', () => {
    expect(extractToolName({ tool_name: 'open_app' })).toBe('open_app');
  });
  test('returns null on junk / empty', () => {
    expect(extractToolName({ predictions: [{}] })).toBeNull();
    expect(extractToolName(null)).toBeNull();
    expect(extractToolName('nope')).toBeNull();
  });
});

describe('vertexPredictToolName', () => {
  test('posts text and extracts the predicted tool', async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fakeFetch = (async (url: string, init: { body: string }) => {
      captured = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ predictions: [{ tool_name: 'get_today_plan' }] }) };
    }) as unknown as typeof fetch;
    const out = await vertexPredictToolName('https://ep/predict', 'what is on today', { fetchImpl: fakeFetch });
    expect(out.tool_name).toBe('get_today_plan');
    expect(captured!.url).toBe('https://ep/predict');
    expect(captured!.body).toEqual({ instances: [{ text: 'what is on today' }] });
  });

  test('throws on non-ok HTTP so the shadow harness records a candidate error', async () => {
    const fakeFetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(vertexPredictToolName('https://ep', 'hi', { fetchImpl: fakeFetch })).rejects.toThrow(/HTTP 503/);
  });
});

describe('resolveCandidateRunner', () => {
  test('endpoint set → real runner, simulated_models=false, calls predict', async () => {
    const calls: string[] = [];
    const predict = async (ep: string, text: string): Promise<ToolChoice> => {
      calls.push(`${ep}::${text}`);
      return { tool_name: 'real_tool' };
    };
    const runner = resolveCandidateRunner('voice-tool-router', {
      env: { CANDIDATE_ENDPOINT__voice_tool_router: 'https://real' },
      predict,
    });
    expect(runner.provenance).toEqual({ candidate_source: 'vertex_endpoint', simulated_models: false, endpoint: 'https://real' });
    const out = await runner.run({ text: 'hello' });
    expect(out.tool_name).toBe('real_tool');
    expect(calls).toEqual(['https://real::hello']);
  });

  test('no endpoint + simulation → simulation provenance + logged (non-silent) fallback', async () => {
    const fellBack: string[] = [];
    const runner = resolveCandidateRunner('voice-tool-router', {
      env: {},
      simulation: async () => ({ tool_name: 'sim_tool' }),
      onFallback: (f, reason) => fellBack.push(`${f}:${reason}`),
    });
    expect(runner.provenance.simulated_models).toBe(true);
    expect(runner.provenance.candidate_source).toBe('simulation');
    expect(fellBack).toHaveLength(1);
    expect(fellBack[0]).toMatch(/CANDIDATE_ENDPOINT__voice_tool_router unset/);
    expect((await runner.run({ text: 'x' })).tool_name).toBe('sim_tool');
  });

  test('no endpoint + no simulation → throws rather than fabricating a candidate', () => {
    expect(() => resolveCandidateRunner('voice-tool-router', { env: {}, onFallback: () => {} })).toThrow(/no simulation fallback/);
  });
});
