/**
 * VTID-04445 — owner rule (2026-09-23): every Vitana voice, in every
 * language, is a woman's voice; every Devon voice, in every language, is a
 * man's voice. This suite walks every voice table the platform can serve and
 * every hand-off gate, so a table entry of the wrong gender — or of unknown
 * gender — fails the build instead of reaching a member.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  PERSONA_VOICE_GENDER,
  personaVoiceGender,
  voiceGender,
  isVoiceAllowedForPersona,
} from '../src/orb/live/voice/persona-voice-gender';
import {
  resolveNovaSonicVoiceOrFallback,
  listNovaSonicVoices,
} from '../src/orb/live/voice/nova-sonic-voice';
import { resolvePollyVoice, resolvePollySpecialistVoice } from '../src/services/tts/polly';
import { listFishVoices } from '../src/services/tts/fish';
import { getLiveApiVoice, __resetLiveApiVoiceFallbackLogForTests } from '../src/orb/live/voice/live-api-voice';
import { getLiveLanguageVoice, getGeminiTtsVoice } from '../src/orb/live/voice/voice-mapping';
import { __resetPolicyResolverForTests } from '../src/services/decision-contract/policy-resolver';
import {
  enforceVertexVoiceGender,
  VERTEX_SPECIALIST_FALLBACK_VOICE,
} from '../src/orb/live/upstream/vertex-serbian-bridge';
import { personaVoiceAvailability } from '../src/orb/live/voice/specialist-voice-availability';

const LANGS = ['de', 'en', 'es', 'fr', 'pt', 'pl', 'ru', 'sr', 'ar', 'zh', 'tr'];

describe('VTID-04445 — the rule itself', () => {
  it('Vitana is female and Devon is male', () => {
    expect(PERSONA_VOICE_GENDER).toEqual({ vitana: 'female', devon: 'male' });
    expect(personaVoiceGender(null)).toBe('female'); // a session with no persona is Vitana
    expect(personaVoiceGender('Devon')).toBe('male');
  });
});

describe('Nova Sonic', () => {
  it('Vitana: a known female voice in every language (fallback included)', () => {
    for (const lang of LANGS) {
      const { voice } = resolveNovaSonicVoiceOrFallback({ language: lang, persona: 'vitana' });
      expect({ lang, g: voiceGender('nova', voice) }).toEqual({ lang, g: 'female' });
    }
  });

  it('Devon: a known male voice in every language (fallback included)', () => {
    for (const lang of LANGS) {
      const { voice } = resolveNovaSonicVoiceOrFallback({ language: lang, persona: 'devon' });
      expect({ lang, g: voiceGender('nova', voice) }).toEqual({ lang, g: 'male' });
    }
  });

  it('every table entry has the gender of its table', () => {
    const { female, male } = listNovaSonicVoices();
    for (const v of Object.values(female)) expect(voiceGender('nova', v)).toBe('female');
    for (const v of Object.values(male)) expect(voiceGender('nova', v)).toBe('male');
    expect(Object.keys(male).sort()).toEqual(Object.keys(female).sort());
  });
});

describe('Polly (cascade, greetings, narration, reminders)', () => {
  it('Vitana: every Polly voice is female', () => {
    for (const lang of LANGS) {
      const v = resolvePollyVoice(lang);
      if (!v) continue; // sr: Polly has no voice at all (Fish covers it)
      expect({ lang, g: voiceGender('polly', String(v.voiceId)) }).toEqual({ lang, g: 'female' });
    }
  });

  it('Devon: every Polly specialist voice is male', () => {
    for (const lang of LANGS) {
      const v = resolvePollySpecialistVoice(lang);
      if (!v) continue; // tr/zh/sr: covered by the male Fish voices below
      expect({ lang, g: voiceGender('polly', String(v.voiceId)) }).toEqual({ lang, g: 'male' });
    }
  });
});

describe('Fish (languages Polly cannot cover)', () => {
  it('Vitana voices are female, Devon voices are male', () => {
    const { receptionist, specialist } = listFishVoices();
    for (const v of Object.values(receptionist)) expect(voiceGender('fish', v.referenceId)).toBe('female');
    for (const v of Object.values(specialist)) expect(voiceGender('fish', v.referenceId)).toBe('male');
  });

  it('Devon has a male voice for every language where Polly has none', () => {
    const { specialist } = listFishVoices();
    for (const lang of LANGS) {
      if (resolvePollySpecialistVoice(lang)) continue;
      expect({ lang, fish: !!specialist[lang] }).toEqual({ lang, fish: true });
    }
  });
});

describe('Gemini (Serbian bridge; cache-cold fallbacks of the policy rows)', () => {
  beforeEach(() => {
    __resetPolicyResolverForTests();
    __resetLiveApiVoiceFallbackLogForTests();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('every Vitana language voice is female', () => {
    for (const lang of LANGS) {
      expect({ lang, api: voiceGender('gemini', getLiveApiVoice(lang)) }).toEqual({ lang, api: 'female' });
      expect({ lang, live: voiceGender('gemini', getLiveLanguageVoice(lang)) }).toEqual({ lang, live: 'female' });
      expect({ lang, tts: voiceGender('gemini', getGeminiTtsVoice(lang).name) }).toEqual({ lang, tts: 'female' });
    }
  });

  it('enforceVertexVoiceGender: Devon never female, Vitana never male', () => {
    expect(enforceVertexVoiceGender('Charon', 'devon')).toBe('Charon');
    expect(enforceVertexVoiceGender('Aoede', 'devon')).toBe(VERTEX_SPECIALIST_FALLBACK_VOICE);
    expect(enforceVertexVoiceGender('Fenrir', 'vitana')).toBe('Aoede');
    expect(enforceVertexVoiceGender('Vindemiatrix', 'vitana')).toBe('Vindemiatrix');
    expect(enforceVertexVoiceGender('NotAVoice', 'vitana')).toBe('Aoede');
    expect(voiceGender('gemini', VERTEX_SPECIALIST_FALLBACK_VOICE)).toBe('male');
  });

  it('Devon registry voice (agent_personas.voice_id = Charon) is allowed', () => {
    expect(isVoiceAllowedForPersona('gemini', 'Charon', 'devon')).toBe(true);
    expect(isVoiceAllowedForPersona('gemini', 'Charon', 'vitana')).toBe(false);
  });
});

describe('hand-off gate — Devon only joins when he can speak with a male voice', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('Nova and the Serbian bridge: always', () => {
    for (const lang of LANGS) {
      expect(personaVoiceAvailability({ persona: 'devon', lang, provider: 'nova_sonic' }).ok).toBe(true);
      expect(personaVoiceAvailability({ persona: 'devon', lang, provider: 'vertex' }).ok).toBe(true);
    }
  });

  it('cascade: a male Polly voice (ru), else the male Fish voice only when Fish is configured', () => {
    delete process.env.TTS_FISH_FALLBACK_ENABLED;
    delete process.env.FISH_API_KEY;
    expect(personaVoiceAvailability({ persona: 'devon', lang: 'ru', provider: 'cascaded' }).ok).toBe(true);
    for (const lang of ['tr', 'zh', 'sr']) {
      expect(personaVoiceAvailability({ persona: 'devon', lang, provider: 'cascaded' })).toEqual({
        ok: false,
        pipeline: 'cascaded',
        reason: 'no_male_voice_for_language',
      });
    }
    process.env.TTS_FISH_FALLBACK_ENABLED = 'true';
    process.env.FISH_API_KEY = 'k';
    for (const lang of ['tr', 'zh', 'sr']) {
      expect(personaVoiceAvailability({ persona: 'devon', lang, provider: 'cascaded' }).ok).toBe(true);
    }
  });

  it('Vitana is never blocked', () => {
    for (const lang of LANGS) {
      expect(personaVoiceAvailability({ persona: 'vitana', lang, provider: 'cascaded' }).ok).toBe(true);
    }
  });

  it('both hand-off sites in orb-live.ts ask the gate before queueing a swap', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/orb-live.ts'), 'utf8');
    // report_to_specialist
    expect(src).toMatch(
      /pickedPersona !== RECEPTIONIST_PERSONA_KEY && \(!_handoffVoice \|\| _handoffVoice\.ok\) && \(await registryIsValidPersona\(pickedPersona\)\)/,
    );
    // switch_persona
    expect(src).toMatch(/const _swapVoice = personaVoiceAvailability\(\{ persona: target,/);
    expect(src).toMatch(/if \(!_swapVoice\.ok\) \{/);
    // the Vertex setup voice goes through the gender gate
    expect(src).toMatch(/_personaVoice = enforceVertexVoiceGender\(_personaVoice, _persona\);/);
  });
});

describe('LiveKit orb-agent (Python) — Vitana language defaults', () => {
  it('every google_tts default voice is female', () => {
    const py = fs.readFileSync(
      path.join(__dirname, '../../agents/orb-agent/src/orb_agent/providers.py'),
      'utf8',
    );
    const block = py.slice(py.indexOf('"google_tts": {'), py.indexOf('"cartesia"'));
    const voices = [...block.matchAll(/"([a-z]{2})":\s*"([^"]+)"/g)].map((m) => ({ lang: m[1], voice: m[2] }));
    expect(voices.length).toBeGreaterThanOrEqual(8);
    for (const { lang, voice } of voices) {
      expect({ lang, g: voiceGender('gemini', voice) }).toEqual({ lang, g: 'female' });
    }
  });
});
