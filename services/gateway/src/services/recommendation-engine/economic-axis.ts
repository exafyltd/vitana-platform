/**
 * Derive economic_axis for an autopilot recommendation from its source_type
 * and source_ref. Used at insert time (recommendation-generator.ts) to label
 * the recommendation so the index-pillar-weighter economic_boost gate can
 * fire for users with an active economic Life Compass goal.
 *
 * Per docs/GOVERNANCE/ULTIMATE-GOAL.md, the longevity economy axis is
 * orthogonal to the 5 health pillars. Mapping is conservative: only return
 * a non-'none' axis when the (source_type, source_ref) combination is
 * unambiguously economic. When in doubt, return 'none'.
 *
 * Tables of intent:
 *   marketplace source         → 'marketplace'
 *   community source_refs that
 *   match introduction /
 *   partnership semantics      → 'find_match'
 *   everything else            → 'none' (default — health-only, dev,
 *                                  behavior, llm, etc.)
 *
 * income_generation and business_formation are valid enum values but no
 * signal source currently emits them — future analyzers (Vitana Autonomous
 * Economic Actor, business-formation recs) will. Until then they sit unused.
 */

import type { EconomicAxis } from './ranking/index-pillar-weighter';

/**
 * source_ref strings that semantically advance the Find a Match axis.
 * Kept in sync with COMMUNITY_ACTIONS in autopilot-recommendations.ts and
 * with CATEGORY_PREFERRED_SOURCE_REFS in index-pillar-weighter.ts for the
 * `community` and `connection` compass categories.
 */
export const FIND_MATCH_SOURCE_REFS: ReadonlySet<string> = new Set([
  'engage_matches',
  'onboarding_matches',
  'onboarding_discover_matches',
  'mentor_newcomer',
  'deepen_connection',
  'onboarding_group',
  'invite_friend',
  'engage_meetup',
]);

export function deriveEconomicAxis(
  sourceType: string | null | undefined,
  sourceRef: string | null | undefined,
): EconomicAxis {
  if (sourceType === 'marketplace') return 'marketplace';
  if (sourceType === 'community' && sourceRef && FIND_MATCH_SOURCE_REFS.has(sourceRef)) return 'find_match';
  return 'none';
}
