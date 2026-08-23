/**
 * BOOTSTRAP-i18n-llm-locale — gateway LLM locale-injection tests.
 *
 * Re-applied under BOOTSTRAP-ORB-R5-REAPPLY (Phase R5). The original change
 * (PR #2392, sha 8e7570e3) was reverted on 2026-05-29 on a MISDIAGNOSIS — the
 * real cause was the R0 Vertex instruction-size bug (diagnosed + fixed in a
 * separate lane). The behavior is back on main; these tests lock the locale
 * helper so the "German users get English LLM output" gap cannot silently
 * reopen.
 *
 * Note: this helper PREPENDS a short "LANGUAGE: Respond ONLY in {X}" directive
 * to the system prompt for user-facing LLM callers. It is NOT applied to the
 * voice system instruction (orb-live / orb-livekit already enforce language)
 * nor to admin/dev paths (English by design per CLAUDE.md §13b) — so it does
 * not contribute to the R0 aggregate-instruction overflow.
 */

import {
  buildLocalizedSystemPrompt,
  buildLocalizedSystemPromptForLang,
} from '../../src/i18n/llm-locale';

const BASE = 'You are an expert health coach. Answer the question.';

describe('buildLocalizedSystemPrompt', () => {
  it('returns the base prompt unchanged when locale is null/undefined (English-by-design paths)', () => {
    expect(buildLocalizedSystemPrompt(BASE, null)).toBe(BASE);
    expect(buildLocalizedSystemPrompt(BASE, undefined)).toBe(BASE);
  });

  it('German: forces German output, du-form register, and the compound-word rule', () => {
    const out = buildLocalizedSystemPrompt(BASE, 'de');
    expect(out).toContain('LANGUAGE: Respond ONLY in German (Deutsch).');
    expect(out).toContain('du-form');
    expect(out).toContain('22 characters'); // compound-word rule is DE-only
    // The base prompt is preserved at the end.
    expect(out.endsWith(BASE)).toBe(true);
  });

  it('Spanish: forces Spanish + tú-form, and does NOT inject the German compound rule', () => {
    const out = buildLocalizedSystemPrompt(BASE, 'es');
    expect(out).toContain('Respond ONLY in Spanish (Español).');
    expect(out).toContain('tú-form');
    expect(out).not.toContain('22 characters');
  });

  it('Serbian: forces Serbian + ti-form register', () => {
    const out = buildLocalizedSystemPrompt(BASE, 'sr');
    expect(out).toContain('Respond ONLY in Serbian (Srpski).');
    expect(out).toContain('ti-form');
  });

  it('English: forces English output but has no register/compound hint', () => {
    const out = buildLocalizedSystemPrompt(BASE, 'en');
    expect(out).toContain('Respond ONLY in English.');
    expect(out).not.toContain('du-form');
    expect(out).not.toContain('22 characters');
  });

  it('keeps brand names untranslated (does not constrain Vitana/MAXINA/OASIS)', () => {
    const out = buildLocalizedSystemPrompt(BASE, 'de');
    expect(out).toContain('Vitana, MAXINA, OASIS');
  });
});

describe('buildLocalizedSystemPromptForLang (short-code convenience)', () => {
  it('normalizes BCP-47-ish prefixes (de-DE, en-US, …) to the supported set', () => {
    expect(buildLocalizedSystemPromptForLang(BASE, 'de-DE')).toContain('German (Deutsch)');
    expect(buildLocalizedSystemPromptForLang(BASE, 'en-US')).toContain('English');
    expect(buildLocalizedSystemPromptForLang(BASE, 'sr-RS')).toContain('Serbian (Srpski)');
    expect(buildLocalizedSystemPromptForLang(BASE, 'es-419')).toContain('Spanish (Español)');
  });

  // VTID-03509 — the 18 Aug release locales. 'fr' asserted BASE here before,
  // because French genuinely was unsupported; that expectation is what this
  // change reverses.
  it('constrains the four locales added for the 18 Aug release', () => {
    expect(buildLocalizedSystemPromptForLang(BASE, 'fr-FR')).toContain('French (Français)');
    expect(buildLocalizedSystemPromptForLang(BASE, 'pt-PT')).toContain('Portuguese (Português)');
    expect(buildLocalizedSystemPromptForLang(BASE, 'ru-RU')).toContain('Russian (Русский)');
    expect(buildLocalizedSystemPromptForLang(BASE, 'pl-PL')).toContain('Polish (Polski)');
  });

  // "portuguese", "polish", "portugiesisch" and "polnisch" all begin with
  // "po", which matches neither 'pt' nor 'pl'. Without the language-name map
  // every one of these resolves to German — the exact bug the map exists for.
  it('resolves word-form language names whose spelling does not match their ISO code', () => {
    expect(buildLocalizedSystemPromptForLang(BASE, 'Portuguese')).toContain('Portuguese (Português)');
    expect(buildLocalizedSystemPromptForLang(BASE, 'Polish')).toContain('Polish (Polski)');
    expect(buildLocalizedSystemPromptForLang(BASE, 'polnisch')).toContain('Polish (Polski)');
    expect(buildLocalizedSystemPromptForLang(BASE, 'portugiesisch')).toContain('Portuguese (Português)');
    // Regression guard for the pre-existing es/sr cases documented in catalog.ts.
    expect(buildLocalizedSystemPromptForLang(BASE, 'Serbian')).toContain('Serbian (Srpski)');
    expect(buildLocalizedSystemPromptForLang(BASE, 'Spanish')).toContain('Spanish (Español)');
  });

  it('gives every supported locale an informal-register directive', () => {
    // A locale with no register hint reads formally — translated, but off-brand.
    for (const lang of ['de', 'es', 'sr', 'fr', 'pt', 'ru', 'pl']) {
      expect(buildLocalizedSystemPromptForLang(BASE, lang)).toMatch(/informal|du-form|ti-form|tú-form|tu-form|ты-form|ty-form/);
    }
  });

  it('passes through unchanged for null / empty / unsupported languages', () => {
    expect(buildLocalizedSystemPromptForLang(BASE, null)).toBe(BASE);
    expect(buildLocalizedSystemPromptForLang(BASE, '')).toBe(BASE);
    // Deferred past the 18 Aug release — deliberately NOT in GatewayLocale.
    expect(buildLocalizedSystemPromptForLang(BASE, 'ja')).toBe(BASE);
    expect(buildLocalizedSystemPromptForLang(BASE, 'ko-KR')).toBe(BASE);
  });
});
