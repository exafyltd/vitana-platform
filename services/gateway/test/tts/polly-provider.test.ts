/**
 * VTID-03495 — Amazon Polly TTS provider tests.
 *
 * Focus is on the three places Polly diverges from Cloud TTS in ways a
 * "did we get bytes back" test would not catch:
 *   1. Serbian must return null, never English audio.
 *   2. PCM sample rate must be reported as 16kHz, never assumed 24kHz.
 *   3. Speaking rate must become SSML prosody, with the text XML-escaped.
 */

import {
  resolvePollyVoice,
  buildPollyInput,
  escapeSsml,
  normalizeLang,
  POLLY_UNSUPPORTED_LANGS,
  POLLY_PCM_SAMPLE_RATE_HZ,
  getPollyRegion,
} from '../../src/services/tts/polly';
import {
  getTtsProvider,
  getPcmSampleRateHz,
  isPollyStrict,
  GOOGLE_PCM_SAMPLE_RATE_HZ,
} from '../../src/services/tts/tts-provider';

describe('VTID-03495 Polly voice resolution', () => {
  it('returns null for Serbian rather than silently substituting another language', () => {
    // The whole point: fluent audio in the WRONG language is worse than none,
    // because nothing downstream can tell it went wrong.
    expect(resolvePollyVoice('sr')).toBeNull();
    expect(resolvePollyVoice('sr-RS')).toBeNull();
    expect(POLLY_UNSUPPORTED_LANGS.has('sr')).toBe(true);
  });

  it('resolves the supported languages with an explicit engine', () => {
    for (const lang of ['en', 'de', 'fr', 'es', 'ar', 'zh', 'ru']) {
      const v = resolvePollyVoice(lang);
      expect(v).not.toBeNull();
      // CLAUDE.md: "IF TTS is used → THEN specify model_name explicitly."
      expect(v!.engine).toBeTruthy();
      expect(v!.voiceId).toBeTruthy();
      expect(v!.languageCode).toBeTruthy();
    }
  });

  it('pins Russian to the standard engine (Polly has no neural Russian voice)', () => {
    expect(resolvePollyVoice('ru')!.engine).toBe('standard');
  });

  it('falls back to English for languages outside the table but not on the unsupported list', () => {
    expect(resolvePollyVoice('ja')!.languageCode).toBe('en-US');
  });

  it('normalizes locale tags down to a base language', () => {
    expect(normalizeLang('de-DE')).toBe('de');
    expect(normalizeLang('en_US')).toBe('en');
    expect(normalizeLang('')).toBe('en');
  });
});

describe('VTID-03495 speaking-rate → SSML', () => {
  it('sends plain text at rate 1.0 (no SSML, no escaping surface)', () => {
    const out = buildPollyInput('Guten Morgen', 1);
    expect(out.textType).toBe('text');
    expect(out.text).toBe('Guten Morgen');
  });

  it('wraps in prosody SSML for a non-default rate', () => {
    const out = buildPollyInput('Guten Morgen', 1.15);
    expect(out.textType).toBe('ssml');
    expect(out.text).toContain('<prosody rate="115%">');
    expect(out.text).toContain('</speak>');
  });

  it('XML-escapes text when building SSML so ampersands cannot break the payload', () => {
    const out = buildPollyInput('Fish & Chips <b>', 1.5);
    expect(out.textType).toBe('ssml');
    expect(out.text).toContain('Fish &amp; Chips &lt;b&gt;');
    // Raw '&' followed by a space would make Polly reject the whole request.
    expect(out.text).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('treats a non-finite or non-positive rate as 1.0 rather than emitting garbage SSML', () => {
    expect(buildPollyInput('x', NaN).textType).toBe('text');
    expect(buildPollyInput('x', 0).textType).toBe('text');
    expect(buildPollyInput('x', -2).textType).toBe('text');
  });

  it('escapeSsml covers all five XML entities', () => {
    expect(escapeSsml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
});

describe('VTID-03495 PCM sample rate', () => {
  const original = process.env.TTS_PROVIDER;
  afterEach(() => {
    if (original === undefined) delete process.env.TTS_PROVIDER;
    else process.env.TTS_PROVIDER = original;
  });

  it('Polly PCM is 16kHz — NOT the 24kHz Cloud TTS uses', () => {
    // Playing 16kHz samples at 24kHz is a 1.5x speed-up: obvious to a
    // listener, invisible to any assertion that only checks for bytes.
    expect(POLLY_PCM_SAMPLE_RATE_HZ).toBe(16_000);
    expect(GOOGLE_PCM_SAMPLE_RATE_HZ).toBe(24_000);
    expect(POLLY_PCM_SAMPLE_RATE_HZ).not.toBe(GOOGLE_PCM_SAMPLE_RATE_HZ);
  });

  it('reports the PCM rate of whichever provider is active', () => {
    process.env.TTS_PROVIDER = 'polly';
    expect(getPcmSampleRateHz()).toBe(16_000);
    process.env.TTS_PROVIDER = 'google';
    expect(getPcmSampleRateHz()).toBe(24_000);
  });
});

describe('VTID-03495 provider gating', () => {
  const originalProvider = process.env.TTS_PROVIDER;
  const originalStrict = process.env.TTS_POLLY_STRICT;
  afterEach(() => {
    if (originalProvider === undefined) delete process.env.TTS_PROVIDER;
    else process.env.TTS_PROVIDER = originalProvider;
    if (originalStrict === undefined) delete process.env.TTS_POLLY_STRICT;
    else process.env.TTS_POLLY_STRICT = originalStrict;
  });

  it('defaults to google when TTS_PROVIDER is unset — deploying this code flips nothing', () => {
    delete process.env.TTS_PROVIDER;
    expect(getTtsProvider()).toBe('google');
  });

  it('falls back to google (loudly) on an unrecognised value rather than failing closed', () => {
    process.env.TTS_PROVIDER = 'azure';
    expect(getTtsProvider()).toBe('google');
  });

  it('selects polly only on the exact opt-in value, case-insensitively', () => {
    process.env.TTS_PROVIDER = 'POLLY';
    expect(getTtsProvider()).toBe('polly');
  });

  it('strict mode is off unless explicitly set to true', () => {
    delete process.env.TTS_POLLY_STRICT;
    expect(isPollyStrict()).toBe(false);
    process.env.TTS_POLLY_STRICT = 'true';
    expect(isPollyStrict()).toBe(true);
  });
});

describe('VTID-03495 region resolution', () => {
  const originals = { p: process.env.AWS_POLLY_REGION, r: process.env.AWS_REGION };
  afterEach(() => {
    if (originals.p === undefined) delete process.env.AWS_POLLY_REGION;
    else process.env.AWS_POLLY_REGION = originals.p;
    if (originals.r === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = originals.r;
  });

  it('defaults to eu-central-1, the only region with Vitana AWS infrastructure', () => {
    delete process.env.AWS_POLLY_REGION;
    delete process.env.AWS_REGION;
    expect(getPollyRegion()).toBe('eu-central-1');
  });

  it('prefers the explicit override over the generic AWS region', () => {
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_POLLY_REGION = 'eu-west-1';
    expect(getPollyRegion()).toBe('eu-west-1');
  });
});
