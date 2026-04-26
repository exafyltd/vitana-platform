/**
 * VTID-01970 — Embedding Cache (sha256(text) → vector LRU)
 *
 * In-process LRU cache that eliminates redundant embedding API calls
 * (OpenAI text-embedding-3-small ~50ms+$, Gemini ~80ms+$). Identical
 * text strings are extremely common in our retrieval paths:
 *   - retrieval-router classifies the same query phrasing repeatedly
 *   - context-pack-builder embeds the same memory items multiple times
 *   - autopilot ranker re-embeds the same recommendation titles
 *
 * Cache key = SHA-256 of normalized text. Bounded LRU (default 5000
 * entries) so we don't grow unbounded across long-lived processes.
 *
 * Plan: Part 8 Phase 3 (Tier 1).
 */

import { createHash } from 'crypto';

const MAX_ENTRIES = 5000;

interface CacheEntry {
  vector: number[];
  model: string;
  dimensions: number;
  cached_at: number;
}

// Map preserves insertion order; we treat that as LRU by deleting + re-inserting on access.
const cache = new Map<string, CacheEntry>();
let hits = 0;
let misses = 0;
let evictions = 0;

function keyFor(text: string): string {
  // Normalize: collapse whitespace, lowercase, trim. Hash to bound key size.
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Look up an embedding by text. Updates LRU position on hit.
 * Returns null on miss — callers must compute then call set().
 */
export function getCachedEmbedding(text: string): CacheEntry | null {
  if (!text) return null;
  const k = keyFor(text);
  const entry = cache.get(k);
  if (!entry) {
    misses += 1;
    return null;
  }
  // LRU: re-insert to move to most-recent.
  cache.delete(k);
  cache.set(k, entry);
  hits += 1;
  return entry;
}

/**
 * Store an embedding for a text. Evicts oldest entry on overflow.
 */
export function setCachedEmbedding(
  text: string,
  vector: number[],
  model: string,
  dimensions: number
): void {
  if (!text || !Array.isArray(vector) || vector.length === 0) return;
  const k = keyFor(text);
  if (cache.has(k)) {
    cache.delete(k);
  } else if (cache.size >= MAX_ENTRIES) {
    // Evict oldest (first-inserted).
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest) {
      cache.delete(oldest);
      evictions += 1;
    }
  }
  cache.set(k, { vector, model, dimensions, cached_at: Date.now() });
}

export function getCacheStats(): {
  size: number;
  max: number;
  hits: number;
  misses: number;
  evictions: number;
  hit_rate: number;
} {
  const total = hits + misses;
  return {
    size: cache.size,
    max: MAX_ENTRIES,
    hits,
    misses,
    evictions,
    hit_rate: total > 0 ? hits / total : 0,
  };
}

export function clearEmbeddingCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
  evictions = 0;
}

// Test-only export
export const EMBEDDING_CACHE_MAX_FOR_TEST = MAX_ENTRIES;
