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

  // VTID-03704 — persona NO LONGER selects the voice. This test used to assert
  // devon/atlas → lennart/florian/carlos; that split is what made the voice
  // change across the sign-in boundary (an anonymous session has no persona and
  // resolved feminine; a signed-in user carrying `devon` resolved masculine), so
  // it is now asserted as an EQUALITY across personas rather than deleted. A
  // deleted test would let the split come back unnoticed.
  it('ignores persona — every persona gets the same female voice', () => {
    for (const persona of ['vitana', 'devon', 'atlas', 'sage', 'mira', 'zzz']) {
      expect(resolveNovaSonicVoice({ language: 'en', persona })).toBe('tina');
      expect(resolveNovaSonicVoice({ language: 'de', persona })).toBe('tina');
      expect(resolveNovaSonicVoice({ language: 'fr', persona })).toBe('ambre');
      expect(resolveNovaSonicVoice({ language: 'es', persona })).toBe('lupe');
    }
  });

  it('never returns one of the retired masculine voices', () => {
    for (const lang of ['en', 'de', 'fr', 'es']) {
      for (const persona of ['devon', 'atlas', 'vitana']) {
        expect(['lennart', 'florian', 'carlos', 'leo'])
          .not.toContain(resolveNovaSonicVoice({ language: lang, persona }));
      }
    }
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
    expect(resolveNovaSonicVoice({ language: 'de-DE', persona: 'devon' })).toBe('tina');
    expect(resolveNovaSonicVoice({ language: 'EN_us', persona: 'vitana' })).toBe('tina');
  });

  it('returns null for languages outside the Nova canary (callers must have fallen back)', () => {
    expect(resolveNovaSonicVoice({ language: 'sr', persona: 'vitana' })).toBeNull();
    expect(resolveNovaSonicVoice({ language: 'ru', persona: 'devon' })).toBeNull();
  });

  // VTID-03704 — pt REVERSED out of Nova. VTID-03672 admitted it on the
  // strength of Bedrock accepting `carolina`/`leo` as voiceIds, while its own
  // note said end-to-end Portuguese generation was never verified. A live
  // production session then answered a `pt` user in ENGLISH. Portuguese now
  // routes to the Polly cascade (Transcribe pt-BR + Polly Camila) instead, so
  // Nova must refuse it here — refusing is what makes the cascade the taken
  // path rather than a branch nothing reaches.
  it('refuses pt so it routes to the Polly cascade instead', () => {
    expect(resolveNovaSonicVoice({ language: 'pt', persona: 'vitana' })).toBeNull();
    expect(resolveNovaSonicVoice({ language: 'pt-BR', persona: 'vitana' })).toBeNull();
    expect(resolveNovaSonicVoice({ language: 'pt', persona: 'devon' })).toBeNull();
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
    for (const lang of ['en', 'de', 'fr', 'es']) {
      for (const persona of ['vitana', 'devon', 'sage', 'atlas', 'mira']) {
        const v = resolveNovaSonicVoice({ language: lang, persona });
        expect(geminiVoices).not.toContain(v);
      }
    }
  });
});
