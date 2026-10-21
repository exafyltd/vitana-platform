/** VTID-04747: see the describe block below. */

import { softTurnEndMs } from '../../../../src/orb/live/session/soft-turn-end';
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
    sessionId: 'sess-04743',
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



/**
 * VTID-04747 — production live-11ec418b (2026-09-29): Nova's END_TURN for a
 * reply was swallowed, the display stayed on "Vitana spricht" and the 20 s
 * audio-stall watchdog reconnected the session. The session now completes
 * the turn itself once model audio has stopped.
 */
describe('VTID-04747: soft turn end', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.useRealTimers(); delete process.env.ORB_SOFT_TURN_END_MS; });

  const turnCompletes = (deps: any) =>
    (deps.emitDiag as jest.Mock).mock.calls.filter((c) => c[1] === 'turn_complete').length;

  it('completes the turn 2.5 s after the last audio chunk when END_TURN never comes', () => {
    const session = makeSession({ upstreamProvider: 'nova_sonic', turn_count: 2 });
    const { client, deps } = makeContext({ session });
    client.emitAudio();
    client.emitAudio();
    expect(session.isModelSpeaking).toBe(true);
    jest.advanceTimersByTime(2400);
    expect(session.isModelSpeaking).toBe(true);
    jest.advanceTimersByTime(200);
    expect(session.isModelSpeaking).toBe(false);
    expect(deps.emitDiag).toHaveBeenCalledWith(session, 'soft_turn_complete', expect.any(Object));
    expect(turnCompletes(deps)).toBe(1);
  });

  it('each new chunk pushes the deadline out', () => {
    const session = makeSession({ upstreamProvider: 'nova_sonic', turn_count: 2 });
    const { client } = makeContext({ session });
    client.emitAudio();
    jest.advanceTimersByTime(2000);
    client.emitAudio();
    jest.advanceTimersByTime(2000);
    expect(session.isModelSpeaking).toBe(true);
  });

  it('a real END_TURN in time cancels it; no second completion', () => {
    const session = makeSession({ upstreamProvider: 'nova_sonic', turn_count: 2 });
    const { client, deps } = makeContext({ session });
    client.emitAudio();
    client.emitTurnComplete({});
    jest.advanceTimersByTime(5000);
    expect(turnCompletes(deps)).toBe(1);
    expect(deps.emitDiag).not.toHaveBeenCalledWith(session, 'soft_turn_complete', expect.any(Object));
  });

  it('a late real END_TURN after the soft end is ignored (never completes twice)', () => {
    const session = makeSession({ upstreamProvider: 'nova_sonic', turn_count: 2 });
    const { client, deps } = makeContext({ session });
    client.emitAudio();
    jest.advanceTimersByTime(3000);
    client.emitTurnComplete({});
    expect(turnCompletes(deps)).toBe(1);
    expect(deps.emitDiag).toHaveBeenCalledWith(session, 'turn_complete_after_soft_end_ignored');
  });

  it('a new reply after the soft end completes normally', () => {
    const session = makeSession({ upstreamProvider: 'nova_sonic', turn_count: 2 });
    const { client, deps } = makeContext({ session });
    client.emitAudio();
    jest.advanceTimersByTime(3000);
    client.emitAudio();
    client.emitTurnComplete({});
    expect(turnCompletes(deps)).toBe(2);
  });

  it('only Nova sessions; ORB_SOFT_TURN_END_MS=0 turns it off', () => {
    const vertex = makeSession({ upstreamProvider: 'vertex', turn_count: 2 });
    const a = makeContext({ session: vertex });
    a.client.emitAudio();
    jest.advanceTimersByTime(5000);
    expect(vertex.isModelSpeaking).toBe(true);

    process.env.ORB_SOFT_TURN_END_MS = '0';
    const nova = makeSession({ upstreamProvider: 'nova_sonic', turn_count: 2, sessionId: 's2' });
    const b = makeContext({ session: nova });
    b.client.emitAudio();
    jest.advanceTimersByTime(5000);
    expect(nova.isModelSpeaking).toBe(true);
  });

  it('a blank ORB_SOFT_TURN_END_MS keeps the default instead of turning it off', () => {
    process.env.ORB_SOFT_TURN_END_MS = '  ';
    expect(softTurnEndMs()).toBe(2500);
    delete process.env.ORB_SOFT_TURN_END_MS;
    expect(softTurnEndMs()).toBe(2500);
    process.env.ORB_SOFT_TURN_END_MS = 'abc';
    expect(softTurnEndMs()).toBe(2500);
  });
});
