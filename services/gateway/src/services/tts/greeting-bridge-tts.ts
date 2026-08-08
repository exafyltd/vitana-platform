/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: greeting AUDIO bridge — TTS synthesis.
 *
 * Separate `TextToSpeechClient` instance from the one `routes/orb-live.ts`
 * uses for `/tts` (that one is module-private there) — Google's TTS client
 * is stateless/ADC-backed, so a second instance is safe and keeps this
 * module import-cycle-free from the route file.
 *
 * Requests LINEAR16 @ 24kHz (not MP3) so the output drops straight into the
 * EXISTING PCM playback pipeline the live greeting audio already uses
 * (orb-widget.js's `_processQueue`) — no client-side changes, no risk of
 * two audio elements racing/overlapping.
 */

import { TextToSpeechClient, protos } from '@google-cloud/text-to-speech';
import { getNeural2TtsVoice, getGeminiTtsVoice, isNeural2EnabledFor } from '../../orb/live/voice/voice-mapping';
import { getVoiceConfig } from '../voice-config';
// VTID-03495: Polly seam. No-ops unless TTS_PROVIDER=polly.
import { tryPollySynthesis, GOOGLE_PCM_SAMPLE_RATE_HZ } from './tts-provider';

let bridgeTtsClient: TextToSpeechClient | null = null;
try {
  bridgeTtsClient = new TextToSpeechClient();
} catch (err) {
  console.warn('[GREETING-BRIDGE-TTS] Failed to initialize TTS client:', (err as Error).message);
}

export const GREETING_BRIDGE_PCM_SAMPLE_RATE_HZ = GOOGLE_PCM_SAMPLE_RATE_HZ;

/**
 * Result of a greeting-bridge synthesis.
 *
 * VTID-03495: `sampleRateHz` is now returned rather than implied by the
 * module constant. Polly's PCM output cannot do 24kHz (8k/16k only), so the
 * rate depends on which provider served the request and the caller must use
 * this value when building the `audio/pcm;rate=` mime. Assuming 24kHz under
 * Polly would play 16kHz samples 1.5x too fast — chipmunk audio, and a
 * failure mode that is obvious to a listener but invisible to any test that
 * only checks "did we get bytes back".
 */
export interface GreetingBridgeAudio {
  audioB64: string;
  sampleRateHz: number;
}

/**
 * Synthesize `text` to base64 LINEAR16 PCM mono. Returns null on any
 * failure (missing client, API error, empty response) — this is a UX
 * enhancement, never allowed to block or fail the real greeting path.
 */
export async function synthesizeGreetingBridgeAudioPcm(
  text: string,
  lang: string,
): Promise<GreetingBridgeAudio | null> {
  if (!text || text.trim().length === 0) return null;

  // VTID-03495: Polly first when configured; falls through to Google below
  // (logged) when Polly can't serve it and strict mode is off.
  const vcForPolly = await getVoiceConfig();
  const polly = await tryPollySynthesis({
    text,
    lang,
    format: 'pcm',
    speakingRate: vcForPolly.tts.speaking_rate,
    callSite: 'greeting-bridge',
  });
  if (polly) {
    // Polly PCM is headerless already — no WAV stripping needed.
    return { audioB64: polly.audioB64, sampleRateHz: polly.sampleRateHz };
  }

  if (!bridgeTtsClient) return null;

  try {
    const useNeural2 = isNeural2EnabledFor(lang);
    const voiceConfig = useNeural2 ? getNeural2TtsVoice(lang) : getGeminiTtsVoice(lang);
    const voiceParams: Record<string, unknown> = {
      languageCode: voiceConfig.languageCode,
      name: voiceConfig.name,
    };
    if (!useNeural2) {
      voiceParams.modelName = 'gemini-2.5-flash-tts';
    }

    const vc = await getVoiceConfig();
    const request: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
      input: { text },
      voice: voiceParams,
      audioConfig: {
        audioEncoding: 'LINEAR16' as any,
        sampleRateHertz: GREETING_BRIDGE_PCM_SAMPLE_RATE_HZ,
        speakingRate: vc.tts.speaking_rate,
        pitch: 0,
      },
    };

    const [response] = await bridgeTtsClient.synthesizeSpeech(request);
    if (!response.audioContent) return null;

    // LINEAR16 output from Cloud TTS includes a 44-byte WAV header (RIFF/fmt/data
    // chunks) even though we asked for raw PCM — the playback pipeline expects
    // headerless PCM samples (it wraps the bytes in its own AudioBuffer), so the
    // header must be stripped or every bridge phrase would open with ~2.5ms of
    // header-as-noise and a WAV-chunk-sized DC click.
    const raw = Buffer.isBuffer(response.audioContent)
      ? response.audioContent
      : Buffer.from(response.audioContent as Uint8Array);
    const pcm = stripWavHeaderIfPresent(raw);
    return { audioB64: pcm.toString('base64'), sampleRateHz: GREETING_BRIDGE_PCM_SAMPLE_RATE_HZ };
  } catch (err) {
    console.warn('[GREETING-BRIDGE-TTS] Synthesis failed:', (err as Error).message);
    return null;
  }
}

/** Cloud TTS LINEAR16 responses are WAV-wrapped; strip the RIFF header if present. */
export function stripWavHeaderIfPresent(buf: Buffer): Buffer {
  if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    // Find the 'data' subchunk rather than assuming a fixed 44-byte header —
    // WAV allows extra chunks (e.g. 'fact') before 'data' for some encoders.
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const chunkId = buf.toString('ascii', offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);
      if (chunkId === 'data') {
        return buf.subarray(offset + 8, offset + 8 + chunkSize);
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
  }
  return buf;
}
