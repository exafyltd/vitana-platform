/**
 * Proactive Guide — barrel exports.
 *
 * Public surface for the guide module used by vitana-brain.ts and ORB voice.
 */

export { isPaused } from './pause-check';
export { pickOpenerCandidate } from './opener-mvp';
export {
  PAUSE_PROACTIVE_GUIDANCE_TOOL,
  CLEAR_PROACTIVE_PAUSES_TOOL,
  executePauseProactiveGuidance,
  executeClearProactivePauses,
} from './dismissal-tool';
export { emitGuideTelemetry } from './guide-telemetry';
export { getAwarenessContext, clearAwarenessCache } from './awareness-context';
export {
  getFeatureIntroductions,
  recordFeatureIntroduction,
  RECORD_FEATURE_INTRODUCTION_TOOL,
  KNOWN_FEATURE_KEYS,
  type FeatureIntroduction,
  type FeatureKey,
} from './feature-introductions';
export {
  getRecentSessionSummaries,
  recordSessionSummary,
  formatSummariesForPrompt,
  type SessionSummary,
  type RecordSessionSummaryInput,
} from './session-summaries';
export {
  applyApprovedPlans,
  getAdaptationStatus,
  type AdaptationStatus,
  type ApplyResult as AdaptationApplyResult,
} from './adaptation-applier';
export {
  extractPatternsForUser,
  getUserRoutines,
  type RoutineKind,
  type RoutineRow,
  type ExtractResult as PatternExtractResult,
} from './pattern-extractor';
export {
  canSurfaceProactively,
  recordTouch,
  acknowledgeTouch,
  type ProactiveSurface,
  type PresenceLevel,
  type PacerDecision,
  type RecordTouchInput,
  type AcknowledgeTouchInput,
} from './presence-pacer';
// BOOTSTRAP-DYK-TOUR
export { upsertActiveDay, countActiveUsageDays } from './active-usage';
export {
  DYK_TIP_REGISTRY,
  resolveNextTip,
  getTipByKey,
  tourHintFromTip,
  mentionsIndexOrPillar,
  INDEX_FRAMING_TOKENS,
  type DidYouKnowTip,
  type IndexPillar,
  type TipPillarLink,
  type ResolveOptions,
} from './tip-curriculum';
// V2 — Proactive Initiative Engine
export {
  INITIATIVE_REGISTRY,
  pickProactiveInitiative,
  getInitiativeByKey,
  INITIATIVE_FRAMING_TOKENS,
  mentionsIndexOrPillar as initiativeMentionsIndexOrPillar,
  type ProactiveInitiative,
  type InitiativeOnYesTool,
  type InitiativeTarget,
  type InitiativePillarLink,
  type ResolvedInitiative,
  type ResolverContext as InitiativeResolverContext,
} from './initiative-registry';
export {
  describeTimeSince,
  fetchLastSessionInfo,
  deriveMotivationSignal,
  type TemporalBucket,
  type MotivationSignal,
  type LastInteraction,
} from './temporal-bucket';
export {
  type ProactivePause,
  type ProactivePauseScope,
  type OpenerCandidate,
  type OpenerCandidateKind,
  type OpenerSelection,
  type UserAwareness,
  type TenureStage,
  type JourneyContext,
  type AwarenessGoal,
  type CommunityAwarenessSignals,
  type RecentActivitySummary,
} from './types';
