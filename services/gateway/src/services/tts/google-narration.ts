/**
 * VTID-05026 — Google Cloud Text-to-Speech for Audiobook narration (ru, sr).
 *
 * Phase 1 of the sparred Audiobook voice plan
 * (docs/validation/VTID-04893/plan-sparring.md). Owner decision: Russian and
 * Serbian Audiobook episodes are read by Google voices; every other language
 * stays on Amazon Polly. Google is reached through the dedicated project of
 * the Serbian/Russian bridges (never `lovable-vitana-vers1`), inside the same
 * 90-day credit window (CLAUDE.md §2e-vertex-serbian-bridge).
 *
 * Auth: the client is built on the shared task-role token module
 * (`lib/google-access-token.ts`, VTID-04893), ALWAYS — independent of the
 * live-voice flag `GOOGLE_AUTH_AWS_SUPPLIER_ENABLED`. The library's own ADC
 * lookup reads the config's EC2 metadata credential source, which ECS does
 * not serve, so it can never work here.
 *
 * Google caps one synthesis request at 5,000 BYTES of input. Cyrillic is two
 * bytes per character in UTF-8, so the 2,800-character Polly splitter would
 * overflow; `splitTextByBytes` packs whole sentences into 4,500 bytes.
 *
 * Nothing here chooses a language or a voice — the caller passes an explicit
 * voice from the Audiobook table (`guided-journey/audiobook-voices.ts`).
 */

import textToSpeech from '@google-cloud/text-to-speech';
import { GoogleAuth } from 'google-auth-library';
import { getGoogleAwsClient } from '../../lib/google-access-token';

/** Google rejects input over 5,000 bytes; keep a margin. */
export const GOOGLE_TTS_CHUNK_BYTES = 4_500;

/** Chunks rendered at the same time; output order is always the text order. */
export const GOOGLE_TTS_CONCURRENCY = 2;

export interface GoogleNarrationVoice {
  /** Full Google voice name, e.g. `ru-RU-Chirp3-HD-Aoede`. */
  name: string;
  /** BCP-47 code the voice belongs to, e.g. `ru-RU`. */
  languageCode: string;
  /**
   * `model_name` for voice families that take one (Gemini-TTS). Null for
   * Chirp 3 HD / Standard / WaveNet voices, which are selected by name alone.
   */
  modelName: string | null;
}

const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');

/** Hard-split one piece that is longer than the budget: by words, then by characters. */
function splitOversized(piece: string, maxBytes: number): string[] {
  const out: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) out.push(current.trim());
    current = '';
  };
  for (const word of piece.split(/(\s+)/)) {
    if (byteLength(current + word) <= maxBytes) {
      current += word;
      continue;
    }
    push();
    if (byteLength(word) <= maxBytes) {
      current = word;
      continue;
    }
    // A single "word" over the budget (no spaces at all): split by code point.
    for (const ch of Array.from(word)) {
      if (byteLength(current + ch) > maxBytes) push();
      current += ch;
    }
  }
  push();
  return out;
}

/**
 * Split `text` into chunks of at most `maxBytes` UTF-8 bytes, on sentence
 * boundaries where possible. Every chunk is within the budget — unlike the
 * Polly splitter, an oversized sentence is cut at word boundaries rather
 * than sent whole, because Google rejects it outright.
 */
export function splitTextByBytes(text: string, maxBytes: number = GOOGLE_TTS_CHUNK_BYTES): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (byteLength(trimmed) <= maxBytes) return [trimmed];
  const sentences = trimmed.match(/[^.!?…]+[.!?…]+(\s+|$)|[^.!?…]+$/g) ?? [trimmed];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (byteLength(sentence) > maxBytes) {
      if (current.trim()) chunks.push(current.trim());
      current = '';
      chunks.push(...splitOversized(sentence, maxBytes));
      continue;
    }
    if (current && byteLength(current + sentence) > maxBytes) {
      chunks.push(current.trim());
      current = '';
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

type TtsClient = InstanceType<typeof textToSpeech.TextToSpeechClient>;

let client: TtsClient | null = null;

/** The TTS client on the task-role auth client. Built once per process. */
export function getGoogleNarrationClient(): TtsClient {
  if (client) return client;
  const auth = new GoogleAuth({
    authClient: getGoogleAwsClient() as never,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  client = new textToSpeech.TextToSpeechClient({ auth: auth as never });
  return client;
}

/** Test hook: forget the cached client. */
export function __resetGoogleNarrationClientForTests(): void {
  client = null;
}

export interface GoogleSynthesizeRequest {
  input: { text: string };
  voice: { languageCode: string; name: string; modelName?: string };
  audioConfig: { audioEncoding: 'MP3' };
}

export type GoogleSynthesizeFn = (req: GoogleSynthesizeRequest) => Promise<Buffer | null>;

/** One request to Google; null on any error (the caller answers 422). */
export const synthesizeGoogleChunk: GoogleSynthesizeFn = async (req) => {
  try {
    const [res] = await getGoogleNarrationClient().synthesizeSpeech(req as never);
    const audio = res.audioContent;
    if (!audio || audio.length === 0) return null;
    return Buffer.from(audio as Uint8Array);
  } catch (err) {
    console.warn(`[GOOGLE-NARRATION] synthesis failed (voice=${req.voice.name}): ${(err as Error).message}`);
    return null;
  }
};

/** The request for one chunk. `model_name` only when the voice family takes one. */
export function buildGoogleSynthesizeRequest(text: string, voice: GoogleNarrationVoice): GoogleSynthesizeRequest {
  return {
    input: { text },
    voice: {
      languageCode: voice.languageCode,
      name: voice.name,
      ...(voice.modelName ? { modelName: voice.modelName } : {}),
    },
    audioConfig: { audioEncoding: 'MP3' },
  };
}

/**
 * Render `text` with one Google voice as a single MP3. Chunks are rendered
 * GOOGLE_TTS_CONCURRENCY at a time and joined in text order (MP3 frames are
 * self-contained, so the parts play end to end). Returns null when any chunk
 * fails — never a partial lesson.
 */
export async function synthesizeGoogleNarrationMp3(
  text: string,
  voice: GoogleNarrationVoice,
  deps: { synthesize?: GoogleSynthesizeFn } = {},
): Promise<{ mp3: Buffer; chunks: number } | null> {
  const chunks = splitTextByBytes(text);
  if (chunks.length === 0) return null;
  const synthesize = deps.synthesize ?? synthesizeGoogleChunk;
  const parts: Array<Buffer | null> = new Array(chunks.length).fill(null);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < chunks.length) {
      const i = next++;
      const out = await synthesize(buildGoogleSynthesizeRequest(chunks[i], voice));
      if (!out) {
        failed = true;
        return;
      }
      parts[i] = out;
    }
  };
  await Promise.all(Array.from({ length: Math.min(GOOGLE_TTS_CONCURRENCY, chunks.length) }, worker));
  if (failed || parts.some((p) => !p)) return null;
  return { mp3: Buffer.concat(parts as Buffer[]), chunks: chunks.length };
}

export interface GoogleVoiceInfo {
  name: string;
  languageCodes: string[];
  ssmlGender: string;
  naturalSampleRateHertz: number | null;
}

/** Google's voice list for one language (read-only). */
export async function listGoogleVoices(languageCode: string): Promise<GoogleVoiceInfo[]> {
  const [res] = await getGoogleNarrationClient().listVoices({ languageCode });
  return (res.voices ?? []).map((v) => ({
    name: String(v.name ?? ''),
    languageCodes: (v.languageCodes ?? []).map(String),
    ssmlGender: String(v.ssmlGender ?? ''),
    naturalSampleRateHertz: typeof v.naturalSampleRateHertz === 'number' ? v.naturalSampleRateHertz : null,
  }));
}
