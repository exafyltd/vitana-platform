/**
 * VTID-04733 — What's New: turn the frontend's shipped manifest into cards.
 *
 * The community app (exafyltd/vitana-v1) publishes /whats-new.json with every
 * build, one entry per user-facing change (src/whats-new/entries/*.json). The
 * gateway reads it from the PRODUCTION frontend, so an entry can only become a
 * card once the build that carries it is live for members. This module is the
 * pure part — parse, validate, choose what to publish; the route in
 * scheduled-notifications.ts does the I/O.
 */

export interface WhatsNewEntry {
  id: string;
  added: string; // YYYY-MM-DD
  title: { en: string; de: string; [locale: string]: string | undefined };
  description: { en: string; de: string; [locale: string]: string | undefined };
  deepLink: string;
}

/** An entry older than this is never published: a late deploy must not flood members with stale news. */
export const WHATS_NEW_MAX_AGE_DAYS = 14;
/** At most one card per this many hours, so a backlog drains one a day instead of all at once. */
export const WHATS_NEW_MIN_GAP_HOURS = 20;
/** feature_announcements.created_by marker; the suffix is the entry id and is the dedupe key. */
export const WHATS_NEW_CREATED_BY_PREFIX = 'scheduled:whats-new:';

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLocalized(v: unknown): v is WhatsNewEntry['title'] {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.en === 'string' && !!o.en.trim() && typeof o.de === 'string' && !!o.de.trim();
}

export function isValidWhatsNewEntry(e: unknown): e is WhatsNewEntry {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === 'string' && ID_RE.test(o.id) &&
    typeof o.added === 'string' && DATE_RE.test(o.added) && !Number.isNaN(Date.parse(o.added)) &&
    isLocalized(o.title) && isLocalized(o.description) &&
    typeof o.deepLink === 'string' && o.deepLink.startsWith('/') && !o.deepLink.startsWith('//')
  );
}

/** Keeps only well-formed entries (a bad one is skipped, never fatal to the rest). */
export function parseWhatsNewManifest(json: unknown): { entries: WhatsNewEntry[]; skipped: number } {
  const raw = (json as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(raw)) return { entries: [], skipped: 0 };
  const entries = raw.filter(isValidWhatsNewEntry);
  return { entries, skipped: raw.length - entries.length };
}

/** Oldest unpublished entry that is still fresh, or null. */
export function selectNextWhatsNewEntry(
  entries: WhatsNewEntry[],
  publishedIds: ReadonlySet<string>,
  now: Date,
): WhatsNewEntry | null {
  const oldest = now.getTime() - WHATS_NEW_MAX_AGE_DAYS * 24 * 3600 * 1000;
  return (
    [...entries]
      .filter((e) => !publishedIds.has(e.id) && Date.parse(e.added) >= oldest)
      .sort((a, b) => a.added.localeCompare(b.added) || a.id.localeCompare(b.id))[0] ?? null
  );
}

export function whatsNewManifestUrl(): string {
  return process.env.WHATS_NEW_URL || 'https://vitanaland.com/whats-new.json';
}

export async function fetchWhatsNewManifest(url = whatsNewManifestUrl(), timeoutMs = 5000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
