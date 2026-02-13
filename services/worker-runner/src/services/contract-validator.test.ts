/**
 * VTID-01231: Tests for Contract Validator
 */

import { validateLLMResponse, formatViolationsForReprompt, ContractViolation } from './contract-validator';

describe('validateLLMResponse', () => {
  describe('valid responses', () => {
    it('should accept a valid success response', () => {
      const response = JSON.stringify({
        ok: true,
        files_changed: ['src/routes/auth.ts'],
        files_created: [],
        summary: 'Added auth middleware',
      });

      const result = validateLLMResponse(response);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.sanitized).toBeDefined();
      expect(result.sanitized!.ok).toBe(true);
      expect(result.sanitized!.files_changed).toEqual(['src/routes/auth.ts']);
      expect(result.sanitized!.summary).toBe('Added auth middleware');
    });

    it('should accept a valid failure response', () => {
      const response = JSON.stringify({
        ok: false,
        files_changed: [],
        files_created: [],
        summary: 'Could not complete',
        error: 'Missing dependency: zod',
      });

      const result = validateLLMResponse(response);
      expect(result.valid).toBe(true);
      expect(result.sanitized!.ok).toBe(false);
      expect(result.sanitized!.error).toBe('Missing dependency: zod');
    });

    it('should extract JSON embedded in markdown', () => {
      const response = `Here's my analysis:

\`\`\`json
{
  "ok": true,
  "files_changed": ["src/index.ts"],
  "files_created": [],
  "summary": "Updated entry point"
}
\`\`\`

That covers the changes.`;

      const result = validateLLMResponse(response);
      expect(result.valid).toBe(true);
      expect(result.sanitized!.summary).toBe('Updated entry point');
    });

    it('should accept response without optional file arrays', () => {
      const response = JSON.stringify({
        ok: true,
        summary: 'No file changes needed, just reviewed',
      });

      const result = validateLLMResponse(response);
      expect(result.valid).toBe(true);
      expect(result.sanitized!.files_changed).toEqual([]);
      expect(result.sanitized!.files_created).toEqual([]);
    });
  });

  describe('invalid responses', () => {
    it('should reject response with no JSON', () => {
      const response = 'I completed the task successfully. The files look good.';

      const result = validateLLMResponse(response);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule).toBe('json_required');
    });

    it('should reject malformed JSON', () => {
      const response = '{ ok: true, summary: "done" }'; // not valid JSON (unquoted keys)

      const result = validateLLMResponse(response);
      expect(result.valid).toBe(false);
      expect(result.violations[0].rule).toBe('json_parseable');
    });

    it('should reject when ok is not a boolean', () => {
      const response = JSON.stringify({
        ok: 'yes',
        summary: 'Done',
      });

      const result = validateLLMResponse(response);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.field === 'ok')).toBe(true);
    });

    it('should reject success response without summary', () => {
      const response = JSON.stringify({
        ok: true,
        files_changed: ['a.ts'],
      });

      const result = validateLLMResponse(response);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.field === 'summary')).toBe(true);
    });

    it('should reject failure response without error', () => {
      const response = JSON.stringify({
        ok: false,
        summary: 'Failed',
      });

      const result = validateLLMResponse(response);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.field === 'error')).toBe(true);
    });

    it('should reject files_changed that is not an array', () => {
      const response = JSON.stringify({
        ok: true,
        files_changed: 'src/index.ts',
        summary: 'Done',
      });

      const result = validateLLMResponse(response);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.field === 'files_changed')).toBe(true);
    });

    it('should reject path traversal in file paths', () => {
      const response = JSON.stringify({
        ok: true,
        files_changed: ['../../etc/passwd'],
        files_created: [],
        summary: 'Updated config',
      });

      const result = validateLLMResponse(response);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.rule === 'no_path_traversal')).toBe(true);
    });

    it('should reject non-string entries in file arrays', () => {
      const response = JSON.stringify({
        ok: true,
        files_changed: ['valid.ts', 123, null],
        files_created: [],
        summary: 'Done',
      });

      const result = validateLLMResponse(response);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.rule === 'type_string')).toBe(true);
    });
  });
});

describe('formatViolationsForReprompt', () => {
  it('should format violations into a reprompt context', () => {
    const violations: ContractViolation[] = [
      { field: 'ok', rule: 'type_boolean', message: "Field 'ok' must be a boolean" },
      { field: 'summary', rule: 'required_on_success', message: "'summary' is required" },
    ];

    const result = formatViolationsForReprompt(violations);
    expect(result).toContain('CONTRACT VALIDATION FAILED');
    expect(result).toContain('type_boolean');
    expect(result).toContain('required_on_success');
    expect(result).toContain('ok: boolean');
  });
});
