// DEV-CICDL-0207 – PR Validator for Autonomous Safe Merge Layer
import {
  PRValidationInput,
  PRValidationResult,
  RuleViolation,
  AUTO_MERGE_ALLOWED_MODULES,
  AUTO_MERGE_FORBIDDEN_PATHS,
  AUTO_MERGE_FORBIDDEN_PATTERNS,
  AutoMergeAllowedModule,
} from '../types/auto-merge';

/**
 * Extracts module from file paths
 * Supports multiple detection strategies
 */
function detectModule(files: string[]): string {
  // Priority 1: Check for explicit module paths
  const modulePatterns: Record<string, RegExp[]> = {
    'CICDL': [/^\.github\/workflows\//, /^\.github\/actions\//],
    'GATEWAY': [/^services\/gateway\//, /^packages\/openapi\//],
    'OASIS': [/^services\/oasis-/, /oasis/i],
    'VTID_GOVERNANCE': [/^supabase\/migrations\/.*governance/, /governance/i],
  };

  const moduleCounts: Record<string, number> = {};

  for (const file of files) {
    for (const [module, patterns] of Object.entries(modulePatterns)) {
      if (patterns.some(p => p.test(file))) {
        moduleCounts[module] = (moduleCounts[module] || 0) + 1;
      }
    }
  }

  // Return module with highest count, or 'UNKNOWN' if none matched
  const sorted = Object.entries(moduleCounts).sort((a, b) => b[1] - a[1]);
  return sorted.length > 0 ? sorted[0][0] : 'UNKNOWN';
}

/**
 * Checks if module is allowed for auto-merge
 */
function isModuleAllowed(module: string): boolean {
  return AUTO_MERGE_ALLOWED_MODULES.includes(module as AutoMergeAllowedModule);
}

/**
 * Checks if any files touch forbidden paths
 */
function checkForbiddenPaths(files: string[]): string[] {
  const violations: string[] = [];

  for (const file of files) {
    for (const forbidden of AUTO_MERGE_FORBIDDEN_PATHS) {
      if (file.startsWith(forbidden) || file === forbidden) {
        violations.push(`File touches forbidden path: ${file}`);
      }
    }
  }

  return violations;
}

/**
 * Checks diff content for forbidden patterns
 */
function checkForbiddenPatterns(diff: string | undefined): string[] {
  if (!diff) return [];

  const violations: string[] = [];

  for (const pattern of AUTO_MERGE_FORBIDDEN_PATTERNS) {
    if (pattern.test(diff)) {
      violations.push(`Diff contains forbidden pattern: ${pattern.source}`);
    }
  }

  return violations;
}

/**
 * Checks for CSP violations in changed files
 */
function checkCSPViolations(files: string[], diff: string | undefined): string[] {
  const violations: string[] = [];

  // Check if CSP-related files are modified
  const cspRelatedFiles = files.filter(f =>
    f.includes('csp') ||
    f.includes('security') ||
    f.includes('helmet') ||
    f.endsWith('.html')
  );

  if (cspRelatedFiles.length > 0 && diff) {
    // Check for unsafe CSP directives
    if (/unsafe-inline|unsafe-eval/i.test(diff)) {
      violations.push('CSP violation: Found unsafe-inline or unsafe-eval directives');
    }
  }

  return violations;
}

/**
 * Checks for navigation/routing changes that need review
 */
function checkNavigationChanges(files: string[], diff: string | undefined): string[] {
  const violations: string[] = [];

  const navFiles = files.filter(f =>
    f.includes('router') ||
    f.includes('routes') ||
    f.includes('navigation') ||
    f.includes('nav-spec')
  );

  if (navFiles.length > 0) {
    // Navigation changes require extra scrutiny
    violations.push(`Navigation/routing files modified: ${navFiles.join(', ')} - requires validation`);
  }

  return violations;
}

/**
 * Checks for master governance file changes
 */
function checkGovernanceFileChanges(files: string[]): string[] {
  const violations: string[] = [];

  const masterGovernanceFiles = [
    'supabase/migrations/20251120000000_init_governance.sql',
    'services/gateway/src/validator-core/',
    'services/gateway/src/types/governance.ts',
  ];

  for (const file of files) {
    for (const master of masterGovernanceFiles) {
      if (file.startsWith(master)) {
        violations.push(`Master governance file modified: ${file} - requires explicit approval`);
      }
    }
  }

  return violations;
}

/**
 * Main PR validation function
 * Validates files, module, diff, and metadata for auto-merge eligibility
 */
export function validatePR(input: PRValidationInput): PRValidationResult {
  const violations: RuleViolation[] = [];
  const evaluations: PRValidationResult['evaluations'] = [];

  const { files, diff, metadata, pr_number, title, vtid } = input;

  // Detect module from files
  const module = detectModule(files);

  // Rule 1: AUTO-MERGE-001 - Module must be allowed
  const moduleAllowed = isModuleAllowed(module);
  evaluations.push({
    rule_code: 'AUTO-MERGE-001',
    status: moduleAllowed ? 'PASS' : 'FAIL',
    reason: moduleAllowed ? `Module ${module} is allowed` : `Module ${module} is not in allowed list`,
  });

  if (!moduleAllowed) {
    violations.push({
      rule_code: 'AUTO-MERGE-001',
      rule_name: 'Allowed Modules List',
      reason: `Module ${module} is not allowed for auto-merge. Allowed: ${AUTO_MERGE_ALLOWED_MODULES.join(', ')}`,
      severity: 'high',
      details: { module, allowed_modules: AUTO_MERGE_ALLOWED_MODULES },
    });
  }

  // Rule 2: Check forbidden paths
  const forbiddenPathViolations = checkForbiddenPaths(files);
  const noForbiddenPaths = forbiddenPathViolations.length === 0;
  evaluations.push({
    rule_code: 'FORBIDDEN-PATHS',
    status: noForbiddenPaths ? 'PASS' : 'FAIL',
    reason: noForbiddenPaths ? 'No forbidden paths touched' : forbiddenPathViolations.join('; '),
  });

  if (!noForbiddenPaths) {
    for (const v of forbiddenPathViolations) {
      violations.push({
        rule_code: 'FORBIDDEN-PATHS',
        rule_name: 'Forbidden Paths Check',
        reason: v,
        severity: 'critical',
      });
    }
  }

  // Rule 3: Check forbidden patterns in diff
  const forbiddenPatternViolations = checkForbiddenPatterns(diff);
  const noForbiddenPatterns = forbiddenPatternViolations.length === 0;
  evaluations.push({
    rule_code: 'FORBIDDEN-PATTERNS',
    status: noForbiddenPatterns ? 'PASS' : 'FAIL',
    reason: noForbiddenPatterns ? 'No forbidden patterns in diff' : forbiddenPatternViolations.join('; '),
  });

  if (!noForbiddenPatterns) {
    for (const v of forbiddenPatternViolations) {
      violations.push({
        rule_code: 'FORBIDDEN-PATTERNS',
        rule_name: 'Forbidden Patterns Check',
        reason: v,
        severity: 'critical',
      });
    }
  }

  // Rule 4: Check CSP violations
  const cspViolations = checkCSPViolations(files, diff);
  const noCSPViolations = cspViolations.length === 0;
  evaluations.push({
    rule_code: 'CSP-CHECK',
    status: noCSPViolations ? 'PASS' : 'FAIL',
    reason: noCSPViolations ? 'No CSP violations detected' : cspViolations.join('; '),
  });

  if (!noCSPViolations) {
    for (const v of cspViolations) {
      violations.push({
        rule_code: 'CSP-CHECK',
        rule_name: 'CSP Compliance Check',
        reason: v,
        severity: 'high',
      });
    }
  }

  // Rule 5: Check navigation changes (warning only for now)
  const navChanges = checkNavigationChanges(files, diff);
  const noNavChanges = navChanges.length === 0;
  evaluations.push({
    rule_code: 'NAV-CHECK',
    status: noNavChanges ? 'PASS' : 'FAIL',
    reason: noNavChanges ? 'No navigation changes' : navChanges.join('; '),
  });

  // Navigation changes are warnings, not blockers
  if (!noNavChanges) {
    for (const v of navChanges) {
      violations.push({
        rule_code: 'NAV-CHECK',
        rule_name: 'Navigation Changes Check',
        reason: v,
        severity: 'medium',
      });
    }
  }

  // Rule 6: Check master governance files
  const govFileChanges = checkGovernanceFileChanges(files);
  const noGovFileChanges = govFileChanges.length === 0;
  evaluations.push({
    rule_code: 'GOV-FILES-CHECK',
    status: noGovFileChanges ? 'PASS' : 'FAIL',
    reason: noGovFileChanges ? 'No master governance files modified' : govFileChanges.join('; '),
  });

  if (!noGovFileChanges) {
    for (const v of govFileChanges) {
      violations.push({
        rule_code: 'GOV-FILES-CHECK',
        rule_name: 'Governance Files Protection',
        reason: v,
        severity: 'critical',
      });
    }
  }

  // Rule 7: Check override flag
  const hasOverride = metadata?.override === true;
  evaluations.push({
    rule_code: 'AUTO-MERGE-005',
    status: hasOverride ? 'FAIL' : 'PASS',
    reason: hasOverride ? 'Human override flag is set' : 'No override flag',
  });

  if (hasOverride) {
    violations.push({
      rule_code: 'AUTO-MERGE-005',
      rule_name: 'Human Override Option',
      reason: 'Human override flag is set - auto-merge disabled',
      severity: 'low',
    });
  }

  // Determine if PR passed validation
  const criticalViolations = violations.filter(v => v.severity === 'critical' || v.severity === 'high');
  const passed = criticalViolations.length === 0;
  const eligibleForAutoMerge = passed && moduleAllowed && !hasOverride;

  // Generate summary
  const summary = passed
    ? `PR #${pr_number} passed validation. Module: ${module}. ${violations.length} warnings.`
    : `PR #${pr_number} failed validation. ${criticalViolations.length} critical/high violations found.`;

  return {
    passed,
    pr_number,
    module,
    eligible_for_auto_merge: eligibleForAutoMerge,
    violations,
    evaluations,
    summary,
    vtid,
    validated_at: new Date().toISOString(),
  };
}

/**
 * Quick check if a PR is potentially auto-merge eligible
 * Used for fast filtering before full validation
 */
export function quickEligibilityCheck(files: string[]): { eligible: boolean; reason: string } {
  const module = detectModule(files);

  if (!isModuleAllowed(module)) {
    return { eligible: false, reason: `Module ${module} not allowed for auto-merge` };
  }

  const forbiddenPaths = checkForbiddenPaths(files);
  if (forbiddenPaths.length > 0) {
    return { eligible: false, reason: forbiddenPaths[0] };
  }

  const govChanges = checkGovernanceFileChanges(files);
  if (govChanges.length > 0) {
    return { eligible: false, reason: govChanges[0] };
  }

  return { eligible: true, reason: `Module ${module} is eligible for auto-merge` };
}

export { detectModule, isModuleAllowed };
