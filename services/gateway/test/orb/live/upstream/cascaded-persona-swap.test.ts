/**
 * VTID-04336 — the Vitana → Devon hand-off on the cascade voice path
 * (Transcribe → Bedrock → Polly/Fish).
 *
 * CLAUDE.md §2c-fish-scope: a change to `cascaded-live-client.ts` outside TTS
 * selection runs for EVERY cascade language, so every behaviour here is
 * pinned for a Polly-backed language (`ru`) AND the Fish-only one (`sr`).
 */

jest.mock('../../../../src/orb/live/upstream/cascaded/transcribe-stream', () => ({
  TranscribeStreamSession: jest.fn().mockImplementation(() => ({
    onFragment: jest.fn(),
    onError: jest.fn(),
    pushAudioB64: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../../../src/services/llm-router', () => ({
  callViaRouter: jest.fn(),
}));

jest.mock('../../../../src/services/tts/polly', () => ({
  synthesizePolly: jest.fn(),
  resolvePollyVoice: jest.fn(),
  resolvePollySpecialistVoice: jest.fn(),
}));

jest.mock('../../../../src/services/tts/fish', () => ({
  synthesizeFish: jest.fn(),
  resolveFishVoice: jest.fn(),
  isFishConfigured: jest.fn(() => true),
}));

// `evaluateCascadeEligibility` checks Fish configuration for `sr`; the
// eligibility gate is not what these tests are about.
jest.mock('../../../../src/orb/live/upstream/cascaded-config', () => ({
  evaluateCascadeEligibility: jest.fn((lang: string) => ({
    eligible: true,
    transcribeLanguageCode: lang === 'sr' ? 'sr-RS' : 'ru-RU',
    reason: null,
  })),
}));

import {
  CascadedLiveClient,
  CASCADE_PERSONA_OPENING_PROMPT,
  CASCADE_TOOL_CONTINUE_PROMPT,
  extractCascadeTools,
} from '../../../../src/orb/live/upstream/cascaded-live-client';
import { callViaRouter } from '../../../../src/services/llm-router';
import {
  synthesizePolly,
  resolvePollyVoice,
  resolvePollySpecialistVoice,
} from '../../../../src/services/tts/polly';
import { synthesizeFish } from '../../../../src/services/tts/fish';

const mockRouter = callViaRouter as jest.Mock;
const mockPolly = synthesizePolly as jest.Mock;
const mockResolvePolly = resolvePollyVoice as jest.Mock;
const mockResolveSpecialist = resolvePollySpecialistVoice as jest.Mock;
const mockFish = synthesizeFish as jest.Mock;

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

const CATALOG = [
  {
    function_declarations: [
      { name: 'navigate', description: 'nav', parameters: { type: 'object', properties: {} } },
      { name: 'report_to_specialist', description: 'file + hand off', parameters: { type: 'object', properties: { summary: { type: 'string' } } } },
      { name: 'switch_persona', description: 'swap', parameters: { type: 'object', properties: { to: { type: 'string' } } } },
    ],
  },
  { google_search: {} },
];

function setUpVoices(lang: 'ru' | 'sr') {
  if (lang === 'ru') {
    mockResolvePolly.mockReturnValue({ voiceId: 'Tatyana', engine: 'standard', languageCode: 'ru-RU' });
    mockResolveSpecialist.mockReturnValue({ voiceId: 'Maxim', engine: 'standard', languageCode: 'ru-RU' });
    mockPolly.mockResolvedValue({ audioB64: 'AAAA' });
  } else {
    // Serbian: Polly has no voice at all; Fish has one curated voice.
    mockResolvePolly.mockReturnValue(null);
    mockResolveSpecialist.mockReturnValue(null);
    mockPolly.mockResolvedValue(null);
    mockFish.mockResolvedValue({ audioB64: 'BBBB' });
  }
}

async function connected(lang: 'ru' | 'sr', tools: unknown[] = CATALOG) {
  const client = new CascadedLiveClient({ lang });
  await client.connect({
    model: 'm',
    voiceName: 'v',
    responseModalities: ['audio'],
    vadSilenceMs: 900,
    systemInstruction: 'You are Vitana.',
    tools: tools as Array<Record<string, unknown>>,
  });
  return client;
}

beforeEach(() => {
  mockRouter.mockReset();
  mockPolly.mockReset();
  mockResolvePolly.mockReset();
  mockResolveSpecialist.mockReset();
  mockFish.mockReset();
});

describe('extractCascadeTools', () => {
  it('keeps only the hand-off tools from a Vertex-style catalog', () => {
    const tools = extractCascadeTools(CATALOG as Array<Record<string, unknown>>);
    expect(tools.map((t) => t.name)).toEqual(['report_to_specialist', 'switch_persona']);
    expect(tools[1].inputSchema).toEqual({ type: 'object', properties: { to: { type: 'string' } } });
  });

  it('returns nothing for an empty or anonymous catalog', () => {
    expect(extractCascadeTools(undefined)).toEqual([]);
    expect(extractCascadeTools([{ function_declarations: [{ name: 'navigate' }] }])).toEqual([]);
  });
});

describe.each(['ru', 'sr'] as const)('VTID-04336 cascade persona swap — lang=%s', (lang) => {
  beforeEach(() => setUpVoices(lang));

  it('declares only the hand-off tools to the model', async () => {
    const client = await connected(lang);
    expect(client.getPersonaState().toolNames).toEqual(['report_to_specialist', 'switch_persona']);
    mockRouter.mockResolvedValueOnce({ ok: true, text: 'Zdravo' });
    client.sendTextTurn('hi', true);
    await flush();
    expect(mockRouter.mock.calls[0][2].tools.map((t: { name: string }) => t.name)).toEqual([
      'report_to_specialist',
      'switch_persona',
    ]);
  });

  it('applyPersona replaces the instruction for the next turn and runs the opening turn', async () => {
    const client = await connected(lang);
    mockRouter.mockResolvedValue({ ok: true, text: 'Devon here' });
    const applied = client.applyPersona({
      persona: 'devon',
      systemInstruction: 'You are Devon, tech support.',
      voiceRole: 'specialist',
      openWithGreeting: true,
    });
    expect(applied).toMatchObject({ persona: 'devon', voiceRole: 'specialist', restoredBaseInstruction: false });
    await flush();
    expect(mockRouter).toHaveBeenCalledTimes(1);
    const [stage, prompt, opts] = mockRouter.mock.calls[0];
    expect(stage).toBe('operator');
    expect(prompt).toBe(CASCADE_PERSONA_OPENING_PROMPT);
    expect(opts.systemPrompt).toBe('You are Devon, tech support.');
    expect(opts.history).toBeUndefined();
  });

  it('the specialist speaks in the specialist voice where the backend has one', async () => {
    const client = await connected(lang);
    mockRouter.mockResolvedValue({ ok: true, text: 'Devon here' });
    const audio: unknown[] = [];
    client.onAudioOutput((e) => audio.push(e));
    client.applyPersona({ persona: 'devon', systemInstruction: 'Devon', voiceRole: 'specialist', openWithGreeting: true });
    await flush();
    expect(audio.length).toBeGreaterThan(0);
    if (lang === 'ru') {
      expect(mockPolly).toHaveBeenCalledWith({ text: 'Devon here', lang: 'ru', format: 'pcm', voiceRole: 'specialist' });
      expect(mockFish).not.toHaveBeenCalled();
    } else {
      // VTID-04445: Serbian has no Polly voice → Devon's male Fish voice
      // (a Fish Official voice, never an unvetted one, never Milica).
      expect(mockPolly).not.toHaveBeenCalled();
      expect(mockFish).toHaveBeenCalledWith({ text: 'Devon here', lang: 'sr', format: 'pcm', voiceRole: 'specialist' });
    }
  });

  it('swap back restores the connect-time instruction + appendix, receptionist voice, no opening turn', async () => {
    const client = await connected(lang);
    client.applyPersona({ persona: 'devon', systemInstruction: 'Devon', voiceRole: 'specialist', openWithGreeting: false });
    const applied = client.applyPersona({
      persona: 'vitana',
      systemInstruction: null,
      appendix: 'Ticket FB-1 filed.',
      voiceRole: 'receptionist',
      openWithGreeting: false,
    });
    expect(applied.restoredBaseInstruction).toBe(true);
    expect(client.getPersonaState().systemInstruction).toBe('You are Vitana.\n\nTicket FB-1 filed.');
    await flush();
    expect(mockRouter).not.toHaveBeenCalled();

    mockRouter.mockResolvedValueOnce({ ok: true, text: 'Back' });
    client.sendTextTurn('hello', true);
    await flush();
    expect(mockRouter.mock.calls[0][2].systemPrompt).toBe('You are Vitana.\n\nTicket FB-1 filed.');
    if (lang === 'ru') {
      expect(mockPolly).toHaveBeenCalledWith({ text: 'Back', lang: 'ru', format: 'pcm' });
    }
  });

  it('keeps a bounded rolling history so the "yes" turn knows what was proposed', async () => {
    const client = await connected(lang);
    mockRouter
      .mockResolvedValueOnce({ ok: true, text: 'Shall I bring in a colleague?' })
      .mockResolvedValueOnce({ ok: true, text: 'OK' });
    client.sendTextTurn('the diary screen crashes when I save', true);
    await flush();
    client.sendTextTurn('yes', true);
    await flush();
    expect(mockRouter.mock.calls[1][2].history).toEqual([
      { role: 'user', content: 'the diary screen crashes when I save' },
      { role: 'assistant', content: 'Shall I bring in a colleague?' },
    ]);
  });

  it('runs one tool round: onToolCall fires, the result is sent back, the bridge is spoken', async () => {
    const client = await connected(lang);
    const toolEvents: Array<{ calls: ReadonlyArray<{ name: string; id?: string; args: Record<string, unknown> }> }> = [];
    client.onToolCall((e) => {
      toolEvents.push(e);
      // Session layer answers asynchronously, like handleToolCall does.
      setImmediate(() => {
        expect(client.sendToolResult({ callId: e.calls[0].id, name: e.calls[0].name, success: true, output: 'Ticket FB-9 created. Speak ONE short bridge.' })).toBe(true);
      });
    });
    const turns: unknown[] = [];
    client.onTurnComplete((e) => turns.push(e));
    mockRouter
      .mockResolvedValueOnce({
        ok: true,
        text: '',
        toolCalls: [{ name: 'report_to_specialist', arguments: { summary: 'diary save crashes' }, id: 'tu_1' }],
      })
      .mockResolvedValueOnce({ ok: true, text: 'Tech support will take it from here.' });

    client.sendTextTurn('yes please', true);
    await flush(10);

    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].calls[0]).toMatchObject({ name: 'report_to_specialist', id: 'tu_1', args: { summary: 'diary save crashes' } });
    expect(mockRouter).toHaveBeenCalledTimes(2);
    const [, prompt2, opts2] = mockRouter.mock.calls[1];
    expect(prompt2).toBe(CASCADE_TOOL_CONTINUE_PROMPT);
    expect(opts2.tools).toBeUndefined();
    expect(opts2.history).toEqual([
      { role: 'user', content: 'yes please' },
      { role: 'assistant', toolCalls: [{ name: 'report_to_specialist', arguments: { summary: 'diary save crashes' }, id: 'tu_1' }], content: undefined },
      { role: 'user', toolResults: [{ id: 'tu_1', name: 'report_to_specialist', result: 'Ticket FB-9 created. Speak ONE short bridge.', isError: false }] },
    ]);
    expect(turns).toHaveLength(1);
  });

  it('never hangs on a pending tool call: close() answers it', async () => {
    const client = await connected(lang);
    client.onToolCall(() => { /* never answered */ });
    mockRouter
      .mockResolvedValueOnce({ ok: true, text: '', toolCalls: [{ name: 'switch_persona', arguments: { to: 'devon' } }] })
      .mockResolvedValueOnce({ ok: true, text: 'ok' });
    client.sendTextTurn('connect me to Devon', true);
    await flush();
    await client.close('test');
    await flush();
    const results = mockRouter.mock.calls[1][2].history[2].toolResults;
    expect(results[0]).toMatchObject({ name: 'switch_persona', result: 'voice session closed', isError: true });
  });

  it('a tool the allowlist does not name is answered as unavailable, never dispatched', async () => {
    const client = await connected(lang);
    const handler = jest.fn();
    client.onToolCall(handler);
    mockRouter
      .mockResolvedValueOnce({ ok: true, text: '', toolCalls: [{ name: 'navigate', arguments: {}, id: 'x' }] })
      .mockResolvedValueOnce({ ok: true, text: 'ok' });
    client.sendTextTurn('go home', true);
    await flush();
    expect(handler).not.toHaveBeenCalled();
    expect(mockRouter.mock.calls[1][2].history[2].toolResults[0]).toMatchObject({ isError: true });
  });
});

describe('VTID-04336 Polly specialist voice fallback (ru)', () => {
  it('VTID-04445: never falls back to the receptionist (female) voice — retries the male voice once', async () => {
    setUpVoices('ru');
    mockPolly.mockReset();
    mockPolly.mockResolvedValueOnce(null).mockResolvedValueOnce({ audioB64: 'CCCC' });
    const client = await connected('ru');
    mockRouter.mockResolvedValue({ ok: true, text: 'Devon here' });
    const audio: unknown[] = [];
    client.onAudioOutput((e) => audio.push(e));
    client.applyPersona({ persona: 'devon', systemInstruction: 'Devon', voiceRole: 'specialist', openWithGreeting: true });
    await flush();
    expect(mockPolly).toHaveBeenCalledTimes(2);
    expect(mockPolly.mock.calls[0][0]).toMatchObject({ voiceRole: 'specialist' });
    expect(mockPolly.mock.calls[1][0]).toMatchObject({ voiceRole: 'specialist' });
    expect(audio.length).toBeGreaterThan(0);
  });

});
