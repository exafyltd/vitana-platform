// Phase C.6 (decision-contract refactor) — signal→impact accessor.
//
// VTID-03140. Per-signal-type impact catalogues are stored as one JSONB
// row per signal_type in `decision_policy`. This module is the only place
// that knows the JSONB shape; consumers go through the typed accessors
// below and never touch the raw policy value.
//
// Why one row per signal_type (not (signal_type, signal_key) rows):
//   - This is still a bounded map of constants. The user explicitly chose
//     the JSONB shape as the right level of abstraction for "catalogue of
//     facts". Per-key rows are reserved for the user-editable recommendation
//     graph in a later phase.
//   - Cache-coldness is byte-identical to the old literal maps because the
//     fallback below mirrors the seed verbatim.

import { getPolicyResolver } from '../decision-contract/policy-resolver';
import { POLICY_KEYS } from '../decision-contract/policy-keys';

// ---------------------------------------------------------------------------
// JSONB shape
// ---------------------------------------------------------------------------

export interface SignalImpactEntry {
  impact: number;
  weight: number;
  rationale: string;
}

export interface SignalImpactMap {
  version: 1;
  impacts: Record<string, SignalImpactEntry>;
}

// ---------------------------------------------------------------------------
// Cold-cache fallback maps — byte-identical to the seed migration values.
// These exist so that if PolicyResolver returns no rows (e.g. fresh
// deploy before RUN-MIGRATION lands), behaviour matches the pre-refactor
// literals exactly.
// ---------------------------------------------------------------------------

const CODEBASE_FALLBACK: SignalImpactMap = {
  version: 1,
  impacts: {
    todo:          { impact: 5, weight: 1, rationale: 'Inline TODO — small but real follow-up' },
    large_file:    { impact: 6, weight: 1, rationale: 'Refactor candidate — affects readability + diffability' },
    missing_tests: { impact: 7, weight: 1, rationale: 'Quality + regression risk' },
    dead_code:     { impact: 4, weight: 1, rationale: 'Cleanup, no functional gain' },
    duplication:   { impact: 5, weight: 1, rationale: 'Maintenance + drift risk' },
    missing_docs:  { impact: 3, weight: 1, rationale: 'Onboarding friction; lowest ranked' },
  },
};

const OASIS_FALLBACK: SignalImpactMap = {
  version: 1,
  impacts: {
    error_pattern:     { impact: 8, weight: 1, rationale: 'Recurring error — high user impact' },
    slow_endpoint:     { impact: 7, weight: 1, rationale: 'Latency degrades UX' },
    failed_deploy:     { impact: 9, weight: 1, rationale: 'Pipeline broken — blocks delivery' },
    anomaly:           { impact: 6, weight: 1, rationale: 'Unexpected behaviour, investigate' },
    underused_feature: { impact: 4, weight: 1, rationale: 'Adoption signal, not urgent' },
  },
};

const HEALTH_FALLBACK: SignalImpactMap = {
  version: 1,
  impacts: {
    missing_index:   { impact: 7, weight: 1, rationale: 'Performance hot-spot at scale' },
    large_table:     { impact: 6, weight: 1, rationale: 'Archival/retention candidate' },
    missing_rls:     { impact: 9, weight: 1, rationale: 'Security — tenant isolation gap' },
    env_gap:         { impact: 8, weight: 1, rationale: 'Configuration drift, breaks features' },
    stale_migration: { impact: 5, weight: 1, rationale: 'Schema lag, low blast radius' },
  },
};

const LLM_FALLBACK: SignalImpactMap = {
  version: 1,
  impacts: {
    high: { impact: 8, weight: 1, rationale: 'confidence > 0.8 — strong LLM judgement' },
    mid:  { impact: 6, weight: 1, rationale: '0.5 < confidence ≤ 0.8 — qualified' },
    low:  { impact: 4, weight: 1, rationale: 'confidence ≤ 0.5 — speculative' },
  },
};

const MARKETPLACE_FALLBACK: SignalImpactMap = {
  version: 1,
  impacts: {
    high: { impact: 8, weight: 1, rationale: 'match_score > 0.7 — strong fit' },
    mid:  { impact: 6, weight: 1, rationale: '0.5 < match_score ≤ 0.7 — qualified' },
    low:  { impact: 4, weight: 1, rationale: 'match_score ≤ 0.5 — exploratory' },
  },
};

const WEARABLE_FALLBACK: SignalImpactMap = {
  version: 1,
  impacts: {
    high:   { impact: 8, weight: 1, rationale: 'Clinical concern — flag prominently' },
    medium: { impact: 6, weight: 1, rationale: 'Notable variance — surface' },
    low:    { impact: 4, weight: 1, rationale: 'Routine trend information' },
  },
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

type SignalType =
  | 'codebase'
  | 'oasis'
  | 'health'
  | 'llm'
  | 'marketplace'
  | 'wearable';

const POLICY_KEY_BY_SIGNAL_TYPE: Record<SignalType, string> = {
  codebase:    POLICY_KEYS.RECOMMENDATION_SIGNAL_IMPACT_CODEBASE,
  oasis:       POLICY_KEYS.RECOMMENDATION_SIGNAL_IMPACT_OASIS,
  health:      POLICY_KEYS.RECOMMENDATION_SIGNAL_IMPACT_HEALTH,
  llm:         POLICY_KEYS.RECOMMENDATION_SIGNAL_IMPACT_LLM,
  marketplace: POLICY_KEYS.RECOMMENDATION_SIGNAL_IMPACT_MARKETPLACE,
  wearable:    POLICY_KEYS.RECOMMENDATION_SIGNAL_IMPACT_WEARABLE,
};

const FALLBACK_BY_SIGNAL_TYPE: Record<SignalType, SignalImpactMap> = {
  codebase:    CODEBASE_FALLBACK,
  oasis:       OASIS_FALLBACK,
  health:      HEALTH_FALLBACK,
  llm:         LLM_FALLBACK,
  marketplace: MARKETPLACE_FALLBACK,
  wearable:    WEARABLE_FALLBACK,
};

function getSignalImpactMap(signalType: SignalType): SignalImpactMap {
  const fallback = FALLBACK_BY_SIGNAL_TYPE[signalType];
  const fromPolicy = getPolicyResolver().getValue<SignalImpactMap>(
    POLICY_KEY_BY_SIGNAL_TYPE[signalType],
    { defaultValue: fallback },
  );
  // Light shape guard: if the row is missing impacts or wrong version,
  // fall back. This is cheap and prevents a malformed override from
  // crashing recommendation generation.
  if (
    !fromPolicy ||
    fromPolicy.version !== 1 ||
    !fromPolicy.impacts ||
    typeof fromPolicy.impacts !== 'object'
  ) {
    return fallback;
  }
  return fromPolicy;
}

function lookupImpact(
  map: SignalImpactMap,
  key: string,
  defaultImpact: number,
): number {
  const entry = map.impacts[key];
  if (entry && typeof entry.impact === 'number') return entry.impact;
  return defaultImpact;
}

// ---------------------------------------------------------------------------
// Per-signal-type accessors (called by recommendation-generator.ts)
// ---------------------------------------------------------------------------

export function getCodebaseSignalImpact(type: string): number {
  return lookupImpact(getSignalImpactMap('codebase'), type, 5);
}

export function getOasisSignalImpact(type: string): number {
  return lookupImpact(getSignalImpactMap('oasis'), type, 6);
}

export function getHealthSignalImpact(type: string): number {
  return lookupImpact(getSignalImpactMap('health'), type, 6);
}

export function getLLMSignalImpact(confidence: number): number {
  const map = getSignalImpactMap('llm');
  const tier = confidence > 0.8 ? 'high' : confidence > 0.5 ? 'mid' : 'low';
  return lookupImpact(map, tier, 4);
}

export function getMarketplaceSignalImpact(matchScore: number): number {
  const map = getSignalImpactMap('marketplace');
  const tier = matchScore > 0.7 ? 'high' : matchScore > 0.5 ? 'mid' : 'low';
  return lookupImpact(map, tier, 4);
}

export function getWearableSignalImpact(
  severity: 'high' | 'medium' | 'low',
): number {
  return lookupImpact(getSignalImpactMap('wearable'), severity, 4);
}
