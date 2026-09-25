/**
 * VTID-04592 — close the conversation when the member asked to stop and
 * Vitana's reply agreed, even without an end_conversation tool call.
 *
 * Production session live-6786b50c (2026-09-25 22:39 UTC): nine stop
 * requests, Vitana answered "Ich beende jetzt das Gespräch" each time, zero
 * tool calls, the widget went back to listening. The utterances below are
 * the real ones from that session's input_transcription/turn_complete diags.
 */

import {
  bindUpstreamSessionHandlers,
  type UpstreamMessageHandlerDeps,
  type UpstreamSessionHandlerContext,
} from '../../../../src/orb/live/session/upstream-message-handler';
import {
  detectStillHereComplaint,
  dispatchEndConversationDirective,
} from '../../../../src/routes/orb-live';
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

/** Minimal fake implementing the full UpstreamLiveClient contract — mirrors
 * test/routes/orb-live-nova-incident-regressions.test.ts's FakeUpstreamClient. */
class FakeUpstreamClient implements UpstreamLiveClient {
  state: UpstreamConnectionState = 'open';
  private transcriptH: ((e: TranscriptEvent) => void) | null = null;
  private turnH: ((e: TurnCompleteEvent) => void) | null = null;

  async connect(_options: UpstreamConnectOptions): Promise<void> { this.state = 'open'; }
  sendAudioChunk(): boolean { return this.state === 'open'; }
  sendTextTurn(): boolean { return this.state === 'open'; }
  sendEndOfTurn(): boolean { return this.state === 'open'; }
  sendToolResult(_result: UpstreamToolResult): boolean { return this.state === 'open'; }
  onAudioOutput(_h: (e: AudioOutputEvent) => void): void { /* unused in this suite */ }
  onTranscript(h: (e: TranscriptEvent) => void): void { this.transcriptH = h; }
  onToolCall(_h: (e: ToolCallEvent) => void): void { /* unused in this suite */ }
  onTurnComplete(h: (e: TurnCompleteEvent) => void): void { this.turnH = h; }
  onInterrupted(_h: (e: InterruptedEvent) => void): void { /* unused in this suite */ }
  onUsage(_h: (e: UpstreamUsageEvent) => void): void { /* unused in this suite */ }
  onError(_h: (e: UpstreamErrorEvent) => void): void { /* unused in this suite */ }
  onClose(_h: (e: UpstreamCloseEvent) => void): void { /* unused in this suite */ }
  async close(): Promise<void> { this.state = 'closed'; }
  getState(): UpstreamConnectionState { return this.state; }

  emitTranscript(e: TranscriptEvent): void { this.transcriptH?.(e); }
  emitTurnComplete(e: TurnCompleteEvent = {}): void { this.turnH?.(e); }
}

function makeSession(over: Record<string, unknown> = {}): any {
  return {
    sessionId: 'sess-still-here-1',
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
    lang: 'de',
    identity: null,
    isAnonymous: false,
    sseResponse: null,
    clientWs: null,
    navigationDispatched: false,
    pendingNavigation: undefined,
    ...over,
  };
}

function makeDeps(overrides: Partial<UpstreamMessageHandlerDeps> = {}): UpstreamMessageHandlerDeps {
  return {
    clearResponseWatchdog: jest.fn(),
    detectAuthIntent: jest.fn().mockReturnValue(null),
    // The functions under test — real implementations, not mocks.
    detectStillHereComplaint,
    dispatchEndConversationDirective: jest.fn(dispatchEndConversationDirective),
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

import {
  detectUserStopIntent,
  detectAssistantAgreedToEnd,
  shouldEndConversationAfterTurn,
} from '../../../../src/orb/live/session/end-conversation-intent';

describe('VTID-04592 end-conversation intent', () => {
  it('recognises every stop request from the production session', () => {
    for (const u of [
      'nee du sollst gehen ich will nicht mit dir reden',
      'geh jetzt',
      'du sollst gehen mach zu hör auf',
      'bist du eigentlich doof schalte ab',
      'geh weg',
      'schluss',
      'Schluss.',
    ]) {
      expect({ u, hit: detectUserStopIntent(u) }).toEqual({ u, hit: true });
    }
  });

  it('recognises the replies in which Vitana agreed to stop', () => {
    for (const a of [
      'Ich verstehe, Dragan. Ich schalte mich jetzt ab.',
      'Alles klar, Dragan. Ich beende jetzt das Gespräch. Wir sprechen später weiter.',
      "Okay, I'm ending the conversation now. Talk to you later.",
      'Goodbye!',
    ]) {
      expect({ a, hit: detectAssistantAgreedToEnd(a) }).toEqual({ a, hit: true });
    }
  });

  it('does not treat ordinary talk as a stop request', () => {
    for (const u of [
      'wem folge ich eigentlich in der community',
      'hör auf',
      'stop',
      'lass uns später reden',
      'zeig mir meine nachrichten',
      'was ist der schlussstrich unter dem thema',
      'how do I switch languages',
    ]) {
      expect({ u, hit: detectUserStopIntent(u) }).toEqual({ u, hit: false });
    }
  });

  it('needs both signals: a stop request answered with help, or a farewell without a request, does not close', () => {
    expect(shouldEndConversationAfterTurn('schluss', 'Wie kann ich dir sonst helfen?')).toBe(false);
    expect(shouldEndConversationAfterTurn('zeig mir meine termine', 'Hier sind deine Termine. Bis später!')).toBe(false);
    expect(shouldEndConversationAfterTurn('schluss', 'Alles klar. Ich beende jetzt das Gespräch.')).toBe(true);
  });
});

describe('VTID-04592 backstop fires through the real handler', () => {
  it('sends the end_conversation directive once when the member says "schluss" and Vitana agrees', () => {
    const clientWs = { readyState: 1, send: jest.fn() };
    const session = makeSession({ clientWs });
    const { deps, client } = makeContext({ session });

    client.emitTranscript({ direction: 'input', text: 'schluss', isFinal: true });
    client.emitTranscript({ direction: 'output', text: 'Alles klar, Dragan. Ich beende jetzt das Gespräch. Wir sprechen später weiter.', isFinal: true });
    client.emitTurnComplete({});

    expect(deps.dispatchEndConversationDirective).toHaveBeenCalledTimes(1);
    expect(deps.dispatchEndConversationDirective).toHaveBeenCalledWith(expect.anything(), 'stop_request_acknowledged');
    const sent = clientWs.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
    expect(sent.filter((m: any) => m.type === 'orb_directive' && m.directive === 'end_conversation')).toHaveLength(1);
  });

  it('does not close when the member says stop and Vitana keeps helping', () => {
    const session = makeSession({ clientWs: { readyState: 1, send: jest.fn() } });
    const { deps, client } = makeContext({ session });

    client.emitTranscript({ direction: 'input', text: 'hör auf', isFinal: true });
    client.emitTranscript({ direction: 'output', text: 'Okay, kürzer: Dein nächster Termin ist morgen um neun.', isFinal: true });
    client.emitTurnComplete({});

    expect(deps.dispatchEndConversationDirective).not.toHaveBeenCalled();
  });

  it('the directive is sent at most once per session, whichever path fires first', () => {
    const clientWs = { readyState: 1, send: jest.fn() };
    const session = makeSession({ clientWs });
    dispatchEndConversationDirective(session, 'user_ended_conversation');
    dispatchEndConversationDirective(session, 'stop_request_acknowledged');
    const sent = clientWs.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
    expect(sent.filter((m: any) => m.directive === 'end_conversation')).toHaveLength(1);
  });
});
