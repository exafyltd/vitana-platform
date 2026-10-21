/**
 * VTID-04862 / VTID-04863 — the live session's rules for remember_fact.
 * Replays the live memory suite sessions on staging e36e486 (2026-10-01)
 * through the real shared handler.
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
import { gateConfirmReplace, memberSaidValue } from '../../../../src/orb/live/session/remember-confirm-gate';
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
  async connect(_o: UpstreamConnectOptions): Promise<void> { this.state = 'open'; }
  sendAudioChunk(): boolean { return true; }
  sendTextTurn(): boolean { return true; }
  sendEndOfTurn(): boolean { return true; }
  sendToolResult(r: UpstreamToolResult): boolean { this.toolResults.push(r); return true; }
  onAudioOutput(h: (e: AudioOutputEvent) => void): void { this.audioH = h; }
  onTranscript(h: (e: TranscriptEvent) => void): void { this.transcriptH = h; }
  onToolCall(h: (e: ToolCallEvent) => void): void { this.toolH = h; }
  onTurnComplete(h: (e: TurnCompleteEvent) => void): void { this.turnH = h; }
  onInterrupted(_h: (e: InterruptedEvent) => void): void {}
  onUsage(_h: (e: UpstreamUsageEvent) => void): void {}
  onError(_h: (e: UpstreamErrorEvent) => void): void {}
  onClose(_h: (e: UpstreamCloseEvent) => void): void {}
  async close(): Promise<void> { this.state = 'closed'; }
  getState(): UpstreamConnectionState { return this.state; }
  said(text: string): void { this.transcriptH?.({ direction: 'input', text, isFinal: true }); }
  replies(text: string): void { this.transcriptH?.({ direction: 'output', text, generationStage: 'SPECULATIVE' } as TranscriptEvent); }
  audio(n: number): void { for (let i = 0; i < n; i++) this.audioH?.({ dataB64: `chunk${i}`, mimeType: 'audio/pcm;rate=24000' }); }
  call(name: string, args: Record<string, unknown>): void { this.toolH?.({ calls: [{ name, args, id: `c${Math.random()}` }] }); }
  done(): void { this.turnH?.({}); }
}

function setup(results: string[]) {
  const sse = { writableEnded: false, write: jest.fn(() => true) };
  const session: any = {
    sessionId: 'sess-confirm',
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
  };
  const client = new FakeUpstreamClient();
  const callbacks = { onAudioResponse: jest.fn(), onTextResponse: jest.fn(), onError: jest.fn(), onTurnComplete: jest.fn(), onInterrupted: jest.fn() };
  const ran: Array<Record<string, unknown>> = [];
  const deps: UpstreamMessageHandlerDeps = {
    clearResponseWatchdog: jest.fn(),
    detectAuthIntent: jest.fn().mockReturnValue(null),
    detectStillHereComplaint: jest.fn().mockReturnValue(false),
    dispatchEndConversationDirective: jest.fn(),
    emitDiag: jest.fn(),
    emitLiveSessionEvent: jest.fn().mockResolvedValue(undefined),
    executeLiveApiTool: jest.fn(async (_s: any, _name: string, args: Record<string, unknown>) => {
      ran.push(args);
      return { success: true, result: results.shift() ?? 'STATUS: saved.' };
    }),
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
  const diag = (stage: string) => (deps.emitDiag as jest.Mock).mock.calls.filter((c) => c[1] === stage).map((c) => c[2]);
  return { session, client, callbacks, ran, diag };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

const CONFLICT =
  'STATUS: conflict. Nothing was saved. You already have a DIFFERENT value for brother_paul_birthday: "5. Mai". The member just said "7. Mai". Tell them …';

beforeEach(() => {
  backstopRuns.length = 0;
  delete process.env.ORB_REMEMBER_HOLD_ENABLED;
});

describe('VTID-04862 a replace waits for the member\'s answer (live B-CONF-01, session live-49485c50)', () => {
  it('the model\'s immediate retry with confirm_replace runs as an ordinary call', async () => {
    const { client, ran, diag } = setup([CONFLICT, CONFLICT]);
    client.said('merk dir paul hat am siebten mai geburtstag');
    // Live: the first call already carried confirm_replace, the tool answered
    // conflict, and 240 ms later the model called again with confirm_replace.
    client.call('remember_fact', { about: 'other', fact_key: 'bruder paul geburtstag', fact_value: '7. Mai', confirm_replace: true });
    await flush();
    client.call('remember_fact', { about: 'other', fact_key: 'bruder paul geburtstag', fact_value: '7. Mai', confirm_replace: true });
    await flush();
    expect(ran.map((a) => a.confirm_replace)).toEqual([false, false]);
    expect(diag('remember_confirm_replace_dropped')).toHaveLength(2);
  });

  it('after the member answers, confirm_replace counts', async () => {
    const { client, ran } = setup([CONFLICT, 'STATUS: saved. Saved: brother_paul_birthday = "7. Mai" (replaced "5. Mai").']);
    client.said('merk dir paul hat am siebten mai geburtstag');
    client.call('remember_fact', { about: 'other', fact_key: 'bruder paul geburtstag', fact_value: '7. Mai' });
    await flush();
    client.done();
    await flush();
    await new Promise((r) => setTimeout(r, 2));
    client.said('der siebte mai ist richtig');
    client.call('remember_fact', { about: 'other', fact_key: 'bruder paul geburtstag', fact_value: '7. Mai', confirm_replace: true });
    await flush();
    expect(ran.map((a) => a.confirm_replace)).toEqual([undefined, true]);
  });

  it('a conflict the gateway\'s own note asked about counts the same way', () => {
    const session: any = { rememberConflictAskedAt: 1000, memberSpokeAt: 900 };
    expect(gateConfirmReplace(session, { confirm_replace: true }).confirm_replace).toBe(false);
    session.memberSpokeAt = 1100;
    expect(gateConfirmReplace(session, { confirm_replace: true }).confirm_replace).toBe(true);
    // Other calls are untouched.
    const plain = { fact_key: 'k', fact_value: 'v' };
    expect(gateConfirmReplace({}, plain)).toBe(plain);
  });
});

describe('VTID-04863 an "already known" the member never said is not played yet (live B-CONF-06)', () => {
  const B_CONF_06 = 'merk dir meine frau hat am vierten november neunzehnhundertneunundneunzig geburtstag';
  const ALREADY_1997 =
    'STATUS: already_known. Nothing new to save: you already have spouse_birthday = "4 November 1997". Tell the member you already knew that.';

  it('the reply is held; the re-check finds the conflict and replaces it', async () => {
    const { client, callbacks, diag } = setup([ALREADY_1997]);
    backstopRuns.push(async (s) => {
      s.rememberNoteSentAt = Date.now(); // the re-check found spouse_birthday:conflict and told Nova
      return [{ fact_key: 'spouse_birthday', status: 'conflict' }];
    });
    client.said(B_CONF_06);
    // Live: Nova sent the STORED value, not what the member said.
    client.call('remember_fact', { about: 'other', fact_key: 'spouse_birthday', fact_value: '1997-11-04' });
    await flush();
    client.replies('Ich weiß bereits, dass der Geburtstag deiner Frau der vierte November ist.');
    client.audio(4);
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    client.done();
    await flush();
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    expect(diag('remember_hold_armed').map((d: any) => d.reason)).toContain('already_known_check');
    expect(diag('remember_hold_dropped').map((d: any) => d.outcome)).toContain('backstop_answered');
  });

  it('the re-check finds nothing new: the held reply plays', async () => {
    const { client, callbacks } = setup([ALREADY_1997]);
    backstopRuns.push(async () => [{ fact_key: 'spouse_birthday', status: 'already_known' }]);
    client.said(B_CONF_06);
    client.call('remember_fact', { about: 'other', fact_key: 'spouse_birthday', fact_value: '1997-11-04' });
    await flush();
    client.audio(3);
    client.done();
    await flush();
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(3);
  });

  it('live B-DUP-01: "Bello" again — the member said it, so the reply plays at once', async () => {
    const { client, callbacks } = setup([
      'STATUS: already_known. Nothing new to save: you already have dog_name = "bello". Tell the member you already knew that.',
    ]);
    client.said('merk dir mein hund heißt bello');
    client.call('remember_fact', { about: 'self', fact_key: 'dog_name', fact_value: 'bello' });
    await flush();
    client.audio(3);
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(3);
  });

  it('memberSaidValue: words and digits, never spoken numbers', () => {
    expect(memberSaidValue('merk dir mein hund heißt bello', 'bello')).toBe(true);
    expect(memberSaidValue('mein hund heißt bellona', 'bello')).toBe(false);
    expect(memberSaidValue('am 4.11.1997', '4 November 1997')).toBe(true);
    expect(memberSaidValue('am 4.11.1999', '4 November 1997')).toBe(false);
    expect(memberSaidValue(B_CONF_06, '4 November 1997')).toBe(false);
  });

  it('is off with ORB_REMEMBER_HOLD_ENABLED=false', async () => {
    process.env.ORB_REMEMBER_HOLD_ENABLED = 'false';
    const { client, callbacks } = setup([ALREADY_1997]);
    client.said(B_CONF_06);
    client.call('remember_fact', { about: 'other', fact_key: 'spouse_birthday', fact_value: '1997-11-04' });
    await flush();
    client.audio(2);
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
  });
});
