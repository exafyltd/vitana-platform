// Phase C.1 (decision-contract refactor) — VTID-03130.
//
// `RecommendationStrategy` + `RankProvenance` types. The boundary that
// every ranker file (`index-pillar-weighter.ts`, `feed-ranker.ts`,
// `recommendation-generator.ts`, `marketplace-analyzer.ts`) will
// migrate behind in Phase C.3 / C.5+ slices.
//
// Discipline (per `docs/decision-contract/phase-c-brief.md`):
//   - A strategy returns BOTH a numeric score and a structured provenance
//     trail naming each contributing component, its weight key, the
//     resolved weight value, the signal value, and the contribution
//     this component made to the final score.
//   - `provenance.components` is append-only inside a single `score()`
//     call. Never mutate a component after pushing it.
//   - Adding a new component `kind` is a strategy_version bump so
//     historical traces remain interpretable.
//   - `weight_key` is the literal `POLICY_KEYS` string — a full
//     roundtrip back to the source row.

import type { AssistantDecisionContext } from './types';
import type { PolicyResolver } from './policy-resolver';

export type RankProvenanceComponent =
  | {
      readonly kind: 'base';
      readonly value: number;
    }
  | {
      // Additive contribution: weight × signal added to the running score.
      readonly kind: 'additive';
      readonly name: string;
      readonly weight_key: string;
      readonly weight_value: number;
      readonly signal: number;
      readonly contribution: number;
    }
  | {
      // Multiplicative contribution: running score × factor.
      readonly kind: 'multiplier';
      readonly name: string;
      readonly weight_key: string;
      readonly weight_value: number;
      readonly applied: boolean;
      readonly contribution_multiplier: number;
    }
  | {
      // Score clamp / cap (e.g. min/max bounds, quota caps).
      readonly kind: 'clamp';
      readonly name: string;
      readonly before: number;
      readonly after: number;
      readonly reason: string;
    };

export interface RankProvenance {
  readonly strategy_id: string;       // e.g. 'pillar_weighter_v1'
  readonly strategy_version: number;  // monotonic; bump on signature change
  readonly computed_at: string;       // ISO-8601 UTC
  readonly tenant_id: string | null;  // matches the resolver lookup
  readonly components: ReadonlyArray<RankProvenanceComponent>;
  readonly final_score: number;
}

// Minimal candidate shape. Phase C.3 will extend with strategy-specific
// fields (pillar, source_ref, dismissal_rate_for_domain etc). This base
// is intentionally narrow so unrelated strategies can share it.
export interface RecommendationCandidate {
  readonly id: string;
  readonly source_ref?: string | null;
  readonly pillar?:
    | 'mental'
    | 'physical'
    | 'social'
    | 'spiritual'
    | 'financial'
    | null;
}

export interface RecommendationStrategyScoreResult {
  readonly score: number;
  readonly provenance: RankProvenance;
}

export interface RecommendationStrategy<
  C extends RecommendationCandidate = RecommendationCandidate,
> {
  readonly id: string;
  readonly version: number;
  score(
    candidate: C,
    ctx: AssistantDecisionContext,
    resolver: PolicyResolver,
  ): RecommendationStrategyScoreResult;
}
