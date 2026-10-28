/**
 * BOOTSTRAP-NOVA-SONIC-VOICE incident regressions (Phase 7, ORB/voice tests).
 *
 * Locks in coverage for the real production incidents fixed by:
 *   2e89a41  silence keepalive + 4096 maxTokens — stops the 15s idle stream death
 *   b745775  silence keepalive must run THROUGH model speech — END_TURN deadlock
 *   b27204f  real-time silence cadence — Nova's endpointer needs a gapless stream
 *   8196055  emit turnComplete on ASSISTANT contentEnd END_TURN
 *   b9acd92  wrap non-object tool outputs — Nova kills the stream on bad toolResult
 *   441ed73  Nova-safe identity lock — unblocks real ORB voice sessions
 *   e95e48e  thread connect-failure diagnostic into the connect_failed OASIS event
 *   684353e  skip Vertex builtin tools + omit empty-audio contentEnd
 *   0c72cfc  stop mislabeling every provider as vertex in voice.latency.measured
 *
 * `src/routes/orb-live.ts` is 15k+ lines; the Nova connect branch, the
 * identity-lock sanitizer call, the connect_failed diagnostic payload, and
 * the provider-labeling stamps all live inside `connectToLiveAPI` — an
 * unexported async function reachable only by driving a full WS session
 * through `initializeOrbWebSocket` (auth, DB-backed bootstrap context,
 * persona/tool-catalog assembly, a real Vertex or Nova upstream connect).
 * That is genuinely un-isolable without a refactor — see this suite's final
 * describe block and the task's final report for the precise breakdown of
 * what is and is not covered here, and why.
 *
 * What IS both isolable and, on inspection, under-tested: the SECOND place
 * `session.silenceKeepaliveInterval` gets (re-)armed. `connectToLiveAPI`'s
 * Nova branch arms it once at connect time via `armUpstreamKeepalive()`
 * (already fully covered by test/orb/live/session/upstream-keepalive.test.ts)
 * — but `src/orb/live/session/upstream-message-handler.ts`'s loop guard
 * (`handleTurnComplete`) CLEARS that same interval when a session's
 * consecutive-model-turn count trips the runaway-loop guard, and
 * `handleTranscript`'s re-arm (on the next user utterance) recreates it.
 * Before this suite, that re-arm path ignored the Nova tuning entirely
 * (no `ignoreModelSpeaking`, Vertex-default cadence) — reproducing the
 * exact b745775/b27204f deadlock for any Nova session that trips the loop
 * guard mid-conversation. Fixed in the same commit as this test (see the
 * task's final report for the exact diff); both `handleTranscript` and
 * `handleTurnComplete` are exported pure(ish) functions, so the fix is
 * covered directly — no WS/DB harness required.
 */

import {
  bindUpstreamSessionHandlers,
  type UpstreamMessageHandlerDeps,
  type UpstreamSessionHandlerContext,
} from '../../src/orb/live/session/upstream-message-handler';
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
} from '../../src/orb/live/upstream/types';

/** Minimal fake implementing the full UpstreamLiveClient contract. */
class FakeUpstreamClient implements UpstreamLiveClient {
  state: UpstreamConnectionState = 'open';
  sentAudio: Array<{ b64: string; mime?: string }> = [];
  sentToolResults: UpstreamToolResult[] = [];
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
  emitToolCall(e: ToolCallEvent): void { this.toolH?.(e); }
  emitTurnComplete(e: TurnCompleteEvent = {}): void { this.turnH?.(e); }
  emitInterrupted(e: InterruptedEvent = {}): void { this.interruptedH?.(e); }
  emitUsage(e: UpstreamUsageEvent): void { this.usageH?.(e); }
  emitError(e: UpstreamErrorEvent): void { this.errorH?.(e); }
}

function makeSession(over: Record<string, unknown> = {}): any {
  return {
    sessionId: 'sess-nova-1',
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
    lang: 'en',
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
 * The exact options object `connectToLiveAPI`'s Nova branch passes to
 * `bindUpstreamSessionHandlers` (orb-live.ts, ~line 7217-7250, comment
 * "Nova NEEDS the synthetic PCM keepalive just like Vertex" / "this
 * loop-guard re-arm path... creates its OWN silenceKeepaliveInterval").
 * Kept in sync by hand — see the task report for why this can't be
 * imported directly (the literal lives inside an unexported function).
 */
const NOVA_KEEPALIVE_OPTIONS: UpstreamSessionHandlerContext['options'] = {
  enableSilenceKeepalive: true,
  ignoreModelSpeaking: true,
  silenceIntervalMs: 250,
  idleThresholdMs: 750,
};

/** Trips the loop guard (default max consecutive model turns = 3) on a
 * non-greeting turn, which clears `session.silenceKeepaliveInterval`. */
function tripLoopGuardAndClearKeepalive(session: any, client: FakeUpstreamClient): void {
  session.silenceKeepaliveInterval = setInterval(() => {}, 999_999); // simulate already-armed
  session.greetingSent = false;
  session.consecutiveModelTurns = 10; // > MAX_CONSECUTIVE_MODEL_TURNS_FALLBACK (3)
  client.emitTurnComplete({});
}

describe('BOOTSTRAP-NOVA-SONIC-VOICE incident b745775/b27204f — loop-guard silence-keepalive re-arm', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('the loop guard actually clears the interval on a runaway non-greeting turn (precondition for every test below)', () => {
    const { session, client } = makeContext({ options: NOVA_KEEPALIVE_OPTIONS });
    expect(session.silenceKeepaliveInterval).toBeUndefined();
    tripLoopGuardAndClearKeepalive(session, client);
    expect(session.silenceKeepaliveInterval).toBeUndefined();
  });

  it('re-arm after the loop guard clears it feeds silence THROUGH model speech for Nova (reverting b745775 breaks this)', () => {
    const { session, client } = makeContext({ options: NOVA_KEEPALIVE_OPTIONS });
    tripLoopGuardAndClearKeepalive(session, client);

    // Next user utterance re-arms the interval.
    client.emitTranscript({ direction: 'input', text: 'still there?', isFinal: true });
    expect(session.silenceKeepaliveInterval).toBeDefined();

    // Model is mid-speech (the exact deadlock precondition: Nova never sent
    // END_TURN yet) and audio has been idle well past the threshold.
    session.isModelSpeaking = true;
    session.lastAudioForwardedTime = Date.now() - 10_000;
    client.sentAudio.length = 0;

    jest.advanceTimersByTime(250);
    expect(client.sentAudio.length).toBeGreaterThan(0);
  });

  it('re-arm after the loop guard clears it pauses during model speech for Vertex (no ignoreModelSpeaking) — no regression to the non-Nova path', () => {
    const { session, client } = makeContext({ options: { enableSilenceKeepalive: true } });
    tripLoopGuardAndClearKeepalive(session, client);

    client.emitTranscript({ direction: 'input', text: 'still there?', isFinal: true });
    expect(session.silenceKeepaliveInterval).toBeDefined();

    session.isModelSpeaking = true;
    session.lastAudioForwardedTime = Date.now() - 10_000;
    client.sentAudio.length = 0;

    // Vertex's default cadence is 3s; even a full 3s tick must NOT send
    // silence while the model is speaking and ignoreModelSpeaking is unset.
    jest.advanceTimersByTime(3_000);
    expect(client.sentAudio).toHaveLength(0);
  });

  it('re-arm after the loop guard clears it uses the configured real-time cadence for Nova, not the 3s Vertex default (reverting b27204f breaks this)', () => {
    const { session, client } = makeContext({ options: NOVA_KEEPALIVE_OPTIONS });
    tripLoopGuardAndClearKeepalive(session, client);
    client.emitTranscript({ direction: 'input', text: 'still there?', isFinal: true });

    session.isModelSpeaking = false;
    session.lastAudioForwardedTime = Date.now() - 10_000;
    client.sentAudio.length = 0;

    // 1s at a 250ms cadence = 4 frames. At the old 3s Vertex cadence this
    // would be 0 frames in the same window.
    jest.advanceTimersByTime(1_000);
    expect(client.sentAudio.length).toBeGreaterThanOrEqual(4);
  });

  it('re-arm after the loop guard clears it respects the configured idle threshold for Nova (750ms), not the 3s Vertex default', () => {
    const { session, client } = makeContext({ options: NOVA_KEEPALIVE_OPTIONS });
    tripLoopGuardAndClearKeepalive(session, client);
    client.emitTranscript({ direction: 'input', text: 'still there?', isFinal: true });

    session.isModelSpeaking = false;
    session.lastAudioForwardedTime = Date.now(); // freshly "forwarded"
    client.sentAudio.length = 0;

    jest.advanceTimersByTime(500); // idle 500ms < 750ms threshold
    expect(client.sentAudio).toHaveLength(0);
    jest.advanceTimersByTime(500); // idle now >= 750ms
    expect(client.sentAudio.length).toBeGreaterThan(0);
  });

  it('re-arm never happens at all when enableSilenceKeepalive is unset, regardless of the other Nova knobs (the option remains a hard gate)', () => {
    const { session, client } = makeContext({
      options: { ignoreModelSpeaking: true, silenceIntervalMs: 250, idleThresholdMs: 750 },
    });
    tripLoopGuardAndClearKeepalive(session, client);
    client.emitTranscript({ direction: 'input', text: 'still there?', isFinal: true });
    expect(session.silenceKeepaliveInterval).toBeUndefined();
  });
});

describe('BOOTSTRAP-NOVA-SONIC-VOICE incident 2e89a41 — Nova gets the silence keepalive gate at all', () => {
  it('Nova-shaped options (enableSilenceKeepalive: true) DO re-arm on the loop-guard path — the old "Nova needs no synthetic keepalive" assumption no longer holds', () => {
    jest.useFakeTimers();
    try {
      const { session, client } = makeContext({ options: NOVA_KEEPALIVE_OPTIONS });
      session.silenceKeepaliveInterval = undefined;
      client.emitTranscript({ direction: 'input', text: 'hi', isFinal: true });
      expect(session.silenceKeepaliveInterval).toBeDefined();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});

/**
 * Incidents NOT covered by an executable test in this file, and why. Every
 * one of these is a genuine `connectToLiveAPI` call-site fix (the ~15k-line
 * unexported async function in orb-live.ts) that requires a full WS session
 * bootstrap (auth, DB-backed context assembly, persona/tool-catalog
 * assembly, an actual Vertex or Nova upstream connect) to exercise — not a
 * pure function reachable from a test file. See the task's final report for
 * the full reasoning and a suggested refactor (extracting the Nova connect
 * plan — armUpstreamKeepalive config, sanitizeInstructionForNova call,
 * connect_failed diagnostic payload — into a small exported/pure function,
 * mirroring how upstream-keepalive.ts, nova-instruction-sanitizer.ts, and
 * nova-sonic-config.ts were already extracted for exactly this reason).
 *
 * This block intentionally contains no assertions — it exists so the gap is
 * visible in the test file itself, not just in a report that can go stale.
 *   - 2e89a41 (connect-time Nova keepalive arm + enableSilenceKeepalive:true
 *     option) — the underlying `armUpstreamKeepalive` mechanics are fully
 *     covered by test/orb/live/session/upstream-keepalive.test.ts; only the
 *     orb-live.ts call-site wiring (which literal options object Nova's
 *     connect branch passes) is unreachable here.
 *   - 441ed73 (sanitizeInstructionForNova wired into the Nova branch only,
 *     nova_instruction_sanitized diag gated on `replaced`) — the sanitizer
 *     itself is fully covered by nova-instruction-sanitizer.test.ts; only
 *     the call site is unreachable.
 *   - e95e48e (connect_failed OASIS payload carries diagnostic /
 *     instruction_chars / tool_entry_count) — assembled entirely inside the
 *     Nova branch's catch block; unreachable without a live (or fully
 *     mocked) failing connect.
 *   - 0c72cfc (session.upstreamProvider stamped from __upstreamDecision;
 *     setProvider() called at both greeting-audio finalize sites before the
 *     turn-0 tracker finalizes) — LatencyTracker.setProvider() itself is
 *     fully covered by latency-tracker.test.ts; only the two orb-live.ts
 *     call sites (SSE handler ~line 13011-13020, WS handler ~14417-14427)
 *     are unreachable.
 *   - 8196055 (ASSISTANT contentEnd END_TURN → turnComplete), b9acd92 (tool
 *     output wrapping), 684353e (skip Vertex builtin tools + omit
 *     empty-audio contentEnd) — these fixes live entirely inside
 *     nova-sonic-protocol.ts / nova-sonic-live-client.ts, BELOW the
 *     UpstreamLiveClient boundary orb-live.ts talks to. They have no
 *     orb-live.ts-specific regression surface at all (orb-live.ts only ever
 *     sees the already-normalized `TurnCompleteEvent` / calls
 *     `client.sendToolResult()` generically) and are already covered by
 *     nova-sonic-protocol.test.ts and nova-sonic-live-client.test.ts.
 */
describe.skip('untestable-without-refactor — see block comment above', () => {
  it('placeholder — intentionally skipped, not a real test', () => {});
});
