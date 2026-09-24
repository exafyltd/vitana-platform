/**
 * VTID-04509 — the resume opener ran the suggested step before the user said
 * a word.
 *
 * Staging, 2026-09-24: `conv_resume` (register continue, nba next_session)
 * handed Nova `execute_with_tool: narrate_guided_session` as a user-role turn.
 * Nova called the tool on turn 0 and narrated the directive and its own
 * translation work (14:16: "…Translation: 'Tap on the ORB now…' Yes, that's
 * correct. Now,…"; 15:57: the returning-user report). At 13:50 the same
 * opener booked a calendar slot (`create_calendar_event`) nobody asked for.
 */

import {
  bindUpstreamSessionHandlers,
  type UpstreamSessionHandlerContext,
  type UpstreamMessageHandlerDeps,
} from '../../../../src/orb/live/session/upstream-message-handler';
import {
  isBeforeFirstUserWord,
  isOpeningActionTool,
  OPENING_ACTION_GUIDANCE,
} from '../../../../src/orb/live/session/opening-turn-guard';
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

class FakeUpstreamClient implements UpstreamLiveClient {
  state: UpstreamConnectionState = 'open';
  sentToolResults: UpstreamToolResult[] = [];
  private audioH: ((e: AudioOutputEvent) => void) | null = null;
  private transcriptH: ((e: TranscriptEvent) => void) | null = null;
  private toolH: ((e: ToolCallEvent) => void) | null = null;
  private turnH: ((e: TurnCompleteEvent) => void) | null = null;

  async connect(_o: UpstreamConnectOptions): Promise<void> { this.state = 'open'; }
  sendAudioChunk(): boolean { return this.state === 'open'; }
  sendTextTurn(): boolean { return this.state === 'open'; }
  sendEndOfTurn(): boolean { return this.state === 'open'; }
  sendToolResult(r: UpstreamToolResult): boolean { this.sentToolResults.push(r); return true; }
  onAudioOutput(h: (e: AudioOutputEvent) => void): void { this.audioH = h; }
  onTranscript(h: (e: TranscriptEvent) => void): void { this.transcriptH = h; }
  onToolCall(h: (e: ToolCallEvent) => void): void { this.toolH = h; }
  onTurnComplete(h: (e: TurnCompleteEvent) => void): void { this.turnH = h; }
  onInterrupted(_h: (e: InterruptedEvent) => void): void { /* unused */ }
  onUsage(_h: (e: UpstreamUsageEvent) => void): void { /* unused */ }
  onError(_h: (e: UpstreamErrorEvent) => void): void { /* unused */ }
  onClose(_h: (e: UpstreamCloseEvent) => void): void { /* unused */ }
  async close(): Promise<void> { this.state = 'closed'; }
  getState(): UpstreamConnectionState { return this.state; }

  emitAudio(e: AudioOutputEvent): void { this.audioH?.(e); }
  emitTranscript(e: TranscriptEvent): void { this.transcriptH?.(e); }
  emitToolCall(e: ToolCallEvent): void { this.toolH?.(e); }
  emitTurnComplete(e: TurnCompleteEvent = {}): void { this.turnH?.(e); }
}

function makeSession(overrides: Record<string, unknown> = {}): any {
  return {
    sessionId: 'live-a5e6462d',
    active: true,
    isModelSpeaking: false,
    audioOutChunks: 0,
    turn_count: 0,
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
    lang: 'en',
    identity: null,
    isAnonymous: false,
    sseResponse: null,
    clientWs: null,
    navigationDispatched: false,
    pendingNavigation: undefined,
    ...overrides,
  };
}

function makeContext(session: any = makeSession()) {
  const client = new FakeUpstreamClient();
  const callbacks = {
    onAudioResponse: jest.fn(),
    onTextResponse: jest.fn(),
    onError: jest.fn(),
    onTurnComplete: jest.fn(),
    onInterrupted: jest.fn(),
  };
  const deps: UpstreamMessageHandlerDeps = {
    clearResponseWatchdog: jest.fn(),
    detectAuthIntent: jest.fn().mockReturnValue(null),
    detectStillHereComplaint: jest.fn().mockReturnValue(false),
    dispatchEndConversationDirective: jest.fn(),
    emitDiag: jest.fn(),
    emitLiveSessionEvent: jest.fn().mockResolvedValue(undefined),
    executeLiveApiTool: jest.fn().mockResolvedValue({ success: true, result: '{"title":"Wallet","screen_id":"WALLET.OVERVIEW"}' }),
    isDevSandbox: jest.fn().mockReturnValue(false),
    sendAudioToLiveAPI: jest.fn().mockReturnValue(true),
    sendFunctionResponseToLiveAPI: jest.fn().mockReturnValue(true),
    sendWsMessage: jest.fn(),
    markVoiceLatency: jest.fn(),
    finalizeVoiceTurnLatency: jest.fn(),
    startResponseWatchdog: jest.fn(),
  } as unknown as UpstreamMessageHandlerDeps;
  const ctx: UpstreamSessionHandlerContext = { session, client, callbacks, deps };
  bindUpstreamSessionHandlers(ctx);
  return { session, client, callbacks, deps };
}

const flush = () => new Promise((r) => setImmediate(r));
const diagStages = (deps: UpstreamMessageHandlerDeps) =>
  (deps.emitDiag as jest.Mock).mock.calls.map((c) => c[1]);

describe('VTID-04509 — pure guards', () => {
  it('AC-1: the tools the incidents ran are action tools', () => {
    for (const t of ['narrate_guided_session', 'create_calendar_event', 'save_diary_entry',
      'send_chat_message', 'create_index_improvement_plan', 'activate_recommendation',
      'navigate', 'navigate_to_screen', 'set_reminder', 'respond_to_match']) {
      expect(isOpeningActionTool(t)).toBe(true);
    }
  });

  it('AC-1: read tools stay allowed on the opening turn', () => {
    for (const t of ['get_current_screen', 'view_messages', 'get_vitana_index', 'search_memory',
      'search_knowledge', 'get_schedule', 'get_wallet_summary']) {
      expect(isOpeningActionTool(t)).toBe(false);
    }
  });

  it('AC-2: "before the first user word" needs turn 0, no model speech and no user transcript', () => {
    expect(isBeforeFirstUserWord({ turn_count: 0, inputTranscriptBuffer: '' })).toBe(true);
    expect(isBeforeFirstUserWord({ turn_count: 0, inputTranscriptBuffer: 'play session three' })).toBe(false);
    expect(isBeforeFirstUserWord({ turn_count: 1, inputTranscriptBuffer: '' })).toBe(false);
    expect(isBeforeFirstUserWord({ turn_count: 0, isModelSpeaking: true })).toBe(false);
  });

  it('AC-3: the guidance asks for an offer, in the model\'s own words, and never names the user', () => {
    const g = JSON.parse(OPENING_ACTION_GUIDANCE);
    expect(g.speak_guidance).toMatch(/offer this step/i);
    expect(g.speak_guidance).toMatch(/never mention this message/i);
    expect(g.speak_guidance).not.toMatch(/say exactly|"[^"]{20,}"/i);
  });
});

describe('VTID-04509 — the incident, through the real session handlers', () => {
  it('AC-4: narrate_guided_session on turn 0 is refused with offer guidance, not run', async () => {
    const { client, deps } = makeContext();
    client.emitToolCall({ calls: [{ id: 'c0', name: 'narrate_guided_session', args: {} }] });
    await flush();
    expect(deps.executeLiveApiTool).not.toHaveBeenCalled();
    expect(client.sentToolResults).toHaveLength(1);
    expect(client.sentToolResults[0].callId).toBe('c0');
    expect(JSON.parse(client.sentToolResults[0].output as string).tool).toBe('opening_action_guard');
    expect(diagStages(deps)).toContain('opening_action_refused');
  });

  it('AC-4: create_calendar_event on turn 0 is refused (no booking without a yes)', async () => {
    const { client, deps } = makeContext();
    client.emitToolCall({ calls: [{ id: 'c0', name: 'create_calendar_event', args: { title: 'Nutrition' } }] });
    await flush();
    expect(deps.executeLiveApiTool).not.toHaveBeenCalled();
  });

  it('AC-5: a read tool on turn 0 still runs (the 16:01 inbox opener)', async () => {
    const { client, deps } = makeContext();
    client.emitToolCall({ calls: [{ id: 'c0', name: 'get_current_screen', args: {} }] });
    await flush();
    expect((deps.executeLiveApiTool as jest.Mock).mock.calls.map((c) => c[1])).toEqual(['get_current_screen']);
  });

  it('AC-5: mixed batch — the read runs, the action is refused', async () => {
    const { client, deps } = makeContext();
    client.emitToolCall({ calls: [
      { id: 'r', name: 'view_messages', args: {} },
      { id: 'a', name: 'send_chat_message', args: {} },
    ] });
    await flush();
    expect((deps.executeLiveApiTool as jest.Mock).mock.calls.map((c) => c[1])).toEqual(['view_messages']);
    expect(client.sentToolResults.find((r) => r.callId === 'a')).toBeDefined();
  });

  it('AC-6: once the user has spoken, the same tool runs normally', async () => {
    const { client, deps } = makeContext(makeSession({ inputTranscriptBuffer: 'yes, play the next session' }));
    client.emitToolCall({ calls: [{ id: 'c0', name: 'narrate_guided_session', args: {} }] });
    await flush();
    expect(deps.executeLiveApiTool).toHaveBeenCalledTimes(1);
    expect(diagStages(deps)).not.toContain('opening_action_refused');
  });

  it('AC-6: on later turns the same tool runs normally', async () => {
    const { client, deps } = makeContext(makeSession({ turn_count: 2 }));
    client.emitToolCall({ calls: [{ id: 'c0', name: 'narrate_guided_session', args: {} }] });
    await flush();
    expect(deps.executeLiveApiTool).toHaveBeenCalledTimes(1);
  });
});
