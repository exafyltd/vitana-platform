// impact-allow-no-test: pure data-access seam (thin Supabase query
// wrappers, no independent request-handling behavior). Coverage note:
// test/shopping-agent.test.ts wholesale jest.mock()s this module — zero
// genuine coverage today.
/**
 * services/condition-matcher.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase `.from(...)` call in condition-matcher.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same queries, same columns, same filter logic, same return
 * shapes — no behavior change today. Client-agnostic (takes `sb` as a
 * param).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchConditionProductMapping(sb: SupabaseClient, conditionKey: string) {
  return sb
    .from('condition_product_mappings')
    .select(
      'condition_key, display_label, recommended_ingredients, recommended_health_goals, recommended_categories, recommended_form, contraindicated_ingredients, contraindicated_with_conditions, contraindicated_with_medications, evidence_level, typical_protocol, typical_timeline'
    )
    .eq('condition_key', conditionKey)
    .eq('is_active', true)
    .maybeSingle();
}

export async function fetchActiveCatalogVocabularySynonyms(sb: SupabaseClient) {
  return sb.from('catalog_vocabulary_synonyms').select('phrase, maps_to_vocabulary, maps_to_values').eq('is_active', true);
}
