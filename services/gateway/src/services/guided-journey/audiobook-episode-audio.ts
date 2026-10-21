/**
 * VTID-04761 — Audiobook (guided journey) listening mode: per-topic MP3.
 *
 * The Audiobook player in My Journey plays the guided curriculum as plain
 * audio — no microphone, no live voice session. It reuses the exact narration
 * text the ORB tap path already uses (VTID-03650: a TTS voice reading the
 * authored `voice_script`, never a conversational model), rendered as MP3:
 *
 *   - MP3 is ~6x smaller than PCM for the same lesson, which matters on a
 *     phone listening through a whole season of episodes.
 *   - A browser <audio> element plays it directly, which is what gives the
 *     player lock-screen / background playback via the Media Session API.
 *
 * Voice (VTID-05026): the Audiobook voice table (`audiobook-voices.ts`) —
 * Polly for nine languages, Google for ru and sr behind their own switches
 * and the per-task daily cap. A woman's voice in every language (persona
 * rule 42a, pinned by the VTID-04445 test). A failed or capped render
 * returns null (the route answers 422); it never falls back to another voice.
 *
 * Narration here is edited, translated curriculum content (owner decision for
 * this initiative): it is read out by TTS, word for word, exactly like the
 * pre-recorded lesson audio. Vitana's live conversational speech is untouched
 * and stays model-composed (NEVER-rule 41).
 *
 * Caching: the same NarrationAudioStore as the PCM path. The provider, engine
 * and format are folded into the key's engine field
 * (`<provider>:<engine>+mp3`), so renders by two providers, or an MP3 and a
 * PCM render, can never be served for each other. Concurrent requests for
 * the same key share one render.
 */

import type { GuidedTopicNarrationContent } from '../assistant-continuation/providers/guided-topic-narration';
import { buildGuidedTopicSpokenText, splitTextForPolly } from '../tts/guided-topic-narration-audio';
import { synthesizePolly } from '../tts/polly';
import { synthesizeGoogleNarrationMp3, type GoogleSynthesizeFn } from '../tts/google-narration';
import {
  buildNarrationCacheKey,
  getNarrationAudioStore,
  type NarrationAudioStore,
} from '../tts/narration-audio-cache';
import { resolveAudiobookVoice, type AudiobookVoice } from './audiobook-voices';
import { reserveAudiobookGoogleChars } from './audiobook-google-budget';

export type AudiobookVoiceProvider = 'polly' | 'google';

export interface AudiobookTopicAudio {
  /** Complete MP3 bytes for the whole topic. */
  mp3: Buffer;
  /** True when served from the narration cache. */
  cached: boolean;
  /** Who rendered the narration (`X-Audiobook-Voice-Provider`). */
  provider: AudiobookVoiceProvider;
}

/** Renders in flight, keyed by cache key, so concurrent plays share one render. */
const inFlight = new Map<string, Promise<AudiobookTopicAudio | null>>();

/** Test hook. */
export function __inFlightAudiobookRendersForTests(): number {
  return inFlight.size;
}

const ENGINE_LABEL = (v: AudiobookVoice) =>
  v.provider === 'polly' ? `polly:${String(v.engine)}` : `google:${v.modelName ?? 'voice'}`;
const VOICE_LABEL = (v: AudiobookVoice) => (v.provider === 'polly' ? String(v.voiceId) : v.name);

/**
 * Render one topic's narration to MP3. Returns null when no voice may read
 * the language, the daily Google cap is reached, or any chunk fails — never
 * a partial lesson, and a partial render is never written to the cache.
 */
export async function synthesizeAudiobookTopicMp3(
  content: GuidedTopicNarrationContent,
  lang: string,
  deps: {
    synthesize?: typeof synthesizePolly;
    synthesizeGoogle?: GoogleSynthesizeFn;
    store?: NarrationAudioStore | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<AudiobookTopicAudio | null> {
  const text = buildGuidedTopicSpokenText(content);
  if (!text) return null;

  const voice = resolveAudiobookVoice(lang, deps.env);
  if (!voice) return null;

  const store = deps.store === undefined ? getNarrationAudioStore() : deps.store;
  const cacheKey = buildNarrationCacheKey({
    topicId: content.topic_id,
    lang,
    text,
    voiceId: VOICE_LABEL(voice),
    engine: `${ENGINE_LABEL(voice)}+mp3`,
  });

  if (store) {
    const hit = await store.get(cacheKey);
    if (hit) return { mp3: Buffer.from(hit.audioB64, 'base64'), cached: true, provider: voice.provider };
  }

  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const render = renderTopic(content.topic_id, text, lang, voice, cacheKey, store, deps).finally(() => {
    inFlight.delete(cacheKey);
  });
  inFlight.set(cacheKey, render);
  return render;
}

async function renderTopic(
  topicId: string,
  text: string,
  lang: string,
  voice: AudiobookVoice,
  cacheKey: string,
  store: NarrationAudioStore | null,
  deps: { synthesize?: typeof synthesizePolly; synthesizeGoogle?: GoogleSynthesizeFn; env?: NodeJS.ProcessEnv },
): Promise<AudiobookTopicAudio | null> {
  let mp3: Buffer;
  let sampleRateHz = 24_000;
  let chunkCount: number;

  if (voice.provider === 'google') {
    if (!reserveAudiobookGoogleChars(text.length, { env: deps.env })) return null;
    const out = await synthesizeGoogleNarrationMp3(text, voice, { synthesize: deps.synthesizeGoogle });
    // One structured line per Google render — the CloudWatch metric filter
    // (scripts/aws/setup-audiobook-google-metric.sh) sums `chars`.
    console.log(
      JSON.stringify({
        event: 'audiobook_google_tts',
        vtid: 'VTID-05026',
        ok: !!out,
        chars: text.length,
        voice: voice.name,
        topic: topicId,
        lang,
      }),
    );
    if (!out) return null;
    mp3 = out.mp3;
    chunkCount = out.chunks;
  } else {
    const synthesize = deps.synthesize ?? synthesizePolly;
    const chunks = splitTextForPolly(text);
    if (chunks.length === 0) return null;
    // MP3 is a stream of self-contained frames, so per-chunk renders join
    // end to end into one playable file.
    const buffers: Buffer[] = [];
    for (const chunk of chunks) {
      const result = await synthesize({
        text: chunk,
        lang,
        format: 'mp3',
        voiceOverride: { voiceId: voice.voiceId, engine: voice.engine, languageCode: voice.languageCode },
      });
      if (!result) return null;
      sampleRateHz = result.sampleRateHz;
      buffers.push(Buffer.from(result.audioB64, 'base64'));
    }
    mp3 = Buffer.concat(buffers);
    chunkCount = chunks.length;
  }

  if (store) await store.put(cacheKey, { audioB64: mp3.toString('base64'), sampleRateHz });

  console.log(
    `[AUDIOBOOK-TTS] cache=miss store=${store?.name ?? 'none'} topic=${topicId} ` +
      `lang=${lang} provider=${voice.provider} voice=${VOICE_LABEL(voice)} engine=${ENGINE_LABEL(voice)} ` +
      `chunks=${chunkCount} chars=${text.length} bytes=${mp3.length}`,
  );
  return { mp3, cached: false, provider: voice.provider };
}
