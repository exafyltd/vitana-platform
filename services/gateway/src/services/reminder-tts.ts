/**
 * VTID-02601 — Pre-render reminder TTS via Google Cloud TTS.
 *
 * Mirrors the voice/lang selection from the existing /api/v1/orb/tts endpoint
 * (Neural2 for en/de, Gemini-tts otherwise). We do this at insert time so the
 * tick endpoint at fire time only needs to read the row — no synthesis on
 * the critical path.
 */

import textToSpeech from '@google-cloud/text-to-speech';
import { protos } from '@google-cloud/text-to-speech';
// VTID-02857: speakingRate read from system_config['tts.speaking_rate']
import { getVoiceConfig } from './voice-config';

let ttsClient: InstanceType<typeof textToSpeech.TextToSpeechClient> | null = null;
try {
  ttsClient = new textToSpeech.TextToSpeechClient();
} catch (err: any) {
  console.warn(`[reminder-tts] TextToSpeechClient init failed (will retry on demand): ${err?.message}`);
}

// Voice catalogue mirrors orb-live.ts. Keep in sync if those change.
const NEURAL2_LANGS = new Set(['en', 'de']);
const NEURAL2_VOICES: Record<string, { name: string; languageCode: string }> = {
  en: { name: 'en-US-Neural2-F', languageCode: 'en-US' },
  de: { name: 'de-DE-Neural2-F', languageCode: 'de-DE' },
};
const GEMINI_TTS_VOICES: Record<string, { name: string; languageCode: string }> = {
  en: { name: 'Aoede', languageCode: 'en-US' },
  de: { name: 'Aoede', languageCode: 'de-DE' },
  fr: { name: 'Aoede', languageCode: 'fr-FR' },
  es: { name: 'Aoede', languageCode: 'es-ES' },
  ar: { name: 'Aoede', languageCode: 'ar-XA' },
  zh: { name: 'Aoede', languageCode: 'cmn-CN' },
  ru: { name: 'Aoede', languageCode: 'ru-RU' },
  sr: { name: 'Aoede', languageCode: 'sr-RS' },
};

function normalizeLang(input: string): string {
  return (input || 'en').toLowerCase().split(/[-_]/)[0].slice(0, 2) || 'en';
}

export async function synthesizeReminderTts(
  text: string,
  lang: string,
): Promise<{ audio_b64: string | null; voice: string | null; lang: string }> {
  if (!ttsClient) {
    try {
      ttsClient = new textToSpeech.TextToSpeechClient();
    } catch (err: any) {
      console.warn(`[reminder-tts] TTS client unavailable: ${err?.message}`);
      return { audio_b64: null, voice: null, lang };
    }
  }

  const normalizedLang = normalizeLang(lang);
  const useNeural2 = NEURAL2_LANGS.has(normalizedLang);
  const voiceConfig = useNeural2
    ? (NEURAL2_VOICES[normalizedLang] || NEURAL2_VOICES['en'])
    : (GEMINI_TTS_VOICES[normalizedLang] || GEMINI_TTS_VOICES['en']);

  const voiceParams: any = {
    languageCode: voiceConfig.languageCode,
    name: voiceConfig.name,
  };
  if (!useNeural2) {
    voiceParams.modelName = 'gemini-2.5-flash-tts';
  }

  // VTID-02857: speakingRate read from system_config['tts.speaking_rate']
  const __vc = await getVoiceConfig();
  const request: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
    input: { text },
    voice: voiceParams,
    audioConfig: {
      audioEncoding: 'MP3' as any,
      speakingRate: __vc.tts.speaking_rate,
      pitch: 0,
    },
  };

  const [response] = await ttsClient.synthesizeSpeech(request);
  if (!response.audioContent) {
    return { audio_b64: null, voice: voiceConfig.name, lang: normalizedLang };
  }

  const audio_b64 = Buffer.isBuffer(response.audioContent)
    ? response.audioContent.toString('base64')
    : Buffer.from(response.audioContent as Uint8Array).toString('base64');

  return { audio_b64, voice: voiceConfig.name, lang: normalizedLang };
}
