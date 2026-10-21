/**
 * VTID-01124: Life Stage, Goals & Trajectory Awareness Types (D40)
 *
 * Type definitions for the Deep Context Intelligence Engine that understands
 * where the user is in their life journey and aligns intelligence with
 * long-term goals, not just immediate desires.
 *
 * Hard Constraints (from spec):
 *   - NEVER impose goals
 *   - NEVER shame deviations
 *   - Treat goals as evolving, not fixed
 *   - Allow conscious contradictions when user chooses
 *   - Keep goal inference transparent and correctable
 */

// =============================================================================
// Life Stage Enums
// =============================================================================

/**
 * Life phase categories (non-prescriptive)
 */
export type LifePhase =
  | 'exploratory'     // Discovering, experimenting, learning
  | 'stabilizing'     // Building foundations, establishing routines
  | 'optimizing'      // Refining, improving, fine-tuning
  | 'transitioning'   // Major life change in progress
  | 'maintaining'     // Sustaining what works
  | 'unknown';        // Insufficient data

/**
 * Stability level indicator
 */
export type StabilityLevel = 'high' | 'medium' | 'low' | 'unknown';

/**
 * Goal horizon categories
 */
export type GoalHorizon = 'short_term' | 'medium_term' | 'long_term';

/**
 * Goal categories aligned with life domains
 */
export type GoalCategory =
  | 'health_longevity'
  | 'social_relationships'
  | 'learning_growth'
  | 'career_purpose'
  | 'lifestyle_optimization'
  | 'financial_security'
  | 'creative_expression'
  | 'community_contribution';

/**
 * Trajectory alignment tags for actions
 */
export type TrajectoryTag =
  | 'long_term_supportive'
  | 'short_term_only'
  | 'goal_conflict'
  | 'neutral_but_safe'
  | 'multi_goal_aligned';

/**
 * Orientation signals (non-binary, probabilistic)
 */
export type OrientationSignal =
  | 'independence_focused'
  | 'family_oriented'
  | 'career_intensive'
  | 'balance_seeking'
  | 'community_focused'
  | 'self_development'
  | 'mixed';

// =============================================================================
// Life Stage Assessment
// =============================================================================

/**
 * Life stage assessment bundle
 */
export interface LifeStageBundle {
  phase: LifePhase;
  phase_confidence: number; // 0-100
  stability_level: StabilityLevel;
  stability_confidence: number; // 0-100
  transition_flag: boolean;
  transition_type?: string; // e.g., "career_change", "relocation", "family_expansion"
  orientation_signals: OrientationSignalScore[];
  assessed_at: string; // ISO timestamp
  decay_at: string; // ISO timestamp when assessment should be refreshed
  disclaimer: string;
}

/**
 * Orientation signal with score
 */
export interface OrientationSignalScore {
  signal: OrientationSignal;
  score: number; // 0-100
  confidence: number; // 0-100
  evidence_count: number;
}

// =============================================================================
// Goal Types
// =============================================================================

/**
 * Detected goal with metadata
 */
export interface UserGoal {
  id: string;
  category: GoalCategory;
  description: string;
  priority: number; // 1-10, higher = more important
  confidence: number; // 0-100
  horizon: GoalHorizon;
  explicit: boolean; // true if user stated directly, false if inferred
  evidence_ids: string[]; // References to evidence sources
  created_at: string;
  updated_at: string;
  status: 'active' | 'achieved' | 'paused' | 'abandoned';
}

/**
 * Goal set with trajectory context
 */
export interface GoalSet {
  goals: UserGoal[];
  primary_focus?: GoalCategory; // Inferred primary life focus
  coherence_score: number; // 0-1, how well goals align with each other
  last_updated: string;
}

// =============================================================================
// Trajectory Alignment
// =============================================================================

/**
 * Trajectory-aligned action recommendation
 */
export interface TrajectoryAction {
  action: string;
  action_type: string; // e.g., "recommendation", "reminder", "suggestion"
  goal_alignment: GoalAlignmentDetail[];
  trajectory_score: number; // 0.0-1.0
  trajectory_tag: TrajectoryTag;
  horizon: GoalHorizon;
  confidence: number; // 0-100
  trade_offs?: string[]; // Gentle highlighting of trade-offs
  multi_goal_support: boolean;
}

/**
 * Goal alignment detail for an action
 */
export interface GoalAlignmentDetail {
  goal_id: string;
  goal_category: GoalCategory;
  alignment: 'supports' | 'contradicts' | 'neutral';
  impact_score: number; // -1 to 1
  explanation?: string;
}

// =============================================================================
// Input Types
// =============================================================================

/**
 * Input for life stage assessment
 */
export interface LifeStageAssessInput {
  session_id?: string;
  include_goals?: boolean;
  include_trajectory?: boolean;
  context_window_days?: number; // How far back to look for signals
}

/**
 * Input for goal detection/update
 */
export interface GoalDetectInput {
  message?: string; // Optional explicit goal statement
  session_id?: string;
  source: 'explicit' | 'conversation' | 'behavior' | 'preference';
}

/**
 * Input for trajectory alignment scoring
 */
export interface TrajectoryScoreInput {
  actions: ProposedAction[];
  session_id?: string;
  include_trade_offs?: boolean;
}

/**
 * Proposed action for trajectory scoring
 */
export interface ProposedAction {
  action_id: string;
  action: string;
  action_type: string;
  domain?: string;
}

// =============================================================================
// Evidence & Traceability
// =============================================================================

/**
 * Evidence for life stage inference
 */
export interface LifeStageEvidence {
  preference_signals: PreferenceSignal[];
  health_signals: HealthSignal[];
  social_signals: SocialSignal[];
  behavioral_patterns: BehavioralPattern[];
  explicit_statements: ExplicitStatement[];
}

export interface PreferenceSignal {
  source: string;
  signal_type: string;
  value: unknown;
  timestamp: string;
}

export interface HealthSignal {
  source: string;
  metric: string;
  value: unknown;
  timestamp: string;
}

export interface SocialSignal {
  source: string;
  signal_type: string;
  value: unknown;
  timestamp: string;
}

export interface BehavioralPattern {
  pattern_type: string;
  frequency: string;
  confidence: number;
  first_seen: string;
  last_seen: string;
}

export interface ExplicitStatement {
  statement: string;
  category: GoalCategory | 'life_stage' | 'orientation';
  extracted_at: string;
  source_type: string;
}

// =============================================================================
// API Response Types
// =============================================================================

/**
 * Response from life_stage_assess RPC
 */
export interface LifeStageAssessResponse {
  ok: boolean;
  error?: string;
  message?: string;
  life_stage?: LifeStageBundle;
  goal_set?: GoalSet;
  trajectory_actions?: TrajectoryAction[];
  evidence?: LifeStageEvidence;
  rules_applied?: string[];
  tenant_id?: string;
  user_id?: string;
}

/**
 * Response from goal operations
 */
export interface GoalOperationResponse {
  ok: boolean;
  error?: string;
  message?: string;
  goal?: UserGoal;
  goals?: UserGoal[];
  goal_set?: GoalSet;
}

/**
 * Response from trajectory scoring
 */
export interface TrajectoryScoreResponse {
  ok: boolean;
  error?: string;
  message?: string;
  scored_actions?: TrajectoryAction[];
  overall_coherence: number; // 0-1
  conflicts_detected: number;
  multi_goal_opportunities: number;
}

/**
 * Response for get current life stage
 */
export interface GetCurrentLifeStageResponse {
  ok: boolean;
  error?: string;
  message?: string;
  life_stage?: LifeStageBundle;
  goal_set?: GoalSet;
  last_assessed?: string;
  needs_refresh: boolean;
}

/**
 * Response from override operations
 */
export interface LifeStageOverrideResponse {
  ok: boolean;
  error?: string;
  message?: string;
  assessment_id?: string;
  override?: Record<string, unknown>;
}

/**
 * Response from explain operations
 */
export interface LifeStageExplainResponse {
  ok: boolean;
  error?: string;
  message?: string;
  assessment_id?: string;
  life_stage?: LifeStageBundle;
  evidence?: LifeStageEvidence;
  rules_applied?: AppliedRule[];
  rules_applied_keys?: string[];
  assessed_at?: string;
  disclaimer?: string;
}

/**
 * Applied rule detail for explain endpoint
 */
export interface AppliedRule {
  rule_key: string;
  rule_version: number;
  domain: 'life_phase' | 'stability' | 'orientation' | 'goal_detection' | 'trajectory';
  target: string;
  logic: Record<string, unknown>;
  weight: number;
}

// =============================================================================
// ORB Integration Types
// =============================================================================

/**
 * Simplified life stage context for ORB system prompt injection
 */
export interface OrbLifeStageContext {
  /** Current life phase */
  phase: LifePhase;
  phase_confidence?: number;

  /** Stability indicator */
  stability: StabilityLevel;
  in_transition: boolean;

  /** Primary orientation */
  primary_orientation?: OrientationSignal;

  /** Active goals summary */
  active_goal_count: number;
  primary_goal_category?: GoalCategory;

  /** Modulation hints for ORB */
  recommendation_style: 'exploratory' | 'supportive' | 'optimization' | 'transitional';
  commitment_level: 'low_pressure' | 'moderate' | 'high_commitment';
  horizon_focus: GoalHorizon;

  /** Always present */
  disclaimer: string;
}

/**
 * Convert a LifeStageBundle to OrbLifeStageContext for context injection
 */
export function toOrbContext(bundle: LifeStageBundle, goalSet?: GoalSet): OrbLifeStageContext {
  // Find primary orientation (highest score)
  const primaryOrientation = bundle.orientation_signals.length > 0
    ? bundle.orientation_signals.reduce((a, b) => a.score > b.score ? a : b)
    : null;

  // Count active goals and find primary category
  const activeGoals = goalSet?.goals.filter(g => g.status === 'active') || [];
  const primaryGoalCategory = activeGoals.length > 0
    ? activeGoals.reduce((a, b) => a.priority > b.priority ? a : b).category
    : undefined;

  // Determine recommendation style based on phase
  let recommendationStyle: OrbLifeStageContext['recommendation_style'] = 'supportive';
  switch (bundle.phase) {
    case 'exploratory':
      recommendationStyle = 'exploratory';
      break;
    case 'optimizing':
      recommendationStyle = 'optimization';
      break;
    case 'transitioning':
      recommendationStyle = 'transitional';
      break;
    default:
      recommendationStyle = 'supportive';
  }

  // Determine commitment level based on stability and phase
  let commitmentLevel: OrbLifeStageContext['commitment_level'] = 'moderate';
  if (bundle.phase === 'exploratory' || bundle.transition_flag) {
    commitmentLevel = 'low_pressure';
  } else if (bundle.phase === 'optimizing' && bundle.stability_level === 'high') {
    commitmentLevel = 'high_commitment';
  }

  // Determine horizon focus
  let horizonFocus: GoalHorizon = 'medium_term';
  if (bundle.phase === 'exploratory') {
    horizonFocus = 'short_term';
  } else if (bundle.phase === 'optimizing' || bundle.stability_level === 'high') {
    horizonFocus = 'long_term';
  }

  return {
    phase: bundle.phase,
    phase_confidence: bundle.phase_confidence,
    stability: bundle.stability_level,
    in_transition: bundle.transition_flag,
    primary_orientation: primaryOrientation?.signal,
    active_goal_count: activeGoals.length,
    primary_goal_category: primaryGoalCategory,
    recommendation_style: recommendationStyle,
    commitment_level: commitmentLevel,
    horizon_focus: horizonFocus,
    disclaimer: bundle.disclaimer
  };
}

/**
 * Format OrbLifeStageContext for system prompt injection
 */
export function formatLifeStageContextForPrompt(ctx: OrbLifeStageContext): string {
  const lines: string[] = [
    '## User Life Context (D40 Signals)',
    `[${ctx.disclaimer}]`,
    ''
  ];

  // Life phase
  if (ctx.phase !== 'unknown' && ctx.phase_confidence && ctx.phase_confidence >= 40) {
    lines.push(`- Life Phase: ${ctx.phase} (confidence: ${ctx.phase_confidence}%)`);
  }

  // Stability and transition
  lines.push(`- Stability: ${ctx.stability}`);
  if (ctx.in_transition) {
    lines.push('- TRANSITION: User appears to be in a life transition');
  }

  // Orientation
  if (ctx.primary_orientation) {
    lines.push(`- Primary Orientation: ${ctx.primary_orientation.replace(/_/g, ' ')}`);
  }

  // Goals
  if (ctx.active_goal_count > 0) {
    lines.push(`- Active Goals: ${ctx.active_goal_count}`);
    if (ctx.primary_goal_category) {
      lines.push(`- Primary Focus: ${ctx.primary_goal_category.replace(/_/g, ' ')}`);
    }
  }

  lines.push('');
  lines.push('### Recommendation Modulation');
  lines.push(`- Style: ${ctx.recommendation_style}`);
  lines.push(`- Commitment Level: ${ctx.commitment_level.replace(/_/g, ' ')}`);
  lines.push(`- Horizon Focus: ${ctx.horizon_focus.replace(/_/g, ' ')}`);

  return lines.join('\n');
}
