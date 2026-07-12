/**
 * Tiny in-process TTL cache for briefing envelopes (VTID-ASSISTANT-ROLES).
 *
 * Briefings fan into ~8 upstream reads; a 60 s cache keeps the session-start
 * injection AND an immediately-following get_briefing tool call from paying
 * twice. Keyed per role (+tenant for admin) — NOT per user, because the
 * envelope contains no user-personal data, only platform/tenant state.
 */

import { BRIEFING_CACHE_TTL_MS, type BriefingEnvelope } from './briefing-types';

interface CacheEntry {
  envelope: BriefingEnvelope;
  builtAt: number;
}

const cache = new Map<string, CacheEntry>();

export function getCachedBriefing(key: string): BriefingEnvelope | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.builtAt > BRIEFING_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.envelope;
}

export function setCachedBriefing(key: string, envelope: BriefingEnvelope): void {
  cache.set(key, { envelope, builtAt: Date.now() });
  // Bounded — briefing keys are per role/tenant, but guard against leaks.
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].builtAt - b[1].builtAt)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

export function clearBriefingCache(): void {
  cache.clear();
}
