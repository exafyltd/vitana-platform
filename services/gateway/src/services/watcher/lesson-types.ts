/**
 * VTID-03461 — Watcher Phase 2 types.
 *
 * Mirrors the watcher_lessons / watcher_rules CHECK constraints. Adding a
 * value here without adding it to the migration makes the DB reject the row.
 */

export type LessonStage =
  | 'planning'
  | 'execute'
  | 'validate'
  | 'ci'
  | 'merge'
  | 'deploy'
  | 'verify'
  | 'any';

export type LessonPatternType =
  // inherited from dev_autopilot_prompt_learnings
  | 'tsc_error'
  | 'jest_failure'
  | 'parse_error'
  | 'out_of_scope'
  | 'validation_other'
  // added in Phase 2 — the second half of the lifecycle
  | 'ci_failure'
  | 'deploy_failure'
  | 'verification_failure'
  | 'governance_violation'
  | 'review_rejection';

export type LessonStatus = 'active' | 'muted' | 'graduated';

export type RuleSeverity = 'info' | 'warn' | 'block_candidate';

/**
 * Retrieval scope. Replaces the old single `scanner` column — the reason the
 * worker-runner could never read the old table is that it has no scanner.
 */
export interface LessonScope {
  scanner?: string;
  service?: string;
  repo?: string;
  path_glob?: string;
}

export interface LessonRow {
  id: string;
  stage: LessonStage;
  pattern_type: LessonPatternType;
  pattern_key: string;
  scope: LessonScope;
  lesson: string;
  example_message: string | null;
  mitigation_note: string | null;
  frequency: number;
  confidence: number;
  status: LessonStatus;
  last_seen_at: string;
}

export interface RuleTrigger {
  steps?: string[];
  touches?: string[];
  services?: string[];
  actors?: string[];
}

export interface RuleRow {
  rule_key: string;
  source_ref: string;
  stage: LessonStage;
  trigger: RuleTrigger;
  reminder: string;
  severity: RuleSeverity;
  enabled: boolean;
}
