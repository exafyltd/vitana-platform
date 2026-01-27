/**
 * Spec Gate Service - VTID-01219
 *
 * Enforces spec existence and approval status BEFORE dispatch.
 * This is the canonical spec gate that blocks execution of tasks
 * without approved specs.
 *
 * Rules:
 * - Canonical spec source: oasis_specs table ONLY
 * - No fallback to other tables
 * - Spec must exist AND have status='approved'
 * - Blocked tasks get explicit error codes
 * - Errors are persisted to vtid_ledger.spec_last_error
 */

import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// Types
// =============================================================================

/**
 * Deterministic error codes for spec gate failures
 * VTID-01219: These replace 'unknown_error' with explicit codes
 */
export type SpecGateErrorCode =
  | 'SPEC_NOT_FOUND'
  | 'SPEC_NOT_APPROVED'
  | 'DISPATCH_ROUTE_NOT_FOUND'
  | 'DISPATCH_FAILED'
  | 'WORKER_CLAIM_FAILED';

/**
 * Result of spec gate check
 */
export interface SpecGateResult {
  allowed: boolean;
  error_code?: SpecGateErrorCode;
  error_message?: string;
  spec?: {
    id: string;
    vtid: string;
    version: number;
    title: string;
    spec_markdown: string;
    status: string;
    created_at: string;
  };
}

/**
 * Spec record from oasis_specs table
 */
interface OasisSpec {
  id: string;
  vtid: string;
  version: number;
  title: string;
  spec_markdown: string;
  spec_hash: string;
  status: string;
  created_by: string | null;
  created_at: string;
}

// =============================================================================
// Configuration
// =============================================================================

const LOG_PREFIX = '[VTID-01219]';

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Check spec gate - canonical spec lookup from oasis_specs ONLY
 *
 * VTID-01219: This is the ONLY spec lookup function for dispatch.
 * No fallback. No secondary tables.
 *
 * @param vtid - The VTID to check
 * @returns SpecGateResult with allowed status and error details if blocked
 */
export async function checkSpecGate(vtid: string): Promise<SpecGateResult> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.error(`${LOG_PREFIX} Missing Supabase credentials`);
    return {
      allowed: false,
      error_code: 'SPEC_NOT_FOUND',
      error_message: 'Database configuration error',
    };
  }

  try {
    // Query oasis_specs - get latest version for this VTID
    const response = await fetch(
      `${supabaseUrl}/rest/v1/oasis_specs?vtid=eq.${encodeURIComponent(vtid)}&select=*&order=version.desc&limit=1`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`${LOG_PREFIX} Failed to query oasis_specs: ${response.status} - ${errorText}`);
      return {
        allowed: false,
        error_code: 'SPEC_NOT_FOUND',
        error_message: `Database query failed: ${response.status}`,
      };
    }

    const specs = await response.json() as OasisSpec[];

    // Check 1: Spec must exist
    if (!specs || specs.length === 0) {
      console.log(`${LOG_PREFIX} SPEC_NOT_FOUND: No spec in oasis_specs for ${vtid}`);
      return {
        allowed: false,
        error_code: 'SPEC_NOT_FOUND',
        error_message: `No spec found in oasis_specs for VTID ${vtid}`,
      };
    }

    const spec = specs[0];

    // Check 2: Spec must be approved
    if (spec.status !== 'approved') {
      console.log(`${LOG_PREFIX} SPEC_NOT_APPROVED: Spec for ${vtid} has status '${spec.status}' (expected 'approved')`);
      return {
        allowed: false,
        error_code: 'SPEC_NOT_APPROVED',
        error_message: `Spec for VTID ${vtid} has status '${spec.status}' - must be 'approved' for execution`,
      };
    }

    // All checks passed
    console.log(`${LOG_PREFIX} Spec gate PASSED for ${vtid} (version=${spec.version}, status=${spec.status})`);
    return {
      allowed: true,
      spec: {
        id: spec.id,
        vtid: spec.vtid,
        version: spec.version,
        title: spec.title,
        spec_markdown: spec.spec_markdown,
        status: spec.status,
        created_at: spec.created_at,
      },
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} Spec gate error for ${vtid}: ${errorMsg}`);
    return {
      allowed: false,
      error_code: 'SPEC_NOT_FOUND',
      error_message: `Spec gate error: ${errorMsg}`,
    };
  }
}

/**
 * Persist spec error to vtid_ledger.spec_last_error
 *
 * VTID-01219: When spec gate blocks, persist the error for visibility
 */
export async function persistSpecError(
  vtid: string,
  errorCode: SpecGateErrorCode,
  errorMessage: string
): Promise<boolean> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.error(`${LOG_PREFIX} Missing Supabase credentials for persistSpecError`);
    return false;
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(vtid)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          spec_last_error: `${errorCode}: ${errorMessage}`,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`${LOG_PREFIX} Failed to persist spec error for ${vtid}: ${response.status} - ${errorText}`);
      return false;
    }

    console.log(`${LOG_PREFIX} Persisted spec error to vtid_ledger for ${vtid}: ${errorCode}`);
    return true;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Error persisting spec error for ${vtid}: ${error}`);
    return false;
  }
}

/**
 * Emit dispatch blocked event
 *
 * VTID-01219: Structured OASIS event when spec gate blocks dispatch
 */
export async function emitDispatchBlocked(
  vtid: string,
  errorCode: SpecGateErrorCode,
  specStatus: string | null = null
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid,
      type: 'vtid.dispatch.blocked' as any,
      source: 'spec-gate-service',
      status: 'error',
      message: `Dispatch blocked for ${vtid}: ${errorCode}`,
      payload: {
        vtid,
        error_code: errorCode,
        spec_status: specStatus,
        service: 'gateway',
        blocked_at: new Date().toISOString(),
      },
    });
    console.log(`${LOG_PREFIX} Emitted vtid.dispatch.blocked for ${vtid}`);
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to emit dispatch blocked event: ${error}`);
  }
}

/**
 * Emit dispatch ready event
 *
 * VTID-01219: Structured OASIS event when spec gate passes
 */
export async function emitDispatchReady(
  vtid: string,
  specStatus: string
): Promise<void> {
  try {
    await emitOasisEvent({
      vtid,
      type: 'vtid.dispatch.ready' as any,
      source: 'spec-gate-service',
      status: 'info',
      message: `Dispatch ready for ${vtid}`,
      payload: {
        vtid,
        spec_status: specStatus,
        service: 'gateway',
        ready_at: new Date().toISOString(),
      },
    });
    console.log(`${LOG_PREFIX} Emitted vtid.dispatch.ready for ${vtid}`);
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to emit dispatch ready event: ${error}`);
  }
}

/**
 * Execute spec gate with full side effects
 *
 * VTID-01219: Main entry point for spec gate enforcement.
 * This function:
 * 1. Checks spec existence and approval status
 * 2. On block: persists error + emits blocked event
 * 3. On pass: emits ready event
 *
 * @param vtid - The VTID to check
 * @returns SpecGateResult with spec content if allowed
 */
export async function enforceSpecGate(vtid: string): Promise<SpecGateResult> {
  const result = await checkSpecGate(vtid);

  if (!result.allowed) {
    // Persist error to vtid_ledger
    await persistSpecError(vtid, result.error_code!, result.error_message!);

    // Emit blocked event
    await emitDispatchBlocked(vtid, result.error_code!, null);
  } else {
    // Emit ready event
    await emitDispatchReady(vtid, result.spec!.status);
  }

  return result;
}

// =============================================================================
// Exports
// =============================================================================

export default {
  checkSpecGate,
  enforceSpecGate,
  persistSpecError,
  emitDispatchBlocked,
  emitDispatchReady,
};
