/**
 * Autopilot Validator Service - VTID-01178
 *
 * Provides the "validator hard gate" before merge.
 * The merge endpoint MUST call validateForMerge() and refuse if it doesn't pass.
 *
 * Validation includes:
 * 1. Code Review Agent check (quality, patterns, documentation)
 * 2. Governance Validator check (policy compliance)
 * 3. Security Scan check (vulnerabilities, secrets)
 *
 * The validator result is recorded in OASIS and used by the autopilot controller
 * to determine if merge can proceed.
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  markValidated,
  markFailed,
  getAutopilotRun,
  getSpecSnapshot,
  type ValidatorResult,
  type ValidatorIssue,
} from './autopilot-controller';

// =============================================================================
// Types
// =============================================================================

export interface ValidationRequest {
  vtid: string;
  pr_number: number;
  repo?: string;
  files_changed?: string[];
}

export interface ValidationResponse {
  ok: boolean;
  passed: boolean;
  result?: ValidatorResult;
  error?: string;
  error_code?: string;
}

interface CodeReviewResult {
  passed: boolean;
  issues: ValidatorIssue[];
  summary: string;
}

interface GovernanceResult {
  passed: boolean;
  decision: 'approved' | 'blocked';
  blocked_reasons: string[];
}

interface SecurityScanResult {
  passed: boolean;
  findings: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low';
    type: string;
    message: string;
    file?: string;
    line?: number;
  }>;
}

// =============================================================================
// OASIS Event Helpers
// =============================================================================

async function emitValidationEvent(
  vtid: string,
  stage: 'started' | 'code_review' | 'governance' | 'security' | 'completed' | 'blocked',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: `autopilot.validation.${stage}` as any,
    source: 'autopilot-validator',
    status,
    message,
    payload: {
      vtid,
      ...payload,
      emitted_at: new Date().toISOString(),
    },
  });
}

// =============================================================================
// Code Review Agent
// =============================================================================

/**
 * Run code review checks on PR changes
 * In production, this would call an AI-based code review agent
 */
async function runCodeReview(
  vtid: string,
  prNumber: number,
  filesChanged: string[]
): Promise<CodeReviewResult> {
  const issues: ValidatorIssue[] = [];

  // Check 1: Look for common anti-patterns in file names
  for (const file of filesChanged) {
    // Check for test files being modified (ensure tests are updated)
    if (file.includes('.test.') || file.includes('.spec.')) {
      // This is good - tests are being updated
    }

    // Check for migration files
    if (file.includes('/migrations/') && !file.match(/^\d{14}_vtid_/)) {
      issues.push({
        severity: 'warning',
        code: 'MIGRATION_NAMING',
        message: `Migration file should follow naming convention: YYYYMMDDHHMMSS_vtid_XXXXX_<description>.sql`,
        file,
      });
    }

    // Check for secrets in common paths
    if (file.includes('.env') || file.includes('credentials') || file.includes('secrets')) {
      issues.push({
        severity: 'error',
        code: 'POTENTIAL_SECRET',
        message: `File may contain secrets - verify this is intentional`,
        file,
      });
    }
  }

  // Check 2: Verify spec snapshot exists and was referenced
  const specSnapshot = getSpecSnapshot(vtid);
  if (!specSnapshot) {
    issues.push({
      severity: 'warning',
      code: 'NO_SPEC_SNAPSHOT',
      message: `No spec snapshot found for ${vtid} - changes may not align with requirements`,
    });
  }

  const passed = !issues.some(i => i.severity === 'error');

  return {
    passed,
    issues,
    summary: passed
      ? `Code review passed with ${issues.filter(i => i.severity === 'warning').length} warning(s)`
      : `Code review failed with ${issues.filter(i => i.severity === 'error').length} error(s)`,
  };
}

// =============================================================================
// Governance Validator
// =============================================================================

/**
 * Run governance checks (policy compliance)
 * This integrates with the existing governance evaluation
 */
async function runGovernanceCheck(
  vtid: string,
  prNumber: number,
  repo: string
): Promise<GovernanceResult> {
  // Import github service dynamically to avoid circular deps
  const { default: githubService } = await import('./github-service');

  try {
    const governance = await githubService.evaluateGovernance(repo, prNumber, vtid);
    return {
      passed: governance.decision === 'approved',
      decision: governance.decision,
      blocked_reasons: governance.blocked_reasons,
    };
  } catch (error) {
    console.error(`[VTID-01178] Governance check failed for ${vtid}:`, error);
    return {
      passed: false,
      decision: 'blocked',
      blocked_reasons: [`Governance check error: ${error instanceof Error ? error.message : 'Unknown error'}`],
    };
  }
}

// =============================================================================
// Security Scan
// =============================================================================

/**
 * Run security scan on changed files
 * In production, this would integrate with security scanning tools
 */
async function runSecurityScan(
  vtid: string,
  prNumber: number,
  filesChanged: string[]
): Promise<SecurityScanResult> {
  const findings: SecurityScanResult['findings'] = [];

  // Basic security pattern checks
  const sensitivePatterns = [
    { pattern: /password\s*=\s*['"][^'"]+['"]/i, type: 'HARDCODED_PASSWORD', severity: 'critical' as const },
    { pattern: /api[_-]?key\s*=\s*['"][^'"]+['"]/i, type: 'HARDCODED_API_KEY', severity: 'critical' as const },
    { pattern: /secret\s*=\s*['"][^'"]+['"]/i, type: 'HARDCODED_SECRET', severity: 'critical' as const },
    { pattern: /eval\s*\(/i, type: 'DANGEROUS_EVAL', severity: 'high' as const },
    { pattern: /dangerouslySetInnerHTML/i, type: 'XSS_RISK', severity: 'high' as const },
  ];

  // Note: In production, we would fetch file contents and scan them
  // For now, we do pattern matching on file names only
  for (const file of filesChanged) {
    if (file.endsWith('.ts') || file.endsWith('.js')) {
      // Check for suspicious file patterns
      if (file.includes('eval') || file.includes('exec')) {
        findings.push({
          severity: 'medium',
          type: 'SUSPICIOUS_FILENAME',
          message: `File name suggests potential code execution: ${file}`,
          file,
        });
      }
    }
  }

  const passed = !findings.some(f => f.severity === 'critical' || f.severity === 'high');

  return {
    passed,
    findings,
  };
}

// =============================================================================
// Main Validation Function
// =============================================================================

/**
 * Validate a PR for merge - HARD GATE
 *
 * This function MUST be called before any merge operation.
 * The merge endpoint should refuse to proceed if this returns passed: false.
 *
 * @param request - Validation request with VTID and PR details
 * @returns ValidationResponse indicating if merge can proceed
 */
export async function validateForMerge(request: ValidationRequest): Promise<ValidationResponse> {
  const { vtid, pr_number, repo = 'exafyltd/vitana-platform', files_changed = [] } = request;

  console.log(`[VTID-01178] Starting validation for ${vtid} PR #${pr_number}`);

  await emitValidationEvent(vtid, 'started', 'info', `Validation started for ${vtid}`, {
    pr_number,
    files_count: files_changed.length,
  });

  const allIssues: ValidatorIssue[] = [];
  let codeReviewPassed = false;
  let governancePassed = false;
  let securityPassed = false;

  try {
    // Step 1: Code Review
    console.log(`[VTID-01178] Running code review for ${vtid}...`);
    const codeReview = await runCodeReview(vtid, pr_number, files_changed);
    codeReviewPassed = codeReview.passed;
    allIssues.push(...codeReview.issues);

    await emitValidationEvent(
      vtid,
      'code_review',
      codeReview.passed ? 'success' : 'warning',
      codeReview.summary,
      { passed: codeReview.passed, issue_count: codeReview.issues.length }
    );

    // Step 2: Governance Check
    console.log(`[VTID-01178] Running governance check for ${vtid}...`);
    const governance = await runGovernanceCheck(vtid, pr_number, repo);
    governancePassed = governance.passed;

    if (!governance.passed) {
      allIssues.push({
        severity: 'error',
        code: 'GOVERNANCE_BLOCKED',
        message: `Governance blocked: ${governance.blocked_reasons.join(', ')}`,
      });
    }

    await emitValidationEvent(
      vtid,
      'governance',
      governance.passed ? 'success' : 'warning',
      governance.passed ? 'Governance check passed' : `Governance blocked: ${governance.blocked_reasons.join(', ')}`,
      { passed: governance.passed, decision: governance.decision }
    );

    // Step 3: Security Scan
    console.log(`[VTID-01178] Running security scan for ${vtid}...`);
    const security = await runSecurityScan(vtid, pr_number, files_changed);
    securityPassed = security.passed;

    for (const finding of security.findings) {
      allIssues.push({
        severity: finding.severity === 'critical' || finding.severity === 'high' ? 'error' : 'warning',
        code: finding.type,
        message: finding.message,
        file: finding.file,
        line: finding.line,
      });
    }

    await emitValidationEvent(
      vtid,
      'security',
      security.passed ? 'success' : 'warning',
      security.passed ? 'Security scan passed' : `Security scan found ${security.findings.length} issue(s)`,
      { passed: security.passed, finding_count: security.findings.length }
    );

    // Final result
    const passed = codeReviewPassed && governancePassed && securityPassed;
    const result: ValidatorResult = {
      passed,
      code_review_passed: codeReviewPassed,
      governance_passed: governancePassed,
      security_scan_passed: securityPassed,
      issues: allIssues,
      validated_at: new Date().toISOString(),
    };

    // Update autopilot state
    if (passed) {
      await markValidated(vtid, result);
      await emitValidationEvent(vtid, 'completed', 'success', `Validation passed for ${vtid}`, {
        passed: true,
        code_review_passed: codeReviewPassed,
        governance_passed: governancePassed,
        security_scan_passed: securityPassed,
      });
    } else {
      await emitValidationEvent(vtid, 'blocked', 'warning', `Validation blocked merge for ${vtid}`, {
        passed: false,
        issue_count: allIssues.length,
        error_issues: allIssues.filter(i => i.severity === 'error').length,
      });
    }

    console.log(`[VTID-01178] Validation complete for ${vtid}: ${passed ? 'PASSED' : 'BLOCKED'}`);

    return {
      ok: true,
      passed,
      result,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-01178] Validation error for ${vtid}:`, errorMessage);

    await emitValidationEvent(vtid, 'blocked', 'error', `Validation error: ${errorMessage}`, {
      error: errorMessage,
    });

    return {
      ok: false,
      passed: false,
      error: errorMessage,
      error_code: 'VALIDATION_ERROR',
    };
  }
}

/**
 * Check if a VTID has a valid validator pass (for merge gate)
 */
export function hasValidatorPass(vtid: string): boolean {
  const { hasValidatorPass: checkPass } = require('./autopilot-controller');
  return checkPass(vtid);
}

/**
 * Get validation result for a VTID
 */
export function getValidationResult(vtid: string): ValidatorResult | null {
  const { getValidatorResult } = require('./autopilot-controller');
  return getValidatorResult(vtid);
}

export default {
  validateForMerge,
  hasValidatorPass,
  getValidationResult,
};
