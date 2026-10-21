/**
 * VTID-04742: the voice prompts tell Vitana which register to use.
 *
 * Production 2026-09-26..29: German voice sessions switched between du and
 * Sie ("Möchten Sie, dass ich Ihnen eine Übersicht zeige …", "… für Ihre
 * Frage …") — the LANGUAGE line named German and said nothing about du.
 */
import { registerRuleForLang } from '../../src/i18n/llm-locale';
import { buildLanguageDirective } from '../../src/services/context-pack-builder';
import { buildSpecialistLanguageDirective } from '../../src/routes/orb-live';
import { buildLiveSystemInstruction } from '../../src/orb/live/instruction/live-system-instruction';

describe('VTID-04742: register rule for voice prompts', () => {
  it.each(['de', 'de-DE', 'German', 'DE'])('German (%s) gets the du rule', (lang) => {
    const rule = registerRuleForLang(lang);
    expect(rule).toMatch(/^REGISTER: /);
    expect(rule).toContain('du-form');
    expect(rule).toContain('NOT Sie-form');
    expect(rule).toContain('tool result');
  });

  it.each([['sr', 'ti-form'], ['es', 'tú-form'], ['fr', 'tu-form'], ['tr', 'sen-form']])('%s gets its informal register', (lang, form) => {
    expect(registerRuleForLang(lang)).toContain(form);
  });

  it.each(['en', 'English', '', undefined, 'xx'])('no rule for %p', (lang) => {
    expect(registerRuleForLang(lang as any)).toBe('');
  });

  it('the text-path language directive carries it', () => {
    expect(buildLanguageDirective('German')).toContain('du-form');
    expect(buildLanguageDirective('English')).not.toContain('REGISTER');
  });

  it('the live voice instruction carries it right after LANGUAGE, and not in English', () => {
    const de = buildLiveSystemInstruction('de', 'conversational', '', 'community', '', '', false, null, '/', [], undefined, '@x');
    expect(de).toMatch(/LANGUAGE: Respond ONLY in German\.[^\n]*\nREGISTER: Use du-form/);
    const en = buildLiveSystemInstruction('en', 'conversational', '', 'community', '', '', false, null, '/', [], undefined, '@x');
    expect(en).not.toContain('REGISTER:');
  });

  it('the specialist language lock carries it', () => {
    expect(buildSpecialistLanguageDirective('de')).toContain('du-form');
  });
});
