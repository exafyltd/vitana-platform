/**
 * VTID-02857: Voice configuration REST endpoints.
 *
 *   GET  /api/v1/voice/config              read full config
 *   PUT  /api/v1/voice/config              partial-merge update; emits voice.config.updated
 *   GET  /api/v1/voice/tts-voices          enumerate voices for {provider, language}
 *   POST /api/v1/voice/preview             synthesize a phrase via the active TTS provider
 *
 * V2V (vertex / livekit) flips continue to live in orb-livekit.ts because of
 * the 60-min cooldown semantics. The Providers & Voice operator screen calls
 * both endpoints from the same form.
 */

import { Router, Request, Response } from 'express';
import textToSpeech, { protos } from '@google-cloud/text-to-speech';
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
let _ttsClient: InstanceType<typeof textToSpeech.TextToSpeechClient> | null = null;
function getTtsClient(): InstanceType<typeof textToSpeech.TextToSpeechClient> {
  if (!_ttsClient) {
    _ttsClient = new textToSpeech.TextToSpeechClient();
  }
  return _ttsClient;
}

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
    };
    const text = (body.text || '').slice(0, 500);
    if (!text) {
      return res.status(400).json({ ok: false, error: 'text required', vtid: VTID });
    }

    const provider = body.provider || 'google_tts';
    if (provider !== 'google_tts') {
      return res.status(400).json({
        ok: false,
        error: `preview for provider '${provider}' not implemented yet`,
        vtid: VTID,
      });
    }

    const language = body.language || 'en';
    const voiceList = GOOGLE_TTS_VOICES_BY_LANGUAGE[language] || GOOGLE_TTS_VOICES_BY_LANGUAGE.en;
    const requestedVoice = body.voice ? voiceList.find((v) => v.name === body.voice) : null;
    const voice = requestedVoice || voiceList[0];

    const speakingRate = clampRate(body.speaking_rate);

    const useGemini = voice.tier === 'gemini';
    const voiceParams: protos.google.cloud.texttospeech.v1.IVoiceSelectionParams = {
      languageCode: voice.languageCode,
      name: voice.name,
    };
    if (useGemini) {
      // @ts-ignore - modelName is supported but types may be outdated
      voiceParams.modelName = 'gemini-2.5-flash-tts';
    }

    try {
      const client = getTtsClient();
      const [response] = await client.synthesizeSpeech({
        input: { text },
        voice: voiceParams,
        audioConfig: {
          audioEncoding: 'MP3' as never,
          speakingRate,
          pitch: 0,
        },
      });
      if (!response.audioContent) {
        return res.status(500).json({ ok: false, error: 'no audio content', vtid: VTID });
      }
      res.setHeader('Content-Type', 'audio/mpeg');
      res.send(response.audioContent);
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message, vtid: VTID });
    }
  },
);

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
