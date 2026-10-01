/**
 * VTID-04761 — Audiobook (guided journey) listening mode: per-topic MP3.
 *
 * The Audiobook player in My Journey plays the guided curriculum as plain
 * audio — no microphone, no live voice session. It reuses the exact narration
 * text and the exact deterministic engine the ORB tap path already uses
 * (VTID-03650: Amazon Polly reading the authored `voice_script`, never a
 * conversational model), only rendered as MP3 instead of raw 16 kHz PCM:
 *
 *   - MP3 is ~6x smaller than PCM for the same lesson, which matters on a
 *     phone listening through a whole season of episodes.
 *   - A browser <audio> element plays it directly, which is what gives the
 *     player lock-screen / background playback via the Media Session API.
 *
 * Voice: `resolvePollyVoice` — the receptionist (Vitana) voice, a woman's
 * voice in every language (persona rule 42a, pinned by the VTID-04445 test).
 *
 * Narration here is edited, translated curriculum content (owner decision for
 * this initiative): it is read out by TTS, word for word, exactly like the
 * pre-recorded lesson audio. Vitana's live conversational speech is untouched
 * and stays model-composed (NEVER-rule 41).
 *
 * Caching: the same NarrationAudioStore as the PCM path. The format is folded
 * into the key's engine field (`<engine>+mp3`), so an MP3 and a PCM render of
 * the same topic can never be served for each other.
 */

import type { GuidedTopicNarrationContent } from '../assistant-continuation/providers/guided-topic-narration';
import { buildGuidedTopicSpokenText, splitTextForPolly } from '../tts/guided-topic-narration-audio';
import { synthesizePolly, resolvePollyVoice } from '../tts/polly';
import {
  buildNarrationCacheKey,
  getNarrationAudioStore,
  type NarrationAudioStore,
} from '../tts/narration-audio-cache';

export interface AudiobookTopicAudio {
  /** Complete MP3 bytes for the whole topic. */
  mp3: Buffer;
  /** True when served from the narration cache. */
  cached: boolean;
}

/**
 * Render one topic's narration to MP3. Returns null when Polly cannot serve
 * the language (`sr`) or any chunk fails — never a partial lesson, and a
 * partial render is never written to the cache.
 */
export async function synthesizeAudiobookTopicMp3(
  content: GuidedTopicNarrationContent,
  lang: string,
  deps: {
    synthesize?: typeof synthesizePolly;
    store?: NarrationAudioStore | null;
  } = {},
): Promise<AudiobookTopicAudio | null> {
  const text = buildGuidedTopicSpokenText(content);
  if (!text) return null;

  const voice = resolvePollyVoice(lang);
  if (!voice) return null;

  const synthesize = deps.synthesize ?? synthesizePolly;
  const store = deps.store === undefined ? getNarrationAudioStore() : deps.store;
  const cacheKey = buildNarrationCacheKey({
    topicId: content.topic_id,
    lang,
    text,
    voiceId: String(voice.voiceId),
    engine: `${String(voice.engine)}+mp3`,
  });

  if (store) {
    const hit = await store.get(cacheKey);
    if (hit) return { mp3: Buffer.from(hit.audioB64, 'base64'), cached: true };
  }

  const chunks = splitTextForPolly(text);
  if (chunks.length === 0) return null;

  // MP3 is a stream of self-contained frames, so per-chunk renders join
  // end to end into one playable file.
  const buffers: Buffer[] = [];
  let sampleRateHz = 0;
  for (const chunk of chunks) {
    const result = await synthesize({ text: chunk, lang, format: 'mp3' });
    if (!result) return null;
    sampleRateHz = result.sampleRateHz;
    buffers.push(Buffer.from(result.audioB64, 'base64'));
  }
  const mp3 = Buffer.concat(buffers);

  if (store) await store.put(cacheKey, { audioB64: mp3.toString('base64'), sampleRateHz });

  console.log(
    `[AUDIOBOOK-TTS] cache=miss store=${store?.name ?? 'none'} topic=${content.topic_id} ` +
      `lang=${lang} voice=${voice.voiceId} engine=${voice.engine} chunks=${chunks.length} ` +
      `chars=${text.length} bytes=${mp3.length}`,
  );
  return { mp3, cached: false };
}
