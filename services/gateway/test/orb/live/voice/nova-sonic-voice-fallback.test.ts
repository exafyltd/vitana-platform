/**
 * VTID-03682 — the Nova voice substitution must be observable.
 *
 * Russian, Polish and Serbian were spoken by `tina` (Nova's GERMAN voice) in
 * production with no log, no telemetry and no signal of any kind, because the
 * call site ended `resolveNovaSonicVoice(...) ?? 'tina'`. These tests pin the
 * property that was missing — that a substitution REPORTS ITSELF — rather than
 * the voice value, which is deliberately unchanged.
 */

import {
  resolveNovaSonicVoice,
  resolveNovaSonicVoiceOrFallback,
  logNovaSonicVoiceFallbackOnce,
  __resetNovaSonicVoiceFallbackLog,
  NOVA_SONIC_FALLBACK_VOICE,
} from '../../../../src/orb/live/voice/nova-sonic-voice';
import * as fs from 'fs';
import * as path from 'path';

describe('VTID-03682: Nova voice fallback is explicit', () => {
  beforeEach(() => __resetNovaSonicVoiceFallbackLog());

  it('reports fallback=true for every language with no native Nova voice', () => {
    // These are the languages SUPPORTED_LIVE_LANGUAGES admits but NOVA_VOICES
    // has no entry for — i.e. every language that was silently getting German.
    for (const lang of ['ru', 'pl', 'sr', 'ar', 'zh', 'pt']) {
      const r = resolveNovaSonicVoiceOrFallback({ language: lang, persona: 'vitana' });
      expect(r.fallback).toBe(true);
      expect(r.voice).toBe(NOVA_SONIC_FALLBACK_VOICE);
    }
  });

  // VTID-03704 — `pt` removed: Nova answered a live Portuguese session in
  // English, so it is no longer a language Nova speaks and now cascades to
  // Polly. It belongs in the fallback=true list above, not here.
  it('reports fallback=false for languages Nova actually speaks', () => {
    for (const lang of ['en', 'de', 'fr', 'es']) {
      const r = resolveNovaSonicVoiceOrFallback({ language: lang, persona: 'vitana' });
      expect(r.fallback).toBe(false);
      expect(r.voice).toBe(resolveNovaSonicVoice({ language: lang, persona: 'vitana' }));
    }
  });

  it('does NOT change which voice is served — pl and sr work today on tina', () => {
    // The bug was the silence, not the choice. If this ever needs to change it
    // is a product decision about how ru/pl/sr SOUND, and it should break this
    // test loudly rather than drift.
    expect(NOVA_SONIC_FALLBACK_VOICE).toBe('tina');
    expect(resolveNovaSonicVoiceOrFallback({ language: 'ru', persona: 'vitana' }).voice).toBe('tina');
    expect(resolveNovaSonicVoiceOrFallback({ language: 'ru', persona: 'devon' }).voice).toBe('tina');
  });

  it('preserves the null contract of the underlying resolver', () => {
    // Other callers rely on null meaning "no native voice"; the new wrapper
    // must not have changed that by absorbing it.
    expect(resolveNovaSonicVoice({ language: 'ru', persona: 'vitana' })).toBeNull();
    expect(resolveNovaSonicVoice({ language: 'de', persona: 'vitana' })).toBe('tina');
  });

  it('logs the substitution once per language, not once per session', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) logNovaSonicVoiceFallbackOnce('ru', 'tina');
      logNovaSonicVoiceFallbackOnce('pl', 'tina');
      expect(warn).toHaveBeenCalledTimes(2);
      const msg = String(warn.mock.calls[0][0]);
      // The message must name the CONSEQUENCE, not just the substitution —
      // "using tina" tells a reader nothing; "German accent" tells them what
      // the user actually hears.
      expect(msg).toContain('nova_sonic');
      expect(msg).toContain('ru');
      expect(msg.toLowerCase()).toContain('german');
    } finally {
      warn.mockRestore();
    }
  });

  it('normalises locale tags so ru-RU does not log twice', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      logNovaSonicVoiceFallbackOnce('ru', 'tina');
      logNovaSonicVoiceFallbackOnce('ru-RU', 'tina');
      logNovaSonicVoiceFallbackOnce('RU', 'tina');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('the call site no longer uses a bare ?? fallback', () => {
    // The whole defect was one operator. A unit test of the resolver cannot
    // see the call site, and the call site is where it was wrong for months —
    // so assert on the source directly, the same way the repo guards other
    // wiring it has been burned by.
    const src = fs.readFileSync(
      path.join(__dirname, '../../../../src/routes/orb-live.ts'),
      'utf8',
    );
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    expect(code).not.toMatch(/resolveNovaSonicVoice\s*\([^)]*\)\s*\?\?/);
    expect(code).toContain('resolveNovaSonicVoiceOrFallback');
    expect(code).toContain('nova_voice_fallback');
  });

  it('latches the diag per session — connectToLiveAPI is re-entered on every reconnect AND rotation', () => {
    // Raised in review on #3136 and confirmed against the call graph:
    // `attemptTransparentReconnect()` calls `connectToLiveAPI()`, and a planned
    // Nova stream rotation (`_novaRotationInFlight`) goes through that same
    // path. Unlatched, one Russian session emits a row per rotation, so a
    // metric meant to count AFFECTED SESSIONS counts reconnects instead — the
    // very "signal that doesn't mean what it says" defect this VTID removes.
    const src = fs.readFileSync(
      path.join(__dirname, '../../../../src/routes/orb-live.ts'),
      'utf8',
    );
    // The emit must sit behind a session-scoped latch that is set before it.
    const guarded =
      /if\s*\(!\(session as any\)\._novaVoiceFallbackDiagEmitted\)\s*\{[\s\S]{0,400}?_novaVoiceFallbackDiagEmitted\s*=\s*true;[\s\S]{0,400}?emitDiag\(\s*session,\s*'nova_voice_fallback'/;
    expect(src).toMatch(guarded);

    // And the reconnect path this guards against must still be real — if
    // connectToLiveAPI ever stops being re-entered, this test should be
    // revisited deliberately rather than quietly passing for a new reason.
    expect(src).toMatch(/attemptTransparentReconnect/);
    expect(src).toMatch(/_novaRotationInFlight/);
  });
});
