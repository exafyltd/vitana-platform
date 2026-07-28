/**
 * Phase 7 (docs/TEST_COVERAGE_PLAN.md) — tests for the RAW upstream Live
 * message handler (`createUpstreamLiveMessageHandler`), i.e. the JSON
 * message parser/dispatcher that runs on every frame received from the
 * Vertex/Gemini Live API WebSocket (`ws.on('message', handler)`).
 *
 * This is the vendor-payload chokepoint the BOOTSTRAP-NOVA-SONIC-VOICE
 * incident history points at (turnComplete on ASSISTANT contentEnd,
 * non-object toolResult killing the stream, malformed audio chunks,
 * etc.) — untested until now.
 *
 * `bindUpstreamSessionHandlers` (the provider-neutral normalized-event
 * half of this same file) already has thorough coverage in
 * `upstream-session-binding.test.ts` and `upstream-provider-parity.test.ts`.
 * This suite deliberately does not re-duplicate that — it targets the
 * OTHER half: `createUpstreamLiveMessageHandler`.
 *
 * Convention follows `upstream-session-binding.test.ts`: a session/deps
 * fixture per test, module-level service dependencies (Supabase, OASIS,
 * identity-intent, extraction-dedup, memory bridge, turn buffers) mocked
 * so the suite is hermetic and never touches the network — matching how
 * `getSupabase()` returning `null` short-circuits every Supabase-gated
 * branch in the source (wake-cadence, chat-bridge, greeting-facts-ledger).
 */

import WebSocket from 'ws';
import {
  createUpstreamLiveMessageHandler,
  type UpstreamMessageHandlerContext,
  type UpstreamMessageHandlerDeps,
} from '../../../../src/orb/live/session/upstream-message-handler';
import { emitOasisEvent } from '../../../../src/services/oasis-event-service';
import { handleIdentityIntent } from '../../../../src/services/identity-intent-handler';
import { deduplicatedExtract } from '../../../../src/services/extraction-dedup-manager';
import { writeMemoryItemWithIdentity } from '../../../../src/services/orb-memory-bridge';
import { addTurn as addSessionTurn } from '../../../../src/services/session-memory-buffer';
import { addTurnRedis } from '../../../../src/services/redis-turn-buffer';
import { getSupabase } from '../../../../src/lib/supabase';

jest.mock('../../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../../../src/services/identity-intent-handler', () => ({
  handleIdentityIntent: jest.fn().mockResolvedValue({ handled: false }),
}));
jest.mock('../../../../src/services/extraction-dedup-manager', () => ({
  deduplicatedExtract: jest.fn(),
}));
jest.mock('../../../../src/services/orb-memory-bridge', () => ({
  writeMemoryItemWithIdentity: jest.fn().mockResolvedValue(undefined),
  DEV_IDENTITY: { USER_ID: 'dev-user-id', TENANT_ID: 'dev-tenant-id' },
}));
jest.mock('../../../../src/services/session-memory-buffer', () => ({
  addTurn: jest.fn(),
}));
jest.mock('../../../../src/services/redis-turn-buffer', () => ({
  addTurnRedis: jest.fn().mockResolvedValue(undefined),
}));
// getSupabase() -> null short-circuits every Supabase-gated fire-and-forget
// branch (wake-cadence signals, chat_messages bridge, greeting-facts-ledger)
// so those best-effort side channels stay out of scope for this suite,
// which targets the message-dispatch contract itself.
jest.mock('../../../../src/lib/supabase', () => ({
  getSupabase: jest.fn().mockReturnValue(null),
}));

const mockEmitOasisEvent = emitOasisEvent as jest.MockedFunction<typeof emitOasisEvent>;
const mockHandleIdentityIntent = handleIdentityIntent as jest.MockedFunction<typeof handleIdentityIntent>;
const mockDeduplicatedExtract = deduplicatedExtract as jest.MockedFunction<typeof deduplicatedExtract>;
const mockWriteMemoryItemWithIdentity = writeMemoryItemWithIdentity as jest.MockedFunction<typeof writeMemoryItemWithIdentity>;
const mockAddSessionTurn = addSessionTurn as jest.MockedFunction<typeof addSessionTurn>;
const mockAddTurnRedis = addTurnRedis as jest.MockedFunction<typeof addTurnRedis>;
const mockGetSupabase = getSupabase as jest.MockedFunction<typeof getSupabase>;

const flush = () => new Promise((r) => setImmediate(r));

function makeSse() {
  const events: any[] = [];
  return {
    events,
    write: jest.fn((raw: string) => {
      const m = raw.match(/^data: (.*)\n\n$/s);
      if (m) events.push(JSON.parse(m[1]));
      return true;
    }),
    writableEnded: false,
  };
}

function makeWs(readyState: number = WebSocket.OPEN) {
  return {
    readyState,
    ping: jest.fn(),
    close: jest.fn(),
  } as any;
}

function makeSession(overrides: Record<string, unknown> = {}): any {
  return {
    sessionId: 'sess-raw-1',
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
    upstreamWs: undefined,
    conversation_id: 'conv-1',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<UpstreamMessageHandlerDeps> = {}): UpstreamMessageHandlerDeps {
  return {
    clearResponseWatchdog: jest.fn(),
    detectAuthIntent: jest.fn().mockReturnValue(null),
    emitDiag: jest.fn(),
    emitLiveSessionEvent: jest.fn().mockResolvedValue(undefined),
    executeLiveApiTool: jest.fn().mockResolvedValue({ success: true, result: 'ok' }),
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

function makeHandler(opts: {
  session?: any;
  ws?: any;
  deps?: Partial<UpstreamMessageHandlerDeps>;
} = {}) {
  const session = opts.session ?? makeSession();
  const ws = opts.ws ?? makeWs();
  const deps = makeDeps(opts.deps);
  const callbacks = {
    onAudioResponse: jest.fn(),
    onTextResponse: jest.fn(),
    onError: jest.fn(),
    onTurnComplete: jest.fn(),
    onInterrupted: jest.fn(),
  };
  const onSetupComplete = jest.fn();
  const isSetupComplete = jest.fn().mockReturnValue(false);
  const ctx: UpstreamMessageHandlerContext = {
    session,
    ws,
    callbacks,
    onSetupComplete,
    isSetupComplete,
    deps,
  };
  const handler = createUpstreamLiveMessageHandler(ctx);
  const send = (payload: unknown) => handler(JSON.stringify(payload));
  const sendRaw = (raw: WebSocket.Data) => handler(raw);
  return { session, ws, deps, callbacks, handler, send, sendRaw, onSetupComplete };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmitOasisEvent.mockResolvedValue({ ok: true });
  mockHandleIdentityIntent.mockResolvedValue({ handled: false } as any);
  mockWriteMemoryItemWithIdentity.mockResolvedValue(undefined as any);
  mockAddTurnRedis.mockResolvedValue(undefined as any);
  mockGetSupabase.mockReturnValue(null as any);
});

// ---------------------------------------------------------------------------
// Malformed / unparseable input — the adversarial surface. Every one of
// these must be swallowed by the outer try/catch: no throw escapes the
// handler, and no callback fires on garbage.
// ---------------------------------------------------------------------------
describe('malformed upstream payloads', () => {
  it('non-JSON text does not throw and triggers no callback', () => {
    const { sendRaw, callbacks } = makeHandler();
    expect(() => sendRaw('not json at all {{{')).not.toThrow();
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    expect(callbacks.onTextResponse).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it('JSON "null" (Object.keys(null) throws) is swallowed, not crashed', () => {
    const { sendRaw, callbacks } = makeHandler();
    expect(() => sendRaw('null')).not.toThrow();
    expect(callbacks.onTurnComplete).not.toHaveBeenCalled();
  });

  it('a bare JSON number/string payload is ignored without crashing', () => {
    const { send, callbacks } = makeHandler();
    expect(() => send(42 as any)).not.toThrow();
    expect(() => send('just a string' as any)).not.toThrow();
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
  });

  it('an empty object matches no branch and is silently ignored', () => {
    const { send, callbacks, deps } = makeHandler();
    send({});
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    expect(callbacks.onTextResponse).not.toHaveBeenCalled();
    expect(callbacks.onTurnComplete).not.toHaveBeenCalled();
    expect(deps.executeLiveApiTool).not.toHaveBeenCalled();
  });

  it('an unrecognized top-level key is ignored (unknown message type)', () => {
    const { send, callbacks } = makeHandler();
    send({ some_future_field: { x: 1 } });
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    expect(callbacks.onTextResponse).not.toHaveBeenCalled();
  });

  it('accepts a Buffer (real ws.on("message") shape), not just a string', () => {
    // Uses `interrupted` (not `setup_complete`) deliberately: setup_complete
    // arms real (non-fake-timer) intervals on `ctx.ws` that would leak past
    // this test — that behavior is covered under fake timers in the
    // `setup_complete` describe block below.
    const { sendRaw, callbacks } = makeHandler();
    sendRaw(Buffer.from(JSON.stringify({ server_content: { interrupted: true } })));
    expect(callbacks.onInterrupted).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// setup_complete
// ---------------------------------------------------------------------------
describe('setup_complete', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('snake_case setup_complete triggers ctx.onSetupComplete and returns (no other branch runs)', () => {
    const { send, onSetupComplete, callbacks } = makeHandler();
    send({ setup_complete: true, server_content: { turn_complete: true } });
    expect(onSetupComplete).toHaveBeenCalledTimes(1);
    // turn_complete in the SAME payload must not also fire — setup_complete
    // returns immediately.
    expect(callbacks.onTurnComplete).not.toHaveBeenCalled();
  });

  it('camelCase setupComplete is recognized identically', () => {
    const { send, onSetupComplete } = makeHandler();
    send({ setupComplete: true });
    expect(onSetupComplete).toHaveBeenCalledTimes(1);
  });

  it('arms a 25s upstream ping interval that calls ws.ping() while OPEN', () => {
    const { send, ws } = makeHandler();
    send({ setup_complete: true });
    jest.advanceTimersByTime(25_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(25_000);
    expect(ws.ping).toHaveBeenCalledTimes(2);
  });

  it('does not ping once the socket is no longer OPEN', () => {
    const ws = makeWs(WebSocket.CLOSING);
    const { send } = makeHandler({ ws });
    send({ setup_complete: true });
    jest.advanceTimersByTime(50_000);
    expect(ws.ping).not.toHaveBeenCalled();
  });

  it('arms the silence keepalive: idle + model-not-speaking feeds a silence frame via deps.sendAudioToLiveAPI', () => {
    const session = makeSession({ lastAudioForwardedTime: Date.now() - 10_000, isModelSpeaking: false });
    const { send, deps, ws } = makeHandler({ session });
    send({ setup_complete: true });
    jest.advanceTimersByTime(3_000);
    expect(deps.sendAudioToLiveAPI).toHaveBeenCalledWith(ws, expect.any(String), 'audio/pcm;rate=16000');
  });

  it('silence keepalive does NOT fire while the model is speaking', () => {
    const session = makeSession({ lastAudioForwardedTime: Date.now() - 10_000, isModelSpeaking: true });
    const { send, deps } = makeHandler({ session });
    send({ setup_complete: true });
    jest.advanceTimersByTime(6_000);
    expect(deps.sendAudioToLiveAPI).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// server_content.interrupted
// ---------------------------------------------------------------------------
describe('server_content — interrupted', () => {
  it('snake_case interrupted clears buffers, calls onInterrupted, writes SSE, finalizes latency as error', () => {
    const sse = makeSse();
    const session = makeSession({ sseResponse: sse, outputTranscriptBuffer: 'partial', pendingEventLinks: [{ title: 't', url: 'u' }] });
    const { send, callbacks, deps } = makeHandler({ session });
    send({ server_content: { interrupted: true } });
    expect(session.outputTranscriptBuffer).toBe('');
    expect(session.pendingEventLinks).toEqual([]);
    expect(session.isModelSpeaking).toBe(false);
    expect(callbacks.onInterrupted).toHaveBeenCalledTimes(1);
    expect(deps.finalizeVoiceTurnLatency).toHaveBeenCalledWith(session, 'error');
    expect(sse.events).toEqual([{ type: 'interrupted' }]);
  });

  it('camelCase serverContent.interrupted is recognized identically', () => {
    const { send, callbacks } = makeHandler();
    send({ serverContent: { interrupted: true } });
    expect(callbacks.onInterrupted).toHaveBeenCalledTimes(1);
  });

  it('grounding_metadata.interrupted (nested alt path) also triggers interruption', () => {
    const { send, callbacks } = makeHandler();
    send({ server_content: { grounding_metadata: { interrupted: true } } });
    expect(callbacks.onInterrupted).toHaveBeenCalledTimes(1);
  });

  it('returns immediately — turn_complete in the same content object never also fires', () => {
    const { send, callbacks } = makeHandler();
    send({ server_content: { interrupted: true, turn_complete: true } });
    expect(callbacks.onInterrupted).toHaveBeenCalledTimes(1);
    expect(callbacks.onTurnComplete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// server_content.turn_complete — the historically incident-prone branch
// (BOOTSTRAP-NOVA-SONIC-VOICE: turnComplete on ASSISTANT contentEnd).
// ---------------------------------------------------------------------------
describe('server_content — turn_complete', () => {
  it('snake_case turn_complete: clears watchdog, ungates mic, bumps counters, fires onTurnComplete', () => {
    const sse = makeSse();
    const session = makeSession({ sseResponse: sse, isModelSpeaking: true });
    const { send, callbacks, deps } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    expect(deps.clearResponseWatchdog).toHaveBeenCalledWith(session);
    expect(session.isModelSpeaking).toBe(false);
    expect(session.turn_count).toBe(1);
    expect(session.consecutiveModelTurns).toBe(1);
    expect(callbacks.onTurnComplete).toHaveBeenCalledTimes(1);
    expect(deps.finalizeVoiceTurnLatency).toHaveBeenCalledWith(session, 'success');
    expect(sse.events).toContainEqual(expect.objectContaining({ type: 'turn_complete', is_greeting: false }));
  });

  it('camelCase turnComplete is recognized identically', () => {
    const { send, callbacks } = makeHandler();
    send({ server_content: { turnComplete: true } });
    expect(callbacks.onTurnComplete).toHaveBeenCalledTimes(1);
  });

  it('flushes accumulated input/output transcript buffers into transcriptTurns and clears them', () => {
    const session = makeSession({
      inputTranscriptBuffer: 'wie geht es dir',
      outputTranscriptBuffer: 'mir geht es gut',
    });
    const { send } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    expect(session.inputTranscriptBuffer).toBe('');
    expect(session.outputTranscriptBuffer).toBe('');
    expect(session.transcriptTurns.map((t: any) => [t.role, t.text])).toEqual([
      ['user', 'wie geht es dir'],
      ['assistant', 'mir geht es gut'],
    ]);
  });

  it('greeting turn (turn 1 immediately after greetingSent) skips the user-text write/push entirely', () => {
    const session = makeSession({
      greetingSent: true,
      greetingTurnIndex: 0,
      turn_count: 0,
      inputTranscriptBuffer: 'greeting prompt text',
      outputTranscriptBuffer: 'Hello there!',
      identity: { user_id: 'u1', tenant_id: 't1' },
    });
    const { send } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    // turn_count becomes 1 === greetingTurnIndex(0)+1 -> isGreetingTurn true.
    expect(session.transcriptTurns.map((t: any) => t.role)).toEqual(['assistant']);
    expect(mockWriteMemoryItemWithIdentity).not.toHaveBeenCalled();
  });

  it('writes the user transcript to memory_items when identity is present and text is long enough', async () => {
    const session = makeSession({
      identity: { user_id: 'u1', tenant_id: 't1' },
      inputTranscriptBuffer: 'this is a sufficiently long user utterance to persist',
    });
    const { send } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    await flush();
    expect(mockWriteMemoryItemWithIdentity).toHaveBeenCalledWith(
      { user_id: 'u1', tenant_id: 't1' },
      expect.objectContaining({ source: 'orb_voice', content: expect.stringContaining('sufficiently long') }),
    );
    expect(mockAddSessionTurn).toHaveBeenCalledWith('sess-raw-1', 't1', 'u1', 'user', expect.any(String));
    expect(mockAddTurnRedis).toHaveBeenCalledWith('sess-raw-1', 't1', 'u1', 'user', expect.any(String));
  });

  it('falls back to DEV_IDENTITY in dev-sandbox mode when no session identity is set', async () => {
    const session = makeSession({
      identity: null,
      inputTranscriptBuffer: 'a long enough dev-sandbox utterance right here',
    });
    const { send } = makeHandler({ session, deps: { isDevSandbox: jest.fn().mockReturnValue(true) } });
    send({ server_content: { turn_complete: true } });
    await flush();
    expect(mockWriteMemoryItemWithIdentity).toHaveBeenCalledWith(
      { user_id: 'dev-user-id', tenant_id: 'dev-tenant-id' },
      expect.anything(),
    );
  });

  it('does NOT write short (<=20 char) user transcripts to memory', async () => {
    const session = makeSession({
      identity: { user_id: 'u1', tenant_id: 't1' },
      inputTranscriptBuffer: 'short',
    });
    const { send } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    await flush();
    expect(mockWriteMemoryItemWithIdentity).not.toHaveBeenCalled();
  });

  it('closes the upstream WS for a pending persona swap and flags the session', () => {
    const upstreamWs = { close: jest.fn() };
    const session = makeSession({ pendingPersonaSwap: 'devon', upstreamWs, active: true });
    const { send } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    expect(upstreamWs.close).toHaveBeenCalledWith(1000, 'persona_swap');
    expect(session.activePersona).toBe('devon');
    expect(session.pendingPersonaSwap).toBeNull();
    expect(session._personaSwapInFlight).toBe(true);
  });

  it('does not close upstream for a pending swap when there is no upstreamWs', () => {
    const session = makeSession({ pendingPersonaSwap: 'devon', upstreamWs: undefined, active: true });
    const { send } = makeHandler({ session });
    expect(() => send({ server_content: { turn_complete: true } })).not.toThrow();
    // Swap application itself is gated on `session.upstreamWs && session.active`.
    expect(session.pendingPersonaSwap).toBe('devon');
  });

  it('anonymous session hits the hard turn-limit (>8) and sends session_limit_reached', () => {
    const sendWsMessage = jest.fn();
    const sse = makeSse();
    const clientWs = { readyState: WebSocket.OPEN };
    const session = makeSession({ isAnonymous: true, turn_count: 8, sseResponse: sse, clientWs });
    const { send } = makeHandler({ session, deps: { sendWsMessage } });
    send({ server_content: { turn_complete: true } });
    expect(sse.events).toContainEqual(expect.objectContaining({ type: 'session_limit_reached', reason: 'turn_limit' }));
    expect(sendWsMessage).toHaveBeenCalledWith(clientWs, expect.objectContaining({ type: 'session_limit_reached' }));
  });

  it('anonymous session with detected login intent redirects to the signin tab', () => {
    const sse = makeSse();
    const session = makeSession({
      isAnonymous: true,
      inputTranscriptBuffer: 'I want to log in please',
      sseResponse: sse,
    });
    const { send } = makeHandler({
      session,
      deps: { detectAuthIntent: jest.fn().mockReturnValue('login') },
    });
    send({ server_content: { turn_complete: true } });
    expect(sse.events).toContainEqual(
      expect.objectContaining({ type: 'session_limit_reached', reason: 'login_intent', redirect: '/maxina?tab=signin' }),
    );
  });

  it('anonymous session with detected signup intent redirects to the signup tab', () => {
    const sse = makeSse();
    const session = makeSession({
      isAnonymous: true,
      inputTranscriptBuffer: 'sign me up',
      sseResponse: sse,
    });
    const { send } = makeHandler({
      session,
      deps: { detectAuthIntent: jest.fn().mockReturnValue('signup') },
    });
    send({ server_content: { turn_complete: true } });
    expect(sse.events).toContainEqual(
      expect.objectContaining({ type: 'session_limit_reached', reason: 'signup_intent', redirect: '/maxina?tab=signup' }),
    );
  });

  it('pauses the silence keepalive after exceeding the consecutive-model-turn loop guard', () => {
    const fakeInterval = setInterval(() => {}, 60_000);
    const session = makeSession({ consecutiveModelTurns: 5, silenceKeepaliveInterval: fakeInterval });
    const { send } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    expect(session.silenceKeepaliveInterval).toBeUndefined();
    clearInterval(fakeInterval);
  });

  it('dispatches a pending navigation directive AFTER turn bookkeeping, then clears it', () => {
    const sse = makeSse();
    const sendWsMessage = jest.fn();
    const clientWs = { readyState: WebSocket.OPEN };
    const session = makeSession({
      sseResponse: sse,
      clientWs,
      pendingNavigation: {
        screen_id: 'journey',
        route: '/journey',
        title: 'Journey',
        reason: 'user_request',
        decision_source: 'model',
        requested_at: Date.now(),
      },
    });
    const { send } = makeHandler({ session, deps: { sendWsMessage } });
    send({ server_content: { turn_complete: true } });
    expect(sse.events).toContainEqual(
      expect.objectContaining({ type: 'orb_directive', directive: 'navigate', screen_id: 'journey' }),
    );
    expect(sendWsMessage).toHaveBeenCalledWith(clientWs, expect.objectContaining({ screen_id: 'journey' }));
    expect(session.pendingNavigation).toBeUndefined();
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'orb.navigator.dispatched' }),
    );
  });

  it('with no pending navigation, no orb_directive is dispatched', () => {
    const sse = makeSse();
    const session = makeSession({ sseResponse: sse, pendingNavigation: undefined });
    const { send } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    expect(sse.events).not.toContainEqual(expect.objectContaining({ type: 'orb_directive' }));
  });

  it('injects pending event links into the output transcript before flushing to memory', () => {
    const sse = makeSse();
    const session = makeSession({
      sseResponse: sse,
      outputTranscriptBuffer: 'Here is the concert you asked about',
      pendingEventLinks: [{ title: 'Concert Night', url: 'https://example.com/e1' }],
    });
    const { send } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    const transcriptEvents = sse.events.filter((e: any) => e.type === 'output_transcript');
    expect(transcriptEvents.some((e: any) => e.text.includes('https://example.com/e1'))).toBe(true);
    expect(session.pendingEventLinks).toEqual([]);
  });

  it('a suppressed (duplicate) turn logs emitDiag and does NOT add to recentAssistantTexts', () => {
    const session = makeSession({
      outputTranscriptBuffer: 'this is a repeated greeting line spoken again',
      suppressCurrentTurnAudio: true,
      currentTurnAudioChunksDropped: 7,
    });
    const { send, deps } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    expect(deps.emitDiag).toHaveBeenCalledWith(
      session,
      'duplicate_turn_suppressed_at_complete',
      expect.objectContaining({ dropped_chunks: 7 }),
    );
    expect(session.recentAssistantTexts).toBeUndefined();
    expect(session.suppressCurrentTurnAudio).toBe(false);
    expect(session.currentTurnAudioChunksDropped).toBe(0);
  });

  it('a normal (non-suppressed) turn >=30 chars is recorded into recentAssistantTexts (capped at 3)', () => {
    const session = makeSession({
      outputTranscriptBuffer: 'a sufficiently long assistant reply text',
      recentAssistantTexts: ['one', 'two', 'three'],
    });
    const { send } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    expect(session.recentAssistantTexts).toHaveLength(3);
    expect(session.recentAssistantTexts[2]).toBe('a sufficiently long assistant reply text');
  });

  it('VTID-01953: an identity-mutation intent handled by handleIdentityIntent pushes an identity_redirect SSE/WS event', async () => {
    mockHandleIdentityIntent.mockResolvedValueOnce({
      handled: true,
      detected_fact_key: 'user_name',
      detected_pattern: 'change my name to',
      redirect_target: '/profile/edit',
    } as any);
    const sse = makeSse();
    const sendWsMessage = jest.fn();
    const clientWs = { readyState: WebSocket.OPEN };
    const session = makeSession({
      identity: { user_id: 'u1', tenant_id: 't1' },
      inputTranscriptBuffer: 'please change my name to Alex now',
      sseResponse: sse,
      clientWs,
    });
    const { send } = makeHandler({ session, deps: { sendWsMessage } });
    send({ server_content: { turn_complete: true } });
    await flush();
    expect(mockHandleIdentityIntent).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', tenant_id: 't1', source: 'orb-live' }),
    );
    expect(sse.events).toContainEqual(
      expect.objectContaining({ type: 'identity_redirect', redirect_target: '/profile/edit', fact_key: 'user_name' }),
    );
    expect(sendWsMessage).toHaveBeenCalledWith(clientWs, expect.objectContaining({ type: 'identity_redirect' }));
  });

  it('VTID-01953: an UNhandled identity-intent result pushes nothing', async () => {
    mockHandleIdentityIntent.mockResolvedValueOnce({ handled: false } as any);
    const sse = makeSse();
    const session = makeSession({
      identity: { user_id: 'u1', tenant_id: 't1' },
      inputTranscriptBuffer: 'just a normal sentence about my day',
      sseResponse: sse,
    });
    const { send } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    await flush();
    expect(sse.events).not.toContainEqual(expect.objectContaining({ type: 'identity_redirect' }));
  });

  it('VTID-02670: an impersonation utterance from a different persona than active flips identityDriftCount + emits an OASIS drift event', () => {
    const session = makeSession({
      outputTranscriptBuffer: "Hi, I'm Devon, how can I help you today with your bug?",
      activePersona: 'vitana',
    });
    const { send } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    expect(session.identityDriftCount).toBe(1);
  });

  it('VTID-02670: a SECOND consecutive impersonation forces a hard reconnect (upstreamWs.close)', () => {
    const upstreamWs = { close: jest.fn() };
    const session = makeSession({
      outputTranscriptBuffer: "Hi, I'm Devon, ready to help.",
      activePersona: 'vitana',
      identityDriftCount: 1, // one prior offense already recorded
      upstreamWs,
    });
    const { send } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    expect(session.identityDriftCount).toBe(2);
    expect(session._personaSwapInFlight).toBe(true);
    expect(upstreamWs.close).toHaveBeenCalled();
  });

  it('VTID-02670: the assistant speaking IN its own active persona name is not flagged as drift', () => {
    const session = makeSession({
      outputTranscriptBuffer: "Hi, I'm Vitana, happy to help!",
      activePersona: 'vitana',
    });
    const { send } = makeHandler({ session });
    send({ server_content: { turn_complete: true } });
    expect(session.identityDriftCount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// server_content.model_turn — audio chunks (inline_data)
// ---------------------------------------------------------------------------
describe('server_content — model_turn audio (inline_data)', () => {
  it('forwards a valid audio chunk to onAudioResponse and starts the audio_stall watchdog', () => {
    const { send, callbacks, deps } = makeHandler();
    send({
      server_content: {
        model_turn: { parts: [{ inline_data: { mime_type: 'audio/pcm;rate=24000', data: 'AQIDBA==' } }] },
      },
    });
    expect(callbacks.onAudioResponse).toHaveBeenCalledWith('AQIDBA==');
    expect(deps.startResponseWatchdog).toHaveBeenCalledWith(expect.anything(), expect.any(Number), 'audio_stall');
  });

  it('camelCase modelTurn/inlineData/mimeType is recognized identically', () => {
    const { send, callbacks } = makeHandler();
    send({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'ZZZZ' } }] },
      },
    });
    expect(callbacks.onAudioResponse).toHaveBeenCalledWith('ZZZZ');
  });

  it('marks isModelSpeaking + fires markVoiceLatency/emitDiag exactly once on the FIRST chunk of a turn', () => {
    const session = makeSession({ isModelSpeaking: false });
    const { send, deps } = makeHandler({ session });
    const msg = { server_content: { model_turn: { parts: [{ inline_data: { mime_type: 'audio/pcm', data: 'AA==' } }] } } };
    send(msg);
    expect(session.isModelSpeaking).toBe(true);
    expect(deps.markVoiceLatency).toHaveBeenCalledWith(session, 'audio_out_first_chunk');
    expect(deps.emitDiag).toHaveBeenCalledWith(session, 'model_start_speaking');
    (deps.markVoiceLatency as jest.Mock).mockClear();
    send(msg); // second chunk, already speaking
    expect(deps.markVoiceLatency).not.toHaveBeenCalled();
  });

  it('drops audio chunks once navigationDispatched (post-nav Turn 2 must not overlap the transition line)', () => {
    const session = makeSession({ navigationDispatched: true });
    const { send, callbacks } = makeHandler({ session });
    send({ server_content: { model_turn: { parts: [{ inline_data: { mime_type: 'audio/pcm', data: 'AA==' } }] } } });
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    expect(session.audioOutChunks).toBe(1);
  });

  it('drops audio chunks while suppressCurrentTurnAudio is set (duplicate-turn suppression)', () => {
    const session = makeSession({ suppressCurrentTurnAudio: true, isModelSpeaking: true });
    const { send, callbacks } = makeHandler({ session });
    send({ server_content: { model_turn: { parts: [{ inline_data: { mime_type: 'audio/pcm', data: 'AA==' } }] } } });
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    expect(session.currentTurnAudioChunksDropped).toBe(1);
  });

  it('a non-audio mime type is not treated as an audio chunk', () => {
    const { send, callbacks } = makeHandler();
    send({ server_content: { model_turn: { parts: [{ inline_data: { mime_type: 'image/png', data: 'AA==' } }] } } });
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
  });

  it('modelTurn with no parts array does not crash and forwards nothing', () => {
    const { send, callbacks } = makeHandler();
    expect(() => send({ server_content: { model_turn: {} } })).not.toThrow();
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
  });

  it('modelTurn.parts that is not an array is swallowed by the outer catch, not thrown', () => {
    const { send, callbacks } = makeHandler();
    expect(() => send({ server_content: { model_turn: { parts: { not: 'an array' } } } })).not.toThrow();
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
  });

  it('[latent bug — flagged, not fixed] inline_data missing `data` throws internally on the FIRST chunk; the outer catch swallows it and drops the chunk instead of forwarding `undefined`', () => {
    // session.audioOutChunks starts at 0 -> becomes 1 -> `1 % 50 === 1` -> the
    // debug log line does `audioB64.length` where audioB64 is `inlineData.data`
    // = undefined, which throws a TypeError. It's caught by the handler's
    // outer try/catch (so the process never crashes), but the side effect is
    // that the chunk is silently dropped mid-processing AFTER isModelSpeaking
    // has already flipped true and watchdog/latency marks already fired —
    // an inconsistent partial-application of one "message". A real upstream
    // sending an audio part without `data` (any malformed/truncated frame)
    // would produce exactly this: gated mic + no audio delivered, silently.
    const session = makeSession();
    const { send, callbacks, deps } = makeHandler({ session });
    expect(() =>
      send({ server_content: { model_turn: { parts: [{ inline_data: { mime_type: 'audio/pcm' } }] } } }),
    ).not.toThrow();
    expect(session.isModelSpeaking).toBe(true); // already flipped before the throw
    expect(deps.markVoiceLatency).toHaveBeenCalled(); // already fired before the throw
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled(); // never reached
  });

  it('multiple parts (audio + text) in one modelTurn both dispatch', () => {
    const { send, callbacks } = makeHandler();
    send({
      server_content: {
        model_turn: {
          parts: [
            { inline_data: { mime_type: 'audio/pcm', data: 'AA==' } },
            { text: 'hello there' },
          ],
        },
      },
    });
    expect(callbacks.onAudioResponse).toHaveBeenCalledWith('AA==');
    expect(callbacks.onTextResponse).toHaveBeenCalledWith('hello there');
  });

  it('BOOTSTRAP-ORB-HOTFIX-1: emits the pre-greeting latency gauge on the very first audio chunk after a sent greeting', () => {
    const session = makeSession({ greetingSent: true, turn_count: 0, audioOutChunks: 0 });
    const { send, deps } = makeHandler({ session });
    send({ server_content: { model_turn: { parts: [{ inline_data: { mime_type: 'audio/pcm', data: 'AA==' } }] } } });
    expect(deps.emitLiveSessionEvent).toHaveBeenCalledWith(
      'orb.live.greeting.delivered',
      expect.objectContaining({ session_id: session.sessionId }),
    );
  });

  it('BOOTSTRAP-ORB-HOTFIX-1: does NOT emit the pre-greeting gauge on a non-greeting first chunk', () => {
    const session = makeSession({ greetingSent: false, turn_count: 0, audioOutChunks: 0 });
    const { send, deps } = makeHandler({ session });
    send({ server_content: { model_turn: { parts: [{ inline_data: { mime_type: 'audio/pcm', data: 'AA==' } }] } } });
    expect(deps.emitLiveSessionEvent).not.toHaveBeenCalledWith(
      'orb.live.greeting.delivered',
      expect.anything(),
    );
  });

  it('BOOTSTRAP-ORB-GREETING-REEMIT: suppresses an unsolicited opener re-emit (greeting sent, turn>=1, user never spoke)', () => {
    const session = makeSession({
      greetingSent: true,
      turn_count: 1,
      consecutiveModelTurns: 1,
      inputTranscriptBuffer: '',
      isModelSpeaking: false,
    });
    const { send, deps } = makeHandler({ session });
    send({ server_content: { model_turn: { parts: [{ inline_data: { mime_type: 'audio/pcm', data: 'AA==' } }] } } });
    expect(session.suppressCurrentTurnAudio).toBe(true);
    expect(deps.emitDiag).toHaveBeenCalledWith(
      session,
      'greeting_reemit_suppressed',
      expect.objectContaining({ turn_count: 1, consecutive_model_turns: 1 }),
    );
  });

  it('BOOTSTRAP-ORB-GREETING-REEMIT: does NOT suppress once the user has actually spoken (buffer non-empty)', () => {
    const session = makeSession({
      greetingSent: true,
      turn_count: 1,
      consecutiveModelTurns: 1,
      inputTranscriptBuffer: 'a real user reply',
      isModelSpeaking: false,
    });
    const { send } = makeHandler({ session });
    send({ server_content: { model_turn: { parts: [{ inline_data: { mime_type: 'audio/pcm', data: 'AA==' } }] } } });
    expect(session.suppressCurrentTurnAudio).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// server_content.model_turn — text parts
// ---------------------------------------------------------------------------
describe('server_content — model_turn text', () => {
  it('forwards text to onTextResponse and starts the text_stall watchdog', () => {
    const { send, callbacks, deps } = makeHandler();
    send({ server_content: { model_turn: { parts: [{ text: 'Guten Tag!' }] } } });
    expect(callbacks.onTextResponse).toHaveBeenCalledWith('Guten Tag!');
    expect(deps.startResponseWatchdog).toHaveBeenCalledWith(expect.anything(), expect.any(Number), 'text_stall');
  });

  it('an empty text string is falsy and is not forwarded', () => {
    const { send, callbacks } = makeHandler();
    send({ server_content: { model_turn: { parts: [{ text: '' }] } } });
    expect(callbacks.onTextResponse).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// server_content — input/output transcription
// ---------------------------------------------------------------------------
describe('server_content — transcriptions', () => {
  it('input_transcription as a plain string is buffered and pushed via SSE input_transcript', () => {
    const sse = makeSse();
    const session = makeSession({ sseResponse: sse });
    const { send } = makeHandler({ session });
    send({ server_content: { input_transcription: 'hallo welt' } });
    expect(session.inputTranscriptBuffer).toBe('hallo welt');
    expect(sse.events).toContainEqual({ type: 'input_transcript', text: 'hallo welt' });
  });

  it('input_transcription as an object with .text extracts the text', () => {
    const session = makeSession();
    const { send } = makeHandler({ session });
    send({ server_content: { input_transcription: { text: 'wie gehts' } } });
    expect(session.inputTranscriptBuffer).toBe('wie gehts');
  });

  it('camelCase inputTranscription is recognized identically', () => {
    const session = makeSession();
    const { send } = makeHandler({ session });
    send({ server_content: { inputTranscription: 'moin' } });
    expect(session.inputTranscriptBuffer).toBe('moin');
  });

  it('a malformed transcription value (bare number, no .text) is silently skipped, not crashed', () => {
    const session = makeSession();
    const { send } = makeHandler({ session });
    expect(() => send({ server_content: { input_transcription: 12345 } })).not.toThrow();
    expect(session.inputTranscriptBuffer).toBe('');
  });

  it('filters the server-injected greeting prompt out of the greeting turn (EN pattern)', () => {
    const sse = makeSse();
    const session = makeSession({ greetingSent: true, turn_count: 0, sseResponse: sse });
    const { send } = makeHandler({ session });
    send({ server_content: { input_transcription: 'Please greet the user warmly and briefly.' } });
    expect(session.inputTranscriptBuffer).toBe('');
    expect(sse.events).toEqual([]);
  });

  it('filters the server-injected greeting prompt out of the greeting turn (DE pattern)', () => {
    const session = makeSession({ greetingSent: true, turn_count: 0 });
    const { send } = makeHandler({ session });
    send({ server_content: { input_transcription: 'begrüße den Benutzer freundlich' } });
    expect(session.inputTranscriptBuffer).toBe('');
  });

  it('resets loop-guard counters and arms the response watchdog on real user speech', () => {
    const session = makeSession({ consecutiveModelTurns: 2, consecutiveToolCalls: 3 });
    const { send, deps } = makeHandler({ session });
    send({ server_content: { input_transcription: 'hallo' } });
    expect(session.consecutiveModelTurns).toBe(0);
    expect(session.consecutiveToolCalls).toBe(0);
    expect(deps.startResponseWatchdog).toHaveBeenCalledWith(session, expect.any(Number), 'response_timeout');
  });

  it('sends a "thinking" message when the model is not currently speaking', () => {
    const sse = makeSse();
    const sendWsMessage = jest.fn();
    const clientWs = { readyState: WebSocket.OPEN };
    const session = makeSession({ sseResponse: sse, clientWs, isModelSpeaking: false });
    const { send } = makeHandler({ session, deps: { sendWsMessage } });
    send({ server_content: { input_transcription: 'hallo' } });
    expect(sse.events).toContainEqual({ type: 'thinking' });
    expect(sendWsMessage).toHaveBeenCalledWith(clientWs, { type: 'thinking' });
  });

  it('does NOT send "thinking" while the model is already speaking', () => {
    const sse = makeSse();
    const session = makeSession({ sseResponse: sse, isModelSpeaking: true });
    const { send } = makeHandler({ session });
    send({ server_content: { input_transcription: 'hallo' } });
    expect(sse.events).not.toContainEqual({ type: 'thinking' });
  });

  it('output_transcription accumulates in outputTranscriptBuffer and is pushed via SSE', () => {
    const sse = makeSse();
    const session = makeSession({ sseResponse: sse });
    const { send } = makeHandler({ session });
    send({ server_content: { output_transcription: 'Mir geht es ' } });
    send({ server_content: { output_transcription: 'gut!' } });
    expect(session.outputTranscriptBuffer).toBe('Mir geht es gut!');
    expect(sse.events).toEqual([
      { type: 'output_transcript', text: 'Mir geht es ' },
      { type: 'output_transcript', text: 'gut!' },
    ]);
  });

  it('output_transcription is dropped once navigationDispatched (post-nav Turn 2 text)', () => {
    const sse = makeSse();
    const session = makeSession({ sseResponse: sse, navigationDispatched: true });
    const { send } = makeHandler({ session });
    send({ server_content: { output_transcription: 'should not appear' } });
    expect(session.outputTranscriptBuffer).toBe('');
    expect(sse.events).toEqual([]);
  });

  it('detects a duplicate-turn prefix match against recentAssistantTexts and flips suppressCurrentTurnAudio', () => {
    const session = makeSession({
      recentAssistantTexts: ['Hallo, ich bin Vitana und helfe dir gerne weiter heute'],
    });
    const { send, deps } = makeHandler({ session });
    send({ server_content: { output_transcription: 'Hallo, ich bin Vitana und helfe dir gerne weiter erneut' } });
    expect(session.suppressCurrentTurnAudio).toBe(true);
    expect(deps.emitDiag).toHaveBeenCalledWith(session, 'duplicate_turn_detected', expect.anything());
  });

  it('does not flag duplication when the buffer has not reached the 30-char comparison threshold yet', () => {
    const session = makeSession({ recentAssistantTexts: ['Hallo, ich bin Vitana und helfe dir gerne weiter'] });
    const { send } = makeHandler({ session });
    send({ server_content: { output_transcription: 'Hallo kurz' } });
    expect(session.suppressCurrentTurnAudio).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tool_call — VTID-01224. This is where a non-object/odd toolResult shape
// has historically threatened to kill the stream (see BOOTSTRAP-NOVA-SONIC-
// VOICE incident history referenced in the task).
// ---------------------------------------------------------------------------
describe('tool_call', () => {
  it('snake_case tool_call executes the tool and sends a graced function_response', async () => {
    const { send, deps, ws } = makeHandler({
      deps: { executeLiveApiTool: jest.fn().mockResolvedValue({ success: true, result: 'ok result' }) },
    });
    send({ tool_call: { function_calls: [{ id: 'c1', name: 'get_current_screen', args: { a: 1 } }] } });
    await flush();
    expect(deps.executeLiveApiTool).toHaveBeenCalledWith(expect.anything(), 'get_current_screen', { a: 1 });
    expect(deps.sendFunctionResponseToLiveAPI).toHaveBeenCalledWith(
      ws, 'c1', 'get_current_screen', expect.objectContaining({ success: true, result: 'ok result' }),
    );
  });

  it('camelCase toolCall/functionCalls is recognized identically', async () => {
    const { send, deps } = makeHandler();
    send({ toolCall: { functionCalls: [{ id: 'c2', name: 'x', args: {} }] } });
    await flush();
    expect(deps.executeLiveApiTool).toHaveBeenCalledWith(expect.anything(), 'x', {});
  });

  it('missing fc.args falls back to {} (does not crash, does not pass undefined)', async () => {
    const { send, deps } = makeHandler();
    send({ tool_call: { function_calls: [{ id: 'c3', name: 'no_args_tool' }] } });
    await flush();
    expect(deps.executeLiveApiTool).toHaveBeenCalledWith(expect.anything(), 'no_args_tool', {});
  });

  it('missing fc.id falls back to a generated UUID callId', async () => {
    const { send, deps } = makeHandler();
    send({ tool_call: { function_calls: [{ name: 'no_id_tool', args: {} }] } });
    await flush();
    const call = (deps.sendFunctionResponseToLiveAPI as jest.Mock).mock.calls[0];
    expect(call[1]).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
  });

  it('a hard tool failure (success:false) is reshaped through the offer-integrity grace layer before reaching the model', async () => {
    const { send, deps } = makeHandler({
      deps: { executeLiveApiTool: jest.fn().mockResolvedValue({ success: false, result: '', error: 'system issues with X' }) },
    });
    send({ tool_call: { function_calls: [{ id: 'c4', name: 'create_task', args: {} }] } });
    await flush();
    const [, , , gracedResult] = (deps.sendFunctionResponseToLiveAPI as jest.Mock).mock.calls[0];
    expect(gracedResult.success).toBe(true); // never a raw failure to the model
    expect(JSON.stringify(gracedResult)).not.toMatch(/system issues/i);
    // Telemetry still records the TRUE outcome.
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ success: false, tool_name: 'create_task' }) }),
    );
  });

  it('[finding — pins current behavior] a THROWN/rejected tool call sends the RAW error, bypassing graceToolResultForModel', async () => {
    // Unlike the `success:false` result path above (which IS graced), the
    // `.catch()` arm for an actually-thrown/rejected tool promise sends
    // `{ success:false, result:'', error: err.message }` directly — the
    // same shape VTID-03245 exists to prevent leaking to the model. This
    // is symmetric with `handleToolCall` in the same file's normalized
    // path (also un-graced on .catch), so it looks like a deliberate,
    // if debatable, choice rather than a regression — flagged here so a
    // future VTID-03245-style fix has a red test to turn green, and any
    // accidental behavior change here is caught.
    const { send, deps } = makeHandler({
      deps: { executeLiveApiTool: jest.fn().mockRejectedValue(new Error('nova threw mid-call')) },
    });
    send({ tool_call: { function_calls: [{ id: 'c5', name: 'risky_tool', args: {} }] } });
    await flush();
    expect(deps.sendFunctionResponseToLiveAPI).toHaveBeenCalledWith(
      expect.anything(), 'c5', 'risky_tool',
      { success: false, result: '', error: 'nova threw mid-call' },
    );
  });

  it('always sends SOME function_response even when the WS write itself fails (sent=false is only logged)', async () => {
    const { send, deps } = makeHandler({
      deps: { sendFunctionResponseToLiveAPI: jest.fn().mockReturnValue(false) },
    });
    expect(() =>
      send({ tool_call: { function_calls: [{ id: 'c6', name: 'x', args: {} }] } }),
    ).not.toThrow();
    await flush();
    expect(deps.sendFunctionResponseToLiveAPI).toHaveBeenCalled();
  });

  it('extracts structured "Title | ... | Link: URL" pairs into pendingEventLinks and pushes a link event', async () => {
    const sse = makeSse();
    const session = makeSession({ sseResponse: sse });
    const { send } = makeHandler({
      session,
      deps: {
        executeLiveApiTool: jest.fn().mockResolvedValue({
          success: true,
          result: 'Cool Event | 2026-08-01 | Berlin | Link: https://example.com/e1',
        }),
      },
    });
    send({ tool_call: { function_calls: [{ id: 'c7', name: 'search_events', args: {} }] } });
    await flush();
    expect(session.pendingEventLinks).toEqual([{ title: 'Cool Event', url: 'https://example.com/e1' }]);
    expect(sse.events).toContainEqual({ type: 'link', url: 'https://example.com/e1', tool: 'search_events' });
  });

  it('falls back to bare URL extraction (deduplicated) when no structured "| Link:" format is present', async () => {
    const session = makeSession();
    const { send } = makeHandler({
      session,
      deps: {
        executeLiveApiTool: jest.fn().mockResolvedValue({
          success: true,
          result: 'See https://example.com/raw and again https://example.com/raw for details',
        }),
      },
    });
    send({ tool_call: { function_calls: [{ id: 'c8', name: 'x', args: {} }] } });
    await flush();
    expect(session.pendingEventLinks).toEqual([{ title: '', url: 'https://example.com/raw' }]);
  });

  it('tool loop guard: past the consecutive-call limit, sends synthetic loop-break responses WITHOUT executing any tool', async () => {
    const session = makeSession({ consecutiveToolCalls: 5 }); // fallback max = 5; +1 this call = 6 > 5
    const { send, deps } = makeHandler({ session });
    send({
      tool_call: {
        function_calls: [
          { id: 'a', name: 'x', args: {} },
          { id: 'b', name: 'y', args: {} },
        ],
      },
    });
    expect(deps.executeLiveApiTool).not.toHaveBeenCalled();
    expect(deps.sendFunctionResponseToLiveAPI).toHaveBeenCalledTimes(2);
    for (const call of (deps.sendFunctionResponseToLiveAPI as jest.Mock).mock.calls) {
      expect(call[3]).toEqual(expect.objectContaining({ success: false, error: expect.stringMatching(/Tool loop guard/) }));
    }
  });

  it('an empty function_calls array increments the counter but executes nothing', () => {
    const session = makeSession();
    const { send, deps } = makeHandler({ session });
    send({ tool_call: { function_calls: [] } });
    expect(session.consecutiveToolCalls).toBe(1);
    expect(deps.executeLiveApiTool).not.toHaveBeenCalled();
    expect(deps.sendFunctionResponseToLiveAPI).not.toHaveBeenCalled();
  });

  it('a non-array function_calls value is swallowed by the outer catch, not thrown', () => {
    const session = makeSession();
    const { send, deps } = makeHandler({ session });
    expect(() => send({ tool_call: { function_calls: 'not-an-array' } })).not.toThrow();
    expect(deps.executeLiveApiTool).not.toHaveBeenCalled();
    // The crash happens before the increment (at `.map(...)` on the raw list).
    expect(session.consecutiveToolCalls).toBe(0);
  });

  it('a non-object tool_call value (e.g. tool_call: true) does not crash', () => {
    const { send } = makeHandler();
    expect(() => send({ tool_call: true })).not.toThrow();
  });

  it('sends a "thinking" message with the tool names while executing', () => {
    const sse = makeSse();
    const session = makeSession({ sseResponse: sse });
    const { send } = makeHandler({ session });
    send({ tool_call: { function_calls: [{ id: 'c9', name: 'find_practitioner', args: {} }] } });
    expect(sse.events).toContainEqual({ type: 'thinking', reason: 'tool_call', tools: ['find_practitioner'] });
  });
});
