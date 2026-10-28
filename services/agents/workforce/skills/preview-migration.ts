/**
 * Preview Migration Skill - VTID-01164
 *
 * Dry-run migration sanity checks. Parses SQL for dangerous operations,
 * missing transaction guards, and naming convention violations.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  PreviewMigrationParams,
  PreviewMigrationResult,
  MigrationWarning,
  MigrationBlocker,
  MigrationOperation,
  SkillContext,
} from './types';

// =============================================================================
// Constants
// =============================================================================

/**
 * Migration naming convention pattern
 * Format: YYYYMMDDHHMMSS_vtid_XXXXX_description.sql
 */
const NAMING_PATTERN = /^\d{14}_vtid_\d{5}_[a-z0-9_]+\.sql$/i;

/**
 * Alternative naming pattern (without vtid)
 * Format: YYYYMMDDHHMMSS_description.sql
 */
const ALT_NAMING_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/i;

/**
 * Dangerous operations that require explicit approval
 */
const DANGEROUS_OPERATIONS = [
  'DROP TABLE',
  'DROP COLUMN',
  'TRUNCATE',
  'DROP DATABASE',
  'DROP SCHEMA',
  'DROP FUNCTION',
];

/**
 * SQL operation patterns
 */
const OPERATION_PATTERNS: Array<{
  type: MigrationOperation['type'];
  pattern: RegExp;
  destructive: boolean;
}> = [
  { type: 'CREATE_TABLE', pattern: /CREATE\s+TABLE/gi, destructive: false },
  { type: 'ALTER_TABLE', pattern: /ALTER\s+TABLE/gi, destructive: false },
  { type: 'DROP_TABLE', pattern: /DROP\s+TABLE/gi, destructive: true },
  { type: 'CREATE_INDEX', pattern: /CREATE\s+(?:UNIQUE\s+)?INDEX/gi, destructive: false },
  { type: 'DROP_INDEX', pattern: /DROP\s+INDEX/gi, destructive: true },
  { type: 'CREATE_FUNCTION', pattern: /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/gi, destructive: false },
  { type: 'DROP_FUNCTION', pattern: /DROP\s+FUNCTION/gi, destructive: true },
  { type: 'CREATE_POLICY', pattern: /CREATE\s+POLICY/gi, destructive: false },
  { type: 'INSERT', pattern: /INSERT\s+INTO/gi, destructive: false },
  { type: 'UPDATE', pattern: /UPDATE\s+\w+\s+SET/gi, destructive: false },
  { type: 'DELETE', pattern: /DELETE\s+FROM/gi, destructive: true },
];

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
    console.error(`[PreviewMigration] Error reading file ${filePath}:`, error);
    return null;
  }
}

/**
 * Check migration file naming convention
 */
function checkNaming(filePath: string): {
  valid: boolean;
  expected_pattern: string;
  actual_filename: string;
  issues: string[];
} {
  const filename = path.basename(filePath);
  const issues: string[] = [];

  const matchesVtid = NAMING_PATTERN.test(filename);
  const matchesAlt = ALT_NAMING_PATTERN.test(filename);

  if (!matchesVtid && !matchesAlt) {
    issues.push(`Filename does not match expected pattern`);
  }

  if (matchesAlt && !matchesVtid) {
    issues.push(`Missing VTID in filename - recommended format: YYYYMMDDHHMMSS_vtid_XXXXX_description.sql`);
  }

  // Check for invalid characters
  if (/[A-Z]/.test(filename.replace(/\.sql$/i, ''))) {
    issues.push('Filename contains uppercase letters - use lowercase with underscores');
  }

  return {
    valid: matchesVtid || matchesAlt,
    expected_pattern: 'YYYYMMDDHHMMSS_vtid_XXXXX_description.sql',
    actual_filename: filename,
    issues,
  };
}

/**
 * Check for transaction guards
 */
function checkTransactions(content: string): {
  has_begin: boolean;
  has_commit: boolean;
  has_rollback_handler: boolean;
  recommendation: string;
} {
  const normalizedContent = content.toLowerCase();

  const hasBegin = /begin\s*;|begin\s+transaction/i.test(normalizedContent);
  const hasCommit = /commit\s*;|commit\s+transaction/i.test(normalizedContent);
  const hasRollback = /rollback|exception\s+when/i.test(normalizedContent);

  let recommendation = '';

  if (!hasBegin && !hasCommit) {
    // Check if there are DDL statements that need transactions
    const hasDdl = /alter\s+table|drop|create\s+table/i.test(normalizedContent);
    if (hasDdl) {
      recommendation = 'Consider wrapping DDL statements in a transaction for atomic execution';
    } else {
      recommendation = 'Transaction guards optional for this migration';
    }
  } else if (hasBegin && !hasCommit) {
    recommendation = 'Missing COMMIT statement - migration may not apply';
  } else if (!hasBegin && hasCommit) {
    recommendation = 'COMMIT without BEGIN - check migration structure';
  } else {
    recommendation = 'Transaction guards present';
  }

  return {
    has_begin: hasBegin,
    has_commit: hasCommit,
    has_rollback_handler: hasRollback,
    recommendation,
  };
}

/**
 * Detect SQL operations in content
 */
function detectOperations(content: string): MigrationOperation[] {
  const operations: MigrationOperation[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const op of OPERATION_PATTERNS) {
      // Reset lastIndex for global regex
      op.pattern.lastIndex = 0;

      if (op.pattern.test(line)) {
        // Extract target (table/index/function name)
        let target = 'unknown';
        const targetMatch = line.match(/(?:TABLE|INDEX|FUNCTION|INTO|FROM|POLICY\s+\w+\s+ON)\s+["']?(\w+)["']?/i);
        if (targetMatch) {
          target = targetMatch[1];
        }

        operations.push({
          type: op.type,
          target,
          line_number: i + 1,
          is_destructive: op.destructive,
        });
      }
    }
  }

  return operations;
}

/**
 * Check for dangerous operations
 */
function checkDangerousOperations(
  content: string,
  operations: MigrationOperation[]
): { warnings: MigrationWarning[]; blockers: MigrationBlocker[] } {
  const warnings: MigrationWarning[] = [];
  const blockers: MigrationBlocker[] = [];
  const lines = content.split('\n');

  // Check for dangerous operations
  for (const dangerousOp of DANGEROUS_OPERATIONS) {
    const pattern = new RegExp(dangerousOp.replace(' ', '\\s+'), 'gi');

    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        // Check if there's a comment explaining the operation
        const hasComment = lines[i].includes('--') ||
          (i > 0 && lines[i - 1].trim().startsWith('--'));

        if (dangerousOp === 'DROP TABLE' || dangerousOp === 'DROP DATABASE') {
          blockers.push({
            severity: 'critical',
            category: 'destructive_operation',
            message: `${dangerousOp} detected - requires explicit approval`,
            line_number: i + 1,
            recommendation: 'Add a comment explaining why this is necessary and get approval',
          });
        } else if (dangerousOp === 'DROP COLUMN') {
          if (!hasComment) {
            blockers.push({
              severity: 'error',
              category: 'destructive_operation',
              message: `DROP COLUMN without explanatory comment`,
              line_number: i + 1,
              recommendation: 'Add a comment explaining the column removal and verify no code dependencies',
            });
          } else {
            warnings.push({
              severity: 'warning',
              category: 'destructive_operation',
              message: `DROP COLUMN detected - verify no code dependencies`,
              line_number: i + 1,
            });
          }
        } else {
          warnings.push({
            severity: 'warning',
            category: 'destructive_operation',
            message: `${dangerousOp} detected - review carefully`,
            line_number: i + 1,
          });
        }
      }
    }
  }

  // Check for missing IF EXISTS on DROP
  for (const op of operations) {
    if (op.type.startsWith('DROP_')) {
      const line = lines[op.line_number - 1];
      if (!line.toLowerCase().includes('if exists')) {
        warnings.push({
          severity: 'warning',
          category: 'missing_guard',
          message: `${op.type} without IF EXISTS - may fail if object doesn't exist`,
          line_number: op.line_number,
        });
      }
    }
  }

  // Check for missing IF NOT EXISTS on CREATE
  for (const op of operations) {
    if (op.type === 'CREATE_TABLE' || op.type === 'CREATE_INDEX') {
      const line = lines[op.line_number - 1];
      if (!line.toLowerCase().includes('if not exists')) {
        warnings.push({
          severity: 'info',
          category: 'idempotency',
          message: `${op.type} without IF NOT EXISTS - may fail on re-run`,
          line_number: op.line_number,
        });
      }
    }
  }

  return { warnings, blockers };
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Main skill handler
 */
export async function previewMigration(
  params: PreviewMigrationParams,
  context: SkillContext
): Promise<PreviewMigrationResult> {
  const {
    vtid,
    migration_content,
    file_path,
    check_naming = true,
    check_reversibility = true,
    check_transactions = true,
  } = params;

  // Emit start event
  await context.emitEvent('start', 'info', 'Migration preview started', {
    has_content: !!migration_content,
    file_path: file_path || 'inline',
    checks: { naming: check_naming, reversibility: check_reversibility, transactions: check_transactions },
  });

  try {
    let content = migration_content || '';
    let actualFilePath = file_path || 'inline-content.sql';

    // Read file if path provided
    if (file_path && !migration_content) {
      const fileContent = readFileContent(file_path);
      if (!fileContent) {
        return {
          ok: false,
          error: `Could not read migration file: ${file_path}`,
          safe_to_apply: false,
          warnings: [],
          blockers: [{
            severity: 'critical',
            category: 'file_error',
            message: 'Migration file not found or not readable',
            recommendation: 'Verify the file path is correct',
          }],
          operations_detected: [],
          naming_check: {
            valid: false,
            expected_pattern: 'YYYYMMDDHHMMSS_vtid_XXXXX_description.sql',
            actual_filename: path.basename(file_path),
            issues: ['File not found'],
          },
          transaction_check: {
            has_begin: false,
            has_commit: false,
            has_rollback_handler: false,
            recommendation: 'Cannot check - file not readable',
          },
          summary: {
            total_operations: 0,
            destructive_operations: 0,
            warnings_count: 0,
            blockers_count: 1,
          },
        };
      }
      content = fileContent;
    }

    if (!content.trim()) {
      return {
        ok: false,
        error: 'No migration content provided',
        safe_to_apply: false,
        warnings: [],
        blockers: [],
        operations_detected: [],
        naming_check: {
          valid: false,
          expected_pattern: 'YYYYMMDDHHMMSS_vtid_XXXXX_description.sql',
          actual_filename: '',
          issues: ['No content'],
        },
        transaction_check: {
          has_begin: false,
          has_commit: false,
          has_rollback_handler: false,
          recommendation: 'No content to check',
        },
        summary: {
          total_operations: 0,
          destructive_operations: 0,
          warnings_count: 0,
          blockers_count: 0,
        },
      };
    }

    // Run checks
    const namingCheck = check_naming && file_path
      ? checkNaming(actualFilePath)
      : { valid: true, expected_pattern: '', actual_filename: '', issues: [] };

    const transactionCheck = check_transactions
      ? checkTransactions(content)
      : { has_begin: false, has_commit: false, has_rollback_handler: false, recommendation: 'Not checked' };

    const operations = detectOperations(content);
    const { warnings, blockers } = checkDangerousOperations(content, operations);

    // Add naming issues as warnings
    if (check_naming && !namingCheck.valid && namingCheck.issues.length > 0) {
      for (const issue of namingCheck.issues) {
        warnings.push({
          severity: 'warning',
          category: 'naming',
          message: issue,
        });
      }
    }

    // Calculate summary
    const destructiveOps = operations.filter(o => o.is_destructive).length;
    const safeToApply = blockers.length === 0;

    const result: PreviewMigrationResult = {
      ok: true,
      safe_to_apply: safeToApply,
      warnings,
      blockers,
      operations_detected: operations,
      naming_check: namingCheck,
      transaction_check: transactionCheck,
      summary: {
        total_operations: operations.length,
        destructive_operations: destructiveOps,
        warnings_count: warnings.length,
        blockers_count: blockers.length,
      },
    };

    // Emit success or warning
    await context.emitEvent(
      'success',
      safeToApply ? 'success' : 'warning',
      `Migration preview completed: ${safeToApply ? 'safe' : 'blockers found'}`,
      {
        safe_to_apply: safeToApply,
        operations: operations.length,
        destructive_operations: destructiveOps,
        warnings: warnings.length,
        blockers: blockers.length,
      }
    );

    // Emit blocker events
    for (const blocker of blockers) {
      await context.emitEvent('blocker_found', 'warning', blocker.message, {
        category: blocker.category,
        severity: blocker.severity,
        line_number: blocker.line_number,
      });
    }

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    // Emit failed event
    await context.emitEvent('failed', 'error', `Migration preview failed: ${errorMsg}`, {
      error: errorMsg,
    });

    return {
      ok: false,
      error: errorMsg,
      safe_to_apply: false,
      warnings: [],
      blockers: [],
      operations_detected: [],
      naming_check: {
        valid: false,
        expected_pattern: '',
        actual_filename: '',
        issues: [errorMsg],
      },
      transaction_check: {
        has_begin: false,
        has_commit: false,
        has_rollback_handler: false,
        recommendation: 'Error during check',
      },
      summary: {
        total_operations: 0,
        destructive_operations: 0,
        warnings_count: 0,
        blockers_count: 0,
      },
    };
  }
}
