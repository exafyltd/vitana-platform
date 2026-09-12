/**
 * VTID-03824 (second follow-up) — the still-here-complaint backstop must
 * actually fire end-to-end through handleTurnComplete, not just classify
 * text correctly in isolation.
 *
 * Real live evidence: a repositioned, correctly-worded "ENDING THE
 * CONVERSATION — OVERRIDES RULE 0" prompt instruction was confirmed
 * present in a real session's rendered system instruction, and the model
 * STILL never called end_conversation across 5 turns of explicit stop
 * requests, including "du bist immer noch da" twice. Prompt compliance
 * alone was not enough, so a deterministic code path was added:
 * handleTurnComplete now inspects the just-completed turn's transcribed
 * user text and, on a still-here complaint, dispatches the exact same
 * `orb_directive: end_conversation` message the TOOL would have sent —
 * reusing the widget's already-built, already-tested close handling with
 * zero client-side changes.
 *
 * Uses the same bindUpstreamSessionHandlers harness as
 * test/routes/orb-live-nova-incident-regressions.test.ts, but wires the
 * REAL detectStillHereComplaint/dispatchEndConversationDirective from
 * orb-live.ts (not mocked) so this proves the actual wiring, not just
 * that a mock was called.
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

describe('VTID-03824: still-here-complaint backstop fires through the real handler wiring', () => {
  it('dispatches end_conversation when the completed turn\'s transcript is a still-here complaint', () => {
    const clientWs = { readyState: 1, send: jest.fn() }; // WebSocket.OPEN = 1
    const session = makeSession({ clientWs });
    const { deps, client } = makeContext({ session });

    client.emitTranscript({ direction: 'input', text: 'du bist immer noch da', isFinal: true });
    client.emitTurnComplete({});

    expect(deps.dispatchEndConversationDirective).toHaveBeenCalledTimes(1);
    expect(deps.dispatchEndConversationDirective).toHaveBeenCalledWith(
      session,
      'still_here_complaint_detected',
    );
    // The real implementation actually sent the directive over the WS —
    // proving this isn't just a mock-called-a-mock loop, but that the
    // widget's existing orb_directive:end_conversation handler will fire.
    expect(clientWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(clientWs.send.mock.calls[0][0]);
    expect(sent).toMatchObject({
      type: 'orb_directive',
      directive: 'end_conversation',
      reason: 'still_here_complaint_detected',
    });
  });

  it('does NOT dispatch on an ambiguous "let\'s talk later" turn (the backstop must not be trigger-happy)', () => {
    const clientWs = { readyState: 1, send: jest.fn() };
    const session = makeSession({ clientWs });
    const { deps, client } = makeContext({ session });

    client.emitTranscript({ direction: 'input', text: 'ich will gerade nicht sprechen lass uns später reden', isFinal: true });
    client.emitTurnComplete({});

    expect(deps.dispatchEndConversationDirective).not.toHaveBeenCalled();
    expect(clientWs.send).not.toHaveBeenCalled();
  });

  it('is idempotent — a second still-here turn in the same session does not double-dispatch', () => {
    const clientWs = { readyState: 1, send: jest.fn() };
    const session = makeSession({ clientWs });
    const { deps, client } = makeContext({ session });

    client.emitTranscript({ direction: 'input', text: 'du bist immer noch da', isFinal: true });
    client.emitTurnComplete({});
    client.emitTranscript({ direction: 'input', text: 'du bist immer noch da', isFinal: true });
    client.emitTurnComplete({});

    expect(deps.dispatchEndConversationDirective).toHaveBeenCalledTimes(1);
  });

  it('does not fire on the greeting turn (matches the existing isGreetingTurn guard for all turn-complete side effects)', () => {
    const clientWs = { readyState: 1, send: jest.fn() };
    // turn_count starts at 0 and greetingTurnIndex 0, so the FIRST completed
    // turn (turn_count becomes 1 inside handleTurnComplete) is the greeting
    // turn — matches isGreetingTurn's own definition elsewhere in this file.
    const session = makeSession({ clientWs, turn_count: 0, greetingSent: true, greetingTurnIndex: 0 });
    const { deps, client } = makeContext({ session });

    client.emitTranscript({ direction: 'input', text: 'du bist immer noch da', isFinal: true });
    client.emitTurnComplete({});

    expect(deps.dispatchEndConversationDirective).not.toHaveBeenCalled();
  });

  it('does not fire when the session is already inactive', () => {
    const clientWs = { readyState: 1, send: jest.fn() };
    const session = makeSession({ clientWs, active: false });
    const { deps, client } = makeContext({ session });

    client.emitTranscript({ direction: 'input', text: 'du bist immer noch da', isFinal: true });
    client.emitTurnComplete({});

    expect(deps.dispatchEndConversationDirective).not.toHaveBeenCalled();
  });
});
