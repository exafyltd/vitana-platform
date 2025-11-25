/**
 * VTID Validator - DEV-OASIS-0206
 *
 * Validates that task outputs and agent work products contain valid VTIDs
 * from the ledger. Rejects invented/guessed VTIDs.
 */

// VTID format regex - matches LAYER-MODULE-NNNN-NNNN or LAYER-MODULE-NNNN
export const VTID_FORMAT_REGEX = /^[A-Z]+-[A-Z0-9]+-\d{4}(-\d{4})?$/;

// Valid VTID layers
export const VALID_VTID_LAYERS = ['DEV', 'ADM', 'GOVRN', 'OASIS'];

// Known modules (non-exhaustive, for heuristic validation)
export const KNOWN_MODULES = [
  'OASIS', 'COMHU', 'GOVBE', 'GOVUI', 'GATE', 'AUTH', 'TASK',
  'VTID', 'EVENT', 'MCP', 'FRONT', 'BACK', 'TEST', 'INFRA'
];

export interface VtidValidationResult {
  valid: boolean;
  vtid: string | null;
  errors: string[];
  warnings: string[];
}

export interface TaskPayload {
  vtid?: string;
  task_id?: string;
  [key: string]: any;
}

/**
 * Validates VTID format matches expected pattern
 */
export function validateVtidFormat(vtid: string): { valid: boolean; error?: string } {
  if (!vtid || typeof vtid !== 'string') {
    return { valid: false, error: 'VTID is required and must be a string' };
  }

  if (!VTID_FORMAT_REGEX.test(vtid)) {
    return {
      valid: false,
      error: `VTID '${vtid}' does not match expected format (LAYER-MODULE-NNNN or LAYER-MODULE-NNNN-NNNN)`
    };
  }

  // Extract and validate layer
  const parts = vtid.split('-');
  const layer = parts[0];
  if (!VALID_VTID_LAYERS.includes(layer)) {
    return {
      valid: false,
      error: `VTID layer '${layer}' is not valid. Valid layers: ${VALID_VTID_LAYERS.join(', ')}`
    };
  }

  return { valid: true };
}

/**
 * Detects if a VTID appears to be invented rather than obtained from the ledger.
 * Uses heuristics to identify patterns that suggest manual construction.
 */
export function detectInventedVtid(vtid: string): { invented: boolean; reason?: string } {
  if (!vtid) return { invented: false };

  const parts = vtid.split('-');

  // Check for suspicious patterns
  // 1. Sequential/round numbers (e.g., 0000, 1111, 9999)
  const numericParts = parts.filter(p => /^\d+$/.test(p));
  for (const num of numericParts) {
    if (/^(\d)\1{3}$/.test(num) && num !== '0001') {
      return { invented: true, reason: `Suspicious pattern: ${num} looks manually constructed` };
    }
    // Very high numbers unlikely to be real
    if (parseInt(num) > 5000) {
      return { invented: true, reason: `Suspiciously high sequence number: ${num}` };
    }
  }

  // 2. Unusual module names (not in known list and looks random)
  const module = parts[1];
  if (module && !KNOWN_MODULES.includes(module) && module.length <= 3) {
    return { invented: true, reason: `Unknown short module '${module}' - may be invented` };
  }

  return { invented: false };
}

/**
 * Validates a task payload has a valid VTID
 */
export function validateTaskVtid(payload: TaskPayload): VtidValidationResult {
  const result: VtidValidationResult = {
    valid: false,
    vtid: null,
    errors: [],
    warnings: []
  };

  // Check for VTID presence
  const vtid = payload.vtid || payload.task_id;
  if (!vtid) {
    result.errors.push('VTID_REQUIRED: Task output must include a vtid field');
    return result;
  }

  result.vtid = vtid;

  // Validate format
  const formatCheck = validateVtidFormat(vtid);
  if (!formatCheck.valid) {
    result.errors.push(`VTID_FORMAT_INVALID: ${formatCheck.error}`);
    return result;
  }

  // Check for invented VTID
  const inventedCheck = detectInventedVtid(vtid);
  if (inventedCheck.invented) {
    result.warnings.push(`VTID_POSSIBLY_INVENTED: ${inventedCheck.reason}`);
    // This is a warning, not an error - needs ledger verification to confirm
  }

  result.valid = result.errors.length === 0;
  return result;
}

/**
 * Validates that an agent's work output conforms to VTID requirements
 */
export function validateAgentOutput(output: {
  vtid?: string;
  type?: string;
  result?: any;
  metadata?: Record<string, any>;
}): VtidValidationResult {
  const result: VtidValidationResult = {
    valid: false,
    vtid: null,
    errors: [],
    warnings: []
  };

  // Implementation/execution outputs MUST have VTID
  const executionTypes = ['implementation', 'execution', 'task_complete', 'deploy', 'build'];
  const isExecution = output.type && executionTypes.includes(output.type.toLowerCase());

  if (isExecution && !output.vtid) {
    result.errors.push('VTID_REQUIRED_FOR_EXECUTION: Execution outputs must include a valid VTID');
    return result;
  }

  if (!output.vtid) {
    result.warnings.push('VTID_RECOMMENDED: Output should include VTID for traceability');
    result.valid = true; // Not strictly required for non-execution outputs
    return result;
  }

  // Validate the VTID
  return validateTaskVtid({ vtid: output.vtid });
}

/**
 * VtidValidator class for use in governance enforcement pipeline
 */
export class VtidValidator {
  /**
   * Validates a VTID string
   */
  validateFormat(vtid: string): VtidValidationResult {
    return validateTaskVtid({ vtid });
  }

  /**
   * Validates agent output for VTID compliance
   */
  validateAgentOutput(output: any): VtidValidationResult {
    return validateAgentOutput(output);
  }

  /**
   * Checks if VTID appears to be invented
   */
  isLikelyInvented(vtid: string): boolean {
    return detectInventedVtid(vtid).invented;
  }

  /**
   * Generates validation rules for governance engine
   */
  getValidationRules(): Array<{
    rule_code: string;
    description: string;
    check: (input: any) => boolean;
  }> {
    return [
      {
        rule_code: 'VTID_AUTOMATIC_CREATION_REQUIRED',
        description: 'All new tasks must obtain VTID via /api/v1/vtid/get-or-create',
        check: (input: any) => {
          if (!input.vtid) return false;
          return validateVtidFormat(input.vtid).valid;
        }
      },
      {
        rule_code: 'VTID_LEDGER_SINGLE_SOURCE_OF_TRUTH',
        description: 'All VTIDs must come from the ledger; no manual increments or pattern guessing',
        check: (input: any) => {
          if (!input.vtid) return false;
          return !detectInventedVtid(input.vtid).invented;
        }
      },
      {
        rule_code: 'VTID_CONTEXT_REUSE_REQUIRED',
        description: 'If a task already has a VTID in context, agents must reuse it',
        check: (input: any) => {
          // This rule requires context awareness - checked at runtime
          // For static validation, we just ensure VTID is present
          return !!input.vtid;
        }
      }
    ];
  }
}

export const vtidValidator = new VtidValidator();
