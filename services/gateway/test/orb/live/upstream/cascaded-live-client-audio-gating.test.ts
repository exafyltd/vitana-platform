/**
 * VTID-03986 — cascade voice latency escalated turn over turn on a real
 * staging session (measured: 8.7s -> 16.6s -> 35s -> 43s), reported live by
 * the platform owner immediately after Fish Audio (VTID-03984) made a
 * cascade-eligible language reachable for the first time.
 *
 * Root cause: VTID-03706's full-duplex mode (staging-only) forwards a
 * continuous audio frame for the ENTIRE session — real speech above the
 * echo floor, digital silence below it — so Nova Sonic's own native VAD and
 * barge-in keep working. `CascadedLiveClient.sendAudioChunk()` forwarded
 * every one of those frames straight into `TranscribeStreamSession`
 * unconditionally, with no awareness that the cascade (unlike Nova) has no
 * barge-in and no use for audio while a turn is generating or its reply is
 * still playing out client-side. `TranscribeStreamSession` is a single,
 * ordered, never-restarted pipe per session (see its own header) — every
 * frame pushed during Vitana's own turn queues ahead of the next real user
 * utterance, so each reply's own duration added to a backlog Transcribe had
 * to work through before it could transcribe anything new. That backlog
 * compounds every turn, exactly matching the measured escalation.
 *
 * Fix: `sendAudioChunk()` now drops (not forwards) mic audio while
 * `turnInFlight` is true or while `Date.now() < busyUntilMs` — the latter
 * set from the just-emitted reply's estimated client-side playback duration
 * (`emitAudio()`, 16-bit mono PCM @ 16kHz) plus a fixed margin. These tests
 * drive `CascadedLiveClient` directly (not source-check), the same pattern
 * `cascaded-live-client-empty-completion.test.ts` uses.
 */

jest.mock('../../../../src/orb/live/upstream/cascaded/transcribe-stream', () => ({
  TranscribeStreamSession: jest.fn().mockImplementation(() => ({
    onFragment: jest.fn(),
    onError: jest.fn(),
    pushAudioB64: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../../../src/services/llm-router', () => ({
  callViaRouter: jest.fn(),
}));

jest.mock('../../../../src/services/tts/polly', () => ({
  synthesizePolly: jest.fn(),
  resolvePollyVoice: jest.fn(),
}));

jest.mock('../../../../src/services/tts/fish', () => ({
  synthesizeFish: jest.fn(),
}));

import { CascadedLiveClient } from '../../../../src/orb/live/upstream/cascaded-live-client';
import { TranscribeStreamSession } from '../../../../src/orb/live/upstream/cascaded/transcribe-stream';
import { callViaRouter } from '../../../../src/services/llm-router';
import { synthesizePolly, resolvePollyVoice } from '../../../../src/services/tts/polly';

const mockTranscribeCtor = TranscribeStreamSession as unknown as jest.Mock;
const mockCallViaRouter = callViaRouter as jest.Mock;
const mockSynthesizePolly = synthesizePolly as jest.Mock;
const mockResolvePollyVoice = resolvePollyVoice as jest.Mock;

interface MockTranscribeInstance {
  pushAudioB64: jest.Mock;
}

async function makeConnectedClient(): Promise<{ client: CascadedLiveClient; transcribe: MockTranscribeInstance }> {
  const client = new CascadedLiveClient({ lang: 'ru' });
  await client.connect({ systemInstruction: 'You are Vitana.' });
  const results = mockTranscribeCtor.mock.results;
  const transcribe = results[results.length - 1].value as MockTranscribeInstance;
  return { client, transcribe };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 16-bit mono PCM @ 16kHz: `bytes` of silence encode `bytes/32` ms of audio. */
function pcmB64ForMs(ms: number): string {
  const bytes = ms * 32;
  return Buffer.alloc(bytes).toString('base64');
}

describe('VTID-03986: cascade drops mic audio while Vitana is thinking or speaking', () => {
  let nowMs = 1_000_000;

  beforeEach(() => {
    nowMs = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    mockTranscribeCtor.mockClear();
    mockCallViaRouter.mockReset();
    mockSynthesizePolly.mockReset();
    mockResolvePollyVoice.mockReset();
    mockResolvePollyVoice.mockReturnValue({ voiceId: 'Tatyana', engine: 'standard' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('forwards audio normally before any turn has ever run', async () => {
    const { client, transcribe } = await makeConnectedClient();

    const accepted = client.sendAudioChunk('AAAA');

    expect(accepted).toBe(true);
    expect(transcribe.pushAudioB64).toHaveBeenCalledTimes(1);
    expect(transcribe.pushAudioB64).toHaveBeenCalledWith('AAAA');
  });

  it('drops mic audio while a turn is generating (turnInFlight), then resumes once the reply finishes playing', async () => {
    const { client, transcribe } = await makeConnectedClient();
    const llmDeferred = deferred<{ ok: true; text: string }>();
    mockCallViaRouter.mockReturnValueOnce(llmDeferred.promise as Promise<never>);
    // 1000ms of reply audio (32000 bytes @ 16kHz/16-bit) -> estimated
    // playback 1000ms + the fixed 400ms margin = busy for 1400ms after emit.
    mockSynthesizePolly.mockResolvedValue({ audioB64: pcmB64ForMs(1000) });

    // Pre-turn chunk: forwarded normally.
    client.sendAudioChunk('pre-turn');
    expect(transcribe.pushAudioB64).toHaveBeenCalledTimes(1);

    client.sendTextTurn('privet', true);
    // turnInFlight flips true synchronously at the top of runTurn(), before
    // the first await — no microtask flush needed to observe it.
    const duringGeneration = client.sendAudioChunk('during-generation');
    expect(duringGeneration).toBe(true); // accepted, not backpressure
    expect(transcribe.pushAudioB64).toHaveBeenCalledTimes(1); // NOT forwarded

    // Resolve the LLM call and let runTurn run through Polly + emitAudio.
    llmDeferred.resolve({ ok: true, text: 'Privet! Kak dela?' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // turnInFlight is false now, but the reply's estimated playback window
    // (set inside emitAudio()) is still open at the same mocked `now`.
    const immediatelyAfter = client.sendAudioChunk('immediately-after-emit');
    expect(immediatelyAfter).toBe(true);
    expect(transcribe.pushAudioB64).toHaveBeenCalledTimes(1); // still NOT forwarded

    // Advance past the busy window (1000ms playback + 400ms margin).
    nowMs += 1401;
    const afterWindow = client.sendAudioChunk('after-window');
    expect(afterWindow).toBe(true);
    expect(transcribe.pushAudioB64).toHaveBeenCalledTimes(2);
    expect(transcribe.pushAudioB64).toHaveBeenNthCalledWith(1, 'pre-turn');
    expect(transcribe.pushAudioB64).toHaveBeenNthCalledWith(2, 'after-window');
  });

  it('does not extend the busy window when the turn errors before any audio is emitted', async () => {
    const { client, transcribe } = await makeConnectedClient();
    mockCallViaRouter.mockResolvedValueOnce({ ok: false, error: 'AccessDeniedException' });

    client.sendTextTurn('privet', true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // No reply was ever synthesized, so busyUntilMs was never advanced —
    // turnInFlight is false again and audio should flow immediately.
    expect(mockSynthesizePolly).not.toHaveBeenCalled();
    const chunk = client.sendAudioChunk('after-failed-turn');
    expect(chunk).toBe(true);
    expect(transcribe.pushAudioB64).toHaveBeenCalledTimes(1);
    expect(transcribe.pushAudioB64).toHaveBeenCalledWith('after-failed-turn');
  });

  it('a short reply gates for a correspondingly short window, not a fixed long one', async () => {
    const { client, transcribe } = await makeConnectedClient();
    mockCallViaRouter.mockResolvedValueOnce({ ok: true, text: 'Da.' });
    // 100ms of audio -> busy for 100 + 400 = 500ms after emit.
    mockSynthesizePolly.mockResolvedValueOnce({ audioB64: pcmB64ForMs(100) });

    client.sendTextTurn('privet', true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Still within the 500ms window: dropped.
    nowMs += 499;
    client.sendAudioChunk('still-busy');
    expect(transcribe.pushAudioB64).toHaveBeenCalledTimes(0);

    // Past the 500ms window: forwarded.
    nowMs += 2;
    client.sendAudioChunk('window-elapsed');
    expect(transcribe.pushAudioB64).toHaveBeenCalledTimes(1);
    expect(transcribe.pushAudioB64).toHaveBeenCalledWith('window-elapsed');
  });

  it('still returns false (not true) when the client is not open at all', async () => {
    const client = new CascadedLiveClient({ lang: 'ru' });
    // Never connected — state stays 'idle', distinct from the busy-but-open
    // case above, which must return true.
    expect(client.sendAudioChunk('anything')).toBe(false);
  });
});
