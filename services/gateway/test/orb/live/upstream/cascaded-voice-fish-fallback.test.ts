/**
 * VTID-03970 — Fish Audio closes the cascade's one remaining gap (`sr`)
 * WHEN EXPLICITLY ENABLED, and changes nothing when it isn't.
 *
 * `cascaded-voice.test.ts` already pins that `sr` reports `no_polly_voice`
 * with Fish unconfigured — that test's behaviour must be untouched by this
 * change (asserted again here for the default-env case, then flipped).
 */

import { evaluateCascadeEligibility } from '../../../../src/orb/live/upstream/cascaded-config';

describe('VTID-03970: cascade eligibility with Fish fallback', () => {
  afterEach(() => {
    delete process.env.TTS_FISH_FALLBACK_ENABLED;
    delete process.env.FISH_API_KEY;
  });

  it('sr stays ineligible (no_polly_voice) when Fish is unconfigured — the pre-existing default', () => {
    const e = evaluateCascadeEligibility('sr');
    expect(e.eligible).toBe(false);
    expect(e.reason).toBe('no_polly_voice');
    expect(e.ttsProvider).toBeNull();
  });

  it('sr stays ineligible when the flag is set but no API key is configured', () => {
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    const e = evaluateCascadeEligibility('sr');
    expect(e.eligible).toBe(false);
    expect(e.reason).toBe('no_polly_voice');
  });

  it('sr becomes eligible, routed to Fish, once explicitly enabled AND keyed', () => {
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    process.env.FISH_API_KEY = 'sk-fish-test';
    const e = evaluateCascadeEligibility('sr');
    expect(e.eligible).toBe(true);
    expect(e.reason).toBeNull();
    expect(e.ttsProvider).toBe('fish');
    expect(e.transcribeLanguageCode).toBe('sr-RS');
  });

  it('a language Polly already covers stays on Polly even with Fish enabled', () => {
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    process.env.FISH_API_KEY = 'sk-fish-test';
    const e = evaluateCascadeEligibility('ru');
    expect(e.eligible).toBe(true);
    expect(e.ttsProvider).toBe('polly');
  });

  it('a language with no curated Fish voice either stays ineligible even with Fish enabled', () => {
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    process.env.FISH_API_KEY = 'sk-fish-test';
    // ja has no Polly voice AND no curated Fish voice.
    const e = evaluateCascadeEligibility('ja');
    expect(e.eligible).toBe(false);
    expect(e.reason).toBe('no_polly_voice');
    expect(e.ttsProvider).toBeNull();
  });
});
