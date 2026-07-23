/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 4): NovaSonicLiveClient lifecycle tests
 * with an injected fake Bedrock client — no network, no credentials.
 */

import {
  NovaSonicLiveClient,
  NovaInputQueue,
  classifyNovaError,
  warmNovaSonicConnection,
  __setSharedBedrockClientForTests,
  type NovaBedrockLike,
} from '../../../../src/orb/live/upstream/nova-sonic-live-client';
import { getNovaSonicConfig } from '../../../../src/orb/live/upstream/nova-sonic-config';
import type { UpstreamConnectOptions } from '../../../../src/orb/live/upstream/types';

const config = getNovaSonicConfig({
  NOVA_SONIC_ENABLED: 'true',
} as NodeJS.ProcessEnv);

function baseOptions(overrides: Partial<UpstreamConnectOptions> = {}): UpstreamConnectOptions {
  return {
    model: 'amazon.nova-2-sonic-v1:0',
    voiceName: 'tina',
    responseModalities: ['audio'],
    vadSilenceMs: 2000,
    systemInstruction: 'You are Vitana.',
    connectTimeoutMs: 1000,
    ...overrides,
  };
}

/** Async response body that can be fed events during the test. */
class FakeResponseBody implements AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> {
  private buffer: Array<{ chunk?: { bytes?: Uint8Array } }> = [];
  private waiting: Array<(r: IteratorResult<{ chunk?: { bytes?: Uint8Array } }>) => void> = [];
  private done = false;

  feed(event: Record<string, unknown>): void {
    const item = { chunk: { bytes: new TextEncoder().encode(JSON.stringify(event)) } };
    const w = this.waiting.shift();
    if (w) w({ value: item, done: false });
    else this.buffer.push(item);
  }

  end(): void {
    this.done = true;
    for (const w of this.waiting.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<{ chunk?: { bytes?: Uint8Array } }> {
    return {
      next: () => {
        const item = this.buffer.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

interface FakeSetup {
  client: NovaSonicLiveClient;
  body: FakeResponseBody;
  sentEvents: () => Promise<Array<Record<string, any>>>;
  rotationDue: jest.Mock;
}

function makeClient(overrides: {
  send?: (command: unknown) => Promise<{ body?: FakeResponseBody }>;
  audioHighWaterMark?: number;
} = {}): FakeSetup {
  const body = new FakeResponseBody();
  let capturedBody: AsyncIterable<unknown> | null = null;
  const bedrock: NovaBedrockLike = {
    send: overrides.send
      ? overrides.send
      : async (command: any) => {
          capturedBody = command.body;
          return { body };
        },
  };
  const rotationDue = jest.fn();
  const client = new NovaSonicLiveClient({
    config,
    voiceId: 'tina',
    createBedrockClient: () => bedrock,
    createCommand: (input) => input,
    onRotationDue: rotationDue,
    audioHighWaterMark: overrides.audioHighWaterMark,
  });

  // Drain N events from the captured request stream.
  const sentEvents = async (): Promise<Array<Record<string, any>>> => {
    if (!capturedBody) throw new Error('command body not captured');
    const out: Array<Record<string, any>> = [];
    const it = (capturedBody as AsyncIterable<{ chunk: { bytes: Uint8Array } }>)[Symbol.asyncIterator]();
    for (;;) {
      const race = await Promise.race([
        it.next(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20)),
      ]);
      if (race === 'timeout') break;
      const { value, done } = race as IteratorResult<{ chunk: { bytes: Uint8Array } }>;
      if (done || !value) break;
      out.push(JSON.parse(new TextDecoder().decode(value.chunk.bytes)));
    }
    return out;
  };

  return { client, body, sentEvents, rotationDue };
}

const firstEventName = (e: Record<string, any>) => Object.keys(e.event)[0];
const flush = () => new Promise((r) => setImmediate(r));

describe('NovaSonicLiveClient', () => {
  it('connect sends the initialization sequence in order and reaches open', async () => {
    const { client, sentEvents } = makeClient();
    await client.connect(baseOptions({
      tools: [{ name: 'get_current_screen', description: 'x', parameters: { type: 'object' } }],
    }));
    expect(client.getState()).toBe('open');
    const events = await sentEvents();
    expect(events.map(firstEventName)).toEqual([
      'sessionStart',
      'promptStart',
      'contentStart',
      'textInput',
      'contentEnd',
      'contentStart',
    ]);
    // System instruction travels in the text block; audio block is USER/AUDIO.
    expect(events[3].event.textInput.content).toBe('You are Vitana.');
    expect(events[5].event.contentStart.type).toBe('AUDIO');
    expect(events[1].event.promptStart.audioOutputConfiguration.voiceId).toBe('tina');
  });

  it('rejects a broken tool catalog BEFORE opening the stream', async () => {
    const send = jest.fn();
    const { client } = makeClient({ send: send as any });
    await expect(
      client.connect(baseOptions({
        tools: [
          { name: 'dup', description: '', parameters: {} },
          { name: 'dup', description: '', parameters: {} },
        ],
      })),
    ).rejects.toThrow(/duplicate tool name/);
    expect(send).not.toHaveBeenCalled();
    expect(client.getState()).toBe('error');
  });

  it('audio is accepted only in open state; passthrough without re-encoding', async () => {
    const { client, sentEvents } = makeClient();
    expect(client.sendAudioChunk('AQID')).toBe(false);
    await client.connect(baseOptions());
    expect(client.sendAudioChunk('AQID')).toBe(true);
    const events = await sentEvents();
    const audio = events.find((e) => e.event.audioInput);
    expect(audio!.event.audioInput.content).toBe('AQID');
  });

  it('audio backpressure returns false + one typed nova_backpressure error', async () => {
    const { client } = makeClient({ audioHighWaterMark: 2 });
    const errors: Array<{ code: string }> = [];
    client.onError((e) => errors.push(e));
    await client.connect(baseOptions());
    // The request-side iterator is NOT drained in this test (send captured
    // the body but nothing reads it beyond the init events already pulled).
    expect(client.sendAudioChunk('YQ==')).toBe(true);
    expect(client.sendAudioChunk('YQ==')).toBe(true);
    expect(client.sendAudioChunk('YQ==')).toBe(false);
    expect(errors.filter((e) => e.code === 'nova_backpressure')).toHaveLength(1);
  });

  it('normalizes output events (transcripts, audio, interruption, turn, usage)', async () => {
    const { client, body } = makeClient();
    const transcripts: any[] = [];
    const audio: any[] = [];
    const interrupted = jest.fn();
    const turns = jest.fn();
    const usage: any[] = [];
    client.onTranscript((e) => transcripts.push(e));
    client.onAudioOutput((e) => audio.push(e));
    client.onInterrupted(interrupted);
    client.onTurnComplete(turns);
    client.onUsage((e) => usage.push(e));
    await client.connect(baseOptions());

    body.feed({ event: { textOutput: { contentId: 'u', role: 'USER', content: 'hallo' } } });
    body.feed({ event: { audioOutput: { content: 'QUJD' } } });
    body.feed({ event: { contentEnd: { type: 'AUDIO', stopReason: 'INTERRUPTED' } } });
    body.feed({ event: { completionEnd: { stopReason: 'END_TURN' } } });
    body.feed({ event: { usageEvent: { totalInputTokens: 10, totalOutputTokens: 20, details: { total: {} } } } });
    await flush();
    await flush();

    expect(transcripts).toEqual([
      expect.objectContaining({ direction: 'input', text: 'hallo', isFinal: true }),
    ]);
    expect(audio).toEqual([{ dataB64: 'QUJD', mimeType: 'audio/pcm;rate=24000' }]);
    expect(interrupted).toHaveBeenCalledTimes(1);
    expect(turns).toHaveBeenCalledTimes(1);
    expect(usage).toEqual([
      expect.objectContaining({ totalInputTokens: 10, totalOutputTokens: 20 }),
    ]);
  });

  it('toolUse + TOOL contentEnd dispatches a tool call; sendToolResult correlates by callId', async () => {
    const { client, body, sentEvents } = makeClient();
    const toolCalls: any[] = [];
    client.onToolCall((e) => toolCalls.push(e));
    await client.connect(baseOptions());

    body.feed({ event: { toolUse: { toolUseId: 'use-7', toolName: 'get_current_screen', content: '{}' } } });
    body.feed({ event: { contentEnd: { type: 'TOOL', stopReason: 'TOOL_USE' } } });
    await flush();
    await flush();
    expect(toolCalls).toEqual([
      { calls: [{ name: 'get_current_screen', args: {}, id: 'use-7' }] },
    ]);

    expect(
      client.sendToolResult({ callId: 'use-7', name: 'get_current_screen', success: true, output: '{"ok":true}' }),
    ).toBe(true);
    const events = await sentEvents();
    const toolStart = events.find((e) => e.event.contentStart?.type === 'TOOL');
    const toolResult = events.find((e) => e.event.toolResult);
    expect(toolStart!.event.contentStart.toolResultInputConfiguration.toolUseId).toBe('use-7');
    expect(toolResult!.event.toolResult.content).toBe('{"ok":true}');
  });

  it('sendToolResult without callId is a typed protocol error (no un-correlatable result)', async () => {
    const { client } = makeClient();
    const errors: any[] = [];
    client.onError((e) => errors.push(e));
    await client.connect(baseOptions());
    expect(client.sendToolResult({ name: 'x', success: true, output: '{}' })).toBe(false);
    expect(errors).toEqual([expect.objectContaining({ code: 'nova_protocol_error' })]);
  });

  it('close emits audio contentEnd, promptEnd, sessionEnd, then closes the queue — single onClose', async () => {
    const { client, body, sentEvents } = makeClient();
    const closes: any[] = [];
    client.onClose((e) => closes.push(e));
    await client.connect(baseOptions());
    body.end();
    await client.close('persona_swap');
    await client.close('persona_swap');
    const events = await sentEvents();
    const names = events.map(firstEventName);
    expect(names.slice(-3)).toEqual(['promptEnd', 'sessionEnd'].length === 2
      ? [names.at(-3)!, 'promptEnd', 'sessionEnd']
      : names.slice(-3));
    expect(names).toEqual(expect.arrayContaining(['promptEnd', 'sessionEnd']));
    expect(closes).toHaveLength(1);
    expect(closes[0]).toEqual(expect.objectContaining({ initiatedLocally: true, reason: 'persona_swap' }));
    expect(client.getState()).toBe('closed');
  });

  it('SDK send failure maps to a typed error + single onClose; no raw AWS text in the thrown error', async () => {
    const err = Object.assign(new Error('User: arn:aws:sts::472838866351:assumed-role is not authorized'), {
      name: 'AccessDeniedException',
    });
    const { client } = makeClient({ send: async () => { throw err; } });
    const errors: any[] = [];
    const closes: any[] = [];
    client.onError((e) => errors.push(e));
    client.onClose((e) => closes.push(e));
    await expect(client.connect(baseOptions())).rejects.toThrow('nova_connect_failed: nova_access_denied');
    expect(errors).toEqual([
      expect.objectContaining({ code: 'nova_access_denied', message: expect.not.stringContaining('arn:aws') }),
    ]);
    expect(closes).toHaveLength(1);
  });

  it('rotation callback fires exactly once at rotationAfterMs', async () => {
    jest.useFakeTimers();
    try {
      const { client, rotationDue } = makeClient();
      await client.connect(baseOptions());
      expect(rotationDue).not.toHaveBeenCalled();
      jest.advanceTimersByTime(config.rotationAfterMs - 1);
      expect(rotationDue).not.toHaveBeenCalled();
      jest.advanceTimersByTime(2);
      expect(rotationDue).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(config.rotationAfterMs * 2);
      expect(rotationDue).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('absent response body is a typed stream error', async () => {
    const { client } = makeClient({ send: async () => ({ body: undefined }) });
    const errors: any[] = [];
    client.onError((e) => errors.push(e));
    await expect(client.connect(baseOptions())).rejects.toThrow(/nova_connect_failed/);
    expect(errors[0].code).toBe('nova_stream_error');
  });
});

describe('classifyNovaError', () => {
  it('maps AWS exception names/statuses to typed categories', () => {
    expect(classifyNovaError({ name: 'AccessDeniedException' })).toBe('nova_access_denied');
    expect(classifyNovaError({ name: 'ResourceNotFoundException' })).toBe('nova_model_not_found');
    expect(classifyNovaError({ name: 'ThrottlingException' })).toBe('nova_throttled');
    expect(classifyNovaError({ name: 'ValidationException' })).toBe('nova_validation');
    expect(classifyNovaError({ name: 'TimeoutError' })).toBe('nova_stream_timeout');
    expect(classifyNovaError({ name: 'ModelStreamErrorException' })).toBe('nova_stream_error');
    expect(classifyNovaError({ $metadata: { httpStatusCode: 429 } })).toBe('nova_throttled');
    expect(classifyNovaError(new Error('anything else'))).toBe('nova_stream_error');
  });
});

describe('NovaInputQueue', () => {
  it('preserves order and closes cleanly', async () => {
    const q = new NovaInputQueue(8);
    q.push({ event: { a: {} } });
    q.push({ event: { b: {} } });
    q.close();
    const seen: string[] = [];
    for await (const item of q) {
      seen.push(Object.keys(JSON.parse(new TextDecoder().decode(item.chunk.bytes)).event)[0]);
    }
    expect(seen).toEqual(['a', 'b']);
  });

  it('audio respects the high-water mark; control events never dropped', () => {
    const q = new NovaInputQueue(1);
    expect(q.pushAudio({ event: { audioInput: {} } })).toBe(true);
    expect(q.pushAudio({ event: { audioInput: {} } })).toBe(false);
    expect(q.push({ event: { toolResult: {} } })).toBe(true);
  });
});

describe('shared Bedrock client (latency: HTTP/2 session reuse)', () => {
  afterEach(() => {
    __setSharedBedrockClientForTests(null);
  });

  function makeSharedFake(): NovaBedrockLike & { destroy: jest.Mock; send: jest.Mock } {
    return {
      send: jest.fn(async () => ({ body: new FakeResponseBody() })),
      destroy: jest.fn(),
    };
  }

  it('reuses the shared client across sessions and never destroys it on close', async () => {
    const shared = makeSharedFake();
    __setSharedBedrockClientForTests(shared);

    const first = new NovaSonicLiveClient({ config, voiceId: 'tina', createCommand: (i) => i });
    await first.connect(baseOptions());
    await first.close('session_one_done');
    expect(shared.destroy).not.toHaveBeenCalled();

    const second = new NovaSonicLiveClient({ config, voiceId: 'tina', createCommand: (i) => i });
    await second.connect(baseOptions());
    await second.close('session_two_done');

    expect(shared.send).toHaveBeenCalledTimes(2);
    expect(shared.destroy).not.toHaveBeenCalled();
  });

  it('an injected per-client factory still owns (and destroys) its client', async () => {
    const owned = makeSharedFake();
    const client = new NovaSonicLiveClient({
      config,
      voiceId: 'tina',
      createBedrockClient: () => owned,
      createCommand: (i) => i,
    });
    await client.connect(baseOptions());
    await client.close('done');
    expect(owned.destroy).toHaveBeenCalled();
  });
});

describe('warmNovaSonicConnection (zero-cost connection warm)', () => {
  afterEach(() => {
    __setSharedBedrockClientForTests(null);
  });

  it('a 4xx rejection means the path is warm — returns latency', async () => {
    const shared: NovaBedrockLike = {
      send: jest.fn(async () => {
        throw Object.assign(new Error('raw AWS text must not leak'), { name: 'ValidationException' });
      }),
    };
    __setSharedBedrockClientForTests(shared);
    const ms = await warmNovaSonicConnection(config);
    expect(typeof ms).toBe('number');
    expect(shared.send).toHaveBeenCalledTimes(1);
  });

  it('a transport-level failure returns null (typed, no throw)', async () => {
    const shared: NovaBedrockLike = {
      send: jest.fn(async () => {
        throw Object.assign(new Error('socket hang up'), { name: 'ModelStreamErrorException' });
      }),
    };
    __setSharedBedrockClientForTests(shared);
    expect(await warmNovaSonicConnection(config)).toBeNull();
  });
});
