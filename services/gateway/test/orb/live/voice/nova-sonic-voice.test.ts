/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 3): language/persona → Nova voice tests.
 */

import { resolveNovaSonicVoice } from '../../../../src/orb/live/voice/nova-sonic-voice';

describe('resolveNovaSonicVoice', () => {
  it('maps Vitana (feminine default) per language', () => {
    // EN reuses the DE voice (tina) — user live-test verdict 2026-07-28:
    // Nova's native EN voice (tiffany) sounded bad, tina sounded good.
    expect(resolveNovaSonicVoice({ language: 'en', persona: 'vitana' })).toBe('tina');
    expect(resolveNovaSonicVoice({ language: 'de', persona: 'vitana' })).toBe('tina');
    expect(resolveNovaSonicVoice({ language: 'fr', persona: 'vitana' })).toBe('ambre');
    expect(resolveNovaSonicVoice({ language: 'es', persona: 'vitana' })).toBe('lupe');
  });

  it('maps masculine personas (devon, atlas) per language', () => {
    expect(resolveNovaSonicVoice({ language: 'en', persona: 'devon' })).toBe('lennart');
    expect(resolveNovaSonicVoice({ language: 'de', persona: 'devon' })).toBe('lennart');
    expect(resolveNovaSonicVoice({ language: 'fr', persona: 'atlas' })).toBe('florian');
    expect(resolveNovaSonicVoice({ language: 'es', persona: 'atlas' })).toBe('carlos');
  });

  it('sage and mira use feminine voices', () => {
    expect(resolveNovaSonicVoice({ language: 'de', persona: 'sage' })).toBe('tina');
    expect(resolveNovaSonicVoice({ language: 'en', persona: 'mira' })).toBe('tina');
  });

  it('unknown/absent persona falls back to the feminine voice', () => {
    expect(resolveNovaSonicVoice({ language: 'de' })).toBe('tina');
    expect(resolveNovaSonicVoice({ language: 'en', persona: 'zzz' })).toBe('tina');
  });

  it('handles regional tags and casing', () => {
    expect(resolveNovaSonicVoice({ language: 'de-DE', persona: 'devon' })).toBe('lennart');
    expect(resolveNovaSonicVoice({ language: 'EN_us', persona: 'vitana' })).toBe('tina');
  });

  it('returns null for languages outside the Nova canary (callers must have fallen back)', () => {
    expect(resolveNovaSonicVoice({ language: 'sr', persona: 'vitana' })).toBeNull();
    expect(resolveNovaSonicVoice({ language: 'ru', persona: 'devon' })).toBeNull();
  });

  // VTID-03672 — pt moved from "falls through to Vertex" to a served Nova
  // language. These assert the two halves that can independently break: the
  // language must be admitted by the gate, AND it must resolve to Nova's real
  // pt-BR voices. A wrong-but-plausible id (Nova 1's table, another locale's
  // voice) fails at stream open, in production, for exactly the users whose
  // language just changed.
  it('serves pt with Nova\'s documented pt-BR voices', () => {
    expect(resolveNovaSonicVoice({ language: 'pt', persona: 'vitana' })).toBe('carolina');
    expect(resolveNovaSonicVoice({ language: 'pt', persona: 'devon' })).toBe('leo');
    // pt-BR specifically — the app's Portuguese catalog is Brazilian, and a
    // pt-PT voice would read Brazilian copy in the European variant.
    expect(resolveNovaSonicVoice({ language: 'pt-BR', persona: 'vitana' })).toBe('carolina');
  });

  it('still refuses the languages Nova genuinely does not speak', () => {
    // Not caution — the Nova 2 language table does not list these at all, so
    // widening the gate to them would send users to a model that cannot answer.
    for (const language of ['ru', 'pl', 'sr']) {
      expect(resolveNovaSonicVoice({ language, persona: 'vitana' })).toBeNull();
      expect(resolveNovaSonicVoice({ language, persona: 'devon' })).toBeNull();
    }
  });

  it('never returns a Gemini voice ID', () => {
    const geminiVoices = ['Kore', 'Charon', 'Aoede', 'Fenrir', 'Callirrhoe', 'Achernar'];
    for (const lang of ['en', 'de', 'fr', 'es', 'pt']) {
      for (const persona of ['vitana', 'devon', 'sage', 'atlas', 'mira']) {
        const v = resolveNovaSonicVoice({ language: lang, persona });
        expect(geminiVoices).not.toContain(v);
      }
    }
  });
});
