/**
 * VTID-04336 — the persona swap wiring in `handleTurnComplete`.
 *
 * Nova/Vertex: close the upstream with reason `persona_swap` so the route
 * reconnects with Devon's prompt and voice (unchanged behaviour).
 * Cascade: no stream to reconnect — `applyPersona()` on the same client.
 *
 * The end-to-end block binds the REAL `CascadedLiveClient` through the real
 * `bindUpstreamSessionHandlers`, so the hand-off is proven from the model's
 * tool call to Devon's first spoken turn — for `ru` (Polly) and `sr` (Fish).
 */

jest.mock('../../../../src/orb/live/upstream/cascaded/transcribe-stream', () => ({
  TranscribeStreamSession: jest.fn().mockImplementation(() => ({
    onFragment: jest.fn(),
    onError: jest.fn(),
    pushAudioB64: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../../../../src/services/llm-router', () => ({ callViaRouter: jest.fn() }));
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
jest.mock('../../../../src/orb/live/upstream/cascaded-config', () => ({
  evaluateCascadeEligibility: jest.fn((lang: string) => ({
    eligible: true,
    transcribeLanguageCode: lang === 'sr' ? 'sr-RS' : 'ru-RU',
    reason: null,
  })),
}));

import {
  bindUpstreamSessionHandlers,
  handleTurnComplete,
  type UpstreamMessageHandlerDeps,
  type UpstreamSessionHandlerContext,
} from '../../../../src/orb/live/session/upstream-message-handler';
import {
  buildInProcessPersonaSwap,
  supportsInProcessPersonaSwap,
} from '../../../../src/orb/live/session/in-process-persona-swap';
import {
  CascadedLiveClient,
  CASCADE_PERSONA_OPENING_PROMPT,
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
const mockFish = synthesizeFish as jest.Mock;

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function makeSession(over: Record<string, unknown> = {}): any {
  return {
    sessionId: 'sess-04336',
    active: true,
    isModelSpeaking: false,
    audioOutChunks: 0,
    turn_count: 1,
    consecutiveModelTurns: 0,
    consecutiveToolCalls: 0,
    greetingSent: true,
    greetingTurnIndex: 0,
    inputTranscriptBuffer: '',
    outputTranscriptBuffer: '',
    transcriptTurns: [],
    pendingEventLinks: [],
    lastAudioForwardedTime: Date.now(),
    createdAt: new Date(),
    lang: 'ru',
    identity: null,
    isAnonymous: false,
    sseResponse: null,
    clientWs: null,
    ...over,
  };
}

function makeDeps(over: Partial<UpstreamMessageHandlerDeps> = {}): UpstreamMessageHandlerDeps {
  return {
    clearResponseWatchdog: jest.fn(),
    detectAuthIntent: jest.fn().mockReturnValue(null),
    detectStillHereComplaint: jest.fn().mockReturnValue(false),
    dispatchEndConversationDirective: jest.fn(),
    emitDiag: jest.fn(),
    emitLiveSessionEvent: jest.fn().mockResolvedValue(undefined),
    executeLiveApiTool: jest.fn().mockResolvedValue({ success: true, result: '{}' }),
    isDevSandbox: jest.fn().mockReturnValue(false),
    sendAudioToLiveAPI: jest.fn().mockReturnValue(true),
    sendFunctionResponseToLiveAPI: jest.fn().mockReturnValue(true),
    sendWsMessage: jest.fn(),
    markVoiceLatency: jest.fn(),
    finalizeVoiceTurnLatency: jest.fn(),
    startResponseWatchdog: jest.fn(),
    ...over,
  } as UpstreamMessageHandlerDeps;
}

function fakeCtx(client: any, session: any, deps = makeDeps()): UpstreamSessionHandlerContext {
  return {
    session,
    client,
    callbacks: {
      onAudioResponse: jest.fn(),
      onTextResponse: jest.fn(),
      onError: jest.fn(),
      onTurnComplete: jest.fn(),
      onInterrupted: jest.fn(),
    },
    deps,
  } as unknown as UpstreamSessionHandlerContext;
}

describe('buildInProcessPersonaSwap', () => {
  it('specialist: override prompt, specialist voice, opening turn', () => {
    expect(buildInProcessPersonaSwap({ personaSystemOverride: 'Devon prompt' }, 'devon')).toEqual({
      persona: 'devon',
      systemInstruction: 'Devon prompt',
      appendix: null,
      voiceRole: 'specialist',
      openWithGreeting: true,
    });
  });

  it('back to vitana: base prompt + cached context, receptionist voice, silent', () => {
    expect(
      buildInProcessPersonaSwap(
        { personaSystemOverride: null, specialistContextSection: 'Ticket FB-1', lastTranscriptSection: 'Transcript' },
        'vitana',
      ),
    ).toEqual({
      persona: 'vitana',
      systemInstruction: null,
      appendix: 'Ticket FB-1\n\nTranscript',
      voiceRole: 'receptionist',
      openWithGreeting: false,
    });
  });

  it('detects in-process capable clients by shape', () => {
    expect(supportsInProcessPersonaSwap({ applyPersona: () => ({}) })).toBe(true);
    expect(supportsInProcessPersonaSwap({ close: () => undefined })).toBe(false);
    expect(supportsInProcessPersonaSwap(null)).toBe(false);
  });
});

describe('handleTurnComplete persona-swap branch', () => {
  it('cascade-like client: applyPersona, never close, no _personaSwapInFlight', () => {
    const client = {
      applyPersona: jest.fn().mockReturnValue({ persona: 'devon', voiceRole: 'specialist', instructionChars: 12, restoredBaseInstruction: false }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const session = makeSession({ pendingPersonaSwap: 'devon', personaSystemOverride: 'Devon prompt' });
    const ctx = fakeCtx(client, session);
    handleTurnComplete(ctx, {} as any);
    expect(client.applyPersona).toHaveBeenCalledWith({
      persona: 'devon',
      systemInstruction: 'Devon prompt',
      appendix: null,
      voiceRole: 'specialist',
      openWithGreeting: true,
    });
    expect(client.close).not.toHaveBeenCalled();
    expect(session.activePersona).toBe('devon');
    expect(session.pendingPersonaSwap).toBeNull();
    expect(session._personaSwapInFlight).toBeUndefined();
    expect(ctx.deps.emitDiag).toHaveBeenCalledWith(session, 'persona_swap_in_process', expect.objectContaining({ persona: 'devon' }));
  });

  it('Nova/Vertex-like client (no applyPersona): unchanged close("persona_swap") + reconnect flag', () => {
    const client = { close: jest.fn().mockResolvedValue(undefined) };
    const session = makeSession({ pendingPersonaSwap: 'devon', personaSystemOverride: 'Devon prompt' });
    handleTurnComplete(fakeCtx(client, session), {} as any);
    expect(client.close).toHaveBeenCalledWith('persona_swap');
    expect(session._personaSwapInFlight).toBe(true);
    expect(session.activePersona).toBe('devon');
  });

  it('no pending swap: neither path runs', () => {
    const client = { applyPersona: jest.fn(), close: jest.fn() };
    handleTurnComplete(fakeCtx(client, makeSession()), {} as any);
    expect(client.applyPersona).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });
});

describe.each(['ru', 'sr'] as const)('end-to-end cascade hand-off through the real handlers — lang=%s', (lang) => {
  beforeEach(() => {
    mockRouter.mockReset();
    mockPolly.mockReset();
    mockFish.mockReset();
    (resolvePollyVoice as jest.Mock).mockReset();
    (resolvePollySpecialistVoice as jest.Mock).mockReset();
    if (lang === 'ru') {
      (resolvePollyVoice as jest.Mock).mockReturnValue({ voiceId: 'Tatyana', engine: 'standard', languageCode: 'ru-RU' });
      (resolvePollySpecialistVoice as jest.Mock).mockReturnValue({ voiceId: 'Maxim', engine: 'standard', languageCode: 'ru-RU' });
      mockPolly.mockResolvedValue({ audioB64: 'AAAA' });
    } else {
      (resolvePollyVoice as jest.Mock).mockReturnValue(null);
      (resolvePollySpecialistVoice as jest.Mock).mockReturnValue(null);
      mockPolly.mockResolvedValue(null);
      mockFish.mockResolvedValue({ audioB64: 'BBBB' });
    }
  });

  it('report_to_specialist → bridge in Vitana voice → Devon opens with his prompt and voice', async () => {
    const client = new CascadedLiveClient({ lang });
    const session = makeSession({ lang });
    const deps = makeDeps({
      executeLiveApiTool: jest.fn(async (s: any, name: string) => {
        // What the real report_to_specialist handler does to the session.
        expect(name).toBe('report_to_specialist');
        s.pendingPersonaSwap = 'devon';
        s.personaSystemOverride = 'You are Devon, tech support. Respond in the user language.';
        return { success: true, result: 'Ticket FB-7 created. Speak ONE short bridge sentence.' };
      }),
    });
    bindUpstreamSessionHandlers(fakeCtx(client, session, deps));
    await client.connect({
      model: 'm',
      voiceName: 'v',
      responseModalities: ['audio'],
      vadSilenceMs: 900,
      systemInstruction: 'You are Vitana.',
      tools: [{ function_declarations: [{ name: 'report_to_specialist', description: 'd', parameters: { type: 'object', properties: {} } }] }],
    });

    mockRouter
      .mockResolvedValueOnce({ ok: true, text: '', toolCalls: [{ name: 'report_to_specialist', arguments: { summary: 'diary crashes on save' }, id: 'tu_1' }] })
      .mockResolvedValueOnce({ ok: true, text: 'Tech support takes over now.' })
      .mockResolvedValueOnce({ ok: true, text: 'Hi, tell me what happens on save.' });

    client.sendTextTurn('yes, please connect me', true);
    await flush(20);

    expect(deps.executeLiveApiTool).toHaveBeenCalledTimes(1);
    expect(mockRouter).toHaveBeenCalledTimes(3);
    // Turn 3 is Devon's opening turn, on Devon's prompt, fresh history.
    const [, openPrompt, openOpts] = mockRouter.mock.calls[2];
    expect(openPrompt).toBe(CASCADE_PERSONA_OPENING_PROMPT);
    expect(openOpts.systemPrompt).toBe('You are Devon, tech support. Respond in the user language.');
    expect(openOpts.history).toBeUndefined();
    expect(session.activePersona).toBe('devon');
    expect(client.getState()).toBe('open');
    expect(deps.emitDiag).toHaveBeenCalledWith(session, 'persona_swap_in_process', expect.objectContaining({ voice_role: 'specialist' }));

    if (lang === 'ru') {
      // Bridge in Vitana's voice, Devon's opener in the specialist voice.
      expect(mockPolly).toHaveBeenCalledWith({ text: 'Tech support takes over now.', lang: 'ru', format: 'pcm' });
      expect(mockPolly).toHaveBeenCalledWith({ text: 'Hi, tell me what happens on save.', lang: 'ru', format: 'pcm', voiceRole: 'specialist' });
    } else {
      // Serbian keeps the single curated Fish voice for both.
      // VTID-04445: Vitana's bridge in her voice (Milica), Devon in his male voice (Nikola).
      expect(mockFish).toHaveBeenCalledWith({ text: 'Tech support takes over now.', lang: 'sr', format: 'pcm', voiceRole: 'receptionist' });
      expect(mockFish).toHaveBeenCalledWith({ text: 'Hi, tell me what happens on save.', lang: 'sr', format: 'pcm', voiceRole: 'specialist' });
    }
    await client.close('done');
  });
});
