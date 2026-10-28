/**
 * VTID-02857: Voice configuration REST endpoints.
 *
 *   GET  /api/v1/voice/config              read full config
 *   PUT  /api/v1/voice/config              partial-merge update; emits voice.config.updated
 *   GET  /api/v1/voice/tts-voices          enumerate voices for {provider, language}
 *   POST /api/v1/voice/preview             synthesize a phrase via the active TTS provider
 *   GET  /api/v1/voice/preview/google-voices?lang=ru|sr  female Google voices (VTID-05026)
 *
 * V2V (vertex / livekit) flips continue to live in orb-livekit.ts because of
 * the 60-min cooldown semantics. The Providers & Voice operator screen calls
 * both endpoints from the same form.
 */

import { Router, Request, Response } from 'express';
// VTID-03495: Polly preview support (explicit `provider: 'polly'` only).
import { synthesizePolly, resolvePollyVoice, normalizeLang, POLLY_UNSUPPORTED_LANGS } from '../services/tts/polly';
// VTID-05026: Google preview for the Audiobook narration languages (ru, sr) only.
import { synthesizeGoogleNarrationMp3, listGoogleVoices } from '../services/tts/google-narration';
import { AUDIOBOOK_GOOGLE_VOICES, AUDIOBOOK_POLLY_VOICES } from '../services/guided-journey/audiobook-voices';
import type { Engine, VoiceId } from '@aws-sdk/client-polly';
// VTID-03970: Fish Audio preview support (explicit `provider: 'fish'` only).
import { synthesizeFish, isFishConfigured } from '../services/tts/fish';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  requireAuthWithTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import {
  getVoiceConfig,
  putVoiceConfig,
  invalidateVoiceConfigCache,
  IMPLEMENTED_TTS_PROVIDERS,
  IMPLEMENTED_STT_PROVIDERS,
} from '../services/voice-config';

const router = Router();
const VTID = 'VTID-02857';

// Mirrors the maps in routes/orb-live.ts. Kept in sync by hand for now;
// PR 2 doesn't move them to the helper to avoid an import cycle. Future
// follow-up consolidates them under services/voice-config.ts.
const GOOGLE_TTS_VOICES_BY_LANGUAGE: Record<string, Array<{ name: string; languageCode: string; tier: 'neural2' | 'wavenet' | 'standard' | 'gemini' }>> = {
  en: [
    { name: 'en-US-Neural2-H', languageCode: 'en-US', tier: 'neural2' },
    { name: 'en-US-Neural2-D', languageCode: 'en-US', tier: 'neural2' },
    { name: 'en-US-Neural2-F', languageCode: 'en-US', tier: 'neural2' },
    { name: 'en-US-Wavenet-F', languageCode: 'en-US', tier: 'wavenet' },
    { name: 'Kore', languageCode: 'en-US', tier: 'gemini' },
  ],
  de: [
    { name: 'de-DE-Neural2-G', languageCode: 'de-DE', tier: 'neural2' },
    { name: 'de-DE-Neural2-F', languageCode: 'de-DE', tier: 'neural2' },
    { name: 'de-DE-Wavenet-F', languageCode: 'de-DE', tier: 'wavenet' },
    { name: 'Kore', languageCode: 'de-DE', tier: 'gemini' },
  ],
  fr: [
    { name: 'fr-FR-Neural2-A', languageCode: 'fr-FR', tier: 'neural2' },
    { name: 'fr-FR-Neural2-B', languageCode: 'fr-FR', tier: 'neural2' },
    { name: 'fr-FR-Wavenet-A', languageCode: 'fr-FR', tier: 'wavenet' },
    { name: 'Kore', languageCode: 'fr-FR', tier: 'gemini' },
  ],
  es: [
    { name: 'es-ES-Neural2-A', languageCode: 'es-ES', tier: 'neural2' },
    { name: 'es-ES-Wavenet-C', languageCode: 'es-ES', tier: 'wavenet' },
    { name: 'Kore', languageCode: 'es-ES', tier: 'gemini' },
  ],
  ar: [
    { name: 'ar-XA-Wavenet-D', languageCode: 'ar-XA', tier: 'wavenet' },
    { name: 'ar-XA-Wavenet-A', languageCode: 'ar-XA', tier: 'wavenet' },
    { name: 'Kore', languageCode: 'ar-XA', tier: 'gemini' },
  ],
  zh: [
    { name: 'cmn-CN-Wavenet-A', languageCode: 'cmn-CN', tier: 'wavenet' },
    { name: 'cmn-CN-Wavenet-B', languageCode: 'cmn-CN', tier: 'wavenet' },
    { name: 'Kore', languageCode: 'cmn-CN', tier: 'gemini' },
  ],
  ru: [
    { name: 'ru-RU-Wavenet-A', languageCode: 'ru-RU', tier: 'wavenet' },
    { name: 'ru-RU-Wavenet-C', languageCode: 'ru-RU', tier: 'wavenet' },
    { name: 'Kore', languageCode: 'ru-RU', tier: 'gemini' },
  ],
  sr: [
    { name: 'sr-RS-Standard-A', languageCode: 'sr-RS', tier: 'standard' },
    { name: 'Kore', languageCode: 'sr-RS', tier: 'gemini' },
  ],
};

const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English (US)' },
  { code: 'de', label: 'Deutsch (DE)' },
  { code: 'fr', label: 'Français (FR)' },
  { code: 'es', label: 'Español (ES)' },
  { code: 'ar', label: 'العربية' },
  { code: 'zh', label: '中文 (普通话)' },
  { code: 'ru', label: 'Русский' },
  { code: 'sr', label: 'Srpski' },
];

// ---------------------------------------------------------------------------
// GET /api/v1/voice/config
// ---------------------------------------------------------------------------
router.get('/voice/config', async (_req: Request, res: Response) => {
  try {
    const cfg = await getVoiceConfig(true);
    res.json({
      ok: true,
      ...cfg,
      supported_languages: SUPPORTED_LANGUAGES,
      implemented: {
        tts_providers: Array.from(IMPLEMENTED_TTS_PROVIDERS),
        stt_providers: Array.from(IMPLEMENTED_STT_PROVIDERS),
      },
      vtid: VTID,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message, vtid: VTID });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/v1/voice/config — partial-merge update
// ---------------------------------------------------------------------------
router.put(
  '/voice/config',
  requireAuthWithTenant,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.identity?.exafy_admin) {
      return res.status(403).json({
        ok: false,
        error: 'exafy_admin role required to change voice config',
        vtid: VTID,
      });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await putVoiceConfig(
      {
        tts: body.tts as never,
        stt: body.stt as never,
      },
      req.identity?.user_id ?? null,
    );
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error, vtid: VTID });
    }
    if (Object.keys(result.diff || {}).length > 0) {
      try {
        await emitOasisEvent({
          type: 'voice.config.updated' as never,
          actor: req.identity?.user_id ?? 'system',
          payload: { diff: result.diff, vtid: VTID },
        } as never);
      } catch {
        // never block save on telemetry
      }
    }
    return res.json({ ok: true, diff: result.diff, vtid: VTID });
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/voice/tts-voices?provider=&language=
// ---------------------------------------------------------------------------
router.get('/voice/tts-voices', async (req: Request, res: Response) => {
  try {
    const provider = String(req.query.provider || 'google_tts');
    const language = String(req.query.language || 'en');
    if (provider !== 'google_tts') {
      return res.json({
        ok: true,
        provider,
        language,
        voices: [],
        note: `voice enumeration for provider '${provider}' not implemented yet`,
        vtid: VTID,
      });
    }
    const voices = GOOGLE_TTS_VOICES_BY_LANGUAGE[language] || [];
    res.json({ ok: true, provider, language, voices, vtid: VTID });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message, vtid: VTID });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/voice/preview — synthesize phrase via current TTS provider
// ---------------------------------------------------------------------------
// VTID-05026 — Google is used for the Audiobook narration of exactly two
// languages (ru, sr), each behind its own switch; previews follow the same
// boundary. Language → BCP-47 code for the voice list and synthesis.
const GOOGLE_PREVIEW_LANGS: Readonly<Record<string, string>> = { ru: 'ru-RU', sr: 'sr-RS' };
const GOOGLE_VOICE_NAME_RE = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9-]+$/;

router.post(
  '/voice/preview',
  requireAuthWithTenant,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.identity?.exafy_admin) {
      return res.status(403).json({ ok: false, error: 'exafy_admin role required', vtid: VTID });
    }
    const body = (req.body ?? {}) as {
      text?: string;
      language?: string;
      voice?: string;
      speaking_rate?: number;
      provider?: string;
      /** VTID-05026: Polly engine override, with `voice`, for auditioning. */
      engine?: string;
    };
    const text = (body.text || '').slice(0, 500);
    if (!text) {
      return res.status(400).json({ ok: false, error: 'text required', vtid: VTID });
    }

    const provider = body.provider || 'google_tts';
    if (provider !== 'google_tts' && provider !== 'polly' && provider !== 'fish') {
      return res.status(400).json({
        ok: false,
        error: `preview for provider '${provider}' not implemented yet`,
        vtid: VTID,
      });
    }

    // VTID-03495: Polly preview. Deliberately driven by the EXPLICIT `provider`
    // body param and NOT by the TTS_PROVIDER env var — this endpoint exists so
    // an operator can audition a specific provider/voice on demand, so honoring
    // an ambient env switch here would make previews lie about what they played.
    // Auditioning both sides is how the migration gets validated before flipping.
    if (provider === 'polly') {
      const pollyRate = clampRate(body.speaking_rate);
      // VTID-05026: `voice` + `engine` audition a specific Polly voice (e.g. a
      // generative Audiobook voice) in the language's own language code. An
      // invalid pair is rejected by Polly and answers 422 below.
      let voiceOverride: { voiceId: VoiceId; engine: Engine; languageCode: string } | undefined;
      if (body.voice || body.engine) {
        const lang = normalizeLang(body.language || 'en');
        const base = AUDIOBOOK_POLLY_VOICES[lang] ?? resolvePollyVoice(lang);
        if (!base || !body.voice || !body.engine) {
          return res.status(400).json({
            ok: false,
            error: 'polly preview override needs voice and engine, for a language Polly speaks',
            vtid: VTID,
          });
        }
        voiceOverride = { voiceId: body.voice as VoiceId, engine: body.engine as Engine, languageCode: base.languageCode };
      }
      const result = await synthesizePolly({
        text,
        lang: body.language || 'en',
        format: 'mp3',
        speakingRate: pollyRate,
        ...(voiceOverride ? { voiceOverride } : {}),
      });
      if (!result) {
        return res.status(422).json({
          ok: false,
          error:
            `Polly cannot synthesize language '${body.language || 'en'}'. ` +
            `Unsupported: ${[...POLLY_UNSUPPORTED_LANGS].join(', ')}.`,
          vtid: VTID,
        });
      }
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('X-Vitana-Tts-Voice', result.voice);
      res.setHeader('X-Vitana-Tts-Engine', result.engine);
      return res.send(Buffer.from(result.audioB64, 'base64'));
    }

    // VTID-03970: Fish Audio preview — same explicit-provider discipline as
    // Polly above. Deliberately calls the SAME `synthesizeFish()` the live
    // fallback uses (not a bypass), so this preview honestly reflects real
    // system state: until `TTS_FISH_FALLBACK_ENABLED` + `FISH_API_KEY` are
    // both set, it reports exactly that, rather than lying about what a real
    // request would do. That is the whole point of an audition tool — this
    // is the intended way to verify Fish sounds right before flipping the
    // fallback on for real users, not a workaround for it being off.
    if (provider === 'fish') {
      if (!isFishConfigured()) {
        return res.status(422).json({
          ok: false,
          error:
            'Fish Audio is not configured yet (TTS_FISH_FALLBACK_ENABLED and/or ' +
            'FISH_API_KEY unset on this environment) — see CLAUDE.md §2c-fish.',
          vtid: VTID,
        });
      }
      const result = await synthesizeFish({
        text,
        lang: body.language || 'en',
        format: 'mp3',
      });
      if (!result) {
        return res.status(422).json({
          ok: false,
          error: `Fish Audio has no curated voice for language '${body.language || 'en'}' yet.`,
          vtid: VTID,
        });
      }
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('X-Vitana-Tts-Voice', result.voice);
      return res.send(Buffer.from(result.audioB64, 'base64'));
    }

    // VTID-05026: `google_tts` previews the Audiobook narration voices of ru
    // and sr only, through the task-role auth client (the library's own ADC
    // lookup cannot work on ECS). No other language reaches Google.
    const lang = normalizeLang(body.language || '');
    const languageCode = GOOGLE_PREVIEW_LANGS[lang];
    if (!languageCode) {
      return res.status(400).json({
        ok: false,
        error: 'google_tts preview is limited to the Audiobook narration languages ru and sr',
        vtid: VTID,
      });
    }
    const pinned = AUDIOBOOK_GOOGLE_VOICES[lang as 'ru' | 'sr'];
    const name = body.voice || pinned?.name || '';
    if (!GOOGLE_VOICE_NAME_RE.test(name) || !name.startsWith(`${languageCode}-`)) {
      return res.status(400).json({ ok: false, error: `voice must be a ${languageCode} Google voice name`, vtid: VTID });
    }
    const started = Date.now();
    const out = await synthesizeGoogleNarrationMp3(text, { name, languageCode, modelName: null });
    if (!out) {
      return res.status(422).json({ ok: false, error: 'google_tts synthesis failed', vtid: VTID });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Vitana-Tts-Voice', name);
    res.setHeader('X-Vitana-Tts-Render-Ms', String(Date.now() - started));
    return res.send(out.mp3);
  },
);

// ---------------------------------------------------------------------------
// GET /api/v1/voice/preview/google-voices?lang=ru|sr — VTID-05026
// Read-only: the female Google voices for an Audiobook narration language,
// for the owner's audition. Refuses every other language.
// ---------------------------------------------------------------------------
router.get('/voice/preview/google-voices', requireAuthWithTenant, async (req: AuthenticatedRequest, res: Response) => {
    if (!req.identity?.exafy_admin) {
      return res.status(403).json({ ok: false, error: 'exafy_admin role required', vtid: VTID });
    }
    const lang = normalizeLang(String(req.query.lang || ''));
    const languageCode = GOOGLE_PREVIEW_LANGS[lang];
    if (!languageCode) {
      return res.status(400).json({ ok: false, error: 'lang must be ru or sr', vtid: VTID });
    }
    try {
      const voices = (await listGoogleVoices(languageCode)).filter((v) => v.ssmlGender === 'FEMALE');
      return res.json({
        ok: true,
        lang,
        language_code: languageCode,
        pinned: AUDIOBOOK_GOOGLE_VOICES[lang as 'ru' | 'sr']?.name ?? null,
        voices: voices.map((v) => ({
          name: v.name,
          ssml_gender: v.ssmlGender,
          natural_sample_rate_hertz: v.naturalSampleRateHertz,
        })),
        vtid: VTID,
      });
    } catch (e) {
      return res.status(502).json({ ok: false, error: (e as Error).message, vtid: VTID });
    }
});

function clampRate(n: unknown): number {
  const v = typeof n === 'number' ? n : parseFloat(String(n ?? 1.0));
  if (!Number.isFinite(v)) return 1.0;
  if (v < 0.25) return 0.25;
  if (v > 4.0) return 4.0;
  return v;
}

// Internal hook — let admin/diagnostics force a cache refresh after manual SQL.
router.post('/voice/config/cache/invalidate', requireAuthWithTenant, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.identity?.exafy_admin) {
    return res.status(403).json({ ok: false, error: 'exafy_admin role required', vtid: VTID });
  }
  invalidateVoiceConfigCache();
  res.json({ ok: true, vtid: VTID });
});

export default router;
