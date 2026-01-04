/**
 * Security Scan Skill - VTID-01164
 *
 * Static security scan of diff or specified file paths for known risky patterns.
 * Detects OWASP top 10 vulnerabilities and common security issues.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  SecurityScanParams,
  SecurityScanResult,
  SecurityFinding,
  SkillContext,
} from './types';

// =============================================================================
// Security Patterns
// =============================================================================

interface SecurityPattern {
  id: string;
  category: string;
  severity: SecurityFinding['severity'];
  pattern: RegExp;
  description: string;
  recommendation: string;
}

const SECURITY_PATTERNS: SecurityPattern[] = [
  // Injection patterns
  {
    id: 'SQL_INJECTION_CONCAT',
    category: 'injection',
    severity: 'critical',
    pattern: /(\$\{.*\}|`.*\+.*`|['"].*\+.*['"])\s*(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)/i,
    description: 'Potential SQL injection via string concatenation',
    recommendation: 'Use parameterized queries or prepared statements',
  },
  {
    id: 'SQL_INJECTION_TEMPLATE',
    category: 'injection',
    severity: 'critical',
    pattern: /`SELECT.*\$\{|`INSERT.*\$\{|`UPDATE.*\$\{|`DELETE.*\$\{/i,
    description: 'SQL query using template literals with variables',
    recommendation: 'Use parameterized queries instead of template literals for SQL',
  },
  {
    id: 'COMMAND_INJECTION',
    category: 'injection',
    severity: 'critical',
    pattern: /exec\s*\(\s*['"`].*\$\{|exec\s*\(\s*.*\+|spawn\s*\(\s*['"`].*\$\{/,
    description: 'Potential command injection in exec/spawn call',
    recommendation: 'Sanitize inputs and avoid using user input in shell commands',
  },

  // Auth bypass patterns
  {
    id: 'AUTH_BYPASS_TODO',
    category: 'auth_bypass',
    severity: 'high',
    pattern: /\/\/\s*TODO:?\s*(?:add\s+)?auth|\/\/\s*FIXME:?\s*(?:add\s+)?auth|\/\*\s*TODO:?\s*auth/i,
    description: 'TODO comment suggests missing authentication',
    recommendation: 'Implement proper authentication before deploying',
  },
  {
    id: 'AUTH_SKIP_DEV',
    category: 'auth_bypass',
    severity: 'high',
    pattern: /if\s*\(\s*(?:process\.env\.NODE_ENV|NODE_ENV)\s*(?:===?|!==?)\s*['"`](?:development|dev|test)['"`]\s*\)\s*(?:return|next\(\)|{)/,
    description: 'Authentication may be bypassed in development mode',
    recommendation: 'Ensure auth checks apply in all environments or use proper mocking',
  },
  {
    id: 'NO_AUTH_MIDDLEWARE',
    category: 'auth_bypass',
    severity: 'medium',
    pattern: /router\.(get|post|put|patch|delete)\s*\(\s*['"`][^'"`]+['"`]\s*,\s*async?\s*\(\s*req\s*,\s*res/,
    description: 'Route handler without apparent middleware chain',
    recommendation: 'Ensure authentication middleware is applied to protected routes',
  },

  // Input validation patterns
  {
    id: 'NO_BODY_VALIDATION',
    category: 'input_validation',
    severity: 'medium',
    pattern: /req\.body\.[a-zA-Z_]+(?!\s*\?\s*:|\s*\|\||\s*\?\?|\s*&&)/,
    description: 'Direct access to req.body without validation',
    recommendation: 'Use Zod, Joi, or similar library to validate request body',
  },
  {
    id: 'UNSAFE_PARAMS',
    category: 'input_validation',
    severity: 'medium',
    pattern: /req\.params\.[a-zA-Z_]+\s*[^?&|]/,
    description: 'Direct use of URL params without validation',
    recommendation: 'Validate and sanitize URL parameters before use',
  },
  {
    id: 'UNSAFE_QUERY',
    category: 'input_validation',
    severity: 'medium',
    pattern: /req\.query\.[a-zA-Z_]+\s*[^?&|]/,
    description: 'Direct use of query params without validation',
    recommendation: 'Validate and sanitize query parameters before use',
  },

  // Sensitive data patterns
  {
    id: 'HARDCODED_SECRET',
    category: 'sensitive_data',
    severity: 'critical',
    pattern: /(?:password|secret|api[_-]?key|apikey|token|private[_-]?key)\s*[:=]\s*['"`][^'"`]{8,}['"`]/i,
    description: 'Potential hardcoded secret or API key',
    recommendation: 'Use environment variables for secrets',
  },
  {
    id: 'LOG_SENSITIVE',
    category: 'sensitive_data',
    severity: 'high',
    pattern: /console\.log\s*\(\s*.*(?:password|token|secret|key|auth|bearer)/i,
    description: 'Potentially logging sensitive information',
    recommendation: 'Remove or mask sensitive data from logs',
  },

  // XSS patterns
  {
    id: 'UNSAFE_INNERHTML',
    category: 'xss',
    severity: 'high',
    pattern: /\.innerHTML\s*=\s*(?!['"`]<|['"`]$)/,
    description: 'Setting innerHTML with dynamic content',
    recommendation: 'Use textContent or sanitize HTML before setting innerHTML',
  },
  {
    id: 'UNSAFE_DOCUMENT_WRITE',
    category: 'xss',
    severity: 'high',
    pattern: /document\.write\s*\(/,
    description: 'Using document.write which can enable XSS',
    recommendation: 'Use DOM manipulation methods instead of document.write',
  },

  // Path traversal patterns
  {
    id: 'PATH_TRAVERSAL',
    category: 'path_traversal',
    severity: 'high',
    pattern: /(?:readFile|writeFile|readdir|access|stat)\s*\(\s*(?:req\.|params\.|query\.)/,
    description: 'File operation with user-controlled path',
    recommendation: 'Validate and sanitize file paths, use path.resolve and check boundaries',
  },
  {
    id: 'UNSAFE_PATH_JOIN',
    category: 'path_traversal',
    severity: 'medium',
    pattern: /path\.join\s*\(\s*.*(?:req\.|params\.|query\.)/,
    description: 'Path joining with user input without validation',
    recommendation: 'Validate path components and check for .. traversal',
  },
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
    console.error(`[SecurityScan] Error reading file ${filePath}:`, error);
    return null;
  }
}

/**
 * Scan content for security issues
 */
function scanContent(
  content: string,
  filePath: string,
  categories: SecurityScanParams['categories']
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');

  // Filter patterns by category if specified
  const patternsToCheck = categories && categories.length > 0
    ? SECURITY_PATTERNS.filter(p => categories.includes(p.category as any))
    : SECURITY_PATTERNS;

  for (const pattern of patternsToCheck) {
    // Check each line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = pattern.pattern.exec(line);

      if (match) {
        findings.push({
          id: `${pattern.id}-${filePath}-${i + 1}`,
          severity: pattern.severity,
          category: pattern.category,
          file_path: filePath,
          line_number: i + 1,
          code_snippet: line.trim().slice(0, 100),
          description: pattern.description,
          recommendation: pattern.recommendation,
        });
      }
    }
  }

  return findings;
}

/**
 * Deduplicate findings
 */
function deduplicateFindings(findings: SecurityFinding[]): SecurityFinding[] {
  const seen = new Set<string>();
  return findings.filter(f => {
    const key = `${f.category}-${f.file_path}-${f.line_number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Main skill handler
 */
export async function securityScan(
  params: SecurityScanParams,
  context: SkillContext
): Promise<SecurityScanResult> {
  const { vtid, target_paths, diff_content, scan_depth, categories } = params;

  // Emit start event
  await context.emitEvent('start', 'info', `Security scan started for ${target_paths.length} file(s)`, {
    files_count: target_paths.length,
    scan_depth: scan_depth || 'standard',
    categories: categories || 'all',
  });

  try {
    const allFindings: SecurityFinding[] = [];
    let filesScanned = 0;

    // Scan diff content if provided
    if (diff_content) {
      const diffFindings = scanContent(diff_content, 'diff', categories);
      allFindings.push(...diffFindings);
      filesScanned++;
    }

    // Scan each target path
    for (const targetPath of target_paths) {
      const content = readFileContent(targetPath);
      if (content) {
        const fileFindings = scanContent(content, targetPath, categories);
        allFindings.push(...fileFindings);
        filesScanned++;
      }
    }

    // Deduplicate and sort by severity
    const severityOrder: Record<string, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      info: 4,
    };

    const findings = deduplicateFindings(allFindings).sort(
      (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
    );

    // Calculate summary
    const summary = {
      total_findings: findings.length,
      critical: findings.filter(f => f.severity === 'critical').length,
      high: findings.filter(f => f.severity === 'high').length,
      medium: findings.filter(f => f.severity === 'medium').length,
      low: findings.filter(f => f.severity === 'low').length,
      files_scanned: filesScanned,
    };

    // Determine if scan passed (no critical or high findings)
    const passed = summary.critical === 0 && summary.high === 0;

    const result: SecurityScanResult = {
      ok: true,
      findings,
      summary,
      passed,
    };

    // Emit success event
    await context.emitEvent(
      'success',
      passed ? 'success' : 'warning',
      `Security scan completed: ${summary.total_findings} finding(s)`,
      {
        passed,
        ...summary,
      }
    );

    // Emit individual finding events for critical/high issues
    for (const finding of findings) {
      if (finding.severity === 'critical' || finding.severity === 'high') {
        await context.emitEvent('finding', 'warning', finding.description, {
          finding_id: finding.id,
          severity: finding.severity,
          category: finding.category,
          file_path: finding.file_path,
          line_number: finding.line_number,
        });
      }
    }

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    // Emit failed event
    await context.emitEvent('failed', 'error', `Security scan failed: ${errorMsg}`, {
      error: errorMsg,
    });

    return {
      ok: false,
      error: errorMsg,
      findings: [],
      summary: {
        total_findings: 0,
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        files_scanned: 0,
      },
      passed: false,
    };
  }
}
