/** VTID-04738: see the describe block below. */

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
  private audioH: ((e: AudioOutputEvent) => void) | null = null;
  private toolH: ((e: ToolCallEvent) => void) | null = null;

  async connect(_options: UpstreamConnectOptions): Promise<void> { this.state = 'open'; }
  sendAudioChunk(): boolean { return this.state === 'open'; }
  sendTextTurn(): boolean { return this.state === 'open'; }
  sendEndOfTurn(): boolean { return this.state === 'open'; }
  sendToolResult(_result: UpstreamToolResult): boolean { return this.state === 'open'; }
  onAudioOutput(h: (e: AudioOutputEvent) => void): void { this.audioH = h; }
  onTranscript(h: (e: TranscriptEvent) => void): void { this.transcriptH = h; }
  onToolCall(h: (e: ToolCallEvent) => void): void { this.toolH = h; }
  onTurnComplete(h: (e: TurnCompleteEvent) => void): void { this.turnH = h; }
  onInterrupted(_h: (e: InterruptedEvent) => void): void { /* unused in this suite */ }
  onUsage(_h: (e: UpstreamUsageEvent) => void): void { /* unused in this suite */ }
  onError(_h: (e: UpstreamErrorEvent) => void): void { /* unused in this suite */ }
  onClose(_h: (e: UpstreamCloseEvent) => void): void { /* unused in this suite */ }
  async close(): Promise<void> { this.state = 'closed'; }
  getState(): UpstreamConnectionState { return this.state; }

  emitTranscript(e: TranscriptEvent): void { this.transcriptH?.(e); }
  emitTurnComplete(e: TurnCompleteEvent = {}): void { this.turnH?.(e); }
  emitAudio(): void { this.audioH?.({ data: Buffer.alloc(320).toString('base64'), mimeType: 'audio/pcm;rate=16000' } as any); }
  emitToolCall(name: string): void { this.toolH?.({ calls: [{ id: 'call-1', name, args: { query: 'x' } }] } as any); }
}

function makeSession(over: Record<string, unknown> = {}): any {
  return {
    sessionId: 'sess-04738',
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


const flush = () => new Promise((r) => setImmediate(r));
const sentTypes = (deps: any): any[] => (deps.sendWsMessage as jest.Mock).mock.calls.map((c) => c[1]);
const thinkingSent = (deps: any) =>
  sentTypes(deps).filter((m) => m.type === 'thinking' && m.reason === 'tool_answer_pending');

/**
 * VTID-04738 — production live-cbda9130 (2026-09-29): Nova called
 * search_memory and spoke a filler line; the filler's turn_complete made the
 * widget show Listening for 10 s while the answer was still being generated.
 */
describe('VTID-04738: Thinking while the answer to a tool call is pending', () => {
  it('filler line, then turn_complete before the answer: sends thinking after turn_complete', async () => {
    const clientWs = { readyState: 1, send: jest.fn() };
    const session = makeSession({ clientWs, turn_count: 2 });
    const { client, deps } = makeContext({ session });

    client.emitToolCall('search_memory');
    client.emitAudio(); // filler starts before the result
    await flush(); // tool result sent
    client.emitTurnComplete({});

    expect(thinkingSent(deps)).toHaveLength(1);
    // Sent after turn_complete's own messages, as the last thing this turn.
    const last = sentTypes(deps).pop();
    expect(last).toEqual({ type: 'thinking', reason: 'tool_answer_pending' });
    expect(deps.emitDiag).toHaveBeenCalledWith(session, 'tool_answer_pending_thinking', expect.any(Object));
  });

  it('answer spoken after the result: no extra thinking at its turn_complete', async () => {
    const clientWs = { readyState: 1, send: jest.fn() };
    const session = makeSession({ clientWs, turn_count: 2 });
    const { client, deps } = makeContext({ session });

    client.emitToolCall('search_memory');
    await flush();
    client.emitAudio(); // the answer
    client.emitTurnComplete({});

    expect(thinkingSent(deps)).toHaveLength(0);
  });

  it('after the filler, the answer clears it: its own turn_complete sends no thinking', async () => {
    const clientWs = { readyState: 1, send: jest.fn() };
    const session = makeSession({ clientWs, turn_count: 2 });
    const { client, deps } = makeContext({ session });

    client.emitToolCall('search_memory');
    client.emitAudio();
    await flush();
    client.emitTurnComplete({});
    client.emitAudio(); // answer
    client.emitTurnComplete({});

    expect(thinkingSent(deps)).toHaveLength(1);
  });

  it('a turn without a tool call sends no thinking', () => {
    const clientWs = { readyState: 1, send: jest.fn() };
    const session = makeSession({ clientWs, turn_count: 2 });
    const { client, deps } = makeContext({ session });

    client.emitAudio();
    client.emitTurnComplete({});

    expect(thinkingSent(deps)).toHaveLength(0);
  });
});
