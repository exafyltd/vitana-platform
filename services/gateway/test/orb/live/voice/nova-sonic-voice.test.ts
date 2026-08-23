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

  // VTID-03704 — pt is ROUTED out of Nova but KEEPS its Nova voice.
  //
  // VTID-03672 admitted pt to Nova on the strength of Bedrock accepting
  // `carolina`/`leo` as voiceIds, while its own note said end-to-end
  // Portuguese generation was never verified. A live production session then
  // answered a `pt` user in ENGLISH, so Portuguese now routes to the Polly
  // cascade (Transcribe pt-BR + Polly Camila) — that part is
  // `nova-sonic-config.ts`'s job, asserted in its own suite.
  //
  // This suite pins the OTHER half, which an earlier draft of VTID-03704 got
  // wrong: the voice resolver must NOT also refuse pt. `tryCascadeRescue()`
  // is inert until `ORB_CASCADED_VOICE_ENABLED='true'`, so until the
  // cascade's IAM is granted every pt session still transits Nova via
  // `nova_forced_vertex_unavailable`. Refusing here sent those sessions to
  // the `tina` fallback — a GERMAN voice reading Brazilian Portuguese, worse
  // than what pt had before the fix.
  it('keeps carolina for pt — the cascade gate is inert until IAM lands', () => {
    expect(resolveNovaSonicVoice({ language: 'pt', persona: 'vitana' })).toBe('carolina');
    expect(resolveNovaSonicVoice({ language: 'pt-BR', persona: 'vitana' })).toBe('carolina');
    // Persona-independent, like every other language.
    expect(resolveNovaSonicVoice({ language: 'pt', persona: 'devon' })).toBe('carolina');
  });

  it('never substitutes a German voice for Portuguese', () => {
    // The mutation-style guard for the regression above, stated as the
    // outcome a user would actually hear rather than as an id equality.
    for (const persona of ['vitana', 'devon', 'atlas', 'mira', 'sage']) {
      expect(resolveNovaSonicVoice({ language: 'pt', persona })).not.toBe(
        resolveNovaSonicVoice({ language: 'de', persona }),
      );
    }
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
