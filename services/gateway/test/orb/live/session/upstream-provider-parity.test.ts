/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 6): cross-provider session parity.
 *
 * The same scripted conversation is driven through
 * `bindUpstreamSessionHandlers` twice — once with a Vertex-flavored fake
 * (streaming transcript deltas, `isFinal:false`) and once with a
 * Nova-flavored fake (final user ASR, speculative→FINAL assistant text,
 * 24 kHz audio) — and the browser-level event stream must be identical.
 */

import {
  bindUpstreamSessionHandlers,
  type UpstreamSessionHandlerContext,
  type UpstreamMessageHandlerDeps,
} from '../../../../src/orb/live/session/upstream-message-handler';
import { createNovaWsFacade } from '../../../../src/orb/live/upstream/nova-ws-facade';
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

class ScriptableClient implements UpstreamLiveClient {
  state: UpstreamConnectionState = 'open';
  sentToolResults: UpstreamToolResult[] = [];
  sentText: Array<{ text: string; turnComplete: boolean }> = [];
  sentAudio: Array<{ b64: string; mime?: string }> = [];
  endOfTurns = 0;
  closeReasons: Array<string | undefined> = [];

  h: Record<string, ((e: any) => void) | undefined> = {};

  async connect(_o: UpstreamConnectOptions): Promise<void> { this.state = 'open'; }
  sendAudioChunk(b64: string, mime?: string): boolean {
    if (this.state !== 'open') return false;
    this.sentAudio.push({ b64, mime });
    return true;
  }
  sendTextTurn(text: string, turnComplete = true): boolean {
    if (this.state !== 'open') return false;
    this.sentText.push({ text, turnComplete });
    return true;
  }
  sendEndOfTurn(): boolean {
    if (this.state !== 'open') return false;
    this.endOfTurns++;
    return true;
  }
  sendToolResult(r: UpstreamToolResult): boolean {
    if (this.state !== 'open') return false;
    this.sentToolResults.push(r);
    return true;
  }
  onAudioOutput(h: (e: AudioOutputEvent) => void): void { this.h.audio = h; }
  onTranscript(h: (e: TranscriptEvent) => void): void { this.h.transcript = h; }
  onToolCall(h: (e: ToolCallEvent) => void): void { this.h.tool = h; }
  onTurnComplete(h: (e: TurnCompleteEvent) => void): void { this.h.turn = h; }
  onInterrupted(h: (e: InterruptedEvent) => void): void { this.h.interrupted = h; }
  onUsage(h: (e: UpstreamUsageEvent) => void): void { this.h.usage = h; }
  onError(h: (e: UpstreamErrorEvent) => void): void { this.h.error = h; }
  onClose(h: (e: UpstreamCloseEvent) => void): void { this.h.close = h; }
  async close(reason?: string): Promise<void> {
    this.closeReasons.push(reason);
    this.state = 'closed';
    this.h.close?.({ initiatedLocally: true, reason });
  }
  getState(): UpstreamConnectionState { return this.state; }
}

interface BrowserEvent { type: string; [k: string]: unknown }

function makeHarness() {
  const browserEvents: BrowserEvent[] = [];
  const session: any = {
    sessionId: 's',
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
    // Capture SSE writes as browser-level events.
    sseResponse: {
      write: (raw: string) => {
        const m = raw.match(/^data: (.*)\n\n$/s);
        if (m) browserEvents.push(JSON.parse(m[1]));
      },
      writableEnded: false,
    },
    clientWs: null,
    navigationDispatched: false,
  };
  const client = new ScriptableClient();
  const deps: UpstreamMessageHandlerDeps = {
    clearResponseWatchdog: jest.fn(),
    detectAuthIntent: jest.fn().mockReturnValue(null),
    emitDiag: jest.fn(),
    emitLiveSessionEvent: jest.fn().mockResolvedValue(undefined),
    executeLiveApiTool: jest.fn().mockResolvedValue({ success: true, result: '{"screen":"journey"}' }),
    isDevSandbox: jest.fn().mockReturnValue(false),
    sendAudioToLiveAPI: jest.fn().mockReturnValue(true),
    sendFunctionResponseToLiveAPI: jest.fn().mockReturnValue(true),
    sendWsMessage: jest.fn(),
    markVoiceLatency: jest.fn(),
    finalizeVoiceTurnLatency: jest.fn(),
    startResponseWatchdog: jest.fn(),
  };
  const callbacks = {
    onAudioResponse: (b64: string) => browserEvents.push({ type: 'audio_out', b64, mime: 'audio/pcm;rate=24000' }),
    onTextResponse: jest.fn(),
    onError: jest.fn(),
    onTurnComplete: () => browserEvents.push({ type: 'turn_complete_cb' }),
    onInterrupted: () => browserEvents.push({ type: 'interrupted_cb' }),
  };
  const ctx: UpstreamSessionHandlerContext = { session, client, callbacks, deps };
  bindUpstreamSessionHandlers(ctx);
  return { session, client, browserEvents };
}

const flush = () => new Promise((r) => setImmediate(r));

/** The scripted conversation, per provider flavor. */
async function runScript(flavor: 'vertex' | 'nova') {
  const h = makeHarness();
  const { client } = h;

  // 1. User speaks.
  if (flavor === 'vertex') {
    client.h.transcript!({ direction: 'input', text: 'wie', isFinal: false });
    client.h.transcript!({ direction: 'input', text: 'gehts', isFinal: false });
  } else {
    client.h.transcript!({ direction: 'input', text: 'wie gehts', isFinal: true });
  }

  // 2. Model responds with audio + transcript.
  client.h.audio!({ dataB64: 'AQID', mimeType: 'audio/pcm;rate=24000' });
  if (flavor === 'vertex') {
    client.h.transcript!({ direction: 'output', text: 'Mir geht es ', isFinal: false });
    client.h.transcript!({ direction: 'output', text: 'gut!', isFinal: false });
  } else {
    client.h.transcript!({ direction: 'output', text: 'Mir geht es ', isFinal: false, generationStage: 'SPECULATIVE' });
    client.h.transcript!({ direction: 'output', text: 'gut!', isFinal: false, generationStage: 'SPECULATIVE' });
    client.h.transcript!({ direction: 'output', text: 'Mir geht es gut!', isFinal: true, generationStage: 'FINAL' });
  }

  // 3. Tool call mid-conversation.
  client.h.tool!({ calls: [{ id: 't1', name: 'get_current_screen', args: {} }] });
  await flush();

  // 4. Turn completes.
  client.h.turn!({});

  // 5. User interrupts the next turn.
  client.h.audio!({ dataB64: 'BBBB', mimeType: 'audio/pcm;rate=24000' });
  client.h.interrupted!({});

  return h;
}

// Normalize: drop provider-internal noise and coalesce transcript
// fragments. Vertex streams deltas ("wie" + "gehts"), Nova sends the final
// utterance in one event — the widget renders the concatenation, so parity
// is judged on the user-visible text, not fragment boundaries.
function browserView(events: BrowserEvent[]): BrowserEvent[] {
  const out: BrowserEvent[] = [];
  for (const e of events.filter((ev) => ev.type !== 'thinking')) {
    const prev = out.at(-1);
    if (
      prev &&
      (e.type === 'input_transcript' || e.type === 'output_transcript') &&
      prev.type === e.type
    ) {
      const sep = e.type === 'input_transcript' ? ' ' : '';
      prev.text = `${prev.text}${sep}${e.text}`;
      continue;
    }
    out.push({ ...e });
  }
  return out;
}

describe('cross-provider session parity (vertex vs nova flavors)', () => {
  it('produces an identical browser-level event stream', async () => {
    const vertex = await runScript('vertex');
    const nova = await runScript('nova');
    expect(browserView(nova.browserEvents)).toEqual(browserView(vertex.browserEvents));
    expect(browserView(nova.browserEvents)).toEqual([
      expect.objectContaining({ type: 'input_transcript', text: 'wie gehts' }),
      expect.objectContaining({ type: 'audio_out', mime: 'audio/pcm;rate=24000' }),
      expect.objectContaining({ type: 'output_transcript', text: 'Mir geht es gut!' }),
      expect.objectContaining({ type: 'turn_complete' }),
      { type: 'turn_complete_cb' },
      expect.objectContaining({ type: 'audio_out' }),
      expect.objectContaining({ type: 'interrupted' }),
      { type: 'interrupted_cb' },
    ]);
  });

  it('persists the same final transcript turns on both providers', async () => {
    const vertex = await runScript('vertex');
    const nova = await runScript('nova');
    // Vertex accumulates deltas with input-space joining; Nova's FINAL
    // replaces the speculative buffer. Both end at the same conversation.
    expect(vertex.session.transcriptTurns.map((t: any) => [t.role, t.text])).toEqual([
      ['user', 'wie gehts'],
      ['assistant', 'Mir geht es gut!'],
    ]);
    expect(nova.session.transcriptTurns.map((t: any) => [t.role, t.text])).toEqual([
      ['user', 'wie gehts'],
      ['assistant', 'Mir geht es gut!'],
    ]);
  });

  it('answers the tool call through sendToolResult on both providers', async () => {
    for (const flavor of ['vertex', 'nova'] as const) {
      const h = await runScript(flavor);
      expect(h.client.sentToolResults).toEqual([
        expect.objectContaining({ callId: 't1', name: 'get_current_screen', success: true }),
      ]);
    }
  });

  it('interruption clears the pending output buffer on both providers', async () => {
    for (const flavor of ['vertex', 'nova'] as const) {
      const h = await runScript(flavor);
      expect(h.session.outputTranscriptBuffer).toBe('');
      expect(h.session.isModelSpeaking).toBe(false);
    }
  });
});

describe('nova ws-facade translates legacy route envelopes', () => {
  it('realtime_input → sendAudioChunk (b64 passthrough)', () => {
    const client = new ScriptableClient();
    const facade = createNovaWsFacade(client);
    facade.send(JSON.stringify({
      realtime_input: { media_chunks: [{ mime_type: 'audio/pcm;rate=16000', data: 'AQID' }] },
    }));
    expect(client.sentAudio).toEqual([{ b64: 'AQID', mime: 'audio/pcm;rate=16000' }]);
  });

  it('client_content text turn → sendTextTurn; bare turn_complete → sendEndOfTurn', () => {
    const client = new ScriptableClient();
    const facade = createNovaWsFacade(client);
    facade.send(JSON.stringify({
      client_content: { turns: [{ role: 'user', parts: [{ text: 'Sag hallo' }] }], turn_complete: true },
    }));
    expect(client.sentText).toEqual([{ text: 'Sag hallo', turnComplete: true }]);
    facade.send(JSON.stringify({ client_content: { turn_complete: true } }));
    expect(client.endOfTurns).toBe(1);
  });

  it('tool_response envelopes are refused (must flow via sendToolResult)', () => {
    const client = new ScriptableClient();
    const facade = createNovaWsFacade(client);
    facade.send(JSON.stringify({ tool_response: { function_responses: [{ name: 'x', response: {} }] } }));
    expect(client.sentToolResults).toEqual([]);
  });

  it('readyState mirrors client state; close forwards the reason', async () => {
    const client = new ScriptableClient();
    const facade = createNovaWsFacade(client);
    expect(facade.readyState).toBe(1);
    facade.close(1000, 'persona_swap');
    await flush();
    expect(client.closeReasons).toEqual(['persona_swap']);
    expect(facade.readyState).toBe(3);
  });
});
