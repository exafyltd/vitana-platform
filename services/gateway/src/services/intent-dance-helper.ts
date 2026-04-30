/**
 * VTID-DANCE-D2: Dance facet enrichment.
 *
 * After intent-extractor.ts produces a kind-specific payload, this helper
 * canonicalizes any `dance` block and back-fills missing fields from the
 * dictator's stable profile.dance_preferences (when available).
 *
 * Called regardless of the intent_kind — it's a no-op for non-dance categories.
 * Idempotent and side-effect-free besides the returned mutation suggestion.
 */

import { getSupabase } from '../lib/supabase';

export type DanceVariety =
  | 'salsa' | 'tango' | 'bachata' | 'kizomba'
  | 'swing' | 'ballroom' | 'hiphop' | 'contemporary' | 'other';

export type DanceLevel = 'beginner' | 'social' | 'intermediate' | 'advanced' | 'professional';
export type DanceRole = 'lead' | 'follow' | 'either' | 'both';

export interface DancePayload {
  variety?: DanceVariety | null;
  level_target?: DanceLevel | null;
  role_pref?: DanceRole | null;
  role_taught?: DanceRole | null;
  formality?: 'casual' | 'social' | 'professional' | null;
}

const VARIETY_ALIASES: Record<string, DanceVariety> = {
  salsa: 'salsa',
  cubana: 'salsa',
  'la-style': 'salsa',
  'on-2': 'salsa',
  tango: 'tango',
  'argentine-tango': 'tango',
  bachata: 'bachata',
  kizomba: 'kizomba',
  swing: 'swing',
  'lindy-hop': 'swing',
  'west-coast-swing': 'swing',
  'east-coast-swing': 'swing',
  ballroom: 'ballroom',
  'standard-ballroom': 'ballroom',
  waltz: 'ballroom',
  foxtrot: 'ballroom',
  hiphop: 'hiphop',
  'hip-hop': 'hiphop',
  contemporary: 'contemporary',
  modern: 'contemporary',
  jazz: 'contemporary',
  ballet: 'contemporary',
};

/**
 * Returns the canonical variety key for a free-form variety string.
 * Returns null when no plausible match — caller may fall back to 'other'.
 */
export function canonicalizeVariety(input: string | null | undefined): DanceVariety | null {
  if (!input) return null;
  const norm = input.toLowerCase().trim().replace(/\s+/g, '-');
  return VARIETY_ALIASES[norm] || (norm === 'other' ? 'other' : null);
}

/**
 * Derive the variety from a category like 'dance.learning.salsa' or 'dance.teaching.tango'.
 * Returns null when the category isn't a dance category.
 */
export function varietyFromCategory(category: string | null | undefined): DanceVariety | null {
  if (!category || !category.startsWith('dance.')) return null;
  const segments = category.split('.');
  // dance.learning.<variety> | dance.teaching.<variety> → 3rd segment
  if (segments.length >= 3) {
    return canonicalizeVariety(segments[2]);
  }
  return null;
}

/**
 * Read profile.dance_preferences for the user. Returns {} when none set.
 * Null-tolerant — silently swallows DB errors and returns {} rather than
 * blocking the intent post.
 */
export async function readUserDancePreferences(userId: string): Promise<Record<string, unknown>> {
  const supabase = getSupabase();
  if (!supabase || !userId) return {};
  try {
    const { data } = await supabase
      .from('profiles')
      .select('dance_preferences')
      .eq('user_id', userId)
      .maybeSingle();
    const prefs = (data as any)?.dance_preferences;
    return prefs && typeof prefs === 'object' ? prefs : {};
  } catch {
    return {};
  }
}

/**
 * Enrich a kind_payload with a normalized `dance` block when the category is
 * a dance category. Existing user-stated values win; we only fill blanks
 * from the profile prefs and the category name.
 */
export async function enrichDancePayload(opts: {
  user_id: string | null;
  category: string | null | undefined;
  kind_payload: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { user_id, category } = opts;
  const payload = { ...opts.kind_payload };

  if (!category || !category.startsWith('dance.')) {
    return payload; // no-op for non-dance categories
  }

  const dance: Record<string, unknown> =
    (payload.dance && typeof payload.dance === 'object' ? { ...(payload.dance as Record<string, unknown>) } : {});

  // 1. Fill variety from category if extractor missed it.
  if (!dance.variety) {
    const fromCat = varietyFromCategory(category);
    if (fromCat) dance.variety = fromCat;
  } else {
    // Canonicalize what the extractor produced.
    const canon = canonicalizeVariety(String(dance.variety));
    if (canon) dance.variety = canon;
  }

  // 2. Read profile prefs and back-fill role / level when missing.
  if (user_id) {
    const prefs = await readUserDancePreferences(user_id);

    if (!dance.role_pref && Array.isArray(prefs.roles) && prefs.roles.length > 0) {
      const r = String(prefs.roles[0]).toLowerCase();
      if (r === 'lead' || r === 'follow' || r === 'either' || r === 'both') {
        dance.role_pref = r;
      }
    }

    if (!dance.level_target && dance.variety) {
      const levels = (prefs.levels && typeof prefs.levels === 'object') ? (prefs.levels as Record<string, string>) : {};
      const l = levels[String(dance.variety)];
      if (l) dance.level_target = l;
    }
  }

  payload.dance = dance;
  return payload;
}
