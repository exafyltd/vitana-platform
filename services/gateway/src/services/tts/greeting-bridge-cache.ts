/**
 * VTID-04100 — cache for greeting-bridge audio.
 *
 * The bridge phrase is what makes ORB feel instant: it is written to the SSE
 * stream before the real upstream connect begins, so the user hears a voice
 * while the speech model is still reading its prompt. Measured on staging
 * 2026-09-19, authenticated `de`: first MODEL audio p50 ~2.5-3.0 s, p90 up to
 * 7.5 s. A bridge phrase lands in the time it takes to write one SSE frame.
 *
 * It had no cache. Every session re-synthesized the same phrase through Polly,
 * which is both a per-session bill and a per-session latency cost on the ONE
 * path whose entire purpose is to be fast. The phrase is deterministic for a
 * given (language, rendered text) pair and the text embeds the date, so the
 * key rotates daily on its own with no invalidation logic to get wrong — the
 * same property `NARRATION_AUDIO_CACHE` relies on (CLAUDE.md §2c-cache).
 *
 * Deliberately in-process and small. It does not survive a deploy or a
 * scale-out, exactly like the narration cache's `memory` mode, and that is
 * acceptable here: a miss costs one Polly call, which is the status quo. An
 * S3 tier would be the upgrade if the hit rate ever justifies it — but per
 * §2c-cache's own warning, the S3 leg there has never executed against a real
 * bucket, so copying it would be copying something unproven.
 *
 * Failure posture matches the narration cache: a cache holds no truth, and a
 * miss has a correct cheap recovery, so nothing here ever throws.
 */

export interface CachedBridgeAudio {
  audioB64: string;
  sampleRateHz: number;
}

interface Entry extends CachedBridgeAudio {
  storedAt: number;
}

/** Bounded so a long-running task cannot accumulate one entry per locale per day forever. */
export const GREETING_BRIDGE_CACHE_MAX_ENTRIES = 64;

/** A day plus slack: the text embeds the date, so entries age out naturally. */
export const GREETING_BRIDGE_CACHE_TTL_MS = 26 * 60 * 60 * 1000;

const cache = new Map<string, Entry>();

export function greetingBridgeCacheKey(lang: string, text: string): string {
  return `${(lang || 'en').toLowerCase()}::${text}`;
}

export function getCachedGreetingBridgeAudio(
  lang: string,
  text: string,
  now: number = Date.now(),
): CachedBridgeAudio | null {
  const key = greetingBridgeCacheKey(lang, text);
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.storedAt > GREETING_BRIDGE_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Refresh recency so the eviction below is LRU-ish rather than insertion
  // order — the current day's phrase is the one worth keeping.
  cache.delete(key);
  cache.set(key, hit);
  return { audioB64: hit.audioB64, sampleRateHz: hit.sampleRateHz };
}

export function putCachedGreetingBridgeAudio(
  lang: string,
  text: string,
  audio: CachedBridgeAudio,
  now: number = Date.now(),
): void {
  if (!audio?.audioB64) return;
  const key = greetingBridgeCacheKey(lang, text);
  cache.delete(key);
  cache.set(key, { ...audio, storedAt: now });
  while (cache.size > GREETING_BRIDGE_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Test seam only. */
export function resetGreetingBridgeCache(): void {
  cache.clear();
}

export function greetingBridgeCacheSize(): number {
  return cache.size;
}
