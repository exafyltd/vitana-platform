/**
 * VTID-03970 — Fish Audio TTS provider tests.
 *
 * Mirrors polly-provider.test.ts's focus on the places a "did we get bytes
 * back" test would not catch, plus this module's own specific hazards:
 *   1. Deploying the file must change nothing (opt-in flag + key both gated).
 *   2. A language with no curated voice must return null, never guess one.
 *   3. The reviewed Serbian voice must be the curated official one, never
 *      the community-uploaded reference_id with explicit content that was
 *      originally suggested for this integration.
 */

import { resolveFishVoice, isFishFallbackEnabled, synthesizeFish, FISH_PCM_SAMPLE_RATE_HZ } from '../../src/services/tts/fish';

describe('VTID-03970 Fish Audio voice resolution', () => {
  afterEach(() => {
    delete process.env.TTS_FISH_FALLBACK_ENABLED;
    delete process.env.FISH_API_KEY;
  });

  it('resolves Serbian to the curated official Fish Audio voice, never the flagged NSFW one', () => {
    const v = resolveFishVoice('sr');
    expect(v).not.toBeNull();
    expect(v!.referenceId).toBe('2ad62aaf885e4a14add09fe4a38ffd23');
    // The reference_id originally suggested for this integration
    // ("Srpski Razgovorni Glas") carried an explicit sexual description and
    // sexy/intimate/breathy tags — must never appear here.
    expect(v!.referenceId).not.toBe('f8c26ecae994449faf73bcfae844076b');
  });

  it('normalizes region-tagged locale codes the same way every other table in this codebase does', () => {
    expect(resolveFishVoice('sr-RS')).toEqual(resolveFishVoice('sr'));
  });

  it('returns null for a language with no curated voice, never a wrong-language guess', () => {
    expect(resolveFishVoice('ja')).toBeNull();
    expect(resolveFishVoice('nl')).toBeNull();
  });

  it('defaults to disabled — deploying this file changes nothing', () => {
    expect(isFishFallbackEnabled()).toBe(false);
  });

  it('is enabled only by the exact string "true"', () => {
    process.env.TTS_FISH_FALLBACK_ENABLED = 'yes';
    expect(isFishFallbackEnabled()).toBe(false);
    process.env.TTS_FISH_FALLBACK_ENABLED = 'TRUE';
    expect(isFishFallbackEnabled()).toBe(true);
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    expect(isFishFallbackEnabled()).toBe(true);
  });
});

describe('VTID-03970 synthesizeFish gating and request shape', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TTS_FISH_FALLBACK_ENABLED;
    delete process.env.FISH_API_KEY;
    delete process.env.FISH_TTS_MODEL;
  });

  it('returns null without ever calling fetch when the feature flag is off', async () => {
    process.env.FISH_API_KEY = 'sk-fish-test';
    const result = await synthesizeFish({ text: 'Zdravo', lang: 'sr', format: 'mp3' });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null without calling fetch when enabled but no API key is set', async () => {
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    const result = await synthesizeFish({ text: 'Zdravo', lang: 'sr', format: 'mp3' });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for a language with no curated voice, without calling fetch', async () => {
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    process.env.FISH_API_KEY = 'sk-fish-test';
    const result = await synthesizeFish({ text: 'Bonjour', lang: 'fr', format: 'mp3' });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the reviewed reference_id, bearer key, and explicit model header', async () => {
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    process.env.FISH_API_KEY = 'sk-fish-test';
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 }),
    );

    const result = await synthesizeFish({ text: 'Zdravo, ja sam Vitana.', lang: 'sr', format: 'mp3' });

    expect(result).not.toBeNull();
    expect(result!.voice).toContain('Milica');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.fish.audio/v1/tts');
    expect(init.headers.Authorization).toBe('Bearer sk-fish-test');
    // CLAUDE.md IF-THEN 30: "IF TTS is used → THEN specify model_name explicitly."
    // s2.1-pro-free (VTID-03983): confirmed live to actually synthesize with
    // an unfunded key, unlike the paid s2.1-pro this defaulted to before.
    expect(init.headers.model).toBe('s2.1-pro-free');
    const body = JSON.parse(init.body);
    expect(body.reference_id).toBe('2ad62aaf885e4a14add09fe4a38ffd23');
    expect(body.text).toBe('Zdravo, ja sam Vitana.');
    expect(body.format).toBe('mp3');
  });

  it('requests latency="low", not the slower "normal"/"balanced" modes (VTID-03998)', async () => {
    // Fish's own docs: 'normal' is the best-QUALITY, slowest default;
    // 'low' is the lowest-latency option. Production evidence (oasis_events,
    // pre-login Serbian sessions): every anonymous sr cascade session hit the
    // 30s greeting_timeout stall watchdog with ZERO audio, before
    // cascade_tts_failed even logged — consistent with 'normal' mode running
    // close to (or past) FISH_REQUEST_TIMEOUT_MS. sr has no Polly voice at
    // all, so a slow Fish call is a full outage for that language, not
    // merely degraded quality.
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    process.env.FISH_API_KEY = 'sk-fish-test';
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 }),
    );

    await synthesizeFish({ text: 'Zdravo, ja sam Vitana.', lang: 'sr', format: 'pcm' });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.latency).toBe('low');
  });

  it('requests an explicit sample rate for pcm format and reports it back authoritatively', async () => {
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    process.env.FISH_API_KEY = 'sk-fish-test';
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 }),
    );

    const result = await synthesizeFish({ text: 'Zdravo', lang: 'sr', format: 'pcm' });

    expect(result!.sampleRateHz).toBe(FISH_PCM_SAMPLE_RATE_HZ);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.sample_rate).toBe(FISH_PCM_SAMPLE_RATE_HZ);
  });

  it('an override model is honoured (CLAUDE.md: never left to the provider default)', async () => {
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    process.env.FISH_API_KEY = 'sk-fish-test';
    process.env.FISH_TTS_MODEL = 's2-pro';
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1]).buffer, { status: 200 }));

    await synthesizeFish({ text: 'Zdravo', lang: 'sr', format: 'mp3' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.model).toBe('s2-pro');
  });

  it('degrades to null on a non-2xx response, logging the real error body (e.g. insufficient credit)', async () => {
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    process.env.FISH_API_KEY = 'sk-fish-test';
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 402, message: 'Insufficient API credit' }), { status: 402 }),
    );
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await synthesizeFish({ text: 'Zdravo', lang: 'sr', format: 'mp3' });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/status=402.*Insufficient API credit/s),
    );
    warnSpy.mockRestore();
  });

  it('degrades to null rather than hanging when the request never resolves on its own', async () => {
    jest.useFakeTimers();
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    process.env.FISH_API_KEY = 'sk-fish-test';
    fetchMock.mockImplementation(
      (_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );

    const promise = synthesizeFish({ text: 'Zdravo', lang: 'sr', format: 'mp3' });
    await jest.advanceTimersByTimeAsync(15_000);
    await expect(promise).resolves.toBeNull();
    jest.useRealTimers();
  });

  it('returns null for empty text without calling fetch', async () => {
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    process.env.FISH_API_KEY = 'sk-fish-test';
    const result = await synthesizeFish({ text: '   ', lang: 'sr', format: 'mp3' });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
