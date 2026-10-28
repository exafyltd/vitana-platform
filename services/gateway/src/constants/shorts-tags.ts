/**
 * Canonical allow-list of Shorts tags.
 *
 * SYNC WITH: vitana-v1/src/lib/shortsTags.ts
 *
 * Used by POST /api/v1/media-hub/shorts/auto-metadata to constrain the
 * LLM's tag output and to validate it server-side before returning. Tech
 * debt: move to a DB-backed config endpoint so frontend and backend read
 * the same source at startup.
 */
export const SHORTS_TAG_IDS = [
  'nutrition',
  'sleep',
  'longevity',
  'motivation',
  'mindfulness',
  'fitness',
  'mentalHealth',
  'wellness',
  'education',
  'lifestyle',
] as const;

export type ShortsTagId = (typeof SHORTS_TAG_IDS)[number];

export const SHORTS_TAG_SET: Set<string> = new Set(SHORTS_TAG_IDS);

export function isShortsTagId(value: string): value is ShortsTagId {
  return SHORTS_TAG_SET.has(value);
}
