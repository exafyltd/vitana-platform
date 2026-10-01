/**
 * VTID-04771 — voice.model_under_responds / model_under_responds_r100plus
 *
 * When a tool call takes longer than the filler threshold
 * (voice.tool.filler_threshold_ms, default 300 ms), the tool result output
 * must carry a `speak_guidance` intent so the model produces audio
 * immediately rather than going silent.
 *
 * Constraints verified here:
 *  1. Fast tools (< threshold) → no speak_guidance injected.
 *  2. Slow tools (≥ threshold) with JSON output → speak_guidance added.
 *  3. Slow tools with plain-text output → wrapped in JSON with speak_guidance.
 *  4. Failed tools (success=false) → grace layer already handles them;
 *     filler must NOT overwrite the grace pivot guidance.
 *  5. emitDiag('tool_filler_injected') fires only on slow successful tools.
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

// ---------------------------------------------------------------------------
// Fake upstream client (same shape as vtid-04738 suite)
// ---------------------------------------------------------------------------

class FakeUpstreamClient implements UpstreamLiveClient {
  state: UpstreamConnectionState = 'open';
  toolResults: UpstreamToolResult[] = [];

  private transcriptH: ((e: TranscriptEvent) => void) | null = null;
  private turnH: ((e: TurnCompleteEvent) => void) | null = null;
  private audioH: ((e: AudioOutputEvent) => void) | null = null;
  private toolH: ((e: ToolCallEvent) => void) | null = null;

  async connect(_options: UpstreamConnectOptions): Promise<void> { this.state = 'open'; }
  sendAudioChunk(): boolean { return this.state === 'open'; }
  sendTextTurn(): boolean { return this.state === 'open'; }
  sendEndOfTurn(): boolean { return this.state === 'open'; }
  sendToolResult(result: UpstreamToolResult): boolean {
    this.toolResults.push(result);
    return this.state === 'open';
  }
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

  emitToolCall(name: string, id = 'call-1'): void {
    this.toolH?.({ calls: [{ id, name, args: { query: 'x' } }] } as any);
  }
  emitTurnComplete(): void { this.turnH?.({}); }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(over: Record<string, unknown> = {}): any {
  return {
    sessionId: 'sess-04771',
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
    detectStillHereComplaint,
    dispatchEndConversationDirective: jest.fn(dispatchEndConversationDirective),
    emitDiag: jest.fn(),
    emitLiveSessionEvent: jest.fn().mockResolvedValue(undefined),
    executeLiveApiTool: jest.fn().mockResolvedValue({ success: true, result: '{"ok":true}' }),
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
  };
  bindUpstreamSessionHandlers(ctx);
  return { session, client, callbacks, deps, ctx };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// Mock the filler threshold so tests don't depend on the real PolicyResolver
// ---------------------------------------------------------------------------

jest.mock('../../../../src/orb/upstream/constants', () => {
  const actual = jest.requireActual('../../../../src/orb/upstream/constants');
  return {
    ...actual,
    // Override only the filler threshold — everything else stays real.
    getToolFillerThresholdMs: jest.fn().mockReturnValue(300),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VTID-04771: tool filler speak_guidance for slow tools', () => {
  it('fast tool (< 300 ms): no speak_guidance injected into result output', async () => {
    // executeLiveApiTool resolves synchronously (0 ms elapsed)
    const { client, deps } = makeContext({
      deps: {
        executeLiveApiTool: jest.fn().mockResolvedValue({
          success: true,
          result: '{"data":"fast"}',
        }),
      },
    });

    client.emitToolCall('search_memory');
    await flush();

    expect(client.toolResults).toHaveLength(1);
    const output = JSON.parse(client.toolResults[0].output);
    expect(output).not.toHaveProperty('speak_guidance');
    expect(deps.emitDiag).not.toHaveBeenCalledWith(
      expect.anything(),
      'tool_filler_injected',
      expect.anything(),
    );
  });

  it('slow tool (≥ 300 ms) with JSON output: speak_guidance added', async () => {
    const { client, deps, session } = makeContext({
      deps: {
        executeLiveApiTool: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ success: true, result: '{"data":"slow"}' }),
                350,
              ),
            ),
        ),
      },
    });

    client.emitToolCall('get_calendar_events');
    await new Promise((r) => setTimeout(r, 400));
    await flush();

    expect(client.toolResults).toHaveLength(1);
    const output = JSON.parse(client.toolResults[0].output);
    expect(output).toHaveProperty('speak_guidance');
    expect(typeof output.speak_guidance).toBe('string');
    expect(output.speak_guidance.length).toBeGreaterThan(10);
    // Original data must be preserved
    expect(output.data).toBe('slow');
    expect(deps.emitDiag).toHaveBeenCalledWith(
      session,
      'tool_filler_injected',
      expect.objectContaining({ tool: 'get_calendar_events' }),
    );
  });

  it('slow tool with plain-text output: wrapped in JSON with speak_guidance', async () => {
    const { client, deps } = makeContext({
      deps: {
        executeLiveApiTool: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ success: true, result: 'plain text result' }),
                350,
              ),
            ),
        ),
      },
    });

    client.emitToolCall('search_web');
    await new Promise((r) => setTimeout(r, 400));
    await flush();

    expect(client.toolResults).toHaveLength(1);
    const output = JSON.parse(client.toolResults[0].output);
    expect(output).toHaveProperty('speak_guidance');
    expect(output).toHaveProperty('result', 'plain text result');
    expect(deps.emitDiag).toHaveBeenCalledWith(
      expect.anything(),
      'tool_filler_injected',
      expect.objectContaining({ wrapped: true }),
    );
  });

  it('slow tool that fails: grace layer pivot preserved, filler NOT injected', async () => {
    const { client, deps } = makeContext({
      deps: {
        executeLiveApiTool: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ success: false, result: '', error: 'db error' }),
                350,
              ),
            ),
        ),
      },
    });

    client.emitToolCall('save_note');
    await new Promise((r) => setTimeout(r, 400));
    await flush();

    expect(client.toolResults).toHaveLength(1);
    // graceToolResultForModel rewrites the output to a pivot guidance JSON
    const output = JSON.parse(client.toolResults[0].output);
    // The grace layer sets ok:false, available:false — filler must not overwrite
    expect(output).toHaveProperty('ok', false);
    expect(output).toHaveProperty('available', false);
    // The grace layer already carries speak_guidance — filler must not add a second one
    // (the grace layer's own speak_guidance is already there)
    expect(output).toHaveProperty('speak_guidance');
    // emitDiag('tool_filler_injected') must NOT have fired
    expect(deps.emitDiag).not.toHaveBeenCalledWith(
      expect.anything(),
      'tool_filler_injected',
      expect.anything(),
    );
  });

  it('slow tool with empty result: no filler injected (nothing to augment)', async () => {
    const { client, deps } = makeContext({
      deps: {
        executeLiveApiTool: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ success: true, result: '' }),
                350,
              ),
            ),
        ),
      },
    });

    client.emitToolCall('ping');
    await new Promise((r) => setTimeout(r, 400));
    await flush();

    expect(client.toolResults).toHaveLength(1);
    // Empty result → filler condition `filledOutput` is falsy → no injection
    expect(client.toolResults[0].output).toBe('');
    expect(deps.emitDiag).not.toHaveBeenCalledWith(
      expect.anything(),
      'tool_filler_injected',
      expect.anything(),
    );
  });

  it('slow tool: existing speak_guidance in result is not overwritten', async () => {
    const existingGuidance = 'Already has guidance from the tool itself.';
    const { client, deps } = makeContext({
      deps: {
        executeLiveApiTool: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    success: true,
                    result: JSON.stringify({
                      data: 'x',
                      speak_guidance: existingGuidance,
                    }),
                  }),
                350,
              ),
            ),
        ),
      },
    });

    client.emitToolCall('some_tool');
    await new Promise((r) => setTimeout(r, 400));
    await flush();

    expect(client.toolResults).toHaveLength(1);
    const output = JSON.parse(client.toolResults[0].output);
    // Must not overwrite the tool's own guidance
    expect(output.speak_guidance).toBe(existingGuidance);
    expect(deps.emitDiag).not.toHaveBeenCalledWith(
      expect.anything(),
      'tool_filler_injected',
      expect.anything(),
    );
  });
});
