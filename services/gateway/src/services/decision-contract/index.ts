// VTID-03109 — decision-contract barrel.
// All cross-module imports go through this entry point so the boundary
// can be audited with a single grep.

export type {
  AssistantDecisionContext,
  SchemaVersion,
  VerbatimString,
  SupportedLanguage,
  RecencyBucket,
  PriorOutcome,
  SessionSlice,
  UserRole,
  IdentitySlice,
  SurfaceSlice,
  TimeOfDayBucket,
  LocaleSlice,
  ContinuityState,
  ConfidenceBand,
  ContinuitySlice,
  ResponseStyle,
  Pace,
  Tone,
  Depth,
  InteractionStyleSlice,
} from './types';

export {
  EMPTY_DECISION_CONTEXT,
  SUPPORTED_LANGUAGES,
  asVerbatim,
} from './types';

export {
  validateDecisionContext,
  type ValidationResult,
  type ValidationMode,
} from './invariants';

export {
  renderSystemInstructionFromContext,
  type RenderOptions,
} from './renderer';

// VTID-03116 (Phase B.3) — PolicyResolver service: sync gets after a 15s
// cache warm-up. Both consumers and tests import from here, never from
// the implementation files directly, so the boundary is grep-auditable.
export {
  POLICY_KEYS,
  RENDER_BLOCK_KEYS,
  type PolicyKey,
  type RenderBlockKey,
} from './policy-keys';

export {
  getPolicyResolver,
  warmPolicyResolverCache,
  configurePolicyResolverForTests,
  __resetPolicyResolverForTests,
  type PolicyResolver,
  type PolicyResolverTestSeed,
} from './policy-resolver';

// Phase C.1 (VTID-03130) — RecommendationStrategy + RankProvenance.
// Re-exported through the barrel so every ranker consumer pulls from
// `services/decision-contract` regardless of which slice (B vs C) it
// uses. Single grep surface for the boundary audit.
export type {
  RankProvenanceComponent,
  RankProvenance,
  RecommendationCandidate,
  RecommendationStrategyScoreResult,
  RecommendationStrategy,
} from './strategy';

// Phase C.3 (VTID-03132) — PillarWeighterStrategy implementation.
// Vertical proof: reads 21 ranker policy keys via PolicyResolver,
// calls the existing scoreRec/rankBatch, emits RankProvenance.
// Byte-identical to the pre-C.3 path when defaults are seeded.
export {
  PILLAR_WEIGHTER_STRATEGY_ID,
  PILLAR_WEIGHTER_STRATEGY_VERSION,
  buildPillarWeighterConfig,
  scoreRecWithProvenance,
  rankBatchWithProvenance,
  type PillarWeighterStrategyResult,
} from './strategies/pillar-weighter';
