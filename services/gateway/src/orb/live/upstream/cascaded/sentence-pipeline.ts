/**
 * VTID-04550 — sentence-pipelined TTS for the cascade, behind a flag.
 *
 * Today a cascade turn synthesizes the WHOLE reply in one TTS call and only
 * then emits any audio, so the member hears nothing until the last word of
 * a multi-sentence reply has been rendered. With
 * `ORB_CASCADE_STREAMING_ENABLED=true` the reply is split into sentences;
 * the first sentence is synthesized and emitted as soon as it is ready, the
 * rest follow in order, one at a time.
 *
 * What does NOT change, flag on or off:
 *   - the LLM call, its prompt, history and the reply text (the router has
 *     no streaming API; the full text is waited for exactly as before),
 *   - the words spoken: the segments below partition the reply exactly —
 *     `segments.join('') === reply` — and only surrounding whitespace is
 *     trimmed before a segment is handed to TTS,
 *   - backend selection per segment (`synthesizeCascadeReply`, Polly first,
 *     Fish only on a Polly coverage gap, the specialist voice rules),
 *   - the output transcript (emitted once, full text, before any audio).
 *
 * Scope note (CLAUDE.md §2c-fish-scope): this lives in the shared cascade
 * pipeline, so it affects every cascade language — Polly-backed ru/pl/tr/zh/ar
 * and Fish-backed sr alike. Its tests cover both kinds.
 *
 * Default OFF: unset, `false`, or any other value keeps the single-call path
 * byte-for-byte.
 */

/** Exact-string activation, same convention as the other cascade flags. */
export function isCascadeStreamingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORB_CASCADE_STREAMING_ENABLED === 'true';
}

/** Terminators that end a sentence only when followed by whitespace or end of text. */
const SPACED_TERMINATORS = new Set(['.', '!', '?', '…', '؟', '۔']);
/** Full-width terminators (zh/ja) end a sentence without trailing whitespace. */
const FULLWIDTH_TERMINATORS = new Set(['。', '！', '？']);
/** Closing quotes/brackets that belong to the sentence they follow. */
const CLOSERS = new Set(['"', "'", '”', '“', '’', '‘', '»', '«', ')', ']', '」', '』', '）', '】']);

/** Common 3+ letter abbreviations (de/en/sr/pl/ru) that end in '.' mid-sentence. */
const KNOWN_ABBREVIATIONS = new Set([
  'bzw', 'usw', 'etc', 'ggf', 'inkl', 'evtl', 'vgl', 'z.b', 'str', 'tel', 'prof', 'min', 'max', 'mio', 'mrd',
  'mrs', 'sen', 'jun', 'approx', 'dept', 'itd', 'npr', 'tzv', 'tj', 'np', 'tzn', 'itp', 'tys', 'руб', 'стр', 'тыс', 'млн', 'г',
]);

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/u.test(ch);
}

/**
 * A '.' that is probably not a sentence end: the word before it is one or
 * two letters (z. B., Dr., Nr.), a known abbreviation (bzw., usw., etc.), or
 * the next word starts with a lowercase letter or a digit. Missing a split only costs latency; a wrong
 * split could make TTS read an abbreviation on its own, so err towards not
 * splitting.
 */
function isLikelyAbbreviation(text: string, dotIndex: number, nextWordStart: number): boolean {
  let i = dotIndex - 1;
  while (i >= 0 && /\p{L}/u.test(text[i])) i--;
  const word = text.slice(i + 1, dotIndex);
  if (word.length > 0 && word.length <= 2) return true;
  if (KNOWN_ABBREVIATIONS.has(word.toLowerCase())) return true;
  const next = text[nextWordStart];
  if (next !== undefined && (/\p{Ll}/u.test(next) || /\p{Nd}/u.test(next))) return true;
  return false;
}

/**
 * Split `text` into sentence segments whose concatenation is exactly `text`.
 * Each boundary sits after a terminator (plus any closing quotes/brackets)
 * and the whitespace that follows it, so no character is dropped or added.
 */
export function splitReplyIntoSentences(text: string): string[] {
  const segments: string[] = [];
  let segStart = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const fullwidth = FULLWIDTH_TERMINATORS.has(ch);
    if (!fullwidth && !SPACED_TERMINATORS.has(ch)) {
      i++;
      continue;
    }
    // Absorb runs of terminators ("?!", "...") and closing quotes/brackets.
    let j = i + 1;
    while (j < text.length && (SPACED_TERMINATORS.has(text[j]) || FULLWIDTH_TERMINATORS.has(text[j]) || CLOSERS.has(text[j]))) {
      j++;
    }
    let k = j;
    while (k < text.length && isWhitespace(text[k])) k++;

    const atEnd = k >= text.length;
    const followedBySpace = k > j;
    let boundary = fullwidth ? true : followedBySpace || atEnd;
    if (boundary && !fullwidth && ch === '.' && !atEnd && j === i + 1 && isLikelyAbbreviation(text, i, k)) {
      boundary = false;
    }
    if (boundary && !atEnd) {
      segments.push(text.slice(segStart, k));
      segStart = k;
    }
    i = k > i ? k : i + 1;
  }
  if (segStart < text.length) segments.push(text.slice(segStart));
  return segments;
}

/**
 * Segments that carry speech: whitespace-only pieces are folded into the
 * previous segment so nothing is synthesized for them, and the partition
 * property (`join('') === text`) still holds.
 */
export function speakableSegments(text: string): string[] {
  const out: string[] = [];
  for (const seg of splitReplyIntoSentences(text)) {
    if (!seg.trim() && out.length > 0) {
      out[out.length - 1] += seg;
    } else {
      out.push(seg);
    }
  }
  return out;
}

export interface SentencePipelineResult {
  /** Every segment was synthesized and emitted. */
  ok: boolean;
  /** Number of segments whose audio was emitted. */
  emitted: number;
  /** Index of the segment whose synthesis failed (when ok=false and not stopped). */
  failedIndex?: number;
  /** The caller asked to stop (session closing) before all segments ran. */
  stopped?: boolean;
}

/**
 * Synthesize `segments` in order, emitting each segment's audio the moment
 * it is ready and only then starting the next one. A segment that yields no
 * audio ends the pipeline (the caller reports it exactly as a failed
 * single-call synthesis); audio already emitted stays emitted.
 */
export async function speakSegmentsInOrder(
  segments: string[],
  synthesize: (text: string) => Promise<{ audioB64: string } | null>,
  emit: (audioB64: string) => void,
  shouldContinue: () => boolean = () => true,
): Promise<SentencePipelineResult> {
  let emitted = 0;
  for (let idx = 0; idx < segments.length; idx++) {
    const spoken = segments[idx].trim();
    if (!spoken) continue;
    if (!shouldContinue()) return { ok: false, emitted, stopped: true };
    const speech = await synthesize(spoken);
    if (!speech?.audioB64) return { ok: false, emitted, failedIndex: idx };
    if (!shouldContinue()) return { ok: false, emitted, stopped: true };
    emit(speech.audioB64);
    emitted++;
  }
  return { ok: true, emitted };
}
