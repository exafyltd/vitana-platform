/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 3): language/persona → Nova voice tests.
 */

import { resolveNovaSonicVoice } from '../../../../src/orb/live/voice/nova-sonic-voice';

describe('resolveNovaSonicVoice', () => {
  it('maps Vitana (feminine default) per language', () => {
    // VTID-03809 — EN uses `amy` (Nova 2 Sonic's native en-GB voice).
    // History: user live-test verdict 2026-07-28 rejected native `tiffany`
    // (en-US) and settled on `tina` (DE) reused for EN, at the cost of a
    // German accent on English speech; a later listener disliked that and
    // this swapped it for `amy` instead — untried in this app before now.
    expect(resolveNovaSonicVoice({ language: 'en', persona: 'vitana' })).toBe('amy');
    expect(resolveNovaSonicVoice({ language: 'de', persona: 'vitana' })).toBe('tina');
    expect(resolveNovaSonicVoice({ language: 'fr', persona: 'vitana' })).toBe('ambre');
    expect(resolveNovaSonicVoice({ language: 'es', persona: 'vitana' })).toBe('lupe');
  });

  // VTID-04445 — owner rule: every Vitana voice is a woman's voice, every
  // Devon voice a man's voice. This test used to assert the opposite (VTID-
  // 03704: persona ignored, Devon spoke with Vitana's female voice).
  it('maps Devon to the male voice of the same locale', () => {
    expect(resolveNovaSonicVoice({ language: 'en', persona: 'devon' })).toBe('matthew');
    expect(resolveNovaSonicVoice({ language: 'de', persona: 'devon' })).toBe('lennart');
    expect(resolveNovaSonicVoice({ language: 'fr', persona: 'devon' })).toBe('florian');
    expect(resolveNovaSonicVoice({ language: 'es', persona: 'devon' })).toBe('carlos');
    expect(resolveNovaSonicVoice({ language: 'pt', persona: 'devon' })).toBe('leo');
  });

  it('never hands Vitana (or the anonymous, persona-less case) a male voice', () => {
    for (const lang of ['en', 'de', 'fr', 'es', 'pt']) {
      for (const persona of ['vitana', null, undefined, '']) {
        expect(['matthew', 'lennart', 'florian', 'carlos', 'leo'])
          .not.toContain(resolveNovaSonicVoice({ language: lang, persona }));
      }
    }
  });

  it('sage and mira use feminine voices', () => {
    expect(resolveNovaSonicVoice({ language: 'de', persona: 'sage' })).toBe('tina');
    expect(resolveNovaSonicVoice({ language: 'en', persona: 'mira' })).toBe('amy');
  });

  it('unknown/absent persona falls back to the feminine voice', () => {
    expect(resolveNovaSonicVoice({ language: 'de' })).toBe('tina');
    expect(resolveNovaSonicVoice({ language: 'en', persona: 'zzz' })).toBe('amy');
  });

  it('handles regional tags and casing', () => {
    expect(resolveNovaSonicVoice({ language: 'de-DE', persona: 'devon' })).toBe('lennart');
    expect(resolveNovaSonicVoice({ language: 'DE_at', persona: 'Devon' })).toBe('lennart');
    expect(resolveNovaSonicVoice({ language: 'EN_us', persona: 'vitana' })).toBe('amy');
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
    // VTID-04445 — Devon gets pt-BR's male voice, never Vitana's.
    expect(resolveNovaSonicVoice({ language: 'pt', persona: 'devon' })).toBe('leo');
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
