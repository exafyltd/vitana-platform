/**
 * VTID-04609 — Vitana's farewell was spoken and stored twice.
 *
 * Live, session live-a7b3a904 (Serbian, Vertex bridge, 2026-09-26): Vitana
 * said her farewell (audio chunks 243→312), called end_conversation, got the
 * tool result and generated the same farewell again (312→377). The inbox row
 * and the lock-screen text read "Razumem. Nema problema. Želim vam prijatan
 * dan!Razumem. Nema problema. Želim vam prijatan dan!".
 *
 * Once the close directive has gone out after a spoken farewell, further
 * model audio and transcript are dropped. Real dispatchEndConversationDirective,
 * real shared handlers; the raw (Vertex legacy) handler is checked by source.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  bindUpstreamSessionHandlers,
  isPostFarewellOutput,
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

class FakeUpstreamClient implements UpstreamLiveClient {
  state: UpstreamConnectionState = 'open';
  private audioH: ((e: AudioOutputEvent) => void) | null = null;
  private transcriptH: ((e: TranscriptEvent) => void) | null = null;

  async connect(_o: UpstreamConnectOptions): Promise<void> { this.state = 'open'; }
  sendAudioChunk(): boolean { return true; }
  sendTextTurn(): boolean { return true; }
  sendEndOfTurn(): boolean { return true; }
  sendToolResult(_r: UpstreamToolResult): boolean { return true; }
  onAudioOutput(h: (e: AudioOutputEvent) => void): void { this.audioH = h; }
  onTranscript(h: (e: TranscriptEvent) => void): void { this.transcriptH = h; }
  onToolCall(_h: (e: ToolCallEvent) => void): void { /* unused */ }
  onTurnComplete(_h: (e: TurnCompleteEvent) => void): void { /* unused */ }
  onInterrupted(_h: (e: InterruptedEvent) => void): void { /* unused */ }
  onUsage(_h: (e: UpstreamUsageEvent) => void): void { /* unused */ }
  onError(_h: (e: UpstreamErrorEvent) => void): void { /* unused */ }
  onClose(_h: (e: UpstreamCloseEvent) => void): void { /* unused */ }
  async close(): Promise<void> { this.state = 'closed'; }
  getState(): UpstreamConnectionState { return this.state; }

  emitAudio(): void { this.audioH?.({ dataB64: 'AAAA', mimeType: 'audio/pcm;rate=24000' }); }
  emitOutput(text: string): void { this.transcriptH?.({ direction: 'output', text, isFinal: false }); }
}

const FAREWELL = 'Razumem. Nema problema. Želim vam prijatan dan!';

function setup() {
  const session: any = {
    sessionId: 'sess-04602',
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
    lang: 'sr',
    identity: null,
    isAnonymous: false,
    sseResponse: null,
    clientWs: { readyState: 1, send: jest.fn() },
    navigationDispatched: false,
  };
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
    detectStillHereComplaint,
    dispatchEndConversationDirective,
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
  };
  const ctx: UpstreamSessionHandlerContext = { session, client, callbacks, deps };
  bindUpstreamSessionHandlers(ctx);
  return { session, client, callbacks };
}

describe('VTID-04609: model output after a spoken farewell and close is dropped', () => {
  it('keeps the farewell once and drops the repeat (transcript and audio)', () => {
    const { session, client, callbacks } = setup();

    client.emitAudio();
    client.emitOutput(FAREWELL);
    dispatchEndConversationDirective(session, 'user said no, nothing now');
    client.emitAudio();
    client.emitOutput(FAREWELL);

    expect(session.outputTranscriptBuffer).toBe(FAREWELL);
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(1);
    expect(isPostFarewellOutput(session)).toBe(true);
  });

  it('still plays the farewell when the tool was called before anything was said', () => {
    const { session, client, callbacks } = setup();

    dispatchEndConversationDirective(session, 'tool first');
    client.emitAudio();
    client.emitOutput(FAREWELL);

    expect(isPostFarewellOutput(session)).toBe(false);
    expect(session.outputTranscriptBuffer).toBe(FAREWELL);
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(1);
  });

  it('changes nothing while no close has been dispatched', () => {
    const { session, client, callbacks } = setup();

    client.emitAudio();
    client.emitOutput('Dobro jutro. ');
    client.emitAudio();
    client.emitOutput('Kako si?');

    expect(session.outputTranscriptBuffer).toBe('Dobro jutro. Kako si?');
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
  });

  it('the raw Vertex handler applies the same guard to audio and transcript', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../../src/orb/live/session/upstream-message-handler.ts'),
      'utf8',
    );
    const raw = src.slice(src.indexOf('function handleUpstreamLiveMessage'), src.indexOf('return handleUpstreamLiveMessage;'));
    expect(raw).toMatch(/suppressCurrentTurnAudio === true \|\| isPostFarewellOutput\(session\)/);
    expect(raw).toMatch(/else if \(isPostFarewellOutput\(session\)\)/);
  });
});
