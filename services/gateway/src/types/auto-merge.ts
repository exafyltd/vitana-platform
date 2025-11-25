// DEV-CICDL-0207 – Autonomous Safe Merge Layer Types

/**
 * Allowed modules for auto-merge
 */
export const AUTO_MERGE_ALLOWED_MODULES = ['CICDL', 'GATEWAY', 'OASIS', 'VTID_GOVERNANCE'] as const;
export type AutoMergeAllowedModule = typeof AUTO_MERGE_ALLOWED_MODULES[number];

/**
 * Forbidden paths that block auto-merge regardless of module
 */
export const AUTO_MERGE_FORBIDDEN_PATHS = [
  '.github/CODEOWNERS',
  'supabase/migrations/20251120000000_init_governance.sql',
  'prisma/schema.prisma',
  'services/gateway/src/lib/supabase.ts',
  '.env',
  '.env.local',
  '.env.production',
  'credentials.json',
  'secrets/',
] as const;

/**
 * Forbidden patterns that indicate potential security issues
 */
export const AUTO_MERGE_FORBIDDEN_PATTERNS = [
  /<script[\s>]/i,                    // Inline JS
  /style\s*=\s*["'][^"']*expression/i, // CSS expressions
  /javascript:/i,                      // JavaScript URLs
  /on\w+\s*=\s*["']/i,                // Event handlers
  /eval\s*\(/,                         // eval() calls
  /Function\s*\(/,                     // Function constructor
  /document\.write/,                   // document.write
  /innerHTML\s*=/,                     // innerHTML assignment
] as const;

/**
 * PR entity status types
 */
export type PRCIStatus = 'pending' | 'success' | 'failed';
export type PRValidatorStatus = 'pending' | 'success' | 'failed';

/**
 * PR event types for OASIS tracking
 */
export type PREventType =
  | 'PR_CREATED'
  | 'PR_VALIDATED'
  | 'PR_CI_PASSED'
  | 'PR_CI_FAILED'
  | 'PR_READY_TO_MERGE'
  | 'PR_MERGED'
  | 'PR_BLOCKED'
  | 'PR_OVERRIDE_SET'
  | 'PR_OVERRIDE_CLEARED';

/**
 * PR entity model
 */
export interface PREntity {
  id: string;
  tenant_id: string;
  pr_number: number;
  repo: string;
  branch: string;
  base_branch: string;
  module: string;
  title: string;
  author?: string;
  vtid?: string;
  ci_status: PRCIStatus;
  validator_status: PRValidatorStatus;
  merge_eligible: boolean;
  merged: boolean;
  override_flag: boolean;
  oasis_tracking: boolean;
  blocked_reason?: string;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

/**
 * PR event model
 */
export interface PREvent {
  id: string;
  tenant_id: string;
  pr_entity_id: string;
  event_type: PREventType;
  status: 'success' | 'failed' | 'info';
  message?: string;
  actor?: string;
  vtid?: string;
  metadata: Record<string, any>;
  created_at: string;
}

/**
 * PR validation input for validatePR()
 */
export interface PRValidationInput {
  pr_number: number;
  repo?: string;
  branch: string;
  base_branch?: string;
  title: string;
  author?: string;
  files: string[];
  diff?: string;
  metadata?: Record<string, any>;
  vtid?: string;
}

/**
 * Rule violation details
 */
export interface RuleViolation {
  rule_code: string;
  rule_name: string;
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  details?: Record<string, any>;
}

/**
 * PR validation result
 */
export interface PRValidationResult {
  passed: boolean;
  pr_number: number;
  module: string;
  eligible_for_auto_merge: boolean;
  violations: RuleViolation[];
  evaluations: Array<{
    rule_code: string;
    status: 'PASS' | 'FAIL';
    reason?: string;
  }>;
  summary: string;
  vtid?: string;
  validated_at: string;
}

/**
 * Auto-merge eligibility check result
 */
export interface AutoMergeEligibility {
  eligible: boolean;
  pr_number: number;
  module: string;
  ci_status: PRCIStatus;
  validator_status: PRValidatorStatus;
  oasis_tracking: boolean;
  override_flag: boolean;
  blocked_reasons: string[];
  can_merge: boolean;
  recommendation: 'AUTO_MERGE' | 'MANUAL_REVIEW' | 'BLOCKED';
}

/**
 * Auto-merge action result
 */
export interface AutoMergeResult {
  success: boolean;
  pr_number: number;
  merge_method: 'squash' | 'merge' | 'rebase';
  commit_sha?: string;
  message: string;
  vtid?: string;
  merged_at?: string;
  error?: string;
}

/**
 * DTO for API responses
 */
export interface AutoMergeRulesDTO {
  category: string;
  rules: Array<{
    rule_code: string;
    name: string;
    description: string;
    is_active: boolean;
    logic: Record<string, any>;
  }>;
  allowed_modules: string[];
  forbidden_paths: string[];
}
