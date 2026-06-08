// VTID-03126 — Phase D.3 of the decision-contract refactor.
//
// Locks the wire-up that migrates `LIVE_API_VOICES` from inline Record
// in routes/orb-live.ts to `decision_policy`-backed accessor with
// explicit fallback telemetry.

import {
  getLiveApiVoice,
  __resetLiveApiVoiceFallbackLogForTests,
} from '../../../../src/orb/live/voice/live-api-voice';
import {
  configurePolicyResolverForTests,
  __resetPolicyResolverForTests,
} from '../../../../src/services/decision-contract/policy-resolver';

const NOW_ISO = new Date().toISOString();

function seedVoice(lang: string, voiceName: string, fallbackLang: string | null) {
  configurePolicyResolverForTests({
    decisionPolicy: [
      {
        policy_key: `voice.live_api.voice.${lang}`,
        tenant_id: null,
        version: 1,
        value_json: { voice_name: voiceName, fallback_lang: fallbackLang },
        effective_from: NOW_ISO,
        effective_until: null,
      },
    ],
  });
}

describe('VTID-03126 Phase D.3 Live API voice accessor', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    __resetLiveApiVoiceFallbackLogForTests();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    __resetPolicyResolverForTests();
    __resetLiveApiVoiceFallbackLogForTests();
    warnSpy.mockRestore();
  });

  describe('cold-cache fallback path (byte-identical to pre-D.3 Record)', () => {
    beforeEach(() => {
      __resetPolicyResolverForTests();
    });

    it('en → Aoede (native, no warning)', () => {
      expect(getLiveApiVoice('en')).toBe('Aoede');
      // PolicyResolver may emit its own "policy.miss" warnings when the
      // cache has no row for a key — those are unrelated to the
      // voice-fallback contract. Assert that no [voice-fallback] line was
      // emitted.
      const voiceFallbackCalls = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].startsWith('[voice-fallback]'),
      );
      expect(voiceFallbackCalls).toHaveLength(0);
    });

    it('de → Kore (native, no warning)', () => {
      expect(getLiveApiVoice('de')).toBe('Kore');
      // PolicyResolver may emit its own "policy.miss" warnings when the
      // cache has no row for a key — those are unrelated to the
      // voice-fallback contract. Assert that no [voice-fallback] line was
      // emitted.
      const voiceFallbackCalls = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].startsWith('[voice-fallback]'),
      );
      expect(voiceFallbackCalls).toHaveLength(0);
    });

    it('fr → Charon (native, no warning)', () => {
      expect(getLiveApiVoice('fr')).toBe('Charon');
      // PolicyResolver may emit its own "policy.miss" warnings when the
      // cache has no row for a key — those are unrelated to the
      // voice-fallback contract. Assert that no [voice-fallback] line was
      // emitted.
      const voiceFallbackCalls = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].startsWith('[voice-fallback]'),
      );
      expect(voiceFallbackCalls).toHaveLength(0);
    });

    it('es → Fenrir (native, no warning)', () => {
      expect(getLiveApiVoice('es')).toBe('Fenrir');
      // PolicyResolver may emit its own "policy.miss" warnings when the
      // cache has no row for a key — those are unrelated to the
      // voice-fallback contract. Assert that no [voice-fallback] line was
      // emitted.
      const voiceFallbackCalls = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].startsWith('[voice-fallback]'),
      );
      expect(voiceFallbackCalls).toHaveLength(0);
    });

    it('ar → Aoede (English fallback) and emits a warning', () => {
      expect(getLiveApiVoice('ar')).toBe('Aoede');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/lang="ar".*using "en" voice "Aoede"/),
      );
    });

    it('zh → Kore (German fallback) and emits a warning', () => {
      expect(getLiveApiVoice('zh')).toBe('Kore');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/lang="zh".*using "de" voice "Kore"/),
      );
    });

    it('ru → Aoede (English fallback) and emits a warning', () => {
      expect(getLiveApiVoice('ru')).toBe('Aoede');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/lang="ru".*using "en" voice "Aoede"/),
      );
    });

    it('sr → Aoede (English fallback) and emits a warning', () => {
      expect(getLiveApiVoice('sr')).toBe('Aoede');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/lang="sr".*using "en" voice "Aoede"/),
      );
    });
  });

  describe('telemetry de-duplication', () => {
    beforeEach(() => {
      __resetPolicyResolverForTests();
    });

    it('emits the fallback warning at most once per (lang, fallback_lang) pair', () => {
      for (let i = 0; i < 5; i++) {
        getLiveApiVoice('ar');
      }
      // 5 calls, but the (ar, en) pair logs only once across the process
      // lifetime — high-cardinality voice sessions cannot spam the logger.
      const voiceFallbackCalls = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].startsWith('[voice-fallback]'),
      );
      expect(voiceFallbackCalls).toHaveLength(1);
    });

    it('different fallback langs each get their own one-time warning', () => {
      getLiveApiVoice('ar'); // (ar, en)
      getLiveApiVoice('zh'); // (zh, de)
      getLiveApiVoice('ru'); // (ru, en)
      getLiveApiVoice('sr'); // (sr, en)
      const voiceFallbackCalls = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].startsWith('[voice-fallback]'),
      );
      expect(voiceFallbackCalls).toHaveLength(4);
    });
  });

  describe('resolver-seeded path — DB row wins over fallback', () => {
    it('returns the seeded voice_name', () => {
      seedVoice('ar', 'NewArabicVoice', null);
      expect(getLiveApiVoice('ar')).toBe('NewArabicVoice');
    });

    it('clearing fallback_lang in DB silences the telemetry', () => {
      // Operational dream: ship a native Arabic voice → edit the DB row
      // → no code change, no deploy, no warning.
      seedVoice('ar', 'NativeArabic', null);
      getLiveApiVoice('ar');
      getLiveApiVoice('ar');
      // PolicyResolver may emit its own "policy.miss" warnings when the
      // cache has no row for a key — those are unrelated to the
      // voice-fallback contract. Assert that no [voice-fallback] line was
      // emitted.
      const voiceFallbackCalls = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].startsWith('[voice-fallback]'),
      );
      expect(voiceFallbackCalls).toHaveLength(0);
    });

    it('setting fallback_lang in DB on a previously-native lang surfaces a warning', () => {
      // The reverse of the above: tagging a voice as fallback (e.g. a
      // regression where we have to temporarily route fr to en) makes
      // the silent voice routing visible.
      seedVoice('fr', 'Aoede', 'en');
      getLiveApiVoice('fr');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/lang="fr".*using "en" voice "Aoede"/),
      );
    });
  });

  describe('input sanitization', () => {
    beforeEach(() => {
      __resetPolicyResolverForTests();
    });

    it('empty string lang → English default, no warning', () => {
      expect(getLiveApiVoice('')).toBe('Aoede');
      // PolicyResolver may emit its own "policy.miss" warnings when the
      // cache has no row for a key — those are unrelated to the
      // voice-fallback contract. Assert that no [voice-fallback] line was
      // emitted.
      const voiceFallbackCalls = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].startsWith('[voice-fallback]'),
      );
      expect(voiceFallbackCalls).toHaveLength(0);
    });

    it('unknown lang → English fallback voice (Aoede), no warning (no DB row at all)', () => {
      // No DB row for "jp"; no entry in LIVE_API_VOICE_FALLBACKS either.
      // The accessor's safety-net is the English row, which is native.
      expect(getLiveApiVoice('jp')).toBe('Aoede');
      // PolicyResolver may emit its own "policy.miss" warnings when the
      // cache has no row for a key — those are unrelated to the
      // voice-fallback contract. Assert that no [voice-fallback] line was
      // emitted.
      const voiceFallbackCalls = warnSpy.mock.calls.filter((args) =>
        typeof args[0] === 'string' && args[0].startsWith('[voice-fallback]'),
      );
      expect(voiceFallbackCalls).toHaveLength(0);
    });
  });
});
