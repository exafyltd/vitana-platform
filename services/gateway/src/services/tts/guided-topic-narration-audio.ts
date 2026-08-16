/**
 * VTID-03650 — Guided Journey chapter narration via Amazon Polly.
 *
 * WHY THIS EXISTS: the previous mechanism handed the authored curriculum text
 * (voice_script) to a CONVERSATIONAL model as a "say exactly this" turn-1 line
 * (VTID-03293, `buildGuidedTopicSpokenLesson`) and, separately, as reference
 * material in the turns-2+ system instruction (`buildGuidedTopicNarrationBlock`).
 * Both routes fed the same raw text into a model with its own content-safety
 * judgment — and that judgment rejected legitimate wellness/curriculum text:
 * Nova's content filter blocked it outright (VTID-03647, 34 occurrences/3 days,
 * "This request has been blocked by our content filters"), and when VTID-03647
 * rerouted the SAME text to Vertex, Vertex ALSO rejected it — a hard
 * `upstream_ws_close` code 1007 "Request contains an invalid argument"
 * (VTID-03648). Two independent conversational models rejecting the identical
 * authored text is decisive: the mechanism was wrong, not either model's
 * tuning. A conversational LLM is the wrong tool for "read this specific,
 * pre-approved curriculum text" — it has no obligation to comply, and every
 * model asked so far has, for different reasons, declined.
 *
 * THE FIX: read the authored text with a deterministic text-to-speech engine
 * instead. Amazon Polly has no notion of "is this appropriate to say in this
 * conversational context" — it renders the exact input text to audio, always,
 * or fails on a mechanical reason (unsupported language, API error), never on
 * a judgment call about the content. The lesson audio is synthesized here and
 * played to the client directly (see `sendGuidedTopicNarrationAudioBridge` in
 * `routes/orb-live.ts`), and the live model (Nova only — per product decision,
 * no Vertex fallback for this path) is left with a SHORT, safe follow-up turn
 * ("any questions, or ready to practice?") instead of the risky raw material.
 *
 * This is a narrower, more deliberate use of Polly than the general
 * `TTS_PROVIDER` switch (`tts-provider.ts`, default 'google', gates 4 other
 * call sites): this call site is Polly-only, unconditionally, independent of
 * `TTS_PROVIDER` — calling `synthesizePolly` directly rather than going
 * through `tryPollySynthesis`'s `TTS_PROVIDER==='polly'` gate. The point of
 * this feature is specifically to stop routing curriculum content through any
 * conversational model; falling back to a SECOND conversational model (Vertex)
 * or a different judgment-bearing pipeline would reproduce the exact defect
 * this module exists to eliminate. When Polly cannot serve the request
 * (unsupported language, API error), the caller degrades to the PRE-EXISTING
 * model-narrated behavior — unchanged from before this VTID — rather than
 * silence.
 */

import type { GuidedTopicNarrationContent } from '../assistant-continuation/providers/guided-topic-narration';
import { synthesizePolly } from './polly';

export interface GuidedTopicNarrationAudio {
  audioB64: string;
  sampleRateHz: number;
}

/**
 * Assemble the narration text read aloud for a guided topic. Prefers the
 * authored `voice_script` (the KB curriculum text, written to be spoken);
 * when that is empty, falls back to composing from the structured
 * explanation fields so a topic without a dedicated script still gets SOME
 * narration rather than dead air — same source material the old
 * model-narrated path used, just concatenated instead of handed to an LLM
 * as reference material.
 */
export function buildGuidedTopicSpokenText(content: GuidedTopicNarrationContent): string {
  if (content.voice_script && content.voice_script.trim().length > 0) {
    return content.voice_script.trim();
  }
  const exp = content.explanation || { whatItIs: null, userBenefit: null, whenToUse: null, tryThis: null };
  const parts = [exp.whatItIs, exp.userBenefit, exp.whenToUse, exp.tryThis].filter(
    (p): p is string => !!p && p.trim().length > 0,
  );
  return parts.join(' ').trim();
}

/**
 * Amazon Polly's synchronous `SynthesizeSpeech` API caps input text at 3000
 * characters — longer text needs the async S3-backed API this platform
 * doesn't otherwise use. Curriculum scripts can exceed that (some measured
 * around 2000 chars, some plausibly longer), so long text is split on
 * sentence boundaries into safe-sized chunks and synthesized per-chunk; PCM
 * is headerless raw samples at a fixed rate, so concatenating the decoded
 * buffers end-to-end produces correct, gap-free continuous audio — no
 * re-encoding needed.
 */
const POLLY_SAFE_CHUNK_CHARS = 2800;

export function splitTextForPolly(text: string, maxChars: number = POLLY_SAFE_CHUNK_CHARS): string[] {
  if (text.length <= maxChars) return text.length > 0 ? [text] : [];
  const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length > 0 && current.length + sentence.length > maxChars) {
      chunks.push(current.trim());
      current = '';
    }
    // A single sentence longer than the whole budget still has to go
    // somewhere — accept the oversized chunk rather than dropping content;
    // Polly will reject it loudly (synthesizePolly catches and returns null)
    // rather than silently truncating.
    current += sentence;
  }
  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks;
}

/**
 * Synthesize the guided-topic narration via Polly. Returns null when Polly
 * cannot serve the language or the request fails for any reason — including
 * when only SOME chunks of a long script succeed, since a lesson that cuts
 * off partway through is worse than falling back cleanly to the pre-existing
 * model-narrated path for the whole thing.
 */
export async function synthesizeGuidedTopicNarrationAudio(
  content: GuidedTopicNarrationContent,
  lang: string,
): Promise<GuidedTopicNarrationAudio | null> {
  const text = buildGuidedTopicSpokenText(content);
  if (!text) return null;

  const chunks = splitTextForPolly(text);
  if (chunks.length === 0) return null;

  const buffers: Buffer[] = [];
  let sampleRateHz: number | null = null;
  for (const chunk of chunks) {
    const result = await synthesizePolly({ text: chunk, lang, format: 'pcm' });
    if (!result) return null;
    if (sampleRateHz === null) sampleRateHz = result.sampleRateHz;
    buffers.push(Buffer.from(result.audioB64, 'base64'));
  }
  if (buffers.length === 0 || sampleRateHz === null) return null;

  const combined = Buffer.concat(buffers);
  console.log(
    `[GUIDED-TOPIC-TTS] provider=polly topic=${content.topic_id} lang=${lang} ` +
      `chunks=${chunks.length} chars=${text.length} rate_hz=${sampleRateHz}`,
  );
  return { audioB64: combined.toString('base64'), sampleRateHz };
}
