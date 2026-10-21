/**
 * VTID-04473: Jev client + wire-type validation. No network — fetch is injected.
 */
import { callJev, isJevConfigured, jevModel, JEV_DEFAULT_MODEL } from '../src/services/jev/jev-client';
import { assertValidQuestions, validateAnswers, scoreLevel, choiceProbability, JevQuestions } from '../src/services/jev/jev-types';

const ENV = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' } as NodeJS.ProcessEnv;

const Q: JevQuestions = {
  cat: { type: 'choice', instructions: 'pick', criteria: { a: 'A', b: 'B' } },
  yes: { type: 'noul', instructions: 'yes?' },
  lvl: { type: 'score', instructions: 'how much', criteria: ['low', 'mid', 'high'] },
};

const GOOD = {
  model: 'jev-1.13.0',
  answers: {
    cat: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 },
    yes: { type: 'noul', noul: 0.8 },
    lvl: { type: 'score', score: 2, probabilities: [0.1, 0.2, 0.7], confidence: 0.7 },
  },
  usage: { input_tokens: 1200, output_tokens: 3 },
};

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe('VTID-04473 jev-client', () => {
  test('activation needs BOTH the exact flag and a key', () => {
    expect(isJevConfigured({})).toBe(false);
    expect(isJevConfigured({ JEV_DECISIONS_ENABLED: 'true' })).toBe(false);
    expect(isJevConfigured({ TYPESAFE_API_KEY: 'k' })).toBe(false);
    expect(isJevConfigured({ JEV_DECISIONS_ENABLED: 'TRUE', TYPESAFE_API_KEY: 'k' })).toBe(false);
    expect(isJevConfigured(ENV)).toBe(true);
  });

  test('model is pinned by default, never -latest', () => {
    expect(jevModel({})).toBe(JEV_DEFAULT_MODEL);
    expect(JEV_DEFAULT_MODEL).not.toMatch(/latest/);
    expect(jevModel({ JEV_MODEL: 'jev-1.14.0' })).toBe('jev-1.14.0');
  });

  test('not configured → no fetch at all', async () => {
    const fetchImpl = jest.fn();
    const r = await callJev({ state: {}, questions: Q, env: {}, fetchImpl: fetchImpl as any });
    expect(r).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('success posts the documented contract and returns validated answers', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(res(200, GOOD));
    const r = await callJev({ state: { x: 1 }, questions: Q, env: ENV, fetchImpl: fetchImpl as any });
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body)).toEqual({ model: 'jev-1.13.0', state: { x: 1 }, questions: Q });
    if (r.ok) expect(r.usage.input_tokens).toBe(1200);
  });

  test('429 is retried once, then succeeds', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(res(429, 'slow down')).mockResolvedValueOnce(res(200, GOOD));
    const r = await callJev({ state: {}, questions: Q, env: ENV, fetchImpl: fetchImpl as any, sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('401 is not retried and reported as http_error', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(res(401, 'bad key'));
    const r = await callJev({ state: {}, questions: Q, env: ENV, fetchImpl: fetchImpl as any });
    expect(r).toMatchObject({ ok: false, reason: 'http_error', status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('an answer outside the declared options is malformed, never passed on', async () => {
    const bad = { ...GOOD, answers: { ...GOOD.answers, cat: { type: 'choice', choice: 'zzz', probabilities: {}, confidence: 0.9 } } };
    const r = await callJev({ state: {}, questions: Q, env: ENV, fetchImpl: jest.fn().mockResolvedValue(res(200, bad)) as any });
    expect(r).toMatchObject({ ok: false, reason: 'malformed_response' });
  });

  test('abort → timeout; thrown error → network', async () => {
    const abort = jest.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(await callJev({ state: {}, questions: Q, env: ENV, fetchImpl: abort as any })).toMatchObject({ reason: 'timeout' });
    const net = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    expect(await callJev({ state: {}, questions: Q, env: ENV, fetchImpl: net as any })).toMatchObject({ reason: 'network' });
  });

  test('invalid question sets are refused before any call', async () => {
    expect(() => assertValidQuestions({})).toThrow();
    expect(() => assertValidQuestions({ c: { type: 'choice', instructions: 'x', criteria: { only: '1' } } })).toThrow(/2 options/);
    expect(() => assertValidQuestions({ s: { type: 'score', instructions: 'x', criteria: ['one'] } })).toThrow(/levels/);
    const fetchImpl = jest.fn();
    const r = await callJev({ state: {}, questions: { q: { type: 'noul', instructions: '' } }, env: ENV, fetchImpl: fetchImpl as any });
    expect(r).toMatchObject({ ok: false, reason: 'invalid_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('answer helpers', () => {
    expect(validateAnswers(Q, GOOD.answers)).toEqual([]);
    expect(validateAnswers(Q, { yes: { noul: 2 } })).toEqual(expect.arrayContaining([expect.stringMatching(/cat/), expect.stringMatching(/yes/)]));
    expect(scoreLevel({ type: 'score', score: 0.2, probabilities: [0.1, 0.2, 0.7], confidence: 1 }, 3)).toBe(2);
    expect(scoreLevel({ type: 'score', score: 9, confidence: 1 }, 3)).toBe(2);
    expect(choiceProbability({ type: 'choice', choice: 'a', probabilities: { a: 0.6 }, confidence: 0.9 })).toBe(0.6);
  });
});
