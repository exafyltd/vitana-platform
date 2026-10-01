/**
 * VTID-04619 — Vitana says she is opening a page but never calls navigate.
 *
 * Production 2026-09-26 09:17 UTC (session live-07f808a6, de, Nova Sonic):
 * the member said "okay, mach das" three times; each time Vitana answered
 * "Ich öffne jetzt die Seite mit …" with zero tool calls, the repeats were
 * muted as duplicate turns, and the member saw a silent Listening loop.
 * The gateway now runs the navigate tool itself when that happens.
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
import {
  buildBackstopNavigateQuestion,
  detectNavigationPromise,
} from '../../../../src/orb/live/session/navigation-promise-intent';
import {
  maybeRunNavigateBackstop,
  noteNavigateToolCall,
} from '../../../../src/orb/live/session/navigate-backstop-hook';
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
import * as fs from 'fs';
import * as path from 'path';

// The production replies, verbatim from the session's output transcripts.
const PROD_PROMISE =
  'Alles klar, ich öffne jetzt die Seite mit deinen Einstellungen für Erinnerungen und Privatsphäre.';

describe('VTID-04619 detectNavigationPromise', () => {
  it('recognises the production reply and other first-person promises', () => {
    for (const a of [
      PROD_PROMISE,
      'Ich öffne dir gleich die Einstellungen.',
      'Okay, ich öffne jetzt.',
      'Ich bringe dich zu deinen Terminen.',
      'Ich leite dich jetzt weiter.',
      'Ich führe dich zur Einstellungsseite.',
      "Sure, I'm opening your settings now.",
      "I'll take you to the privacy page.",
      'Opening the settings page now.',
    ]) {
      expect({ a, hit: detectNavigationPromise(a) }).toEqual({ a, hit: true });
    }
  });

  it('does not treat offers, questions or descriptions as a promise', () => {
    for (const a of [
      'Soll ich dir die Einstellungsseite öffnen?',
      'Möchtest du, dass ich die Seite öffne?',
      'Ich kann dir die Einstellungen zeigen, wenn du willst.',
      'Ich öffne jetzt die Seite?',
      'Want me to open your settings?',
      'Would you like me to take you there?',
      'In den Einstellungen findest du deine Privatsphäre-Optionen.',
      'Dein Geburtstag ist am 4. November.',
      '',
    ]) {
      expect({ a, hit: detectNavigationPromise(a) }).toEqual({ a, hit: false });
    }
  });

  it('a promise in one sentence counts even when another sentence is a question', () => {
    expect(detectNavigationPromise('Gute Idee. Ich öffne dir jetzt die Einstellungen. Noch etwas?')).toBe(true);
  });

  it('builds the navigate question from her words and the member\'s', () => {
    expect(buildBackstopNavigateQuestion(PROD_PROMISE, 'okay mach das')).toBe(`${PROD_PROMISE} — okay mach das`);
    expect(buildBackstopNavigateQuestion('x'.repeat(500), 'y'.repeat(500)).length).toBe(300 + 3 + 200);
  });
});

function hookCtx(result: any = { success: true, result: 'opens as soon as you finish speaking' }) {
  return {
    deps: {
      emitDiag: jest.fn(),
      executeLiveApiTool: jest.fn().mockResolvedValue(result),
    },
  };
}

function hookSession(over: Record<string, unknown> = {}): any {
  return {
    sessionId: 'sess-nav-1',
    active: true,
    identity: { user_id: 'u1', tenant_id: 't1' },
    turn_count: 3,
    ...over,
  };
}

describe('VTID-04619 maybeRunNavigateBackstop', () => {
  const OLD_ENV = process.env.ORB_NAVIGATE_BACKSTOP_ENABLED;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.ORB_NAVIGATE_BACKSTOP_ENABLED;
    else process.env.ORB_NAVIGATE_BACKSTOP_ENABLED = OLD_ENV;
  });

  it('runs navigate with intent "open" when Vitana promised and made no call', async () => {
    const ctx = hookCtx();
    const run = maybeRunNavigateBackstop(ctx as any, hookSession(), 'okay mach das', PROD_PROMISE);
    expect(run).not.toBeNull();
    await expect(run).resolves.toBe(true);
    expect(ctx.deps.executeLiveApiTool).toHaveBeenCalledWith(
      expect.anything(),
      'navigate',
      { question: `${PROD_PROMISE} — okay mach das`, intent: 'open' },
    );
    expect(ctx.deps.emitDiag).toHaveBeenCalledWith(
      expect.anything(),
      'navigate_backstop',
      expect.objectContaining({ ok: true }),
    );
  });

  it('does nothing when the model called navigate or navigate_to_screen this turn, and resets the marker', () => {
    for (const tool of ['navigate', 'navigate_to_screen']) {
      const ctx = hookCtx();
      const session = hookSession();
      noteNavigateToolCall(session, tool);
      expect(maybeRunNavigateBackstop(ctx as any, session, 'ja', PROD_PROMISE)).toBeNull();
      expect(session.navigateToolCalledThisTurn).toBe(false);
      expect(ctx.deps.executeLiveApiTool).not.toHaveBeenCalled();
    }
  });

  it('an unrelated tool call does not suppress it', () => {
    const session = hookSession();
    noteNavigateToolCall(session, 'search_memory');
    expect(session.navigateToolCalledThisTurn).toBeUndefined();
  });

  it('does nothing when a navigation is already under way', () => {
    const cases: Record<string, unknown>[] = [
      { pendingNavigation: { route: '/settings' } },
      { navigationDispatched: true },
      { navigationDispatchedTurn: 3, turn_count: 3 },
      // dispatched during the turn that just completed (turn_count already incremented)
      { navigationDispatchedTurn: 2, turn_count: 3 },
    ];
    for (const over of cases) {
      const ctx = hookCtx();
      expect({ over, run: maybeRunNavigateBackstop(ctx as any, hookSession(over), 'ja', PROD_PROMISE) })
        .toEqual({ over, run: null });
    }
  });

  it('a navigation from an older turn does not block it', () => {
    const ctx = hookCtx();
    expect(maybeRunNavigateBackstop(ctx as any, hookSession({ navigationDispatchedTurn: 1, turn_count: 3 }), 'ja', PROD_PROMISE))
      .not.toBeNull();
  });

  it('does nothing for an inactive or anonymous session, or without a promise', () => {
    const ctx = hookCtx();
    expect(maybeRunNavigateBackstop(ctx as any, hookSession({ active: false }), 'ja', PROD_PROMISE)).toBeNull();
    expect(maybeRunNavigateBackstop(ctx as any, hookSession({ identity: null }), 'ja', PROD_PROMISE)).toBeNull();
    expect(maybeRunNavigateBackstop(ctx as any, hookSession(), 'ja', 'Soll ich die Seite öffnen?')).toBeNull();
    expect(ctx.deps.executeLiveApiTool).not.toHaveBeenCalled();
  });

  it('ORB_NAVIGATE_BACKSTOP_ENABLED=false turns it off', () => {
    process.env.ORB_NAVIGATE_BACKSTOP_ENABLED = 'false';
    const ctx = hookCtx();
    expect(maybeRunNavigateBackstop(ctx as any, hookSession(), 'ja', PROD_PROMISE)).toBeNull();
  });

  it('never throws when the tool fails', async () => {
    const ctx = { deps: { emitDiag: jest.fn(), executeLiveApiTool: jest.fn().mockRejectedValue(new Error('boom')) } };
    await expect(maybeRunNavigateBackstop(ctx as any, hookSession(), 'ja', PROD_PROMISE)).resolves.toBe(false);
  });
});

/** Minimal fake of the UpstreamLiveClient contract (same shape as the VTID-04592 suite). */
class FakeUpstreamClient implements UpstreamLiveClient {
  state: UpstreamConnectionState = 'open';
  private transcriptH: ((e: TranscriptEvent) => void) | null = null;
  private turnH: ((e: TurnCompleteEvent) => void) | null = null;
  async connect(_options: UpstreamConnectOptions): Promise<void> { this.state = 'open'; }
  sendAudioChunk(): boolean { return this.state === 'open'; }
  sendTextTurn(): boolean { return this.state === 'open'; }
  sendEndOfTurn(): boolean { return this.state === 'open'; }
  sendToolResult(_result: UpstreamToolResult): boolean { return this.state === 'open'; }
  onAudioOutput(_h: (e: AudioOutputEvent) => void): void { /* unused */ }
  onTranscript(h: (e: TranscriptEvent) => void): void { this.transcriptH = h; }
  onToolCall(_h: (e: ToolCallEvent) => void): void { /* unused */ }
  onTurnComplete(h: (e: TurnCompleteEvent) => void): void { this.turnH = h; }
  onInterrupted(_h: (e: InterruptedEvent) => void): void { /* unused */ }
  onUsage(_h: (e: UpstreamUsageEvent) => void): void { /* unused */ }
  onError(_h: (e: UpstreamErrorEvent) => void): void { /* unused */ }
  onClose(_h: (e: UpstreamCloseEvent) => void): void { /* unused */ }
  async close(): Promise<void> { this.state = 'closed'; }
  getState(): UpstreamConnectionState { return this.state; }
  emitTranscript(e: TranscriptEvent): void { this.transcriptH?.(e); }
  emitTurnComplete(e: TurnCompleteEvent = {}): void { this.turnH?.(e); }
}

function handlerContext() {
  const session: any = {
    sessionId: 'sess-nav-handler',
    active: true,
    isModelSpeaking: false,
    audioOutChunks: 0,
    turn_count: 2,
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
    sseResponse: null,
    clientWs: { readyState: 1, send: jest.fn() },
    navigationDispatched: false,
    pendingNavigation: undefined,
  };
  const client = new FakeUpstreamClient();
  const deps: UpstreamMessageHandlerDeps = {
    clearResponseWatchdog: jest.fn(),
    detectAuthIntent: jest.fn().mockReturnValue(null),
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
  };
  const ctx: UpstreamSessionHandlerContext = {
    session,
    client,
    callbacks: {
      onAudioResponse: jest.fn(),
      onTextResponse: jest.fn(),
      onError: jest.fn(),
      onTurnComplete: jest.fn(),
      onInterrupted: jest.fn(),
    },
    deps,
  };
  bindUpstreamSessionHandlers(ctx);
  return { session, client, deps };
}

describe('VTID-04619 backstop fires through the real handler', () => {
  it('navigates once when the member says "okay mach das" and Vitana promises without a call', () => {
    const { client, deps } = handlerContext();
    client.emitTranscript({ direction: 'input', text: 'okay mach das', isFinal: true });
    client.emitTranscript({ direction: 'output', text: PROD_PROMISE, isFinal: true });
    client.emitTurnComplete({});
    const navCalls = (deps.executeLiveApiTool as jest.Mock).mock.calls.filter((c) => c[1] === 'navigate');
    expect(navCalls).toHaveLength(1);
    expect(navCalls[0][2]).toEqual({ question: expect.stringContaining('ich öffne jetzt die Seite'), intent: 'open' });
  });

  it('does not navigate on an ordinary answer', () => {
    const { client, deps } = handlerContext();
    client.emitTranscript({ direction: 'input', text: 'erinnerst du dich an den geburtstag meiner frau', isFinal: true });
    client.emitTranscript({ direction: 'output', text: 'Ja, ihr Geburtstag ist am 4. November.', isFinal: true });
    client.emitTurnComplete({});
    expect((deps.executeLiveApiTool as jest.Mock).mock.calls.filter((c) => c[1] === 'navigate')).toHaveLength(0);
  });

  it('the handler notes navigate tool calls in both tool loops', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../../src/orb/live/session/upstream-message-handler.ts'),
      'utf8',
    );
    expect(src.match(/noteNavigateToolCall\(session, toolName\)/g)?.length).toBe(2);
    expect(src).toMatch(/maybeRunNavigateBackstop\(ctx, session, userText, session\.outputTranscriptBuffer \|\| ''\)/);
  });
});
