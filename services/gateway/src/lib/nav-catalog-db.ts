/**
 * VTID-NAV-02: Navigator Catalog — DB cache layer
 *
 * Backs navigation-catalog.ts with a live Supabase-sourced catalog so
 * Community Admin users can add/edit screens and trigger phrases without a
 * gateway redeploy. The original static NAVIGATION_CATALOG constant remains
 * as the compile-time fallback: if the DB is down or hasn't been loaded
 * yet, the orb still routes correctly off the in-code data.
 *
 * Design notes
 * ------------
 * 1. searchCatalog() / lookupScreen() / entriesByCategory() stay SYNCHRONOUS.
 *    They read from a module-level cache (Map<tenantKey, NavCatalogEntry[]>).
 *    Background refreshCatalogCache() keeps the cache fresh. Consumers never
 *    need to await the catalog.
 *
 * 2. The cache is keyed by tenant. Rows with tenant_id IS NULL form the
 *    SHARED catalog (default for everybody). A row with a non-null tenant_id
 *    and the same screen_id OVERRIDES the shared row for that tenant only.
 *    getCatalogForTenant(tid) applies the override.
 *
 * 3. First cache fill is triggered from the gateway boot sequence via
 *    warmNavCatalogCache(). It runs async; failures are logged and swallowed
 *    because NAVIGATION_CATALOG is already serving requests.
 *
 * 4. After an admin write, the admin router calls invalidateNavCatalogCache()
 *    so subsequent sessions pick up the edit immediately.
 */

import type { NavCatalogEntry, LangCode, NavCategory } from './navigation-catalog';
import { NAVIGATION_CATALOG, getContent } from './navigation-catalog';
import { getSupabase } from './supabase';

// =============================================================================
// Types (shape of the rows coming back from Supabase)
// =============================================================================

interface NavCatalogRow {
  id: string;
  screen_id: string;
  tenant_id: string | null;
  route: string;
  category: string;
  access: 'public' | 'authenticated';
  anonymous_safe: boolean;
  priority: number;
  related_kb_topics: unknown;
  context_rules: unknown;
  override_triggers: unknown;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

interface NavCatalogI18nRow {
  catalog_id: string;
  lang: string;
  title: string;
  description: string;
  when_to_visit: string;
  updated_at: string;
}

// An override trigger: exact-match phrase that forces this screen to win
// scoring with synthetic high confidence, bypassing normal term matching.
export interface OverrideTrigger {
  lang: string;
  phrase: string;
  active: boolean;
}

// Context-rules JSONB shape. All optional; missing = no constraint.
export interface NavContextRules {
  exclude_on_routes?: string[];
  require_goal_match?: string[];
  boost_if_recent_topic?: string[];
}

// Extended catalog entry carrying the new rule fields. NavCatalogEntry
// (the base type exported from navigation-catalog.ts) intentionally stays
// backward compatible; the extra fields live here so scoring can see them
// without breaking the 77 existing tests.
export interface NavCatalogEntryWithRules extends NavCatalogEntry {
  context_rules?: NavContextRules;
  override_triggers?: OverrideTrigger[];
  tenant_id?: string | null;
  id?: string;
}

// =============================================================================
// Cache
// =============================================================================

const SHARED_KEY = '__shared__';

// Map from tenant key to the full merged catalog for that tenant.
// Key "__shared__" holds the tenant_id=NULL entries; any other key holds
// the shared catalog with that tenant's overrides applied.
const catalogCache: Map<string, NavCatalogEntryWithRules[]> = new Map();

// All raw rows the last refresh pulled, grouped by screen_id for fast admin
// reads (/api/v1/admin/navigator/catalog/:screen_id).
let allRowsById: Map<string, NavCatalogEntryWithRules> = new Map();

let lastRefreshAt: number = 0;
let refreshInFlight: Promise<void> | null = null;
let dbLoadedAtLeastOnce: boolean = false;

const REFRESH_INTERVAL_MS = 60_000;

// =============================================================================
// Public read API
// =============================================================================

/**
 * Return the effective catalog for a given tenant, applying per-tenant
 * overrides on top of the shared catalog. If the DB cache hasn't been
 * populated yet, falls back to the compile-time NAVIGATION_CATALOG constant
 * so the Navigator never goes dark.
 */
export function getCatalogForTenant(
  tenantId: string | null | undefined
): NavCatalogEntryWithRules[] {
  if (!dbLoadedAtLeastOnce) {
    return NAVIGATION_CATALOG as NavCatalogEntryWithRules[];
  }

  const shared = catalogCache.get(SHARED_KEY) || [];
  if (!tenantId) return shared;

  const override = catalogCache.get(tenantId);
  if (!override || override.length === 0) return shared;

  // Overlay: tenant rows win per screen_id. override already contains shared+delta
  // (built inside refreshCatalogCache), so just return it.
  return override;
}

/**
 * Return a single catalog entry by its internal UUID (not screen_id).
 * Used by the admin API audit / restore endpoints.
 */
export function getCatalogEntryById(id: string): NavCatalogEntryWithRules | null {
  if (!dbLoadedAtLeastOnce) return null;
  return allRowsById.get(id) || null;
}

/**
 * Check every override_trigger on every entry in the tenant's effective
 * catalog for an exact-match phrase in the requested language. Returns the
 * first matching entry or null. Case-insensitive. Used by navigator-consult
 * to short-circuit scoring when an admin has explicitly forced a mapping.
 */
export function findOverrideTriggerMatch(
  utterance: string,
  lang: LangCode,
  tenantId: string | null | undefined
): NavCatalogEntryWithRules | null {
  const normalized = normalizePhrase(utterance);
  if (!normalized) return null;
  const entries = getCatalogForTenant(tenantId);
  const langKey = (lang || 'en').slice(0, 2).toLowerCase();

  for (const entry of entries) {
    const triggers = entry.override_triggers || [];
    for (const trig of triggers) {
      if (!trig.active) continue;
      const trigLang = (trig.lang || 'en').slice(0, 2).toLowerCase();
      if (trigLang !== langKey) continue;
      if (normalizePhrase(trig.phrase) === normalized) {
        return entry;
      }
    }
  }
  return null;
}

function normalizePhrase(s: string): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[.,!?;:'"()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isNavCatalogLoaded(): boolean {
  return dbLoadedAtLeastOnce;
}

export function lastNavCatalogRefreshAt(): number {
  return lastRefreshAt;
}

// =============================================================================
// Refresh
// =============================================================================

/**
 * Load every nav_catalog row + its i18n rows from Supabase and rebuild the
 * tenant caches. Idempotent. Deduplicates concurrent callers so only one
 * fetch is in flight at a time.
 */
export async function refreshNavCatalogCache(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const t0 = Date.now();
    try {
      const supabase = getSupabase();
      if (!supabase) {
        console.warn('[VTID-NAV-02] refreshNavCatalogCache: supabase client unavailable, keeping static fallback');
        return;
      }

      const { data: rows, error: rowsErr } = await supabase
        .from('nav_catalog')
        .select(
          'id, screen_id, tenant_id, route, category, access, anonymous_safe, priority, related_kb_topics, context_rules, override_triggers, is_active, created_at, updated_at, updated_by'
        )
        .eq('is_active', true);

      if (rowsErr) {
        console.warn(`[VTID-NAV-02] refreshNavCatalogCache rows error: ${rowsErr.message}`);
        return;
      }
      if (!rows || rows.length === 0) {
        // Table empty (not yet seeded). Keep static fallback.
        console.log('[VTID-NAV-02] nav_catalog empty — using static NAVIGATION_CATALOG fallback');
        return;
      }

      const catalogIds = (rows as NavCatalogRow[]).map(r => r.id);
      const { data: i18nRows, error: i18nErr } = await supabase
        .from('nav_catalog_i18n')
        .select('catalog_id, lang, title, description, when_to_visit, updated_at')
        .in('catalog_id', catalogIds);

      if (i18nErr) {
        console.warn(`[VTID-NAV-02] refreshNavCatalogCache i18n error: ${i18nErr.message}`);
        return;
      }

      const byCatalogId: Map<string, Record<string, { title: string; description: string; when_to_visit: string }>> = new Map();
      for (const r of (i18nRows as NavCatalogI18nRow[] | null) || []) {
        if (!byCatalogId.has(r.catalog_id)) byCatalogId.set(r.catalog_id, {});
        byCatalogId.get(r.catalog_id)![r.lang] = {
          title: r.title,
          description: r.description || '',
          when_to_visit: r.when_to_visit || '',
        };
      }

      // Build full entries and split by tenant.
      const sharedBuilt: NavCatalogEntryWithRules[] = [];
      const perTenantDelta: Map<string, NavCatalogEntryWithRules[]> = new Map();
      const idMap: Map<string, NavCatalogEntryWithRules> = new Map();

      for (const raw of rows as NavCatalogRow[]) {
        const i18n = byCatalogId.get(raw.id) || {};
        if (!i18n.en) {
          // Every entry must have at least English. Skip malformed rows.
          console.warn(`[VTID-NAV-02] skipping nav_catalog ${raw.screen_id} — no 'en' i18n row`);
          continue;
        }

        const entry: NavCatalogEntryWithRules = {
          id: raw.id,
          screen_id: raw.screen_id,
          route: raw.route,
          category: raw.category as NavCatalogEntryWithRules['category'],
          access: raw.access,
          anonymous_safe: !!raw.anonymous_safe,
          priority: raw.priority || 0,
          related_kb_topics: Array.isArray(raw.related_kb_topics) ? raw.related_kb_topics as string[] : [],
          i18n,
          tenant_id: raw.tenant_id,
          context_rules: (raw.context_rules || {}) as NavContextRules,
          override_triggers: Array.isArray(raw.override_triggers) ? raw.override_triggers as OverrideTrigger[] : [],
        };

        idMap.set(raw.id, entry);

        if (raw.tenant_id == null) {
          sharedBuilt.push(entry);
        } else {
          if (!perTenantDelta.has(raw.tenant_id)) perTenantDelta.set(raw.tenant_id, []);
          perTenantDelta.get(raw.tenant_id)!.push(entry);
        }
      }

      // Rebuild cache: shared list + per-tenant merged lists.
      catalogCache.clear();
      catalogCache.set(SHARED_KEY, sharedBuilt);

      for (const [tid, deltaList] of perTenantDelta.entries()) {
        // Overlay: start with shared, replace any screen_id that has a tenant row.
        const overrideMap = new Map<string, NavCatalogEntryWithRules>();
        for (const e of deltaList) overrideMap.set(e.screen_id, e);
        const merged = sharedBuilt.map(s => overrideMap.get(s.screen_id) || s);
        // Also append tenant-only screen_ids that didn't exist in shared.
        for (const e of deltaList) {
          if (!sharedBuilt.find(s => s.screen_id === e.screen_id)) merged.push(e);
        }
        catalogCache.set(tid, merged);
      }

      allRowsById = idMap;
      dbLoadedAtLeastOnce = true;
      lastRefreshAt = Date.now();

      console.log(
        `[VTID-NAV-02] nav_catalog cache refreshed: ${sharedBuilt.length} shared + ${perTenantDelta.size} tenant overlay(s) in ${Date.now() - t0}ms`
      );
    } catch (err: any) {
      console.warn(`[VTID-NAV-02] refreshNavCatalogCache exception: ${err.message}`);
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * Trigger a cache refresh on the next read, force-flushing lastRefreshAt.
 * Called by the admin API after a create/update/delete so the next orb
 * session sees the edit without waiting for the 60s polling interval.
 */
export function invalidateNavCatalogCache(): void {
  lastRefreshAt = 0;
  // Fire-and-forget refresh so the caller (admin API) doesn't block.
  refreshNavCatalogCache().catch(err => {
    console.warn(`[VTID-NAV-02] background refresh after invalidate failed: ${err?.message}`);
  });
}

/**
 * Boot-time warmer. Call once from gateway startup.
 * Kicks off an initial refresh and schedules a periodic refresh interval.
 */
export function warmNavCatalogCache(): void {
  refreshNavCatalogCache().catch(err => {
    console.warn(`[VTID-NAV-02] initial warm failed: ${err?.message}`);
  });
  setInterval(() => {
    // Skip refresh if one happened very recently (e.g. admin invalidation).
    if (Date.now() - lastRefreshAt < REFRESH_INTERVAL_MS - 5_000) return;
    refreshNavCatalogCache().catch(err => {
      console.warn(`[VTID-NAV-02] periodic refresh failed: ${err?.message}`);
    });
  }, REFRESH_INTERVAL_MS).unref?.();
}

// =============================================================================
// Tenant-aware catalog scorer
// =============================================================================
//
// IMPORTANT: this scoring body is an intentional copy of searchCatalog() in
// navigation-catalog.ts. We duplicate it here so the DB-backed path can
// score over a tenant-specific entry list without having to alter the static
// file (which 77 navigator tests import directly). Any scoring change must
// be mirrored in BOTH locations until we consolidate into a single scorer
// after the DB path is proven. Keeping them in sync is the responsibility
// of the engineer changing either side.
// =============================================================================

// Multilingual stopword set — exact mirror of navigation-catalog.ts's STOPWORDS.
const SCORER_STOPWORDS = new Set<string>([
  // English
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'these', 'those',
  'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'having',
  'will', 'would', 'should', 'could', 'shall', 'may', 'might', 'must',
  'can', 'cant', 'dont', 'doesnt', 'didnt', 'wont',
  'who', 'what', 'when', 'where', 'why', 'how', 'which',
  'you', 'your', 'yours', 'mine', 'our', 'ours', 'their', 'theirs',
  'him', 'her', 'his', 'hers', 'its',
  'all', 'any', 'some', 'one', 'two', 'too', 'also', 'just', 'only',
  'now', 'then', 'than', 'there', 'here', 'about', 'over', 'under',
  'want', 'wants', 'wanted', 'need', 'needs', 'needed', 'like', 'likes', 'liked',
  'get', 'got', 'getting', 'take', 'taken', 'taking',
  'show', 'shows', 'showed',
  // German
  'ich', 'mich', 'mir', 'mein', 'meine', 'meinen', 'meinem', 'meiner', 'meines',
  'du', 'dich', 'dir', 'dein', 'deine', 'deinen',
  'er', 'sie', 'es', 'ihn', 'ihm', 'ihr', 'ihre', 'ihren',
  'wir', 'uns', 'unser', 'unsere',
  'der', 'die', 'das', 'den', 'dem', 'des',
  'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'und', 'oder', 'aber', 'doch', 'denn', 'weil', 'wenn', 'als', 'ob',
  'ist', 'sind', 'war', 'waren', 'wird', 'werden', 'wurde', 'wurden',
  'habe', 'hat', 'hatte', 'hatten', 'haben',
  'kann', 'können', 'könnte', 'soll', 'sollte', 'müsste', 'müssen', 'darf',
  'will', 'wollen', 'wollte', 'mag', 'möchte', 'möchten',
  'wie', 'was', 'wer', 'wo', 'wann', 'warum', 'welche', 'welcher', 'welches',
  'auch', 'noch', 'schon', 'mal', 'doch', 'eben', 'halt',
  'für', 'mit', 'von', 'bei', 'aus', 'nach', 'zu', 'zur', 'zum', 'auf', 'in',
  'gehe', 'gehen', 'geht', 'mache', 'machen', 'macht', 'tue', 'tun', 'tut',
  'sehe', 'sehen', 'sieht', 'zeige', 'zeigen', 'zeigt',
]);

function scorerTokenize(text: string): string[] {
  return text
    .split(/[\s\.\,\?\!\:\;\(\)\[\]\{\}\-\u2013\u2014\'\"\/\&\+\*]+/)
    .filter(t => t.length > 0);
}

function scorerBuildWordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of scorerTokenize(text)) {
    out.add(w);
    if (w.length > 4 && w.endsWith('es')) {
      out.add(w.slice(0, -2));
    } else if (w.length > 3 && w.endsWith('s')) {
      out.add(w.slice(0, -1));
    }
  }
  return out;
}

export interface ScorerOptions {
  category?: NavCategory;
  anonymous_only?: boolean;
  exclude_routes?: string[];
}

/**
 * Tenant-aware drop-in replacement for navigation-catalog.ts::searchCatalog.
 *
 * Scores the given entry list against the query in the requested language.
 * Consumers pass `getCatalogForTenant(tenantId)` as the entries argument so
 * per-tenant overrides apply. Same scoring semantics as searchCatalog() —
 * keep them in sync (see comment above).
 */
export function searchCatalogEntries(
  entries: ReadonlyArray<NavCatalogEntry>,
  query: string,
  lang: LangCode,
  opts: ScorerOptions = {}
): Array<{ entry: NavCatalogEntry; score: number }> {
  if (!query || !query.trim()) return [];

  const lowerQuery = query.toLowerCase().trim();
  const rawTokens = scorerTokenize(lowerQuery).filter(t => t.length > 2);
  const queryTokens = rawTokens.filter(t => !SCORER_STOPWORDS.has(t));
  const effectiveTokens = queryTokens.length > 0 ? queryTokens : rawTokens;

  const excluded = new Set(opts.exclude_routes || []);
  const results: Array<{ entry: NavCatalogEntry; score: number }> = [];

  for (const entry of entries) {
    if (opts.category && entry.category !== opts.category) continue;
    if (opts.anonymous_only && !entry.anonymous_safe) continue;
    if (excluded.has(entry.route)) continue;

    const content = getContent(entry, lang);
    const titleLower = content.title.toLowerCase();
    const descLower = content.description.toLowerCase();
    const hintLower = content.when_to_visit.toLowerCase();

    const titleWords = scorerBuildWordSet(titleLower);
    const hintWords = scorerBuildWordSet(hintLower);
    const descWords = scorerBuildWordSet(descLower);

    let score = 0;

    // Direct phrase match (highest signal)
    if (titleLower.includes(lowerQuery)) score += 40;
    else if (hintLower.includes(lowerQuery)) score += 30;
    else if (descLower.includes(lowerQuery)) score += 20;

    const matchedTokens = new Set<string>();
    for (const tok of effectiveTokens) {
      let matched = false;
      if (titleWords.has(tok)) { score += 15; matched = true; }
      if (hintWords.has(tok))  { score += 6;  matched = true; }
      if (descWords.has(tok))  { score += 3;  matched = true; }

      // Long-token substring fallback for German compounds and similar.
      if (!matched && tok.length >= 6) {
        if (titleLower.includes(tok)) { score += 5; matched = true; }
        else if (hintLower.includes(tok)) { score += 2; matched = true; }
      }

      if (matched) matchedTokens.add(tok);
    }

    if (effectiveTokens.length > 1 && matchedTokens.size >= effectiveTokens.length) {
      score += effectiveTokens.length * 6;
    }

    if (entry.priority && entry.priority > 0 && score > 0) {
      score += entry.priority * 3;
    }

    if (score > 0) results.push({ entry, score });
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const pa = a.entry.priority || 0;
    const pb = b.entry.priority || 0;
    return pb - pa;
  });
  return results;
}
