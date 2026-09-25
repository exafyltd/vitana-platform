/**
 * VTID-04550 — CascadedLiveClient with sentence-pipelined TTS
 * (ORB_CASCADE_STREAMING_ENABLED). Drives the real client with mocked
 * Transcribe / router / Polly / Fish.
 *
 * Covers, per CLAUDE.md §2c-fish-scope, a Polly-backed language (ru) AND the
 * Fish-backed language (sr):
 *   - flag off: one TTS call for the whole reply (today's path, unchanged);
 *   - flag on: first sentence audio is emitted before the second sentence is
 *     synthesized; order preserved; synthesized text == reply text;
 *   - busyUntil covers the cumulative playback of all emitted segments;
 *   - a mid-way synthesis failure reports cascade_tts_failed exactly like
 *     today's single-call failure (no turn-complete), earlier audio stays;
 *   - the output transcript is the full reply, emitted once.
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
  resolvePollySpecialistVoice: jest.fn(),
}));

jest.mock('../../../../src/services/tts/fish', () => ({
  synthesizeFish: jest.fn(),
  resolveFishVoice: jest.fn(),
  isFishConfigured: jest.fn(),
}));

import { CascadedLiveClient } from '../../../../src/orb/live/upstream/cascaded-live-client';
import { TranscribeStreamSession } from '../../../../src/orb/live/upstream/cascaded/transcribe-stream';
import { callViaRouter } from '../../../../src/services/llm-router';
import { synthesizePolly, resolvePollyVoice, resolvePollySpecialistVoice } from '../../../../src/services/tts/polly';
import { synthesizeFish, resolveFishVoice, isFishConfigured } from '../../../../src/services/tts/fish';

const mockTranscribeCtor = TranscribeStreamSession as unknown as jest.Mock;
const mockCallViaRouter = callViaRouter as jest.Mock;
const mockSynthesizePolly = synthesizePolly as jest.Mock;
const mockResolvePollyVoice = resolvePollyVoice as jest.Mock;
const mockResolvePollySpecialist = resolvePollySpecialistVoice as jest.Mock;
const mockSynthesizeFish = synthesizeFish as jest.Mock;
const mockResolveFishVoice = resolveFishVoice as jest.Mock;
const mockIsFishConfigured = isFishConfigured as jest.Mock;

/** 16-bit mono PCM @ 16kHz: `ms` of silence = ms*32 bytes. */
function pcmB64ForMs(ms: number): string {
  return Buffer.alloc(ms * 32).toString('base64');
}

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

type Backend = 'polly' | 'fish';

function setupLang(lang: 'ru' | 'sr'): Backend {
  if (lang === 'ru') {
    mockResolvePollyVoice.mockImplementation((l: string) =>
      l === 'ru' ? { voiceId: 'Tatyana', engine: 'standard', languageCode: 'ru-RU' } : null,
    );
    mockIsFishConfigured.mockReturnValue(false);
    mockResolveFishVoice.mockReturnValue(null);
    return 'polly';
  }
  mockResolvePollyVoice.mockReturnValue(null);
  mockIsFishConfigured.mockReturnValue(true);
  mockResolveFishVoice.mockReturnValue({ referenceId: 'milica', label: 'Milica' });
  return 'fish';
}

async function makeClient(lang: 'ru' | 'sr') {
  const client = new CascadedLiveClient({ lang });
  await client.connect({ systemInstruction: 'You are Vitana.' });
  const results = mockTranscribeCtor.mock.results;
  const transcribe = results[results.length - 1].value as { pushAudioB64: jest.Mock };
  const events: string[] = [];
  const audio: string[] = [];
  const errors: Array<{ code: string }> = [];
  const transcripts: string[] = [];
  let turnCompletes = 0;
  client.onAudioOutput((e) => {
    audio.push(e.dataB64);
    events.push('audio');
  });
  client.onError((e) => errors.push(e as { code: string }));
  client.onTranscript((e) => {
    if (e.direction === 'output') transcripts.push(e.text);
  });
  client.onTurnComplete(() => {
    turnCompletes++;
  });
  return { client, transcribe, events, audio, errors, transcripts, get turnCompletes() { return turnCompletes; } };
}

const REPLY: Record<'ru' | 'sr', { text: string; sentences: string[] }> = {
  ru: {
    text: 'Привет! Как у тебя дела сегодня? Давай начнём.',
    sentences: ['Привет!', 'Как у тебя дела сегодня?', 'Давай начнём.'],
  },
  sr: {
    text: 'Zdravo! Kako si danas? Hajde da počnemo.',
    sentences: ['Zdravo!', 'Kako si danas?', 'Hajde da počnemo.'],
  },
};

describe.each(['ru', 'sr'] as const)('VTID-04550 cascade streaming — %s', (lang) => {
  let nowMs = 1_000_000;
  let synth: jest.Mock;

  beforeEach(() => {
    nowMs = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    for (const m of [
      mockTranscribeCtor,
      mockCallViaRouter,
      mockSynthesizePolly,
      mockResolvePollyVoice,
      mockResolvePollySpecialist,
      mockSynthesizeFish,
      mockResolveFishVoice,
      mockIsFishConfigured,
    ]) {
      m.mockReset?.();
    }
    mockTranscribeCtor.mockImplementation(() => ({
      onFragment: jest.fn(),
      onError: jest.fn(),
      pushAudioB64: jest.fn(),
      stop: jest.fn().mockResolvedValue(undefined),
    }));
    const backend = setupLang(lang);
    synth = backend === 'polly' ? mockSynthesizePolly : mockSynthesizeFish;
    mockCallViaRouter.mockResolvedValue({ ok: true, text: REPLY[lang].text, provider: 'bedrock', model: 'x' });
  });

  afterEach(() => {
    delete process.env.ORB_CASCADE_STREAMING_ENABLED;
    jest.restoreAllMocks();
  });

  it('flag off: whole reply synthesized in ONE call (today\'s path)', async () => {
    synth.mockResolvedValue({ audioB64: pcmB64ForMs(500) });
    const h = await makeClient(lang);
    h.client.sendTextTurn('hi', true);
    await flush();
    expect(synth).toHaveBeenCalledTimes(1);
    expect(synth.mock.calls[0][0].text).toBe(REPLY[lang].text);
    expect(h.turnCompletes).toBe(1);
    expect(h.errors).toEqual([]);
  });

  it('flag on: first sentence audio is emitted before the second sentence is synthesized; order + text preserved', async () => {
    process.env.ORB_CASCADE_STREAMING_ENABLED = 'true';
    const log: string[] = [];
    const h = await makeClient(lang);
    synth.mockImplementation(async (opts: { text: string }) => {
      log.push(`synth:${opts.text}`);
      const idx = REPLY[lang].sentences.indexOf(opts.text);
      return { audioB64: pcmB64ForMs(100 * (idx + 1)) };
    });
    h.client.onAudioOutput((e) => {
      log.push(`audio:${Buffer.from(e.dataB64, 'base64').length}`);
    });
    h.client.sendTextTurn('hi', true);
    await flush(10);

    const [s1, s2, s3] = REPLY[lang].sentences;
    expect(log).toEqual([
      `synth:${s1}`,
      `audio:${100 * 32}`,
      `synth:${s2}`,
      `audio:${200 * 32}`,
      `synth:${s3}`,
      `audio:${300 * 32}`,
    ]);
    // Words spoken are exactly the reply: synthesized segments rejoin to it.
    const spoken = synth.mock.calls.map((c) => c[0].text);
    expect(spoken.join(' ')).toBe(REPLY[lang].text);
    expect(h.transcripts).toEqual([REPLY[lang].text]);
    expect(h.turnCompletes).toBe(1);
    expect(h.errors).toEqual([]);
    // Same LLM call as before — one call, unchanged.
    expect(mockCallViaRouter).toHaveBeenCalledTimes(1);
  });

  it('flag on: busyUntil covers the cumulative playback of all segments (VTID-03986 gate)', async () => {
    process.env.ORB_CASCADE_STREAMING_ENABLED = 'true';
    // 1000ms + 1000ms + 1000ms of audio, all emitted at the same mocked now.
    synth.mockResolvedValue({ audioB64: pcmB64ForMs(1000) });
    const h = await makeClient(lang);
    h.client.sendTextTurn('hi', true);
    await flush(10);
    expect(synth).toHaveBeenCalledTimes(3);
    h.transcribe.pushAudioB64.mockClear();

    // 3000ms playback + 400ms margin from t0 → still busy at +3399.
    nowMs += 3399;
    h.client.sendAudioChunk('still-playing');
    expect(h.transcribe.pushAudioB64).not.toHaveBeenCalled();

    nowMs += 1; // +3400
    h.client.sendAudioChunk('after-playback');
    expect(h.transcribe.pushAudioB64).toHaveBeenCalledWith('after-playback');
  });

  it('flag on: mic audio is dropped while the pipeline is still synthesizing', async () => {
    process.env.ORB_CASCADE_STREAMING_ENABLED = 'true';
    let release!: () => void;
    const h = await makeClient(lang);
    synth
      .mockResolvedValueOnce({ audioB64: pcmB64ForMs(10) })
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            release = () => r({ audioB64: pcmB64ForMs(10) });
          }),
      )
      .mockResolvedValueOnce({ audioB64: pcmB64ForMs(10) });
    h.client.sendTextTurn('hi', true);
    await flush(10);
    expect(h.audio.length).toBe(1);
    nowMs += 60_000; // playback of segment 1 long over, but turn still in flight
    h.transcribe.pushAudioB64.mockClear();
    h.client.sendAudioChunk('mid-turn');
    expect(h.transcribe.pushAudioB64).not.toHaveBeenCalled();
    release();
    await flush(10);
    expect(h.turnCompletes).toBe(1);
  });

  it('flag on: a mid-way synthesis failure is reported as cascade_tts_failed (as today), no turn-complete', async () => {
    process.env.ORB_CASCADE_STREAMING_ENABLED = 'true';
    const h = await makeClient(lang);
    synth.mockResolvedValueOnce({ audioB64: pcmB64ForMs(100) }).mockResolvedValueOnce(null);
    h.client.sendTextTurn('hi', true);
    await flush(10);
    expect(h.audio.length).toBe(1);
    expect(h.errors.map((e) => e.code)).toEqual(['cascade_tts_failed']);
    expect(h.turnCompletes).toBe(0);
    expect(synth).toHaveBeenCalledTimes(2);
  });

  it('flag on: a first-sentence failure behaves exactly like today\'s failure (no audio, error)', async () => {
    process.env.ORB_CASCADE_STREAMING_ENABLED = 'true';
    const h = await makeClient(lang);
    synth.mockResolvedValue(null);
    h.client.sendTextTurn('hi', true);
    await flush(10);
    expect(h.audio.length).toBe(0);
    expect(h.errors.map((e) => e.code)).toEqual(['cascade_tts_failed']);
    expect(h.turnCompletes).toBe(0);
  });

  it('flag on but LLM empty after retry: same cascade_llm_empty path, no TTS', async () => {
    process.env.ORB_CASCADE_STREAMING_ENABLED = 'true';
    mockCallViaRouter.mockResolvedValue({ ok: true, text: '  ', fallbackUsed: true });
    const h = await makeClient(lang);
    h.client.sendTextTurn('hi', true);
    await flush(10);
    expect(synth).not.toHaveBeenCalled();
    expect(h.errors.map((e) => e.code)).toEqual(['cascade_llm_empty']);
  });
});
