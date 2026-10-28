/**
 * Guide session summaries — conversation-flow contract (VTID-03579)
 *
 * `summarizeWithGeminiFlash` writes the one-line recap the user gets when they
 * reopen Vitana ("remember when we talked about X yesterday?"). VTID-03579
 * moved it off its own Vertex -> Gemini-API cascade onto the router, so the
 * provider is now `llm_routing_policy`'s decision rather than this module's.
 *
 * These tests pin the parts of that flow a provider swap can silently break:
 * what the model is actually shown, that the summary is length-bounded before
 * it reaches storage, and — most importantly — that a provider failure returns
 * null so the caller falls back to the heuristic builder instead of writing a
 * broken recap. The function name still says "GeminiFlash"; it is deliberately
 * unchanged here to keep the diff about behaviour, and is no longer accurate.
 */

process.env.NODE_ENV = 'test';

let routerResponse: {
  ok: boolean;
  text?: string;
  error?: string;
  provider?: string;
  model?: string;
} = { ok: true, provider: 'bedrock', model: 'haiku', text: 'Talked through the September wedding plans and evening walks.' };

const callViaRouter = jest.fn(async () => routerResponse);
jest.mock('../src/services/llm-router', () => ({
  callViaRouter: (...args: unknown[]) => callViaRouter(...(args as [])),
}));

import { summarizeWithGeminiFlash } from '../src/services/guide/session-summaries';

const TURNS: Array<{ role: 'user' | 'assistant'; text: string }> = [
  { role: 'user', text: 'We set the wedding for September and I have been walking every evening.' },
  { role: 'assistant', text: 'That is great — the evening walks seem to be helping your sleep.' },
];

describe('guide session summaries: flow contract (VTID-03579)', () => {
  beforeEach(() => {
    callViaRouter.mockClear();
    routerResponse = {
      ok: true,
      provider: 'bedrock',
      model: 'haiku',
      text: 'Talked through the September wedding plans and evening walks.',
    };
  });

  it('summarizes an ordinary session through the router', async () => {
    const summary = await summarizeWithGeminiFlash(TURNS);

    expect(summary).toBe('Talked through the September wedding plans and evening walks.');
    expect(callViaRouter).toHaveBeenCalledTimes(1);

    const [stage, prompt, opts] = callViaRouter.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(stage).toBe('memory');
    expect(opts.service).toBe('guide-session-summaries');

    // The transcript is the user turn and the summarization brief is the system
    // prompt. If the brief ever migrates into the user turn the model starts
    // summarizing its own instructions back at the user.
    expect(prompt).toContain('User: We set the wedding for September');
    expect(prompt).toContain('Assistant: That is great');
    expect(String(opts.systemPrompt)).not.toEqual(prompt);
  });

  it('returns null when the provider fails, so the caller can fall back', async () => {
    routerResponse = { ok: false, provider: 'bedrock', error: 'no provider available' };

    // This is the flow-critical branch. The caller treats null as "use the
    // heuristic summary builder"; anything non-null is written as the user's
    // recap. A provider outage must degrade to the heuristic, never persist a
    // placeholder or an error string as if it were a real memory.
    await expect(summarizeWithGeminiFlash(TURNS)).resolves.toBeNull();
  });

  it('returns null on an empty model response rather than an empty summary', async () => {
    routerResponse = { ok: true, provider: 'bedrock', model: 'haiku', text: '   ' };

    // Whitespace is not a summary. Returning it would store a blank recap that
    // looks like a successful summarization to every downstream count.
    await expect(summarizeWithGeminiFlash(TURNS)).resolves.toBeNull();
  });

  it('truncates an over-long summary before it reaches storage', async () => {
    routerResponse = {
      ok: true,
      provider: 'bedrock',
      model: 'haiku',
      text: 'x'.repeat(2000),
    };

    const summary = await summarizeWithGeminiFlash(TURNS);
    expect(summary).not.toBeNull();
    // Bound enforced here, not at the DB. A different provider can be
    // markedly more verbose than the Gemini Flash this was tuned against.
    expect(summary!.length).toBeLessThanOrEqual(600);
  });

  it('does not call the model at all for an empty session', async () => {
    await expect(summarizeWithGeminiFlash([])).resolves.toBeNull();
    expect(callViaRouter).not.toHaveBeenCalled();
  });
});
