/**
 * VTID-02000: Condition matcher — expands a condition_key into the
 * structured filter hints that feed search + feed + analyzer.
 *
 * Thin wrapper over `condition_product_mappings` with in-memory caching.
 */

import { getSupabase } from '../lib/supabase';

export interface ConditionMappingExpanded {
  condition_key: string;
  display_label: string;
  recommended_ingredients: string[]; // flattened, ranked order preserved
  recommended_ingredients_ranked: Array<{ ingredient: string; evidence: string; rank: number }>;
  recommended_health_goals: string[];
  recommended_categories: string[];
  recommended_form: string[];
  contraindicated_ingredients: string[];
  contraindicated_with_conditions: string[];
  contraindicated_with_medications: string[];
  evidence_level: string | null;
  typical_protocol: string | null;
  typical_timeline: string | null;
}

interface CacheEntry {
  value: ConditionMappingExpanded | null;
  expiresAt: number;
}

const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — mappings rarely change

export async function getConditionMapping(condition_key: string): Promise<ConditionMappingExpanded | null> {
  const now = Date.now();
  const cached = CACHE.get(condition_key);
  if (cached && cached.expiresAt > now) return cached.value;

  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('condition_product_mappings')
    .select(
      'condition_key, display_label, recommended_ingredients, recommended_health_goals, recommended_categories, recommended_form, contraindicated_ingredients, contraindicated_with_conditions, contraindicated_with_medications, evidence_level, typical_protocol, typical_timeline'
    )
    .eq('condition_key', condition_key)
    .eq('is_active', true)
    .maybeSingle();
  if (error || !data) {
    CACHE.set(condition_key, { value: null, expiresAt: now + CACHE_TTL_MS });
    return null;
  }

  const ranked = (data.recommended_ingredients as Array<{ ingredient: string; evidence: string; rank: number }>) ?? [];
  ranked.sort((a, b) => a.rank - b.rank);
  const value: ConditionMappingExpanded = {
    condition_key: data.condition_key,
    display_label: data.display_label,
    recommended_ingredients: ranked.map((r) => r.ingredient),
    recommended_ingredients_ranked: ranked,
    recommended_health_goals: data.recommended_health_goals ?? [],
    recommended_categories: data.recommended_categories ?? [],
    recommended_form: data.recommended_form ?? [],
    contraindicated_ingredients: data.contraindicated_ingredients ?? [],
    contraindicated_with_conditions: data.contraindicated_with_conditions ?? [],
    contraindicated_with_medications: data.contraindicated_with_medications ?? [],
    evidence_level: data.evidence_level ?? null,
    typical_protocol: data.typical_protocol ?? null,
    typical_timeline: data.typical_timeline ?? null,
  };
  CACHE.set(condition_key, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/**
 * Resolve a user-spoken phrase via the catalog_vocabulary_synonyms table.
 * Returns a map of { vocabulary -> values[] } when the phrase matches.
 */
export async function expandSynonymPhrase(phrase: string): Promise<Record<string, string[]>> {
  const normalized = phrase.toLowerCase().trim();
  if (!normalized) return {};
  const supabase = getSupabase();
  if (!supabase) return {};
  const { data } = await supabase
    .from('catalog_vocabulary_synonyms')
    .select('phrase, maps_to_vocabulary, maps_to_values')
    .eq('is_active', true);
  if (!data) return {};
  const result: Record<string, string[]> = {};
  for (const row of data) {
    const rowPhrase = (row.phrase as string).toLowerCase();
    if (normalized.includes(rowPhrase)) {
      const vocab = row.maps_to_vocabulary as string;
      const values = (row.maps_to_values as string[]) ?? [];
      if (!result[vocab]) result[vocab] = [];
      for (const v of values) {
        if (!result[vocab].includes(v)) result[vocab].push(v);
      }
    }
  }
  return result;
}
