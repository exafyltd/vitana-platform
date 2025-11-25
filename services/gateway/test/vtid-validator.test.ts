/**
 * VTID Validator Tests - DEV-OASIS-0206
 */

import {
  validateVtidFormat,
  detectInventedVtid,
  validateTaskVtid,
  validateAgentOutput,
  VtidValidator,
  VTID_FORMAT_REGEX,
  VALID_VTID_LAYERS
} from '../src/validator-core/vtid-validator';

describe('VTID Validator - DEV-OASIS-0206', () => {
  describe('validateVtidFormat', () => {
    it('should accept valid VTID format (4-digit)', () => {
      const result = validateVtidFormat('DEV-OASIS-0001');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept valid VTID format (8-digit)', () => {
      const result = validateVtidFormat('DEV-OASIS-0001-0001');
      expect(result.valid).toBe(true);
    });

    it('should accept all valid layers', () => {
      for (const layer of VALID_VTID_LAYERS) {
        const result = validateVtidFormat(`${layer}-TEST-0001`);
        expect(result.valid).toBe(true);
      }
    });

    it('should reject empty VTID', () => {
      const result = validateVtidFormat('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should reject malformed VTID (missing parts)', () => {
      const result = validateVtidFormat('DEV-OASIS');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('format');
    });

    it('should reject malformed VTID (lowercase)', () => {
      const result = validateVtidFormat('dev-oasis-0001');
      expect(result.valid).toBe(false);
    });

    it('should reject invalid layer', () => {
      const result = validateVtidFormat('INVALID-OASIS-0001');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('layer');
    });

    it('should reject VTID with extra segments', () => {
      const result = validateVtidFormat('DEV-OASIS-0001-0001-0001');
      expect(result.valid).toBe(false);
    });
  });

  describe('detectInventedVtid', () => {
    it('should not flag normal VTIDs as invented', () => {
      const result = detectInventedVtid('DEV-OASIS-0042');
      expect(result.invented).toBe(false);
    });

    it('should flag suspicious patterns (repeated digits)', () => {
      const result = detectInventedVtid('DEV-OASIS-9999');
      expect(result.invented).toBe(true);
      expect(result.reason).toContain('pattern');
    });

    it('should flag very high sequence numbers', () => {
      const result = detectInventedVtid('DEV-OASIS-9001');
      expect(result.invented).toBe(true);
      expect(result.reason).toContain('high');
    });

    it('should flag unknown short modules', () => {
      const result = detectInventedVtid('DEV-XX-0001');
      expect(result.invented).toBe(true);
      expect(result.reason).toContain('module');
    });

    it('should not flag 0001 as invented', () => {
      const result = detectInventedVtid('DEV-OASIS-0001');
      expect(result.invented).toBe(false);
    });
  });

  describe('validateTaskVtid', () => {
    it('should pass for valid task with VTID', () => {
      const result = validateTaskVtid({ vtid: 'DEV-COMHU-0123' });
      expect(result.valid).toBe(true);
      expect(result.vtid).toBe('DEV-COMHU-0123');
      expect(result.errors).toHaveLength(0);
    });

    it('should fail for missing VTID', () => {
      const result = validateTaskVtid({});
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('VTID_REQUIRED: Task output must include a vtid field');
    });

    it('should accept task_id as fallback', () => {
      const result = validateTaskVtid({ task_id: 'DEV-TASK-0001' });
      expect(result.valid).toBe(true);
      expect(result.vtid).toBe('DEV-TASK-0001');
    });

    it('should fail for invalid format', () => {
      const result = validateTaskVtid({ vtid: 'not-a-vtid' });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('FORMAT_INVALID'))).toBe(true);
    });

    it('should warn for possibly invented VTIDs', () => {
      const result = validateTaskVtid({ vtid: 'DEV-OASIS-9999' });
      expect(result.warnings.some(w => w.includes('POSSIBLY_INVENTED'))).toBe(true);
    });
  });

  describe('validateAgentOutput', () => {
    it('should require VTID for execution outputs', () => {
      const result = validateAgentOutput({ type: 'implementation' });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('VTID_REQUIRED_FOR_EXECUTION'))).toBe(true);
    });

    it('should pass for execution output with valid VTID', () => {
      const result = validateAgentOutput({ type: 'implementation', vtid: 'DEV-GATE-0001' });
      expect(result.valid).toBe(true);
    });

    it('should warn but pass for non-execution output without VTID', () => {
      const result = validateAgentOutput({ type: 'info' });
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('RECOMMENDED'))).toBe(true);
    });

    it('should validate execution types case-insensitively', () => {
      const result = validateAgentOutput({ type: 'EXECUTION', vtid: 'DEV-OASIS-0001' });
      expect(result.valid).toBe(true);
    });
  });

  describe('VtidValidator class', () => {
    const validator = new VtidValidator();

    it('should validate format correctly', () => {
      const result = validator.validateFormat('DEV-OASIS-0001');
      expect(result.valid).toBe(true);
    });

    it('should detect invented VTIDs', () => {
      expect(validator.isLikelyInvented('DEV-XX-0001')).toBe(true);
      expect(validator.isLikelyInvented('DEV-OASIS-0123')).toBe(false);
    });

    it('should return validation rules', () => {
      const rules = validator.getValidationRules();
      expect(rules).toHaveLength(3);

      const ruleCodes = rules.map(r => r.rule_code);
      expect(ruleCodes).toContain('VTID_AUTOMATIC_CREATION_REQUIRED');
      expect(ruleCodes).toContain('VTID_LEDGER_SINGLE_SOURCE_OF_TRUTH');
      expect(ruleCodes).toContain('VTID_CONTEXT_REUSE_REQUIRED');
    });

    it('should execute validation rule checks', () => {
      const rules = validator.getValidationRules();
      const autoCreateRule = rules.find(r => r.rule_code === 'VTID_AUTOMATIC_CREATION_REQUIRED');

      expect(autoCreateRule?.check({ vtid: 'DEV-OASIS-0001' })).toBe(true);
      expect(autoCreateRule?.check({})).toBe(false);
    });
  });
});
