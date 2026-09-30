/**
 * VTID-04753: the member never hears a refusal about their own people.
 *
 * Staging, 2026-09-30, "wie heißt meine Frau" with no spouse fact stored and
 * the VTID-04729 prompt fixes confirmed in the live instruction: Nova's first
 * reply still refused in 3 of 4 runs — "Tut mir leid, aber ich kann diese
 * persönliche Information nicht teilen. Solche Details kannst du nur in deinem
 * Profil …". The recall backstop corrected it, after the member had heard it.
 * The reply of a question about the member's own details is now held until it
 * is plainly fine; these tests drive the real shared handler and the real
 * recall backstop.
 */

const recallFacts: { current: Array<{ fact_key: string; fact_value: string; provenance_source?: string }> } = { current: [] };
const recallRuns: Array<'real' | 'none'> = [];
jest.mock('../../../../src/orb/live/session/remember-backstop-hook', () => {
  const actual = jest.requireActual('../../../../src/orb/live/session/remember-backstop-hook');
  return {
    ...actual,
    maybeRunRememberBackstop: jest.fn(() => null),
    maybeRunForgetBackstop: jest.fn(() => null),
    // The real recall backstop, reading the test's facts.
    maybeRunRecallBackstop: jest.fn((ctx: any, session: any, userText: string, reply: string) =>
      (recallRuns.shift() ?? 'real') === 'none'
        ? null
        : actual.maybeRunRecallBackstop(ctx, session, userText, reply, {
            listCurrentFacts: async () => recallFacts.current,
          }),
    ),
  };
});

import {
  bindUpstreamSessionHandlers,
  type UpstreamMessageHandlerDeps,
  type UpstreamSessionHandlerContext,
} from '../../../../src/orb/live/session/upstream-message-handler';
import { judgeRecallReply, setRecallHoldFactsLoader, isHeldRecallQuestion } from '../../../../src/orb/live/session/recall-hold';
import { buildNothingStoredNote, buildRecallBackstopNote } from '../../../../src/services/memory/recall-backstop';
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
  const notes: string[] = [];
  const session: any = {
    sessionId: 'sess-recall-hold',
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
    upstreamClient: { sendTextTurn: (t: string) => { notes.push(t); return true; } },
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
    executeLiveApiTool: jest.fn().mockResolvedValue({ success: true, result: 'Keine Treffer.' }),
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
  const diag = (stage: string) => (deps.emitDiag as jest.Mock).mock.calls.filter((c) => c[1] === stage).map((c) => c[2]);
  return { session, client, callbacks, deps, spokenText, notes, diag };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

// What the live replies on staging said.
const LIVE_REFUSAL =
  'Tut mir leid, aber ich kann diese persönliche Information nicht teilen. Solche Details kannst du nur in deinem Profil einsehen.';
const LIVE_DEFLECTION =
  'Ich muss auf deine Profileinstellungen zugreifen. Möchtest du, dass ich dich zu deinen Profileinstellungen führe, wo du diese Details einsehen kannst?';
const NOTHING_STORED = [{ fact_key: 'preferred_language', fact_value: 'de' }];
const SPOUSE_STORED = [
  { fact_key: 'preferred_language', fact_value: 'de' },
  { fact_key: 'spouse_name', fact_value: 'Anna', provenance_source: 'user_stated' },
  { fact_key: 'spouse_birthday', fact_value: '12. März', provenance_source: 'user_stated' },
];
const OTHER_STORED = [{ fact_key: 'user_pet_name', fact_value: 'Bello', provenance_source: 'user_stated' }];

beforeEach(() => {
  recallRuns.length = 0;
  delete process.env.ORB_RECALL_HOLD_ENABLED;
  delete process.env.ORB_REMEMBER_HOLD_ENABLED;
  setRecallHoldFactsLoader(async () => recallFacts.current);
});
afterAll(() => setRecallHoldFactsLoader(null));

describe('VTID-04753 a refusal about the member\'s own people is never heard', () => {
  it('live 2026-09-30: the privacy refusal is held and dropped; only the answer to the backstop note plays', async () => {
    recallFacts.current = NOTHING_STORED;
    const { client, callbacks, spokenText, notes, diag } = setup();
    client.said('wie heißt meine frau');
    await flush();
    client.replies(LIVE_REFUSAL);
    client.audio(5);
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    expect(spokenText()).not.toMatch(/nicht teilen/);
    expect(diag('recall_hold_suspect')).toHaveLength(1);

    client.done();
    await flush();
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    expect(spokenText()).not.toMatch(/nicht teilen/);
    expect(notes).toHaveLength(1);
    // The member heard nothing: the note asks for a first answer, not a correction.
    expect(notes[0]).toMatch(/did not hear your previous answer/);
    expect(notes[0]).toMatch(/do not have it yet/);
    expect(notes[0]).not.toMatch(/Correct your answer/);
    expect(diag('remember_hold_dropped').map((d: any) => d.outcome)).toEqual(['backstop_answered']);
    expect(diag('recall_backstop')[0]).toMatchObject({ trigger: 'privacy_refusal', reply_held: true });

    // The reply to the note plays live.
    client.replies('Das weiß ich noch nicht. Wie heißt sie denn?');
    client.audio(2);
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
    expect(spokenText()).toMatch(/Wie heißt sie denn/);
  });

  it('the profile detour is held and dropped the same way', async () => {
    recallFacts.current = NOTHING_STORED;
    const { client, callbacks, spokenText, notes } = setup();
    client.said('wie heißt meine frau');
    await flush();
    client.replies(LIVE_DEFLECTION);
    client.audio(4);
    client.done();
    await flush();
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    expect(spokenText()).not.toMatch(/Profileinstellungen/);
    expect(notes[0]).toMatch(/profile or settings/);
    expect(notes[0]).toMatch(/did not hear your previous answer/);
  });

  it('a refusal is held even before the facts are read', async () => {
    let resolve!: (f: any[]) => void;
    setRecallHoldFactsLoader(() => new Promise((r) => { resolve = r; }));
    recallFacts.current = NOTHING_STORED;
    const { client, callbacks } = setup();
    client.said('wie heißt meine frau');
    client.replies(LIVE_REFUSAL);
    client.audio(3);
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    resolve(NOTHING_STORED);
    await flush();
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
  });

  it('an invented birthday is held and dropped (live VTID-04704 shape)', async () => {
    recallFacts.current = NOTHING_STORED;
    const { client, callbacks, spokenText, notes } = setup();
    client.said('erinnerst du dich an den geburtstag meiner frau');
    await flush();
    client.replies('Natürlich! Deine Frau hat am 23. April Geburtstag.');
    client.audio(3);
    client.done();
    await flush();
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    expect(spokenText()).not.toMatch(/23\. April/);
    expect(notes[0]).toMatch(/date was a guess/);
    expect(notes[0]).toMatch(/did not hear your previous answer/);
  });

  it('"not stored yet" with other facts stored is held: the backstop offers them and her answer to that plays once', async () => {
    recallFacts.current = OTHER_STORED;
    const { client, callbacks, notes } = setup();
    client.said('wie heißt meine frau');
    await flush();
    client.replies('Den Namen deiner Frau habe ich leider nicht gespeichert.');
    client.audio(3);
    client.done();
    await flush();
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    expect(notes[0]).toMatch(/user_pet_name: Bello/);
    expect(notes[0]).toMatch(/did not hear your previous answer/);
    expect(notes[0]).not.toMatch(/correct your previous answer/);
  });
});

describe('VTID-04753 a right answer is not held back', () => {
  it('the stored name plays as soon as its text arrives, before turn_complete', async () => {
    recallFacts.current = SPOUSE_STORED;
    const { client, callbacks, spokenText, notes, diag } = setup();
    client.said('wie heißt meine frau');
    await flush();
    client.audio(3); // audio that came before its text is held briefly …
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
    client.replies('Deine Frau heißt Anna.'); // … and released with it
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(3);
    client.audio(2);
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(5);
    expect(spokenText()).toMatch(/Anna/);
    expect(diag('remember_hold_released').map((d: any) => d.outcome)).toEqual(['reply_clean']);
    client.done();
    await flush();
    expect(notes).toHaveLength(0);
  });

  it('the stored birthday plays before turn_complete', async () => {
    recallFacts.current = SPOUSE_STORED;
    const { client, callbacks } = setup();
    client.said('wann hat meine frau geburtstag');
    await flush();
    client.replies('Deine Frau hat am 12. März Geburtstag.');
    client.audio(3);
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(3);
  });

  it('an honest "not stored yet" with nothing stored plays live and is not repeated', async () => {
    recallFacts.current = NOTHING_STORED;
    const { client, callbacks, notes } = setup();
    client.said('wie heißt meine frau');
    await flush();
    client.replies('Das habe ich noch nicht gespeichert. Wie heißt sie denn?');
    client.audio(3);
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(3);
    client.done();
    await flush();
    expect(notes).toHaveLength(0);
  });

  it('a plain first sentence is released without waiting for the facts', () => {
    setRecallHoldFactsLoader(() => new Promise(() => {}));
    const { client, callbacks } = setup();
    client.said('was ist meine lieblingsfarbe');
    client.replies('Deine Lieblingsfarbe ist Blau.');
    client.audio(2);
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
  });

  it('a question that is not about the member, or is about the app, plays live', async () => {
    const a = setup();
    a.client.said('wie wird das wetter morgen');
    a.client.audio(2);
    expect(a.callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
    const b = setup();
    b.client.said('wo finde ich meine einstellungen');
    b.client.audio(2);
    expect(b.callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
  });
});

describe('VTID-04753 tool calls, fallbacks and switches', () => {
  it('"let me check" plays at the tool result; a refusal after the result is held', async () => {
    recallFacts.current = NOTHING_STORED;
    const { client, callbacks, spokenText, notes } = setup();
    client.said('wie heißt meine frau');
    await flush();
    client.replies('Lass mich kurz nachsehen.');
    client.audio(2);
    client.tool('search_memory');
    await flush();
    expect(client.toolResults).toHaveLength(1);
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
    client.replies('Tut mir leid, das kann ich aus Datenschutzgründen nicht preisgeben.');
    client.audio(3);
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
    client.done();
    await flush();
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
    expect(spokenText()).not.toMatch(/Datenschutz/);
    expect(notes[0]).toMatch(/did not hear your previous answer/);
  });

  it('the backstop did not run: the held reply still plays, never silence', async () => {
    recallFacts.current = NOTHING_STORED;
    recallRuns.push('none');
    const { client, callbacks } = setup();
    client.said('wie heißt meine frau');
    await flush();
    client.replies(LIVE_REFUSAL);
    client.audio(4);
    client.done();
    await flush();
    expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(4);
  });

  it('releases at the maximum even when nothing else arrives', () => {
    // Nova stalls mid-reply with no END_TURN (the VTID-04747 soft end, which
    // would complete the turn, is off here).
    process.env.ORB_SOFT_TURN_END_MS = '0';
    jest.useFakeTimers();
    try {
      recallFacts.current = NOTHING_STORED;
      const { client, callbacks } = setup();
      client.said('wie heißt meine frau');
      client.replies(LIVE_REFUSAL);
      client.audio(3);
      expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
      jest.advanceTimersByTime(15_001);
      expect(callbacks.onAudioResponse).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
      delete process.env.ORB_SOFT_TURN_END_MS;
    }
  });

  it('a held reply cut off by the member is never played', async () => {
    recallFacts.current = NOTHING_STORED;
    const { client, callbacks } = setup();
    client.said('wie heißt meine frau');
    await flush();
    client.replies(LIVE_REFUSAL);
    client.audio(3);
    client.interrupt();
    await flush();
    expect(callbacks.onAudioResponse).not.toHaveBeenCalled();
  });

  it('is off with ORB_RECALL_HOLD_ENABLED=false, ORB_REMEMBER_HOLD_ENABLED=false, and for a non-Nova session', async () => {
    recallFacts.current = NOTHING_STORED;
    process.env.ORB_RECALL_HOLD_ENABLED = 'false';
    const a = setup();
    a.client.said('wie heißt meine frau');
    a.client.replies(LIVE_REFUSAL);
    a.client.audio(2);
    expect(a.callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
    delete process.env.ORB_RECALL_HOLD_ENABLED;
    process.env.ORB_REMEMBER_HOLD_ENABLED = 'false';
    const b = setup();
    b.client.said('wie heißt meine frau');
    b.client.replies(LIVE_REFUSAL);
    b.client.audio(2);
    expect(b.callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
    delete process.env.ORB_REMEMBER_HOLD_ENABLED;
    const c = setup({ upstreamProvider: 'vertex' });
    c.client.said('wie heißt meine frau');
    c.client.replies(LIVE_REFUSAL);
    c.client.audio(2);
    expect(c.callbacks.onAudioResponse).toHaveBeenCalledTimes(2);
  });

  it('a remember request is the remember hold\'s, never a recall hold', () => {
    expect(isHeldRecallQuestion('merk dir bitte wie meine frau heißt: anna')).toBe(false);
    expect(isHeldRecallQuestion('was weißt du über mich')).toBe(false);
    expect(isHeldRecallQuestion('wie heißt meine frau')).toBe(true);
    expect(isHeldRecallQuestion('erinnerst du dich an den geburtstag meiner frau')).toBe(true);
  });
});

describe('VTID-04753 judgeRecallReply mirrors the recall backstop', () => {
  const Q = 'wie heißt meine frau';
  it('suspect: refusals and detours, whatever is stored', () => {
    expect(judgeRecallReply(Q, LIVE_REFUSAL, null)).toBe('suspect');
    expect(judgeRecallReply(Q, LIVE_DEFLECTION, null)).toBe('suspect');
    expect(judgeRecallReply(Q, 'Tut mir leid, aber ich kann keine persönlichen Informationen über andere Personen preisgeben.', NOTHING_STORED)).toBe('suspect');
  });
  it('an honest denial: waits for the facts, then suspect only when something could answer it', () => {
    const r = 'Den Namen deiner Frau habe ich leider nicht gespeichert.';
    expect(judgeRecallReply(Q, r, null)).toBe('wait');
    expect(judgeRecallReply(Q, r, NOTHING_STORED)).toBe('clean');
    expect(judgeRecallReply(Q, r, OTHER_STORED)).toBe('suspect');
  });
  it('a stored value is clean, even inside a hedge', () => {
    expect(judgeRecallReply(Q, 'Einen Moment … deine Frau heißt Anna.', SPOUSE_STORED)).toBe('clean');
  });
  it('dates: a stored date is clean, an invented one suspect', () => {
    const D = 'erinnerst du dich an den geburtstag meiner frau';
    expect(judgeRecallReply(D, 'Natürlich! Am 23. April.', null)).toBe('wait');
    expect(judgeRecallReply(D, 'Natürlich! Am 23. April.', NOTHING_STORED)).toBe('suspect');
    expect(judgeRecallReply(D, 'Natürlich! Am 12. März.', SPOUSE_STORED)).toBe('clean');
    // The date may follow in the second sentence: one sentence is not enough.
    expect(judgeRecallReply(D, 'Natürlich erinnere ich mich daran!', SPOUSE_STORED)).toBe('wait');
  });
  it('waits for a complete first sentence', () => {
    expect(judgeRecallReply(Q, 'Deine Frau', null)).toBe('wait');
    expect(judgeRecallReply(Q, 'Deine Frau heißt Maria, oder?', null)).toBe('clean');
  });
});

describe('VTID-04753 note wording when the reply was held', () => {
  it('asks for a first answer, not a correction', () => {
    expect(buildNothingStoredNote('privacy_refusal', true)).toMatch(/did not hear your previous answer/);
    expect(buildNothingStoredNote('privacy_refusal', true)).not.toMatch(/Correct your answer/);
    expect(buildNothingStoredNote('privacy_refusal')).toMatch(/Correct your answer/);
    expect(buildRecallBackstopNote(OTHER_STORED, 'wie heißt meine frau', 'denied', true)).toMatch(/did not hear your previous answer/);
    expect(buildRecallBackstopNote(OTHER_STORED, 'wie heißt meine frau', 'denied', true)).not.toMatch(/correct your previous answer/);
    expect(buildRecallBackstopNote(OTHER_STORED, 'wie heißt meine frau', 'denied')).toMatch(/correct your previous answer plainly/);
    expect(buildRecallBackstopNote(OTHER_STORED, 'x', 'unstored_date', true)).not.toMatch(/you got it wrong/);
  });
  it('no spoken sentence is written into the note (CLAUDE.md rule 41)', () => {
    const note = buildNothingStoredNote('privacy_refusal', true);
    expect(note).not.toMatch(/"[^"]*(weiß|heißt|habe)[^"]*"/);
  });
});
