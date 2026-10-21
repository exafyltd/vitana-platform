/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: greeting AUDIO bridge — TTS synthesis.
 *
 * Requests LINEAR16 PCM so the output drops straight into the EXISTING PCM
 * playback pipeline the live greeting audio already uses (orb-widget.js's
 * `_processQueue`) — no client-side changes, no risk of two audio elements
 * racing/overlapping.
 *
 * BOOTSTRAP-ORB-GREETING-BRIDGE-NO-GOOGLE (VTID-03802): this module used to
 * hold its own `TextToSpeechClient` and fall through to a live Google Cloud
 * TTS call whenever Polly could not serve a request. GCP is fully
 * decommissioned (VTID-03599/VTID-03649) — see
 * `synthesizeGreetingBridgeAudioPcm`'s doc comment for why that fallback was
 * removed rather than fixed to work around a dead host.
 */

import { getVoiceConfig } from '../voice-config';
// VTID-03495: Polly seam. No-ops unless TTS_PROVIDER=polly.
import { tryPollySynthesis } from './tts-provider';
import { POLLY_PCM_SAMPLE_RATE_HZ } from './polly';

export const GREETING_BRIDGE_PCM_SAMPLE_RATE_HZ = POLLY_PCM_SAMPLE_RATE_HZ;

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
 * Synthesize `text` to base64 LINEAR16 PCM mono via Polly. Returns null on
 * any failure (unsupported language, API error, empty text) — this is a UX
 * enhancement, never allowed to block or fail the real greeting path.
 *
 * BOOTSTRAP-ORB-GREETING-BRIDGE-NO-GOOGLE (VTID-03802): the Google Cloud TTS
 * fallback below this comment used to run when Polly could not serve a
 * request (unsupported language, or a Polly API error with
 * `TTS_POLLY_STRICT` unset/false). GCP has been fully decommissioned since
 * VTID-03599/VTID-03649 — billing disabled, the project deleted — so that
 * fallback no longer degrades gracefully to a slower/different provider, it
 * reaches for a host that cannot answer. This function is called from
 * `sendGreetingAudioBridge()`, which the SSE `/live/stream` handler `await`s
 * BEFORE opening the real upstream (Nova) connection — so a hang here stalls
 * the entire session before a single diagnostic event is emitted, before
 * `connectToLiveAPI` is ever called, and before any error reaches the
 * client. Confirmed live 2026-09-02 via `oasis_events`: multiple production
 * SSE sessions show `orb.session.identity.resolved` →
 * `vtid.live.session.start` → `orb.live.context.bootstrap` (all within
 * milliseconds) followed by total silence — zero further `orb.live.diag`
 * events of any kind — until an unrelated `idle_no_engagement` watchdog
 * closes the session 90-145s later. That is exactly the reported symptom
 * ("just connecting all the time"), and exactly the shape a hung `await`
 * with no timeout and no error would produce. Per CLAUDE.md's own standing
 * rule ("if you find a live reference to a GCP host, treat it as dead code
 * to be removed on sight, not as a fallback target"), the Google branch is
 * removed rather than reached for. `TTS_POLLY_STRICT` already made this
 * exact skip explicit and intentional for Serbian; it is now the ONLY
 * behavior for any Polly failure — a lost bridge phrase (this function's
 * whole output is a nicety, not the real greeting) beats a session that
 * never connects.
 */
export async function synthesizeGreetingBridgeAudioPcm(
  text: string,
  lang: string,
): Promise<GreetingBridgeAudio | null> {
  if (!text || text.trim().length === 0) return null;

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

  // Polly did not serve this request (unsupported language, or an API
  // error under non-strict mode) — no bridge phrase this session. Falling
  // through to Google Cloud TTS here would call a decommissioned service.
  return null;
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
