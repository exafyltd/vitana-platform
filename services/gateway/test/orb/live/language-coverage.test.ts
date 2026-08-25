/**
 * VTID-03681 — every per-language table in the ORB live chain must cover every
 * language the gate admits.
 *
 * WHY THIS TEST IS SHAPED THIS WAY
 * --------------------------------
 * The bug it guards was not "pt is missing from a list". Each table was
 * internally correct and every existing test passed. The defect lived in the
 * SEAM: `SUPPORTED_LIVE_LANGUAGES` admitted a language and a table three
 * modules away had no row for it, so the request fell through that table's
 * `?? [en]` default and the user got a fluent English assistant. Nothing
 * errored, and `vtid.live.session.start` recorded the COERCED language, so the
 * telemetry showed a normal English session.
 *
 * So this test deliberately does NOT assert `expect(voices.pt).toBe('Zephyr')`.
 * That form passes the moment someone adds `pt` and says nothing at all about
 * `pl`, or about whatever language is added next — which is precisely how the
 * expansion shipped eight locales with two of them silently broken. It asserts
 * the INVARIANT instead: iterate the gate, and require every downstream table
 * to answer. A new language therefore fails this suite until it is wired
 * everywhere, which is the only property that actually prevents a repeat.
 *
 * The accessors are called through their real public functions rather than by
 * importing the private Records, because the Records are only cache-cold
 * safety nets — production reads `decision_policy` first. Testing the accessor
 * tests what a caller actually gets.
 */

import { SUPPORTED_LIVE_LANGUAGES } from '../../../src/orb/live/config';
import {
  getLiveLanguageVoice,
  getGeminiTtsVoice,
} from '../../../src/orb/live/voice/voice-mapping';
import { getLiveApiVoice } from '../../../src/orb/live/voice/live-api-voice';
import { SHORT_GAP_GREETING_PHRASES } from '../../../src/orb/instruction/greeting-pools';
import { SUPPORTED_LANGUAGES } from '../../../src/services/decision-contract/types';

// The two languages this VTID adds. Named explicitly so the suite fails loudly
// if a later change drops them from the gate rather than silently shrinking
// every loop below to the old eight.
const VTID_03681_LANGUAGES = ['pt', 'pl'] as const;

describe('VTID-03681: ORB live language coverage', () => {
  it('admits pt and pl through the gate that used to coerce them to English', () => {
    for (const lang of VTID_03681_LANGUAGES) {
      expect(SUPPORTED_LIVE_LANGUAGES).toContain(lang);
    }
  });

  it('gives every gated language its own live voice — never the English one by default', () => {
    // `getLiveLanguageVoice` ends `?? FALLBACKS['en']`, so a missing entry
    // returns a real-looking voice instead of failing. Comparing against the
    // English voice is what distinguishes "configured" from "defaulted"; a
    // bare truthiness check would pass for a language with no entry at all.
    const englishVoice = getLiveLanguageVoice('en');
    for (const lang of SUPPORTED_LIVE_LANGUAGES) {
      const voice = getLiveLanguageVoice(lang);
      expect(typeof voice).toBe('string');
      expect(voice.length).toBeGreaterThan(0);
      if (lang !== 'en') {
        expect(`${lang}:${voice}`).not.toBe(`${lang}:${englishVoice}`);
      }
    }
  });

  it('resolves a TTS languageCode matching the requested language, not en-US', () => {
    // This is the assertion that would have caught the real user-facing
    // symptom: a Portuguese request answered with `languageCode: 'en-US'`.
    //
    // `zh` is a genuine exception, not a defect: Google's tag for Mandarin is
    // `cmn-CN` (ISO 639-3 `cmn`), so the app's `zh` legitimately maps to a tag
    // that does not start with `zh`. It is listed explicitly rather than
    // relaxing the check to something like "not en-US", because that weaker
    // form would still pass if a future language resolved to, say, `de-DE`.
    const TAG_PREFIX_EXCEPTIONS: Record<string, string> = { zh: 'cmn' };
    for (const lang of SUPPORTED_LIVE_LANGUAGES) {
      const cfg = getGeminiTtsVoice(lang);
      const expectedPrefix = TAG_PREFIX_EXCEPTIONS[lang] ?? lang;
      expect(`${lang} -> ${cfg.languageCode}`).toBe(
        `${lang} -> ${cfg.languageCode}`.startsWith(`${lang} -> ${expectedPrefix}`)
          ? `${lang} -> ${cfg.languageCode}`
          : `${lang} -> expected a ${expectedPrefix}-* tag`,
      );
    }
  });

  it('pins pt to pt-BR, not pt-PT — the catalog is Brazilian', () => {
    // Both start with `pt`, so the loop above cannot tell them apart, and the
    // failure is undetectable downstream: fluent European Portuguese read over
    // Brazilian copy. Same pin as POLLY_VOICES.pt (VTID-03578).
    expect(getGeminiTtsVoice('pt').languageCode).toBe('pt-BR');
  });

  it('gives every gated language a Live API voice entry', () => {
    for (const lang of SUPPORTED_LIVE_LANGUAGES) {
      const voice = getLiveApiVoice(lang);
      expect(typeof voice).toBe('string');
      expect(voice.length).toBeGreaterThan(0);
    }
  });

  it('gives every gated language its own greeting pool, in that language', () => {
    // `pickShortGapGreetings` ends `|| SHORT_GAP_GREETING_PHRASES.en`, so a
    // missing pool hands the model eight English openers inside a prompt that
    // just told it to speak Portuguese. Asserting the pool is not the English
    // one catches that; asserting it merely exists would not.
    const english = SHORT_GAP_GREETING_PHRASES.en;
    for (const lang of SUPPORTED_LIVE_LANGUAGES) {
      const pool = SHORT_GAP_GREETING_PHRASES[lang];
      expect(Array.isArray(pool)).toBe(true);
      expect(pool.length).toBeGreaterThan(0);
      if (lang !== 'en') {
        expect(pool).not.toEqual(english);
      }
    }
  });

  it('keeps the decision-contract enum in step with the gate', () => {
    // Unlike the lookups above this one REJECTS rather than degrades —
    // `invariants.ts` runs checkEnum against it — so a language admitted by
    // the gate but absent here is reported as a contract violation.
    for (const lang of SUPPORTED_LIVE_LANGUAGES) {
      expect(SUPPORTED_LANGUAGES as readonly string[]).toContain(lang);
    }
  });
});
