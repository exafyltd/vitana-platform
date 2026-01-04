/**
 * Validate RLS Policy Skill - VTID-01164
 *
 * Validates that RLS (Row Level Security) policies correctly reference
 * tenant isolation helpers to prevent cross-tenant data leaks.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ValidateRlsPolicyParams,
  ValidateRlsPolicyResult,
  PolicyCheck,
  RlsViolation,
  SkillContext,
} from './types';

// =============================================================================
// Constants
// =============================================================================

/**
 * Known tenant isolation patterns
 */
const TENANT_HELPERS = [
  'current_tenant_id()',
  'auth.uid()',
  'get_tenant_from_jwt()',
  'auth.jwt()',
  '(auth.jwt() ->>',
  'tenant_id =',
  'user_id =',
  'current_user_id()',
];

/**
 * Tables exempt from tenant validation (system tables)
 */
const EXEMPT_TABLES = [
  'schema_migrations',
  'vtidledger',
  'vtid_ledger',
  'oasis_events',
  'service_versions',
  'governance_rules',
];

/**
 * RLS policy pattern regex
 */
const POLICY_PATTERN = /CREATE\s+POLICY\s+["']?(\w+)["']?\s+ON\s+["']?(\w+)["']?\s+(?:AS\s+\w+\s+)?(?:FOR\s+(\w+)\s+)?(?:TO\s+\w+\s+)?(?:USING|WITH\s+CHECK)\s*\(([\s\S]*?)\)(?:\s+WITH\s+CHECK\s*\(([\s\S]*?)\))?/gi;

/**
 * Alter policy pattern regex
 */
const ALTER_POLICY_PATTERN = /ALTER\s+POLICY\s+["']?(\w+)["']?\s+ON\s+["']?(\w+)["']?/gi;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Read file content safely
 */
function readFileContent(filePath: string): string | null {
  try {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);

    if (!fs.existsSync(absolutePath)) {
      return null;
    }

    return fs.readFileSync(absolutePath, 'utf-8');
  } catch (error) {
    console.error(`[ValidateRlsPolicy] Error reading file ${filePath}:`, error);
    return null;
  }
}

/**
 * Check if a table is exempt from tenant validation
 */
function isExemptTable(tableName: string): boolean {
  const normalized = tableName.toLowerCase().replace(/["`]/g, '');
  return EXEMPT_TABLES.some(exempt =>
    normalized === exempt.toLowerCase() ||
    normalized.includes(exempt.toLowerCase())
  );
}

/**
 * Check if policy expression uses tenant isolation
 */
function hasTenantIsolation(expression: string): { has: boolean; helpers: string[] } {
  const normalizedExpr = expression.toLowerCase();
  const foundHelpers: string[] = [];

  for (const helper of TENANT_HELPERS) {
    if (normalizedExpr.includes(helper.toLowerCase())) {
      foundHelpers.push(helper);
    }
  }

  return {
    has: foundHelpers.length > 0,
    helpers: foundHelpers,
  };
}

/**
 * Parse CREATE POLICY statements from SQL content
 */
function parsePolicies(content: string): Array<{
  name: string;
  table: string;
  type: string;
  usingExpr: string;
  withCheckExpr?: string;
}> {
  const policies: Array<{
    name: string;
    table: string;
    type: string;
    usingExpr: string;
    withCheckExpr?: string;
  }> = [];

  // Reset regex lastIndex
  POLICY_PATTERN.lastIndex = 0;

  let match;
  while ((match = POLICY_PATTERN.exec(content)) !== null) {
    policies.push({
      name: match[1],
      table: match[2],
      type: match[3] || 'ALL',
      usingExpr: match[4] || '',
      withCheckExpr: match[5],
    });
  }

  return policies;
}

/**
 * Validate a single policy
 */
function validatePolicy(
  policy: { name: string; table: string; type: string; usingExpr: string; withCheckExpr?: string },
  strictMode: boolean
): { check: PolicyCheck; violations: RlsViolation[] } {
  const violations: RlsViolation[] = [];
  const issues: string[] = [];

  // Skip exempt tables
  if (isExemptTable(policy.table)) {
    return {
      check: {
        table: policy.table,
        policy_name: policy.name,
        policy_type: policy.type as PolicyCheck['policy_type'],
        valid: true,
        issues: ['Exempt table - no tenant check required'],
      },
      violations: [],
    };
  }

  // Check USING expression
  const usingCheck = hasTenantIsolation(policy.usingExpr);

  // Check WITH CHECK expression if present
  const withCheckResult = policy.withCheckExpr
    ? hasTenantIsolation(policy.withCheckExpr)
    : { has: true, helpers: [] }; // No WITH CHECK is OK for SELECT

  const hasIsolation = usingCheck.has;
  const allHelpers = [...new Set([...usingCheck.helpers, ...withCheckResult.helpers])];

  if (!hasIsolation) {
    issues.push('No tenant isolation helper found in USING expression');
    violations.push({
      severity: 'critical',
      table: policy.table,
      policy: policy.name,
      issue: 'Policy lacks tenant isolation in USING clause',
      recommendation: 'Add tenant_id check using current_tenant_id() or auth.uid()',
    });
  }

  // For INSERT/UPDATE, check WITH CHECK too
  if (['INSERT', 'UPDATE', 'ALL'].includes(policy.type.toUpperCase())) {
    if (policy.withCheckExpr && !withCheckResult.has) {
      issues.push('No tenant isolation helper found in WITH CHECK expression');
      violations.push({
        severity: 'warning',
        table: policy.table,
        policy: policy.name,
        issue: 'Policy lacks tenant isolation in WITH CHECK clause',
        recommendation: 'Add tenant_id check to WITH CHECK clause for data writes',
      });
    }
  }

  // Strict mode checks
  if (strictMode && hasIsolation) {
    // Check for explicit tenant_id (not just auth.uid())
    const hasExplicitTenant = usingCheck.helpers.some(h =>
      h.toLowerCase().includes('tenant')
    );

    if (!hasExplicitTenant) {
      issues.push('No explicit tenant_id check (using auth.uid() only)');
      // This is a warning, not a violation in strict mode
    }
  }

  return {
    check: {
      table: policy.table,
      policy_name: policy.name,
      policy_type: policy.type as PolicyCheck['policy_type'],
      valid: violations.length === 0,
      issues,
    },
    violations,
  };
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Main skill handler
 */
export async function validateRlsPolicy(
  params: ValidateRlsPolicyParams,
  context: SkillContext
): Promise<ValidateRlsPolicyResult> {
  const { vtid, policy_content, file_paths, table_name, strict_mode } = params;

  // Emit start event
  await context.emitEvent('start', 'info', 'RLS policy validation started', {
    has_content: !!policy_content,
    files_count: file_paths?.length || 0,
    table_filter: table_name || 'all',
    strict_mode: strict_mode ?? true,
  });

  try {
    let contentToValidate = '';

    // Gather content from policy_content or files
    if (policy_content) {
      contentToValidate = policy_content;
    }

    if (file_paths && file_paths.length > 0) {
      for (const filePath of file_paths) {
        const content = readFileContent(filePath);
        if (content) {
          contentToValidate += '\n' + content;
        }
      }
    }

    if (!contentToValidate.trim()) {
      return {
        ok: false,
        error: 'No policy content provided - specify policy_content or file_paths',
        valid: false,
        policies_checked: [],
        violations: [],
        tenant_helpers_used: [],
        summary: {
          total_policies: 0,
          valid_policies: 0,
          violations_count: 0,
          tables_affected: [],
        },
      };
    }

    // Parse policies from content
    const policies = parsePolicies(contentToValidate);

    // Filter by table if specified
    const policiesToCheck = table_name
      ? policies.filter(p => p.table.toLowerCase() === table_name.toLowerCase())
      : policies;

    if (policiesToCheck.length === 0) {
      return {
        ok: true,
        valid: true,
        policies_checked: [],
        violations: [],
        tenant_helpers_used: [],
        summary: {
          total_policies: 0,
          valid_policies: 0,
          violations_count: 0,
          tables_affected: [],
        },
      };
    }

    // Validate each policy
    const allChecks: PolicyCheck[] = [];
    const allViolations: RlsViolation[] = [];
    const allHelpers: Set<string> = new Set();
    const tablesAffected: Set<string> = new Set();

    for (const policy of policiesToCheck) {
      const { check, violations } = validatePolicy(policy, strict_mode ?? true);
      allChecks.push(check);
      allViolations.push(...violations);

      // Track tables and helpers
      tablesAffected.add(policy.table);
      const usingCheck = hasTenantIsolation(policy.usingExpr);
      usingCheck.helpers.forEach(h => allHelpers.add(h));
    }

    const validPolicies = allChecks.filter(c => c.valid).length;
    const isValid = allViolations.filter(v => v.severity === 'critical').length === 0;

    const result: ValidateRlsPolicyResult = {
      ok: true,
      valid: isValid,
      policies_checked: allChecks,
      violations: allViolations,
      tenant_helpers_used: [...allHelpers],
      summary: {
        total_policies: allChecks.length,
        valid_policies: validPolicies,
        violations_count: allViolations.length,
        tables_affected: [...tablesAffected],
      },
    };

    // Emit success or warning based on result
    await context.emitEvent(
      'success',
      isValid ? 'success' : 'warning',
      `RLS validation completed: ${validPolicies}/${allChecks.length} valid`,
      {
        valid: isValid,
        policies_checked: allChecks.length,
        violations_count: allViolations.length,
        tables_affected: [...tablesAffected],
      }
    );

    // Emit violation events for critical issues
    for (const violation of allViolations) {
      if (violation.severity === 'critical') {
        await context.emitEvent('violation', 'warning', violation.issue, {
          table: violation.table,
          policy: violation.policy,
          severity: violation.severity,
          recommendation: violation.recommendation,
        });
      }
    }

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    // Emit failed event
    await context.emitEvent('failed', 'error', `RLS validation failed: ${errorMsg}`, {
      error: errorMsg,
    });

    return {
      ok: false,
      error: errorMsg,
      valid: false,
      policies_checked: [],
      violations: [],
      tenant_helpers_used: [],
      summary: {
        total_policies: 0,
        valid_policies: 0,
        violations_count: 0,
        tables_affected: [],
      },
    };
  }
}
