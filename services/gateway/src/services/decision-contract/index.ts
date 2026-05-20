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
