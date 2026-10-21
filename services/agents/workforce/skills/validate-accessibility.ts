/**
 * Validate Accessibility Skill - VTID-01164
 *
 * Static accessibility checks in changed HTML/JS templates.
 * Catches missing aria labels, keyboard nav issues, and semantic element misuse.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ValidateAccessibilityParams,
  ValidateAccessibilityResult,
  A11yIssue,
  SkillContext,
} from './types';

// =============================================================================
// A11y Rule Definitions
// =============================================================================

interface A11yRule {
  id: string;
  category: string;
  severity: A11yIssue['severity'];
  pattern: RegExp;
  antiPattern?: RegExp; // If this matches, issue is not applicable
  issue: string;
  recommendation: string;
  wcag_ref: string;
}

const A11Y_RULES: A11yRule[] = [
  // Aria Labels
  {
    id: 'ICON_BUTTON_NO_LABEL',
    category: 'aria_labels',
    severity: 'error',
    pattern: /<button[^>]*>[\s]*(?:<(?:i|svg|span)[^>]*(?:icon|fa-|material-icons)[^>]*>|<img[^>]*>)[\s]*<\/button>/gi,
    antiPattern: /aria-label|aria-labelledby|title=/i,
    issue: 'Icon-only button missing accessible label',
    recommendation: 'Add aria-label attribute describing the button action',
    wcag_ref: 'WCAG 2.1 - 1.1.1 Non-text Content',
  },
  {
    id: 'LINK_NO_LABEL',
    category: 'aria_labels',
    severity: 'error',
    pattern: /<a[^>]*>[\s]*(?:<(?:i|svg|span)[^>]*(?:icon|fa-|material-icons)[^>]*>|<img[^>]*>)[\s]*<\/a>/gi,
    antiPattern: /aria-label|aria-labelledby|title=/i,
    issue: 'Icon-only link missing accessible label',
    recommendation: 'Add aria-label attribute describing the link destination',
    wcag_ref: 'WCAG 2.1 - 2.4.4 Link Purpose',
  },
  {
    id: 'INPUT_NO_LABEL',
    category: 'aria_labels',
    severity: 'error',
    pattern: /<input[^>]*type=["'](?:text|email|password|search|tel|url|number)["'][^>]*>/gi,
    antiPattern: /aria-label|aria-labelledby|id=["'][^"']+["'][^>]*<label[^>]*for=/i,
    issue: 'Text input missing associated label',
    recommendation: 'Add aria-label or associate with <label for="...">',
    wcag_ref: 'WCAG 2.1 - 1.3.1 Info and Relationships',
  },

  // Keyboard Navigation
  {
    id: 'TABINDEX_POSITIVE',
    category: 'keyboard_nav',
    severity: 'warning',
    pattern: /tabindex=["'][1-9]/gi,
    issue: 'Positive tabindex disrupts natural tab order',
    recommendation: 'Use tabindex="0" or "-1" instead; arrange DOM order properly',
    wcag_ref: 'WCAG 2.1 - 2.4.3 Focus Order',
  },
  {
    id: 'ONCLICK_NO_KEYBOARD',
    category: 'keyboard_nav',
    severity: 'warning',
    pattern: /<(?:div|span)[^>]*onclick=[^>]*>/gi,
    antiPattern: /onkeydown|onkeyup|onkeypress|role=["']button["']/i,
    issue: 'Click handler on non-interactive element without keyboard handler',
    recommendation: 'Add keyboard handler or use <button> element',
    wcag_ref: 'WCAG 2.1 - 2.1.1 Keyboard',
  },
  {
    id: 'FOCUS_TRAP_POTENTIAL',
    category: 'keyboard_nav',
    severity: 'info',
    pattern: /tabindex=["']-1["'][^>]*(?:modal|dialog|overlay)/gi,
    issue: 'Modal/dialog may create focus trap - verify focus management',
    recommendation: 'Ensure focus returns to trigger element on close',
    wcag_ref: 'WCAG 2.1 - 2.1.2 No Keyboard Trap',
  },

  // Semantic Elements
  {
    id: 'DIV_BUTTON',
    category: 'semantic_elements',
    severity: 'warning',
    pattern: /<div[^>]*(?:role=["']button["']|onclick=)[^>]*>/gi,
    issue: 'Using div as button - use native <button> element',
    recommendation: 'Replace with <button> for built-in accessibility',
    wcag_ref: 'WCAG 2.1 - 4.1.2 Name, Role, Value',
  },
  {
    id: 'SPAN_LINK',
    category: 'semantic_elements',
    severity: 'warning',
    pattern: /<span[^>]*(?:role=["']link["']|onclick=)[^>]*>/gi,
    issue: 'Using span as link - use native <a> element',
    recommendation: 'Replace with <a href="..."> for proper link semantics',
    wcag_ref: 'WCAG 2.1 - 4.1.2 Name, Role, Value',
  },
  {
    id: 'NON_SEMANTIC_NAV',
    category: 'semantic_elements',
    severity: 'info',
    pattern: /<div[^>]*class=["'][^"']*(?:nav|menu|navigation)[^"']*["'][^>]*>/gi,
    antiPattern: /role=["']navigation["']|<nav/i,
    issue: 'Navigation-like div without semantic element',
    recommendation: 'Consider using <nav> element or role="navigation"',
    wcag_ref: 'WCAG 2.1 - 1.3.1 Info and Relationships',
  },

  // Tab Order
  {
    id: 'HIDDEN_FOCUSABLE',
    category: 'tab_order',
    severity: 'warning',
    pattern: /(?:display:\s*none|visibility:\s*hidden)[^}]*(?:<button|<a|<input|tabindex)/gi,
    issue: 'Hidden element may still be focusable',
    recommendation: 'Add tabindex="-1" or aria-hidden="true" to hidden focusable elements',
    wcag_ref: 'WCAG 2.1 - 2.4.3 Focus Order',
  },

  // Focus Visible
  {
    id: 'OUTLINE_NONE',
    category: 'focus_visible',
    severity: 'error',
    pattern: /outline:\s*(?:none|0)/gi,
    antiPattern: /focus-visible|:focus\s*{[^}]*(?:outline|box-shadow|border)/i,
    issue: 'Focus outline removed without alternative',
    recommendation: 'Provide visible focus indicator (box-shadow, border, etc.)',
    wcag_ref: 'WCAG 2.1 - 2.4.7 Focus Visible',
  },

  // Alt Text
  {
    id: 'IMG_NO_ALT',
    category: 'alt_text',
    severity: 'error',
    pattern: /<img[^>]*>/gi,
    antiPattern: /alt=/i,
    issue: 'Image missing alt attribute',
    recommendation: 'Add alt="" for decorative images or descriptive text',
    wcag_ref: 'WCAG 2.1 - 1.1.1 Non-text Content',
  },
  {
    id: 'IMG_EMPTY_ALT_NON_DECORATIVE',
    category: 'alt_text',
    severity: 'info',
    pattern: /<img[^>]*alt=["'][\s]*["'][^>]*>/gi,
    antiPattern: /role=["']presentation["']|aria-hidden=["']true["']/i,
    issue: 'Image has empty alt - verify it is decorative',
    recommendation: 'Empty alt is correct for decorative images; add description if meaningful',
    wcag_ref: 'WCAG 2.1 - 1.1.1 Non-text Content',
  },

  // Heading Order
  {
    id: 'HEADING_SKIP',
    category: 'heading_order',
    severity: 'warning',
    pattern: /<h[1-6][^>]*>/gi,
    issue: 'Verify heading levels do not skip (e.g., h1 to h3)',
    recommendation: 'Maintain logical heading hierarchy',
    wcag_ref: 'WCAG 2.1 - 1.3.1 Info and Relationships',
  },

  // Form Labels
  {
    id: 'SELECT_NO_LABEL',
    category: 'form_labels',
    severity: 'error',
    pattern: /<select[^>]*>/gi,
    antiPattern: /aria-label|aria-labelledby/i,
    issue: 'Select element missing accessible label',
    recommendation: 'Add aria-label or associate with <label>',
    wcag_ref: 'WCAG 2.1 - 1.3.1 Info and Relationships',
  },
  {
    id: 'TEXTAREA_NO_LABEL',
    category: 'form_labels',
    severity: 'error',
    pattern: /<textarea[^>]*>/gi,
    antiPattern: /aria-label|aria-labelledby/i,
    issue: 'Textarea missing accessible label',
    recommendation: 'Add aria-label or associate with <label>',
    wcag_ref: 'WCAG 2.1 - 1.3.1 Info and Relationships',
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
    return null;
  }
}

/**
 * Check content against a11y rules
 */
function checkContent(
  content: string,
  filePath: string,
  checks: ValidateAccessibilityParams['checks'],
  severityThreshold: ValidateAccessibilityParams['severity_threshold']
): { issues: A11yIssue[]; elementsAnalyzed: number } {
  const issues: A11yIssue[] = [];
  const lines = content.split('\n');
  let elementsAnalyzed = 0;

  // Filter rules by category if checks specified
  const rulesToCheck = checks && checks.length > 0
    ? A11Y_RULES.filter(r => checks.includes(r.category as any))
    : A11Y_RULES;

  // Filter by severity threshold
  const severityOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const threshold = severityThreshold || 'warning';
  const thresholdLevel = severityOrder[threshold];

  const filteredRules = rulesToCheck.filter(
    r => severityOrder[r.severity] <= thresholdLevel
  );

  for (const rule of filteredRules) {
    // Check each line (simplified - real implementation would parse HTML)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Reset regex
      rule.pattern.lastIndex = 0;

      const matches = line.match(rule.pattern);
      if (matches) {
        elementsAnalyzed += matches.length;

        for (const match of matches) {
          // Check if anti-pattern applies
          if (rule.antiPattern && rule.antiPattern.test(line)) {
            continue; // Skip - has the required accessibility attribute
          }

          issues.push({
            id: `${rule.id}-${filePath}-${i + 1}`,
            severity: rule.severity,
            category: rule.category,
            file_path: filePath,
            line_number: i + 1,
            element: match.slice(0, 50).trim(),
            issue: rule.issue,
            recommendation: rule.recommendation,
            wcag_ref: rule.wcag_ref,
          });
        }
      }
    }
  }

  return { issues, elementsAnalyzed };
}

/**
 * Deduplicate issues
 */
function deduplicateIssues(issues: A11yIssue[]): A11yIssue[] {
  const seen = new Set<string>();
  return issues.filter(issue => {
    const key = `${issue.category}-${issue.file_path}-${issue.line_number}`;
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
export async function validateAccessibility(
  params: ValidateAccessibilityParams,
  context: SkillContext
): Promise<ValidateAccessibilityResult> {
  const {
    vtid,
    target_paths,
    diff_content,
    severity_threshold = 'warning',
    checks = ['aria_labels', 'keyboard_nav', 'semantic_elements', 'tab_order'],
  } = params;

  // Emit start event
  await context.emitEvent('start', 'info', `Accessibility validation started for ${target_paths.length} file(s)`, {
    files_count: target_paths.length,
    checks: checks,
    severity_threshold,
  });

  try {
    const allIssues: A11yIssue[] = [];
    let filesChecked = 0;
    let totalElements = 0;

    // Check diff content if provided
    if (diff_content) {
      const { issues, elementsAnalyzed } = checkContent(
        diff_content,
        'diff',
        checks,
        severity_threshold
      );
      allIssues.push(...issues);
      totalElements += elementsAnalyzed;
      filesChecked++;
    }

    // Check each target path
    for (const targetPath of target_paths) {
      const content = readFileContent(targetPath);
      if (content) {
        const { issues, elementsAnalyzed } = checkContent(
          content,
          targetPath,
          checks,
          severity_threshold
        );
        allIssues.push(...issues);
        totalElements += elementsAnalyzed;
        filesChecked++;
      }
    }

    // Deduplicate and sort
    const issues = deduplicateIssues(allIssues).sort((a, b) => {
      const severityOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });

    // Calculate summary
    const summary = {
      total_issues: issues.length,
      errors: issues.filter(i => i.severity === 'error').length,
      warnings: issues.filter(i => i.severity === 'warning').length,
      info: issues.filter(i => i.severity === 'info').length,
      files_checked: filesChecked,
      elements_analyzed: totalElements,
    };

    // Passed if no errors
    const passed = summary.errors === 0;

    const result: ValidateAccessibilityResult = {
      ok: true,
      passed,
      issues,
      summary,
      checks_performed: checks,
    };

    // Emit success event
    await context.emitEvent(
      'success',
      passed ? 'success' : 'warning',
      `Accessibility check completed: ${summary.total_issues} issue(s)`,
      {
        passed,
        ...summary,
      }
    );

    // Emit individual issue events for errors
    for (const issue of issues) {
      if (issue.severity === 'error') {
        await context.emitEvent('issue', 'warning', issue.issue, {
          issue_id: issue.id,
          severity: issue.severity,
          category: issue.category,
          file_path: issue.file_path,
          line_number: issue.line_number,
          wcag_ref: issue.wcag_ref,
        });
      }
    }

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    // Emit failed event
    await context.emitEvent('failed', 'error', `Accessibility validation failed: ${errorMsg}`, {
      error: errorMsg,
    });

    return {
      ok: false,
      error: errorMsg,
      passed: false,
      issues: [],
      summary: {
        total_issues: 0,
        errors: 0,
        warnings: 0,
        info: 0,
        files_checked: 0,
        elements_analyzed: 0,
      },
      checks_performed: [],
    };
  }
}
