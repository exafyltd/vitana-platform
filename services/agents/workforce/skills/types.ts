/**
 * Skill Types - VTID-01164
 *
 * Type definitions for the Sub-Agent Skill Pack v1.
 * Shared types for skill handlers and the skill registry.
 */

// =============================================================================
// Base Types
// =============================================================================

/**
 * OASIS event status levels
 */
export type OasisEventStatus = 'info' | 'success' | 'warning' | 'error';

/**
 * Skill execution context
 */
export interface SkillContext {
  vtid: string;
  run_id: string;
  domain: 'frontend' | 'backend' | 'memory' | 'common';
  emitEvent: (
    stage: string,
    status: OasisEventStatus,
    message: string,
    payload?: Record<string, unknown>
  ) => Promise<{ ok: boolean; event_id?: string }>;
}

/**
 * Base skill result
 */
export interface SkillResult {
  ok: boolean;
  error?: string;
}

// =============================================================================
// Check Memory First Types
// =============================================================================

export interface CheckMemoryFirstParams {
  vtid: string;
  query: string;
  target_paths?: string[];
  include_oasis_history?: boolean;
  include_kb?: boolean;
}

export interface MemoryReference {
  type: 'vtid' | 'doc' | 'event' | 'pattern';
  id: string;
  title: string;
  relevance_score: number;
  summary: string;
}

export interface CheckMemoryFirstResult extends SkillResult {
  memory_hit: boolean;
  confidence: number;
  relevant_refs: MemoryReference[];
  recommendation: 'proceed' | 'review_prior_work' | 'consult_prior_vtid' | 'duplicate_detected';
  prior_vtids: string[];
}

// =============================================================================
// Security Scan Types
// =============================================================================

export interface SecurityScanParams {
  vtid: string;
  target_paths: string[];
  diff_content?: string;
  scan_depth?: 'quick' | 'standard' | 'deep';
  categories?: Array<'injection' | 'auth_bypass' | 'input_validation' | 'sensitive_data' | 'xss' | 'csrf' | 'path_traversal'>;
}

export interface SecurityFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  file_path: string;
  line_number: number;
  code_snippet: string;
  description: string;
  recommendation: string;
}

export interface SecurityScanResult extends SkillResult {
  findings: SecurityFinding[];
  summary: {
    total_findings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    files_scanned: number;
  };
  passed: boolean;
}

// =============================================================================
// Validate RLS Policy Types
// =============================================================================

export interface ValidateRlsPolicyParams {
  vtid: string;
  policy_content?: string;
  file_paths?: string[];
  table_name?: string;
  strict_mode?: boolean;
}

export interface PolicyCheck {
  table: string;
  policy_name: string;
  policy_type: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';
  valid: boolean;
  issues: string[];
}

export interface RlsViolation {
  severity: 'critical' | 'warning';
  table: string;
  policy: string;
  issue: string;
  recommendation: string;
}

export interface ValidateRlsPolicyResult extends SkillResult {
  valid: boolean;
  policies_checked: PolicyCheck[];
  violations: RlsViolation[];
  tenant_helpers_used: string[];
  summary: {
    total_policies: number;
    valid_policies: number;
    violations_count: number;
    tables_affected: string[];
  };
}

// =============================================================================
// Preview Migration Types
// =============================================================================

export interface PreviewMigrationParams {
  vtid: string;
  migration_content?: string;
  file_path?: string;
  check_naming?: boolean;
  check_reversibility?: boolean;
  check_transactions?: boolean;
}

export interface MigrationWarning {
  severity: 'warning' | 'info';
  category: string;
  message: string;
  line_number?: number;
}

export interface MigrationBlocker {
  severity: 'critical' | 'error';
  category: string;
  message: string;
  line_number?: number;
  recommendation: string;
}

export interface MigrationOperation {
  type: 'CREATE_TABLE' | 'ALTER_TABLE' | 'DROP_TABLE' | 'CREATE_INDEX' | 'DROP_INDEX' | 'CREATE_FUNCTION' | 'DROP_FUNCTION' | 'CREATE_POLICY' | 'INSERT' | 'UPDATE' | 'DELETE';
  target: string;
  line_number: number;
  is_destructive: boolean;
}

export interface PreviewMigrationResult extends SkillResult {
  safe_to_apply: boolean;
  warnings: MigrationWarning[];
  blockers: MigrationBlocker[];
  operations_detected: MigrationOperation[];
  naming_check: {
    valid: boolean;
    expected_pattern: string;
    actual_filename: string;
    issues: string[];
  };
  transaction_check: {
    has_begin: boolean;
    has_commit: boolean;
    has_rollback_handler: boolean;
    recommendation: string;
  };
  summary: {
    total_operations: number;
    destructive_operations: number;
    warnings_count: number;
    blockers_count: number;
  };
}

// =============================================================================
// Analyze Service Types
// =============================================================================

export interface AnalyzeServiceParams {
  vtid: string;
  service_name?: string;
  keywords?: string[];
  file_patterns?: string[];
  feature_description?: string;
  include_tests?: boolean;
}

export interface ExistingService {
  name: string;
  file_path: string;
  type: 'route' | 'service' | 'controller' | 'middleware';
  endpoints: Array<{
    method: string;
    path: string;
    handler: string;
  }>;
  relevance_score: number;
}

export interface SimilarPattern {
  pattern_name: string;
  file_path: string;
  description: string;
  code_example: string;
  applicable_to: string;
}

export interface AnalyzeServiceResult extends SkillResult {
  existing_services: ExistingService[];
  similar_patterns: SimilarPattern[];
  implementation_recommendation: {
    location: string;
    pattern_to_follow: string;
    existing_service_to_extend?: string;
    notes: string[];
  };
  potential_duplicates: Array<{
    file_path: string;
    description: string;
    similarity_score: number;
  }>;
  summary: {
    services_found: number;
    patterns_found: number;
    files_analyzed: number;
    duplicate_risk: 'none' | 'low' | 'medium' | 'high';
  };
}

// =============================================================================
// Validate Accessibility Types
// =============================================================================

export interface ValidateAccessibilityParams {
  vtid: string;
  target_paths: string[];
  diff_content?: string;
  severity_threshold?: 'error' | 'warning' | 'info';
  checks?: Array<'aria_labels' | 'keyboard_nav' | 'semantic_elements' | 'tab_order' | 'focus_visible' | 'alt_text' | 'heading_order' | 'form_labels'>;
}

export interface A11yIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  category: string;
  file_path: string;
  line_number: number;
  element: string;
  issue: string;
  recommendation: string;
  wcag_ref: string;
}

export interface ValidateAccessibilityResult extends SkillResult {
  passed: boolean;
  issues: A11yIssue[];
  summary: {
    total_issues: number;
    errors: number;
    warnings: number;
    info: number;
    files_checked: number;
    elements_analyzed: number;
  };
  checks_performed: string[];
}

// =============================================================================
// Skill Registry Types
// =============================================================================

export type SkillHandler<P, R extends SkillResult> = (
  params: P,
  context: SkillContext
) => Promise<R>;

export interface SkillDefinition<P = unknown, R extends SkillResult = SkillResult> {
  skill_id: string;
  name: string;
  domain: 'frontend' | 'backend' | 'memory' | 'common';
  handler: SkillHandler<P, R>;
  timeout_ms: number;
}
