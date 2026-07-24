/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 3): language/persona → Nova voice tests.
 */

import { resolveNovaSonicVoice } from '../../../../src/orb/live/voice/nova-sonic-voice';

describe('resolveNovaSonicVoice', () => {
  it('maps Vitana (feminine default) per language', () => {
    expect(resolveNovaSonicVoice({ language: 'en', persona: 'vitana' })).toBe('tiffany');
    expect(resolveNovaSonicVoice({ language: 'de', persona: 'vitana' })).toBe('tina');
    expect(resolveNovaSonicVoice({ language: 'fr', persona: 'vitana' })).toBe('ambre');
    expect(resolveNovaSonicVoice({ language: 'es', persona: 'vitana' })).toBe('lupe');
  });

  it('maps masculine personas (devon, atlas) per language', () => {
    expect(resolveNovaSonicVoice({ language: 'en', persona: 'devon' })).toBe('matthew');
    expect(resolveNovaSonicVoice({ language: 'de', persona: 'devon' })).toBe('lennart');
    expect(resolveNovaSonicVoice({ language: 'fr', persona: 'atlas' })).toBe('florian');
    expect(resolveNovaSonicVoice({ language: 'es', persona: 'atlas' })).toBe('carlos');
  });

  it('sage and mira use feminine voices', () => {
    expect(resolveNovaSonicVoice({ language: 'de', persona: 'sage' })).toBe('tina');
    expect(resolveNovaSonicVoice({ language: 'en', persona: 'mira' })).toBe('tiffany');
  });

  it('unknown/absent persona falls back to the feminine voice', () => {
    expect(resolveNovaSonicVoice({ language: 'de' })).toBe('tina');
    expect(resolveNovaSonicVoice({ language: 'en', persona: 'zzz' })).toBe('tiffany');
  });

  it('handles regional tags and casing', () => {
    expect(resolveNovaSonicVoice({ language: 'de-DE', persona: 'devon' })).toBe('lennart');
    expect(resolveNovaSonicVoice({ language: 'EN_us', persona: 'vitana' })).toBe('tiffany');
  });

  it('returns null for languages outside the Nova canary (callers must have fallen back)', () => {
    expect(resolveNovaSonicVoice({ language: 'sr', persona: 'vitana' })).toBeNull();
    expect(resolveNovaSonicVoice({ language: 'ru', persona: 'devon' })).toBeNull();
  });

  it('never returns a Gemini voice ID', () => {
    const geminiVoices = ['Kore', 'Charon', 'Aoede', 'Fenrir', 'Callirrhoe', 'Achernar'];
    for (const lang of ['en', 'de', 'fr', 'es']) {
      for (const persona of ['vitana', 'devon', 'sage', 'atlas', 'mira']) {
        const v = resolveNovaSonicVoice({ language: lang, persona });
        expect(geminiVoices).not.toContain(v);
      }
    }
  });
});
