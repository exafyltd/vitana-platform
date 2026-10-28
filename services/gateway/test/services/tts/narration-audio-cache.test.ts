/**
 * BOOTSTRAP-POLLY-NARRATION-CACHE — guided-topic narration audio cache.
 *
 * The single most important assertion in this file is that the ENGINE
 * participates in the cache key. Six languages are about to move from Polly's
 * `neural` engine to `generative`; if the key were `(topic_id, lang)` — which
 * reads as entirely reasonable — every one of those languages would keep
 * serving its cached neural audio forever after the flip, with no error and no
 * signal anywhere. That is the same silent-wrong-output shape as VTID-03578
 * (Portuguese read aloud in English by a healthy-sounding voice) and VTID-03682.
 */

import {
  buildNarrationCacheKey,
  MemoryNarrationStore,
  resolveNarrationCacheMode,
  getNarrationAudioStore,
  resetNarrationAudioStoreForTests,
} from '../../../src/services/tts/narration-audio-cache';

const BASE = {
  topicId: 'T178',
  lang: 'de',
  text: 'Hallo, das ist eine Lektion.',
  voiceId: 'Vicki',
  engine: 'neural',
};

describe('buildNarrationCacheKey', () => {
  it('is stable for identical inputs', () => {
    expect(buildNarrationCacheKey(BASE)).toBe(buildNarrationCacheKey({ ...BASE }));
  });

  it('CHANGES when the engine changes — this is what makes the neural→generative flip safe', () => {
    const neural = buildNarrationCacheKey(BASE);
    const generative = buildNarrationCacheKey({ ...BASE, engine: 'generative' });
    expect(generative).not.toBe(neural);
  });

  it('changes when the voice changes', () => {
    expect(buildNarrationCacheKey({ ...BASE, voiceId: 'Daniel' })).not.toBe(
      buildNarrationCacheKey(BASE),
    );
  });

  it('changes when the lesson text changes, so a curriculum edit self-invalidates', () => {
    expect(
      buildNarrationCacheKey({ ...BASE, text: BASE.text + ' Noch ein Satz.' }),
    ).not.toBe(buildNarrationCacheKey(BASE));
  });

  it('changes when the language changes', () => {
    expect(buildNarrationCacheKey({ ...BASE, lang: 'en' })).not.toBe(
      buildNarrationCacheKey(BASE),
    );
  });

  it('changes when the topic changes', () => {
    expect(buildNarrationCacheKey({ ...BASE, topicId: 'T179' })).not.toBe(
      buildNarrationCacheKey(BASE),
    );
  });

  it('namespaces by schema version, language and topic so keys stay browsable', () => {
    expect(buildNarrationCacheKey(BASE)).toMatch(/^narration\/v1\/de\/T178\/[0-9a-f]{64}$/);
  });
});

describe('MemoryNarrationStore', () => {
  const entry = (bytes: number) => ({
    audioB64: 'a'.repeat(bytes),
    sampleRateHz: 16000,
  });

  it('returns null on a miss and the entry on a hit', async () => {
    const s = new MemoryNarrationStore();
    expect(await s.get('k')).toBeNull();
    await s.put('k', entry(10));
    expect((await s.get('k'))?.sampleRateHz).toBe(16000);
  });

  it('evicts least-recently-used entries once the BYTE budget is exceeded', async () => {
    const s = new MemoryNarrationStore(100);
    await s.put('a', entry(40));
    await s.put('b', entry(40));
    // Touch 'a' so 'b' becomes least-recently-used.
    await s.get('a');
    await s.put('c', entry(40));

    expect(await s.get('a')).not.toBeNull();
    expect(await s.get('b')).toBeNull();
    expect(await s.get('c')).not.toBeNull();
  });

  it('refuses an entry larger than the whole budget instead of evicting everything for it', async () => {
    const s = new MemoryNarrationStore(100);
    await s.put('small', entry(50));
    await s.put('huge', entry(500));

    expect(await s.get('huge')).toBeNull();
    expect(await s.get('small')).not.toBeNull();
  });

  it('does not double-count bytes when the same key is overwritten', async () => {
    const s = new MemoryNarrationStore(100);
    await s.put('k', entry(40));
    await s.put('k', entry(40));
    expect(s.stats()).toEqual({ entries: 1, bytes: 40 });
  });
});

describe('resolveNarrationCacheMode', () => {
  it('defaults to memory when unset', () => {
    expect(resolveNarrationCacheMode(undefined)).toBe('memory');
  });

  it('honours the three recognised values', () => {
    expect(resolveNarrationCacheMode('off')).toBe('off');
    expect(resolveNarrationCacheMode('memory')).toBe('memory');
    expect(resolveNarrationCacheMode('s3')).toBe('s3');
  });

  it('treats an UNRECOGNISED value as memory, not off — a typo must not silently restore per-tap billing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveNarrationCacheMode('S3-bucket')).toBe('memory');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('getNarrationAudioStore', () => {
  beforeEach(() => resetNarrationAudioStoreForTests());
  afterEach(() => resetNarrationAudioStoreForTests());

  it('returns null when caching is off', () => {
    expect(getNarrationAudioStore('off')).toBeNull();
  });

  it('returns the memory store by default', () => {
    expect(getNarrationAudioStore('memory')?.name).toBe('memory');
  });

  it('falls back to memory AND logs an error when s3 is selected with no bucket', () => {
    const prev = process.env.NARRATION_AUDIO_BUCKET;
    delete process.env.NARRATION_AUDIO_BUCKET;
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});

    const store = getNarrationAudioStore('s3');

    // Falling back to memory rather than to nothing: the operator asked for
    // caching, so disabling it silently is the worse of the two wrong answers.
    expect(store?.name).toBe('memory');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('NARRATION_AUDIO_BUCKET'));

    err.mockRestore();
    if (prev !== undefined) process.env.NARRATION_AUDIO_BUCKET = prev;
  });

  it('returns the s3 store when a bucket is named', () => {
    const prev = process.env.NARRATION_AUDIO_BUCKET;
    process.env.NARRATION_AUDIO_BUCKET = 'vitana-narration-audio';

    expect(getNarrationAudioStore('s3')?.name).toBe('s3');

    if (prev === undefined) delete process.env.NARRATION_AUDIO_BUCKET;
    else process.env.NARRATION_AUDIO_BUCKET = prev;
  });
});
