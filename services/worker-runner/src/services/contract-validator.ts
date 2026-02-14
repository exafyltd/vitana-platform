/**
 * VTID-01231: Contract Validator for Worker-Runner
 *
 * Validates LLM outputs against the contracts declared in
 * autonomy_guardrails.yaml BEFORE they become actions.
 *
 * This is the "deterministic validator" — no LLM needed, just schema checks.
 * If a response doesn't conform, it's rejected and the caller can re-prompt.
 */

import { ExecutionResult } from '../types';

/**
 * Worker contract fields from autonomy_guardrails.yaml:
 *   must_include: [commands, dry_run, pr_required, rollback_commands]
 *
 * We validate that the LLM response is structurally correct
 * before the worker-runner acts on it.
 */
export interface ContractViolation {
  field: string;
  rule: string;
  message: string;
}

export interface ContractValidationResult {
  valid: boolean;
  violations: ContractViolation[];
  sanitized?: ExecutionResult;
}

/**
 * Validate the raw LLM response text before it's parsed into an ExecutionResult.
 *
 * Checks:
 * 1. Response contains valid JSON
 * 2. JSON has required fields (ok, summary)
 * 3. ok is a boolean
 * 4. files_changed/files_created are arrays of strings (if present)
 * 5. No path traversal in file paths
 * 6. summary is non-empty
 */
export function validateLLMResponse(rawResponse: string): ContractValidationResult {
  const violations: ContractViolation[] = [];

  // 1. Extract JSON
  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      valid: false,
      violations: [{
        field: 'response',
        rule: 'json_required',
        message: 'LLM response does not contain a JSON object',
      }],
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return {
      valid: false,
      violations: [{
        field: 'response',
        rule: 'json_parseable',
        message: `LLM response contains invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`,
      }],
    };
  }

  // 2. Required field: 'ok'
  if (typeof parsed.ok !== 'boolean') {
    violations.push({
      field: 'ok',
      rule: 'type_boolean',
      message: `Field 'ok' must be a boolean, got ${typeof parsed.ok}`,
    });
  }

  // 3. Required field: 'summary'
  if (parsed.ok === true && (!parsed.summary || typeof parsed.summary !== 'string')) {
    violations.push({
      field: 'summary',
      rule: 'required_on_success',
      message: "Field 'summary' is required and must be a non-empty string when ok=true",
    });
  }

  // 4. If ok=false, require 'error'
  if (parsed.ok === false && (!parsed.error || typeof parsed.error !== 'string')) {
    violations.push({
      field: 'error',
      rule: 'required_on_failure',
      message: "Field 'error' is required and must be a non-empty string when ok=false",
    });
  }

  // 5. Validate file arrays
  for (const field of ['files_changed', 'files_created'] as const) {
    const value = parsed[field];
    if (value !== undefined && value !== null) {
      if (!Array.isArray(value)) {
        violations.push({
          field,
          rule: 'type_array',
          message: `Field '${field}' must be an array, got ${typeof value}`,
        });
      } else {
        // Check each entry is a string with no path traversal
        for (let i = 0; i < value.length; i++) {
          if (typeof value[i] !== 'string') {
            violations.push({
              field: `${field}[${i}]`,
              rule: 'type_string',
              message: `Each entry in '${field}' must be a string`,
            });
          } else if ((value[i] as string).includes('..')) {
            violations.push({
              field: `${field}[${i}]`,
              rule: 'no_path_traversal',
              message: `Path traversal detected in '${field}[${i}]': ${value[i]}`,
            });
          }
        }
      }
    }
  }

  // Build sanitized result if valid
  if (violations.length === 0) {
    const sanitized: ExecutionResult = {
      ok: parsed.ok as boolean,
      files_changed: Array.isArray(parsed.files_changed)
        ? (parsed.files_changed as string[]).filter((f) => typeof f === 'string')
        : [],
      files_created: Array.isArray(parsed.files_created)
        ? (parsed.files_created as string[]).filter((f) => typeof f === 'string')
        : [],
      summary: (parsed.summary as string) || 'No summary provided',
      error: parsed.error as string | undefined,
      violations: Array.isArray(parsed.violations)
        ? (parsed.violations as string[]).filter((v) => typeof v === 'string')
        : [],
    };

    return { valid: true, violations: [], sanitized };
  }

  return { valid: false, violations };
}

/**
 * Format violations into a re-prompt context string.
 * This is appended to the next LLM call to help it fix its response.
 */
export function formatViolationsForReprompt(violations: ContractViolation[]): string {
  const lines = violations.map(
    (v) => `- [${v.field}] ${v.rule}: ${v.message}`
  );
  return `
## CONTRACT VALIDATION FAILED

Your previous response did not conform to the required output contract.
Fix the following violations and respond again with valid JSON:

${lines.join('\n')}

REMINDER: Respond with a JSON object containing:
- ok: boolean (true if task succeeded)
- files_changed: string[] (list of modified files)
- files_created: string[] (list of new files)
- summary: string (human-readable summary)
- error: string (if ok=false, describe the failure)
`;
}
