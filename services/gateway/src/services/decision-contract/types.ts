// VTID-03109 — AssistantDecisionContext (Phase A keystone).
//
// The ONLY shape the prompt renderer is allowed to read from. Providers
// distill multi-source signals into the closed enums defined here; the
// renderer reads only this object and never branches on raw timestamps,
// scores, DB rows, or free-form text.
//
// Subsequent phases (B/C/D/E) progressively migrate consumers and ranker
// layers onto this contract; this file is the immovable target they
// validate against.

export type SchemaVersion = 1;

// Strings echoed verbatim by the model (user name, vitana handle,
// pre-localized screen title). The brand exists so an audit can prove no
// prompt fragment is masquerading as data.
export type VerbatimString = string & { readonly __verbatim: unique symbol };

export function asVerbatim(s: string): VerbatimString {
  return s as VerbatimString;
}

export type SupportedLanguage = 'en' | 'de' | 'fr' | 'es' | 'ar' | 'zh' | 'ru' | 'sr';
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  'en', 'de', 'fr', 'es', 'ar', 'zh', 'ru', 'sr',
];

export type RecencyBucket =
  | 'reconnect' | 'recent' | 'same_day' | 'today'
  | 'yesterday' | 'week' | 'long' | 'first';

export type PriorOutcome = 'success' | 'failure' | 'unknown';

export interface SessionSlice {
  readonly recency_bucket: RecencyBucket;
  readonly prior_session_outcome: PriorOutcome;
  readonly is_silent_resume: boolean;
}

export type UserRole = 'community' | 'admin' | 'developer' | 'pro' | 'unknown';

export interface IdentitySlice {
  readonly role: UserRole;
  readonly has_vitana_id: boolean;
  readonly vitana_id_handle: VerbatimString | null;
  readonly has_user_name: boolean;
  readonly user_first_name: VerbatimString | null;
}

export interface SurfaceSlice {
  readonly has_current_screen: boolean;
  readonly current_screen_title: VerbatimString | null;
  readonly current_screen_route: VerbatimString | null;
  readonly recent_screen_count: number;
  readonly recent_screen_titles: readonly VerbatimString[];
}

export type TimeOfDayBucket =
  | 'early_morning' | 'morning' | 'afternoon' | 'evening' | 'late_evening';

export interface LocaleSlice {
  readonly language: SupportedLanguage;
  readonly time_of_day_bucket: TimeOfDayBucket;
  readonly is_weekend: boolean;
}

export type ContinuityState =
  | 'fresh' | 'continuing_recent_topic' | 'returning_after_gap' | 'reconnect_silent';
export type ConfidenceBand = 'low' | 'medium' | 'high';

export interface ContinuitySlice {
  readonly state: ContinuityState;
  readonly has_pending_question: boolean;
  readonly has_pending_decision: boolean;
  readonly confidence_band: ConfidenceBand;
}

export type ResponseStyle = 'directive' | 'collaborative' | 'exploratory' | 'unknown';
export type Pace = 'fast' | 'measured' | 'slow' | 'unknown';
export type Tone = 'warm' | 'professional' | 'playful' | 'unknown';
export type Depth = 'brief' | 'standard' | 'comprehensive' | 'unknown';

export interface InteractionStyleSlice {
  readonly response_style: ResponseStyle;
  readonly pace: Pace;
  readonly tone: Tone;
  readonly depth: Depth;
  readonly confidence_band: ConfidenceBand;
}

export interface AssistantDecisionContext {
  readonly schema_version: SchemaVersion;
  readonly session?: SessionSlice;
  readonly identity?: IdentitySlice;
  readonly surface?: SurfaceSlice;
  readonly locale?: LocaleSlice;
  readonly continuity?: ContinuitySlice;
  readonly interaction_style?: InteractionStyleSlice;
}

export const EMPTY_DECISION_CONTEXT: AssistantDecisionContext = Object.freeze({
  schema_version: 1,
});
