/**
 * VTID-03641 — pollyOnlyVoice wiring in the provider-neutral session binding.
 *
 * A `pollyOnlyVoice` session (language with no native voice on Nova OR
 * Vertex — selected via the `nova_polly_only_voice` bypass in
 * upstream-provider-selector.ts) must:
 *   1. NEVER forward Nova's own native audio to the client — Nova will still
 *      generate audio using whichever voice it has, in the wrong language.
 *   2. Synthesize the completed turn's text via Amazon Polly and forward
 *      THAT audio instead, at turn_complete.
 *   3. Degrade to text-only (no audio, transcript still visible) rather than
 *      any fallback voice when Polly itself fails.
 *
 * Uses the same `bindUpstreamSessionHandlers` + `FakeUpstreamClient` harness
 * as `upstream-session-binding.test.ts`.
 */

import {
  bindUpstreamSessionHandlers,
  type UpstreamSessionHandlerContext,
  type UpstreamMessageHandlerDeps,
} from '../../../../src/orb/live/session/upstream-message-handler';
import type {
  AudioOutputEvent,
  InterruptedEvent,
  ToolCallEvent,
  TranscriptEvent,
  TurnCompleteEvent,
  UpstreamCloseEvent,
  UpstreamConnectOptions,
  UpstreamConnectionState,
  UpstreamErrorEvent,
  UpstreamLiveClient,
  UpstreamToolResult,
  UpstreamUsageEvent,
} from '../../../../src/orb/live/upstream/types';
import { synthesizePolly } from '../../../../src/services/tts/polly';

jest.mock('../../../../src/services/tts/polly', () => ({
  synthesizePolly: jest.fn(),
}));

const mockSynthesizePolly = synthesizePolly as jest.MockedFunction<typeof synthesizePolly>;

/** Minimal fake implementing the full UpstreamLiveClient contract. */
class FakeUpstreamClient implements UpstreamLiveClient {
  state: UpstreamConnectionState = 'open';
  sentToolResults: UpstreamToolResult[] = [];
  sentAudio: Array<{ b64: string; mime?: string }> = [];
  closeReasons: string[] = [];

  private audioH: ((e: AudioOutputEvent) => void) | null = null;
  private transcriptH: ((e: TranscriptEvent) => void) | null = null;
  private toolH: ((e: ToolCallEvent) => void) | null = null;
  private turnH: ((e: TurnCompleteEvent) => void) | null = null;
  private interruptedH: ((e: InterruptedEvent) => void) | null = null;
  private usageH: ((e: UpstreamUsageEvent) => void) | null = null;
  private errorH: ((e: UpstreamErrorEvent) => void) | null = null;
  private closeH: ((e: UpstreamCloseEvent) => void) | null = null;

  async connect(_options: UpstreamConnectOptions): Promise<void> { this.state = 'open'; }
  sendAudioChunk(b64: string, mime?: string): boolean {
    if (this.state !== 'open') return false;
    this.sentAudio.push({ b64, mime });
    return true;
  }
  sendTextTurn(): boolean { return this.state === 'open'; }
  sendEndOfTurn(): boolean { return this.state === 'open'; }
  sendToolResult(result: UpstreamToolResult): boolean {
    if (this.state !== 'open') return false;
    this.sentToolResults.push(result);
    return true;
  }
  onAudioOutput(h: (e: AudioOutputEvent) => void): void { this.audioH = h; }
  onTranscript(h: (e: TranscriptEvent) => void): void { this.transcriptH = h; }
  onToolCall(h: (e: ToolCallEvent) => void): void { this.toolH = h; }
  onTurnComplete(h: (e: TurnCompleteEvent) => void): void { this.turnH = h; }
  onInterrupted(h: (e: InterruptedEvent) => void): void { this.interruptedH = h; }
  onUsage(h: (e: UpstreamUsageEvent) => void): void { this.usageH = h; }
  onError(h: (e: UpstreamErrorEvent) => void): void { this.errorH = h; }
  onClose(h: (e: UpstreamCloseEvent) => void): void { this.closeH = h; }
  async close(reason?: string): Promise<void> {
    this.closeReasons.push(reason ?? '');
    this.state = 'closed';
    this.closeH?.({ initiatedLocally: true, reason });
  }
  getState(): UpstreamConnectionState { return this.state; }

  emitAudio(e: AudioOutputEvent): void { this.audioH?.(e); }
  emitTranscript(e: TranscriptEvent): void { this.transcriptH?.(e); }
  emitTurnComplete(e: TurnCompleteEvent = {}): void { this.turnH?.(e); }
}

function makeSession(overrides: Record<string, unknown> = {}): any {
  return {
    sessionId: 'sess-polly-only-1',
    active: true,
    isModelSpeaking: false,
    audioOutChunks: 0,
    turn_count: 0,
    consecutiveModelTurns: 0,
    consecutiveToolCalls: 0,
    greetingSent: false,
    greetingTurnIndex: 0,
    inputTranscriptBuffer: '',
    outputTranscriptBuffer: '',
    transcriptTurns: [],
    pendingEventLinks: [],
    lastAudioForwardedTime: Date.now(),
    createdAt: new Date(),
    lang: 'pt',
    identity: null,
    isAnonymous: false,
    sseResponse: null,
    clientWs: null,
    navigationDispatched: false,
    pendingNavigation: undefined,
    pollyOnlyVoice: true,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<UpstreamMessageHandlerDeps> = {}): UpstreamMessageHandlerDeps {
  return {
    clearResponseWatchdog: jest.fn(),
    detectAuthIntent: jest.fn().mockReturnValue(null),
    emitDiag: jest.fn(),
    emitLiveSessionEvent: jest.fn().mockResolvedValue(undefined),
    executeLiveApiTool: jest.fn().mockResolvedValue({ success: true, result: '{"screen":"journey"}' }),
    isDevSandbox: jest.fn().mockReturnValue(false),
    sendAudioToLiveAPI: jest.fn().mockReturnValue(true),
    sendFunctionResponseToLiveAPI: jest.fn().mockReturnValue(true),
    sendWsMessage: jest.fn(),
    markVoiceLatency: jest.fn(),
    finalizeVoiceTurnLatency: jest.fn(),
    startResponseWatchdog: jest.fn(),
    ...overrides,
  };
}

function makeContext(overrides: {
  session?: any;
  deps?: Partial<UpstreamMessageHandlerDeps>;
} = {}) {
  const session = overrides.session ?? makeSession();
  const client = new FakeUpstreamClient();
  const callbacks = {
    onAudioResponse: jest.fn(),
    onTextResponse: jest.fn(),
    onError: jest.fn(),
    onTurnComplete: jest.fn(),
    onInterrupted: jest.fn(),
  };
  const deps = makeDeps(overrides.deps);
  const ctx: UpstreamSessionHandlerContext = { session, client, callbacks, deps, options: undefined };
  bindUpstreamSessionHandlers(ctx);
  return { session, client, callbacks, deps, ctx };
}

const flushPromises = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('VTID-03641 pollyOnlyVoice — Nova native audio suppression', () => {
  it('drops Nova audio chunks entirely for a pollyOnlyVoice session', () => {
    const { client, callbacks } = makeContext();
    client.emitAudio({ dataB64: 'AQID', mimeType: 'audio/pcm;rate=24000' });
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
  });

  it('still runs turn-timing bookkeeping (isModelSpeaking, chunk count) despite dropping the bytes', () => {
    const { session, client } = makeContext();
    client.emitAudio({ dataB64: 'AQID', mimeType: 'audio/pcm;rate=24000' });
    expect(session.isModelSpeaking).toBe(true);
    expect(session.audioOutChunks).toBe(1);
  });

  it('an ordinary (non-pollyOnlyVoice) session is unaffected — Nova audio still forwards', () => {
    const { client, callbacks } = makeContext({ session: makeSession({ pollyOnlyVoice: false, lang: 'en' }) });
    client.emitAudio({ dataB64: 'AQID', mimeType: 'audio/pcm;rate=24000' });
    expect(callbacks.onAudioResponse).toHaveBeenCalledWith('AQID');
  });
});

describe('VTID-03641 pollyOnlyVoice — Polly synthesis at turn_complete', () => {
  it('synthesizes the completed turn text via Polly and forwards it over WS', async () => {
    mockSynthesizePolly.mockResolvedValue({
      audioB64: 'cG9sbHktYXVkaW8=',
      sampleRateHz: 16000,
      voice: 'Camila',
      engine: 'neural',
      languageCode: 'pt-BR',
    });
    const clientWs = { readyState: 1 };
    const { session, client, deps } = makeContext({ session: makeSession({ clientWs }) });
    client.emitTranscript({ direction: 'output', text: 'Olá, como posso ajudar hoje?' });
    client.emitTurnComplete();
    await flushPromises();

    expect(mockSynthesizePolly).toHaveBeenCalledWith({
      text: 'Olá, como posso ajudar hoje?',
      lang: 'pt',
      format: 'pcm',
    });
    expect(deps.sendWsMessage).toHaveBeenCalledWith(
      clientWs,
      expect.objectContaining({
        type: 'audio',
        data_b64: 'cG9sbHktYXVkaW8=',
        mime: 'audio/pcm;rate=16000',
      }),
    );
  });

  it('forwards over SSE instead when the session has no WS client', async () => {
    mockSynthesizePolly.mockResolvedValue({
      audioB64: 'cG9sbHktYXVkaW8=',
      sampleRateHz: 16000,
      voice: 'Ola',
      engine: 'neural',
      languageCode: 'pl-PL',
    });
    const sseResponse = { writableEnded: false, write: jest.fn().mockReturnValue(true) };
    const { client } = makeContext({ session: makeSession({ lang: 'pl', sseResponse }) });
    client.emitTranscript({ direction: 'output', text: 'Cześć, w czym mogę pomóc?' });
    client.emitTurnComplete();
    await flushPromises();

    expect(sseResponse.write).toHaveBeenCalled();
    const written = sseResponse.write.mock.calls.map((c: any[]) => c[0]).join('');
    expect(written).toContain('"type":"audio"');
    expect(written).toContain('"mime":"audio/pcm;rate=16000"');
  });

  it('produces NO audio (text-only degrade) when Polly synthesis fails — never a fallback voice', async () => {
    mockSynthesizePolly.mockResolvedValue(null);
    const clientWs = { readyState: 1 };
    const { session, client, deps } = makeContext({ session: makeSession({ clientWs }) });
    client.emitTranscript({ direction: 'output', text: 'A reply Polly cannot speak.' });
    client.emitTurnComplete();
    await flushPromises();

    expect(deps.sendWsMessage).not.toHaveBeenCalled();
    expect(deps.emitDiag).toHaveBeenCalledWith(
      session,
      'polly_only_voice_synthesis_failed',
      expect.objectContaining({ lang: 'pt' }),
    );
  });

  it('never throws even when synthesizePolly itself rejects', async () => {
    mockSynthesizePolly.mockRejectedValue(new Error('AWS SDK boom'));
    const { client } = makeContext({ session: makeSession({ clientWs: { readyState: 1 } }) });
    client.emitTranscript({ direction: 'output', text: 'Some text.' });
    expect(() => client.emitTurnComplete()).not.toThrow();
    await flushPromises();
    // No assertion needed beyond "did not throw" — the rejection is caught
    // and logged inside deliverPollyOnlyTurnAudio.
  });

  it('does NOT synthesize when the turn was empty (nothing to speak)', async () => {
    const { client } = makeContext({ session: makeSession({ clientWs: { readyState: 1 } }) });
    client.emitTurnComplete();
    await flushPromises();
    expect(mockSynthesizePolly).not.toHaveBeenCalled();
  });

  it('does NOT synthesize for an ordinary (non-pollyOnlyVoice) session', async () => {
    const { client } = makeContext({
      session: makeSession({ pollyOnlyVoice: false, lang: 'en', clientWs: { readyState: 1 } }),
    });
    client.emitTranscript({ direction: 'output', text: 'Ordinary Nova-voiced reply.' });
    client.emitTurnComplete();
    await flushPromises();
    expect(mockSynthesizePolly).not.toHaveBeenCalled();
  });
});
