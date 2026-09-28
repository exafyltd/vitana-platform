/**
 * VTID-04702: save first, then answer.
 *
 * Live B-PROF-01 (staging, 2026-09-28): "Merk dir bitte, mein Geburtstag ist
 * der neunte September neunzehnhundertneunundsechzig" → Nova said "Ich habe
 * dein Geburtsdatum notiert" with no tool call, and the member heard it
 * before the gateway corrected it. The reply of a remember turn is now held
 * until the save has run; these tests drive the real shared handler.
 */

const backstopRuns: Array<(session: any) => Promise<unknown[]> | null> = [];
jest.mock('../../../../src/orb/live/session/remember-backstop-hook', () => {
  const actual = jest.requireActual('../../../../src/orb/live/session/remember-backstop-hook');
  return {
    ...actual,
    maybeRunRememberBackstop: jest.fn((_ctx: unknown, session: any) => {
      const next = backstopRuns.shift();
      return next ? next(session) : null;
    }),
    maybeRunForgetBackstop: jest.fn(() => null),
    maybeRunRecallBackstop: jest.fn(() => null),
  };
});

import {
  bindUpstreamSessionHandlers,
  type UpstreamMessageHandlerDeps,
  type UpstreamSessionHandlerContext,
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

class FakeUpstreamClient implements UpstreamLiveClient {
  state: UpstreamConnectionState = 'open';
  toolResults: UpstreamToolResult[] = [];
  private audioH: ((e: AudioOutputEvent) => void) | null = null;
  private transcriptH: ((e: TranscriptEvent) => void) | null = null;
  private toolH: ((e: ToolCallEvent) => void) | null = null;
  private turnH: ((e: TurnCompleteEvent) => void) | null = null;
  private interruptH: ((e: InterruptedEvent) => void) | null = null;
  async connect(_o: UpstreamConnectOptions): Promise<void> { this.state = 'open'; }
  sendAudioChunk(): boolean { return true; }
  sendTextTurn(): boolean { return true; }
  sendEndOfTurn(): boolean { return true; }
  sendToolResult(r: UpstreamToolResult): boolean { this.toolResults.push(r); return true; }
  onAudioOutput(h: (e: AudioOutputEvent) => void): void { this.audioH = h; }
  onTranscript(h: (e: TranscriptEvent) => void): void { this.transcriptH = h; }
  onToolCall(h: (e: ToolCallEvent) => void): void { this.toolH = h; }
  onTurnComplete(h: (e: TurnCompleteEvent) => void): void { this.turnH = h; }
  onInterrupted(h: (e: InterruptedEvent) => void): void { this.interruptH = h; }
  onUsage(_h: (e: UpstreamUsageEvent) => void): void {}
  onError(_h: (e: UpstreamErrorEvent) => void): void {}
  onClose(_h: (e: UpstreamCloseEvent) => void): void {}
  async close(): Promise<void> { this.state = 'closed'; }
  getState(): UpstreamConnectionState { return this.state; }
  said(text: string): void { this.transcriptH?.({ direction: 'input', text, isFinal: true }); }
  replies(text: string): void { this.transcriptH?.({ direction: 'output', text, generationStage: 'SPECULATIVE' } as TranscriptEvent); }
  audio(n: number): void { for (let i = 0; i < n; i++) this.audioH?.({ dataB64: `chunk${i}`, mimeType: 'audio/pcm;rate=24000' }); }
  tool(name: string): void { this.toolH?.({ calls: [{ name, args: {}, id: 'c1' }] }); }
  done(): void { this.turnH?.({}); }
  interrupt(): void { this.interruptH?.({} as InterruptedEvent); }
}

function setup(over: Record<string, unknown> = {}) {
  const sse = { writableEnded: false, write: jest.fn(() => true) };
  const session: any = {
    sessionId: 'sess-hold',
    active: true,
    upstreamProvider: 'nova_sonic',
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
    identity: { user_id: 'u1', tenant_id: 't1' },
    isAnonymous: false,
    sseResponse: sse,
    clientWs: null,
    navigationDispatched: false,
    ...over,
  };
  const client = new FakeUpstreamClient();
  const callbacks = { onAudioResponse: jest.fn(), onTextResponse: jest.fn(), onError: jest.fn(), onTurnComplete: jest.fn(), onInterrupted: jest.fn() };
  const deps: UpstreamMessageHandlerDeps = {
    clearResponseWatchdog: jest.fn(),
    detectAuthIntent: jest.fn().mockReturnValue(null),
    detectStillHereComplaint: jest.fn().mockReturnValue(false),
    dispatchEndConversationDirective: jest.fn(),
    emitDiag: jest.fn(),
    emitLiveSessionEvent: jest.fn().mockResolvedValue(undefined),
    executeLiveApiTool: jest.fn().mockResolvedValue({ success: true, result: 'STATUS: saved' }),
    isDevSandbox: jest.fn().mockReturnValue(false),
    sendAudioToLiveAPI: jest.fn().mockReturnValue(true),
    sendFunctionResponseToLiveAPI: jest.fn().mockReturnValue(true),
    sendWsMessage: jest.fn(),
    markVoiceLatency: jest.fn(),
    finalizeVoiceTurnLatency: jest.fn(),
    startResponseWatchdog: jest.fn(),
  } as any;
  const ctx: UpstreamSessionHandlerContext = { session, client, callbacks, deps } as any;
  bindUpstreamSessionHandlers(ctx);
  const spokenText = () =>
    sse.write.mock.calls.map((c: any[]) => String(c[0])).filter((l) => l.includes('output_transcript')).join('');
  return { session, client, callbacks, deps, spokenText };
}

const flush = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));
const B_PROF_01 = 'merk dir bitte mein geburtstag ist der neunte september neunzehnhundertneunundsechzig';

beforeEach(() => {
  backstopRuns.length = 0;
  delete process.env.ORB_REMEMBER_HOLD_ENABLED;
});

describe('VTID-04702 the reply of a remember turn waits for the save', () => {
  it('live B-PROF-01: the false "notiert" reply is never forwarded; the reply after the save is', async () => {
    const { client, callbacks, spokenText } = setup();
    backstopRuns.push(async (session) => {
      session.rememberNoteSentAt = Date.now(); // the backstop saved and told Nova
      return [{ fact_key: 'user_birthday', status: 'profile_owned' }];
    });
    client.said(B_PROF_01);
    client.replies('Ich habe dein Geburtsdatum notiert: 9 September 1969.');
    client.audio(5);
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    expect(spokenText()).not.toMatch(/notiert/);

    client.done();
    await flush();
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    expect(spokenText()).not.toMatch(/notiert/);

    // The corrected reply, after the backstop's note, plays live.
    client.replies('Dein Geburtstag gehört in dein Profil.');
    client.audio(2);
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
    expect(spokenText()).toMatch(/Profil/);
  });

  it('Nova called remember_fact: the reply plays once the tool result is sent', async () => {
    const { client, callbacks } = setup();
    client.said('merk dir mein hund heißt bello');
    client.audio(3); // "Einen Moment ..." before the tool call
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    client.tool('remember_fact');
    await flush();
    expect(client.toolResults).toHaveLength(1);
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(3);
    client.audio(2); // the reply after the result
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(5);
  });

  it('the backstop did not answer: the held reply still plays, never silence', async () => {
    const { client, callbacks } = setup();
    backstopRuns.push(() => null);
    client.said('merk dir mein hund heißt bello');
    client.audio(4);
    client.done();
    await flush();
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(4);
  });

  it('a plain statement whose reply claims a save is held too (live B-CONF-02 shape)', async () => {
    const { client, callbacks, spokenText } = setup();
    backstopRuns.push(async (session) => {
      session.rememberNoteSentAt = Date.now();
      return [{ fact_key: 'paul_birthday', status: 'conflict' }];
    });
    client.said('mein bruder paul hat übrigens am siebten mai geburtstag');
    client.replies('Ich habe den Geburtstag von Paul am siebten Mai notiert.');
    client.audio(3);
    client.done();
    await flush();
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    expect(spokenText()).not.toMatch(/notiert/);
  });

  it('a held reply cut off by the member is never played; the hold re-arms for the next reply', async () => {
    const { client, callbacks } = setup();
    backstopRuns.push(async (session) => {
      session.rememberNoteSentAt = Date.now();
      return [{ fact_key: 'user_birthday', status: 'profile_owned' }];
    });
    client.said('merk dir bitte mein geburtstag ist der neunte september');
    client.audio(3); // Nova answered the first half of the sentence
    client.interrupt(); // the member kept talking
    client.said('neunzehnhundertneunundsechzig');
    client.replies('Ich habe dein Geburtsdatum notiert.');
    client.audio(2);
    client.done();
    await flush();
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
  });

  it('a turn that is not about remembering plays live', () => {
    const { client, callbacks } = setup();
    client.said('wie wird das wetter morgen');
    client.replies('Morgen wird es sonnig.');
    client.audio(3);
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(3);
  });

  it('is off with ORB_REMEMBER_HOLD_ENABLED=false and for a non-Nova session', () => {
    process.env.ORB_REMEMBER_HOLD_ENABLED = 'false';
    const a = setup();
    a.client.said(B_PROF_01);
    a.client.audio(2);
    expect(a.callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
    delete process.env.ORB_REMEMBER_HOLD_ENABLED;
    const b = setup({ upstreamProvider: 'vertex' });
    b.client.said(B_PROF_01);
    b.client.audio(2);
    expect(b.callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
  });
});

describe('VTID-04702 note wording when the reply was held', () => {
  it('asks for the outcome as the answer, not as a correction', () => {
    const { buildRememberBackstopNote } = jest.requireActual('../../../../src/services/memory/remember-backstop');
    const r = [{ fact_key: 'user_birthday', status: 'profile_owned', instruction: 'x' }];
    expect(buildRememberBackstopNote(r, 'no_call', true)).toMatch(/did not hear your previous answer/);
    expect(buildRememberBackstopNote(r, 'no_call', false)).toMatch(/correct it plainly/);
  });
});
