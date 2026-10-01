/**
 * VTID-04480 — the runaway opening turn.
 *
 * Replays what staging recorded on 2026-09-24 12:49 (session
 * live-a5e6462d…, and the same shape on 2026-09-22 22:16): a resume greeting,
 * five tool calls in a row before a single word, the loop guard on the sixth,
 * then ~70 s of one uninterrupted model turn reading the payloads aloud.
 */

import {
  bindUpstreamSessionHandlers,
  type UpstreamSessionHandlerContext,
  type UpstreamMessageHandlerDeps,
} from '../../../../src/orb/live/session/upstream-message-handler';
import {
  detectBackendDataLeak,
  effectiveToolCallLimit,
  isOpeningTurn,
  loopGuardReplyMaxAudioMs,
  openingTurnMaxToolCalls,
  outputPreview,
  pcmChunkDurationMs,
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
/** 0.5 s of 24 kHz PCM16 mono (24 000 bytes). */
const HALF_SECOND_24K = 'A'.repeat(32_000);
const diagStages = (deps: UpstreamMessageHandlerDeps) =>
  (deps.emitDiag as jest.Mock).mock.calls.map((c) => c[1]);

// The real tool results the staging session fed Nova before the monologue.
const REAL_PAYLOADS = [
  '{"title":"Wallet","description":"Your Maxina wallet — balance, subscriptions, and rewards.","category":"wallet","screen_id":"WALLET.OVERVIEW","route":"/wallet"}',
  '{"ok":false,"available":false,"tool":"loop_guard","speak_guidance":"No more tool calls are needed right now."}',
  'The session is 0adc6ff6-acb0-4dca-99d0-295211a40e3e on DEVHUB.AUTOPILOT.LIVE',
  'your weakest_pillar is nutrition',
];

describe('VTID-04480 — pure guards', () => {
  afterEach(() => {
    delete process.env.ORB_OPENING_MAX_TOOL_CALLS;
    delete process.env.ORB_LOOP_GUARD_REPLY_MAX_MS;
  });

  it('AC-1: opening budget defaults to 2, clamps 1–5, garbage falls back', () => {
    expect(openingTurnMaxToolCalls({})).toBe(2);
    expect(openingTurnMaxToolCalls({ ORB_OPENING_MAX_TOOL_CALLS: '4' })).toBe(4);
    expect(openingTurnMaxToolCalls({ ORB_OPENING_MAX_TOOL_CALLS: '99' })).toBe(5);
    expect(openingTurnMaxToolCalls({ ORB_OPENING_MAX_TOOL_CALLS: 'lots' })).toBe(2);
    expect(openingTurnMaxToolCalls({ ORB_OPENING_MAX_TOOL_CALLS: '0' })).toBe(2);
  });

  it('AC-1: the smaller limit applies only before the first word of the session', () => {
    expect(isOpeningTurn({ turn_count: 0, isModelSpeaking: false })).toBe(true);
    expect(isOpeningTurn({ turn_count: 1, isModelSpeaking: false })).toBe(false);
    expect(isOpeningTurn({ turn_count: 0, isModelSpeaking: true })).toBe(false);
    expect(effectiveToolCallLimit({ turn_count: 0 }, 5, {})).toEqual({ limit: 2, opening: true });
    expect(effectiveToolCallLimit({ turn_count: 3 }, 5, {})).toEqual({ limit: 5, opening: false });
    // Never raises a lower base limit.
    expect(effectiveToolCallLimit({ turn_count: 0 }, 1, {})).toEqual({ limit: 1, opening: true });
  });

  it('AC-3: reply cap defaults to 20 s and clamps 5–60 s', () => {
    expect(loopGuardReplyMaxAudioMs({})).toBe(20_000);
    expect(loopGuardReplyMaxAudioMs({ ORB_LOOP_GUARD_REPLY_MAX_MS: '1000' })).toBe(5_000);
    expect(loopGuardReplyMaxAudioMs({ ORB_LOOP_GUARD_REPLY_MAX_MS: '600000' })).toBe(60_000);
  });

  it('AC-3: PCM duration follows the chunk rate', () => {
    expect(pcmChunkDurationMs(HALF_SECOND_24K, 'audio/pcm;rate=24000')).toBeCloseTo(500, 0);
    expect(pcmChunkDurationMs(HALF_SECOND_24K, 'audio/pcm;rate=16000')).toBeCloseTo(750, 0);
    expect(pcmChunkDurationMs(HALF_SECOND_24K)).toBeCloseTo(500, 0);
    expect(pcmChunkDurationMs('', 'audio/pcm;rate=24000')).toBe(0);
  });

  it('AC-4: every real payload shape from the incident is detected', () => {
    for (const p of REAL_PAYLOADS) expect(detectBackendDataLeak(p)).not.toBeNull();
    expect(detectBackendDataLeak(REAL_PAYLOADS[0])).toBe('json');
    expect(detectBackendDataLeak('the id is 0adc6ff6-acb0-4dca-99d0-295211a40e3e')).toBe('uuid');
    expect(detectBackendDataLeak('you are on WALLET.OVERVIEW now')).toBe('screen_id');
    expect(detectBackendDataLeak('your speak_guidance says')).toBe('snake_case_key');
  });

  it('AC-4: ordinary speech in several languages is never flagged', () => {
    const speech = [
      'Your wallet balance is 0.00 EUR and 0.00 USD. Your premium subscription is active until May 28.',
      'Dein Vitana Index liegt heute bei 72 — Schlaf ist deine stärkste Säule.',
      'Tu índice Vitana es 72. ¿Quieres que planifiquemos la semana?',
      'Imaš 62 nepročitane poruke. Da ih pogledamo zajedno?',
      "It's 3 p.m., so let's plan tomorrow: a walk at 10:30 and your diary at 21:00.",
      'Visit vitanaland.com or the U.S. site — both work.',
    ];
    for (const s of speech) expect(detectBackendDataLeak(s)).toBeNull();
  });

  it('AC-5: output preview is bounded and whitespace-collapsed', () => {
    expect(outputPreview('')).toBeNull();
    expect(outputPreview('  hello \n there ')).toBe('hello there');
    const long = outputPreview('x'.repeat(500));
    expect(long!.length).toBe(241);
    expect(long!.endsWith('…')).toBe(true);
  });
});

describe('VTID-04480 — the incident, through the real session handlers', () => {
  it('AC-2: the third tool call of the opening turn gets the speak-now guidance, not a tool run', async () => {
    const { client, deps } = makeContext();
    const tools = ['get_current_screen', 'get_wallet_summary', 'get_pending_rewards'];
    for (const [i, name] of tools.entries()) {
      client.emitToolCall({ calls: [{ id: `c${i}`, name, args: {} }] });
      await flush();
    }
    expect((deps.executeLiveApiTool as jest.Mock).mock.calls.map((c) => c[1])).toEqual([
      'get_current_screen',
      'get_wallet_summary',
    ]);
    const guard = client.sentToolResults.find((r) => r.name === 'get_pending_rewards');
    expect(guard).toBeDefined();
    expect(JSON.parse(guard!.output as string).speak_guidance).toMatch(/do not call any tool/i);
    const guardDiag = (deps.emitDiag as jest.Mock).mock.calls.find((c) => c[1] === 'tool_loop_guard');
    expect(guardDiag![2]).toEqual(expect.objectContaining({ opening_turn: true, limit: 2 }));
  });

  it('AC-2: later turns keep the normal limit', async () => {
    const { client, deps } = makeContext(makeSession({ turn_count: 3 }));
    for (let i = 0; i < 4; i++) {
      client.emitToolCall({ calls: [{ id: `c${i}`, name: `tool_${i}`, args: {} }] });
      await flush();
    }
    expect(deps.executeLiveApiTool).toHaveBeenCalledTimes(4);
    expect(diagStages(deps)).not.toContain('tool_loop_guard');
  });

  it('AC-3: the reply after the loop guard is muted past the cap, and the cap ends with the turn', async () => {
    const { session, client, callbacks, deps } = makeContext();
    for (let i = 0; i < 3; i++) {
      client.emitToolCall({ calls: [{ id: `c${i}`, name: `tool_${i}`, args: {} }] });
      await flush();
    }
    // 70 s of audio in one turn, as recorded.
    for (let i = 0; i < 140; i++) client.emitAudio({ dataB64: HALF_SECOND_24K, mimeType: 'audio/pcm;rate=24000' });
    const forwarded = callbacks.onAudioResponse.mock.calls.length;
    expect(forwarded).toBeGreaterThanOrEqual(39);
    expect(forwarded).toBeLessThanOrEqual(41);
    expect(diagStages(deps)).toContain('loop_guard_reply_capped');

    client.emitTurnComplete();
    expect(session.loopGuardReply).toBeUndefined();
    expect(session.suppressCurrentTurnAudio).toBe(false);
    // The next turn (after the member speaks) is not capped.
    callbacks.onAudioResponse.mockClear();
    client.emitTranscript({ direction: 'input', text: 'what is my balance', isFinal: true });
    for (let i = 0; i < 60; i++) client.emitAudio({ dataB64: HALF_SECOND_24K, mimeType: 'audio/pcm;rate=24000' });
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(60);
  });

  it('AC-4: a transcript that reads a payload aloud mutes the rest of the turn', () => {
    const { client, callbacks, deps } = makeContext(makeSession({ turn_count: 2 }));
    client.emitAudio({ dataB64: HALF_SECOND_24K, mimeType: 'audio/pcm;rate=24000' });
    client.emitTranscript({ direction: 'output', text: 'Here is your wallet: ', isFinal: false, generationStage: 'SPECULATIVE' });
    client.emitTranscript({ direction: 'output', text: 'title Wallet, screen_id ', isFinal: false, generationStage: 'SPECULATIVE' });
    client.emitAudio({ dataB64: HALF_SECOND_24K, mimeType: 'audio/pcm;rate=24000' });
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(1);
    const d = (deps.emitDiag as jest.Mock).mock.calls.find((c) => c[1] === 'backend_data_speech_suppressed');
    expect(d![2]).toEqual(expect.objectContaining({ kind: 'snake_case_key' }));
  });

  it('AC-4: a key split across two transcript chunks is still caught', () => {
    const { client, deps } = makeContext(makeSession({ turn_count: 2 }));
    client.emitTranscript({ direction: 'output', text: 'your weakest', isFinal: false, generationStage: 'SPECULATIVE' });
    client.emitTranscript({ direction: 'output', text: '_pillar is nutrition', isFinal: false, generationStage: 'SPECULATIVE' });
    expect(diagStages(deps)).toContain('backend_data_speech_suppressed');
  });

  it('AC-4: normal speech is never muted', () => {
    const { client, callbacks, deps } = makeContext(makeSession({ turn_count: 2 }));
    client.emitTranscript({ direction: 'output', text: 'Your wallet balance is 0.00 EUR. ', isFinal: false, generationStage: 'SPECULATIVE' });
    client.emitTranscript({ direction: 'output', text: 'Want me to open your rewards?', isFinal: false, generationStage: 'SPECULATIVE' });
    for (let i = 0; i < 10; i++) client.emitAudio({ dataB64: HALF_SECOND_24K, mimeType: 'audio/pcm;rate=24000' });
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(10);
    expect(diagStages(deps)).not.toContain('backend_data_speech_suppressed');
  });

  it('AC-5: turn_complete records a bounded preview of what was said', () => {
    const { client, deps } = makeContext(makeSession({ turn_count: 2 }));
    client.emitTranscript({ direction: 'output', text: 'Your wallet balance is 0.00 EUR.', isFinal: false, generationStage: 'SPECULATIVE' });
    client.emitTurnComplete();
    const d = (deps.emitDiag as jest.Mock).mock.calls.find((c) => c[1] === 'turn_complete');
    expect(d![2]).toEqual({
      output_preview: 'Your wallet balance is 0.00 EUR.',
      output_chars: 32,
      output_suppressed: false,
    });
  });

  it('AC-5: a turn with no text keeps the bare turn_complete diag', () => {
    const { client, deps } = makeContext(makeSession({ turn_count: 2 }));
    client.emitTurnComplete();
    const d = (deps.emitDiag as jest.Mock).mock.calls.find((c) => c[1] === 'turn_complete');
    expect(d).toHaveLength(2);
  });
});
