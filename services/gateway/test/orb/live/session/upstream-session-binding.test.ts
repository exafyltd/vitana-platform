/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 2): behavioral tests for
 * `bindUpstreamSessionHandlers` — the provider-neutral session binding —
 * driven through a fake `UpstreamLiveClient`. No vendor payloads anywhere:
 * everything flows as normalized events, which is exactly how Nova (and any
 * future provider) reaches the session layer.
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

  // Test triggers.
  emitAudio(e: AudioOutputEvent): void { this.audioH?.(e); }
  emitTranscript(e: TranscriptEvent): void { this.transcriptH?.(e); }
  emitToolCall(e: ToolCallEvent): void { this.toolH?.(e); }
  emitTurnComplete(e: TurnCompleteEvent = {}): void { this.turnH?.(e); }
  emitInterrupted(e: InterruptedEvent = {}): void { this.interruptedH?.(e); }
  emitUsage(e: UpstreamUsageEvent): void { this.usageH?.(e); }
  emitError(e: UpstreamErrorEvent): void { this.errorH?.(e); }
}

function makeSession(): any {
  return {
    sessionId: 'sess-1',
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
    lang: 'de',
    identity: null,
    isAnonymous: false,
    sseResponse: null,
    clientWs: null,
    navigationDispatched: false,
    pendingNavigation: undefined,
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
  options?: UpstreamSessionHandlerContext['options'];
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
  const ctx: UpstreamSessionHandlerContext = {
    session,
    client,
    callbacks,
    deps,
    options: overrides.options,
  };
  bindUpstreamSessionHandlers(ctx);
  return { session, client, callbacks, deps, ctx };
}

const flushPromises = () => new Promise((r) => setImmediate(r));

describe('bindUpstreamSessionHandlers — normalized session behavior', () => {
  it('forwards audio output to onAudioResponse', () => {
    const { client, callbacks } = makeContext();
    client.emitAudio({ dataB64: 'AQID', mimeType: 'audio/pcm;rate=24000' });
    expect(callbacks.onAudioResponse).toHaveBeenCalledWith('AQID');
  });

  it('gates audio behind navigationDispatched', () => {
    const { session, client, callbacks } = makeContext();
    session.navigationDispatched = true;
    client.emitAudio({ dataB64: 'AQID', mimeType: 'audio/pcm;rate=24000' });
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
  });

  it('marks model speaking + latency on first audio chunk', () => {
    const { session, client, deps } = makeContext();
    client.emitAudio({ dataB64: 'AQID', mimeType: 'audio/pcm;rate=24000' });
    expect(session.isModelSpeaking).toBe(true);
    expect(deps.markVoiceLatency).toHaveBeenCalledWith(session, 'audio_out_first_chunk');
  });

  it('interruption clears the output buffer and notifies the client', () => {
    const { session, client, callbacks, deps } = makeContext();
    session.outputTranscriptBuffer = 'partial answer';
    client.emitInterrupted({});
    expect(session.outputTranscriptBuffer).toBe('');
    expect(session.isModelSpeaking).toBe(false);
    expect(callbacks.onInterrupted).toHaveBeenCalledTimes(1);
    expect(deps.finalizeVoiceTurnLatency).toHaveBeenCalledWith(session, 'error');
  });

  it('executes tool calls and returns results via client.sendToolResult', async () => {
    const { client, deps } = makeContext();
    client.emitToolCall({
      calls: [{ id: 'tool-1', name: 'get_current_screen', args: {} }],
    });
    await flushPromises();
    expect(deps.executeLiveApiTool).toHaveBeenCalledWith(
      expect.anything(),
      'get_current_screen',
      {},
    );
    expect(client.sentToolResults).toEqual([
      expect.objectContaining({
        callId: 'tool-1',
        name: 'get_current_screen',
        success: true,
        output: '{"screen":"journey"}',
      }),
    ]);
  });

  it('a FAILED tool still always returns a model-facing result (Nova stalls otherwise)', async () => {
    const { client } = makeContext({
      deps: {
        executeLiveApiTool: jest.fn().mockRejectedValue(new Error('boom')),
      },
    });
    client.emitToolCall({ calls: [{ id: 't2', name: 'create_task', args: { a: 1 } }] });
    await flushPromises();
    expect(client.sentToolResults).toEqual([
      expect.objectContaining({ callId: 't2', name: 'create_task', success: false, error: 'boom' }),
    ]);
  });

  it('tool loop guard sends synthetic loop-break results for every call', async () => {
    const session = makeSession();
    session.consecutiveToolCalls = 99;
    const { client } = makeContext({ session });
    client.emitToolCall({ calls: [{ id: 'a', name: 'x', args: {} }, { id: 'b', name: 'y', args: {} }] });
    await flushPromises();
    expect(client.sentToolResults).toHaveLength(2);
    for (const r of client.sentToolResults) {
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/Tool loop guard/);
    }
  });

  it('input transcript accumulates, resets loop counters, arms watchdog', () => {
    const { session, client, deps } = makeContext();
    session.consecutiveModelTurns = 3;
    client.emitTranscript({ direction: 'input', text: 'hallo', isFinal: true });
    client.emitTranscript({ direction: 'input', text: 'welt', isFinal: true });
    expect(session.inputTranscriptBuffer).toBe('hallo welt');
    expect(session.consecutiveModelTurns).toBe(0);
    expect(deps.startResponseWatchdog).toHaveBeenCalledWith(session, expect.any(Number), 'response_timeout');
  });

  it('speculative assistant transcript accumulates; FINAL replaces (no double-store)', () => {
    const { session, client } = makeContext();
    client.emitTranscript({ direction: 'output', text: 'Ich ', isFinal: false, generationStage: 'SPECULATIVE' });
    client.emitTranscript({ direction: 'output', text: 'helfe dir', isFinal: false, generationStage: 'SPECULATIVE' });
    expect(session.outputTranscriptBuffer).toBe('Ich helfe dir');
    client.emitTranscript({ direction: 'output', text: 'Ich helfe dir gern.', isFinal: true, generationStage: 'FINAL' });
    expect(session.outputTranscriptBuffer).toBe('Ich helfe dir gern.');
  });

  it('turn complete flushes buffers, bumps counters, notifies onTurnComplete', () => {
    const { session, client, callbacks, deps } = makeContext();
    session.inputTranscriptBuffer = 'wie geht es dir';
    session.outputTranscriptBuffer = 'Mir geht es gut, danke der Nachfrage heute.';
    client.emitTurnComplete({});
    expect(session.turn_count).toBe(1);
    expect(session.inputTranscriptBuffer).toBe('');
    expect(session.outputTranscriptBuffer).toBe('');
    expect(session.transcriptTurns.map((t: any) => t.role)).toEqual(['user', 'assistant']);
    expect(callbacks.onTurnComplete).toHaveBeenCalledTimes(1);
    expect(deps.clearResponseWatchdog).toHaveBeenCalledWith(session);
    expect(deps.finalizeVoiceTurnLatency).toHaveBeenCalledWith(session, 'success');
  });

  it('persona swap at turn complete closes upstream via client.close("persona_swap") only', () => {
    const { session, client } = makeContext();
    session.pendingPersonaSwap = 'devon';
    client.emitTurnComplete({});
    expect(client.closeReasons).toEqual(['persona_swap']);
    expect(session.activePersona).toBe('devon');
    expect(session._personaSwapInFlight).toBe(true);
  });

  it('pending navigation dispatches an orb_directive at turn complete', () => {
    const sendWsMessage = jest.fn();
    const session = makeSession();
    session.clientWs = { readyState: 1 };
    session.pendingNavigation = {
      screen_id: 'journey',
      route: '/journey',
      title: 'Journey',
      reason: 'user_request',
      decision_source: 'model',
      requested_at: Date.now(),
    };
    const { client } = makeContext({ session, deps: { sendWsMessage } });
    client.emitTurnComplete({});
    expect(sendWsMessage).toHaveBeenCalledWith(
      session.clientWs,
      expect.objectContaining({ type: 'orb_directive', directive: 'navigate', screen_id: 'journey' }),
    );
    expect(session.pendingNavigation).toBeUndefined();
  });

  it('usage events are recorded on the session', () => {
    const { session, client } = makeContext();
    client.emitUsage({ totalInputTokens: 100, totalOutputTokens: 250 });
    expect(session.lastUsageTotals).toEqual({ totalInputTokens: 100, totalOutputTokens: 250 });
  });

  it('upstream errors surface as typed Error via onError', () => {
    const { client, callbacks } = makeContext();
    client.emitError({ code: 'nova_throttled', message: 'slow down' });
    expect(callbacks.onError).toHaveBeenCalledWith(expect.any(Error));
    expect((callbacks.onError as jest.Mock).mock.calls[0][0].message).toBe('nova_throttled: slow down');
  });

  it('silence keepalive re-arm only when enableSilenceKeepalive (Nova gets none)', () => {
    jest.useFakeTimers();
    try {
      const armed = makeContext({ options: { enableSilenceKeepalive: true } });
      armed.session.silenceKeepaliveInterval = undefined;
      armed.client.emitTranscript({ direction: 'input', text: 'hi', isFinal: true });
      expect(armed.session.silenceKeepaliveInterval).toBeDefined();
      clearInterval(armed.session.silenceKeepaliveInterval);

      const nova = makeContext({ options: { enableSilenceKeepalive: false } });
      nova.session.silenceKeepaliveInterval = undefined;
      nova.client.emitTranscript({ direction: 'input', text: 'hi', isFinal: true });
      expect(nova.session.silenceKeepaliveInterval).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
