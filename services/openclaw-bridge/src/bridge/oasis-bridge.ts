/**
 * OASIS Bridge - Connects OpenClaw execution to Vitana's OASIS event system.
 *
 * This bridge ensures that:
 * 1. All OpenClaw actions emit OASIS events for governance traceability
 * 2. Governance gates (EXECUTION_DISARMED) are respected
 * 3. Tenant isolation is enforced
 * 4. PHI checks run before health-related tasks
 */

import { z } from 'zod';
import { containsPhi } from '../middleware/phi-redactor';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const OasisEventSchema = z.object({
  type: z.string().min(1),
  vtid: z.string().optional(),
  tenant_id: z.string().uuid().optional(),
  payload: z.record(z.unknown()),
  source: z.string().default('openclaw-bridge'),
});

export type OasisEvent = z.input<typeof OasisEventSchema>;

export interface GovernanceCheckResult {
  allowed: boolean;
  reason?: string;
  flags: {
    execution_disarmed: boolean;
    autopilot_loop_enabled: boolean;
    vtid_allocator_enabled: boolean;
  };
}

// ---------------------------------------------------------------------------
// OASIS Event Emission
// ---------------------------------------------------------------------------

/**
 * Emit an OASIS event through the gateway.
 * Non-fatal: OASIS events are telemetry — failure must never crash the service.
 */
export async function emitOasisEvent(event: OasisEvent): Promise<void> {
  const validated = OasisEventSchema.parse(event);
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';

  try {
    const res = await fetch(`${gatewayUrl}/api/v1/oasis/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: validated.type,
        vtid: validated.vtid,
        tenant_id: validated.tenant_id,
        payload: {
          ...validated.payload,
          source: validated.source,
          timestamp: new Date().toISOString(),
        },
      }),
    });

    if (!res.ok) {
      console.warn(`[oasis-bridge] Failed to emit event ${validated.type}: ${res.status}`);
    }
  } catch (err) {
    console.warn(`[oasis-bridge] Event ${validated.type} failed (non-fatal):`, err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Governance Check
// ---------------------------------------------------------------------------

/**
 * Check governance flags before executing an OpenClaw action.
 * Returns whether execution is allowed based on current governance state.
 */
export async function checkGovernance(): Promise<GovernanceCheckResult> {
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';

  try {
    const res = await fetch(`${gatewayUrl}/api/v1/admin/governance/flags`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      // If we can't reach governance, default to disarmed (safe)
      return {
        allowed: false,
        reason: `Governance endpoint unreachable (${res.status}) - defaulting to DISARMED`,
        flags: {
          execution_disarmed: true,
          autopilot_loop_enabled: false,
          vtid_allocator_enabled: false,
        },
      };
    }

    const flags = (await res.json()) as Record<string, unknown>;
    const executionDisarmed = flags.EXECUTION_DISARMED === true;
    const loopEnabled = flags.AUTOPILOT_LOOP_ENABLED === true;

    return {
      allowed: !executionDisarmed && loopEnabled,
      reason: executionDisarmed
        ? 'EXECUTION_DISARMED is active - all autonomous actions blocked'
        : !loopEnabled
          ? 'AUTOPILOT_LOOP_ENABLED is false - loop actions blocked'
          : undefined,
      flags: {
        execution_disarmed: executionDisarmed,
        autopilot_loop_enabled: loopEnabled,
        vtid_allocator_enabled: flags.VTID_ALLOCATOR_ENABLED === true,
      },
    };
  } catch (err) {
    return {
      allowed: false,
      reason: `Governance check failed: ${err instanceof Error ? err.message : String(err)}`,
      flags: {
        execution_disarmed: true,
        autopilot_loop_enabled: false,
        vtid_allocator_enabled: false,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// PHI Gate
// ---------------------------------------------------------------------------

/**
 * Check if a task goal or payload contains PHI.
 * If PHI is detected, the task must use local LLM only.
 */
export function phiGate(text: string): {
  contains_phi: boolean;
  must_use_local_llm: boolean;
  warning?: string;
} {
  const hasPhi = containsPhi(text);
  return {
    contains_phi: hasPhi,
    must_use_local_llm: hasPhi,
    warning: hasPhi
      ? 'PHI detected in task content - routing to local Ollama LLM. No data will leave the server.'
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tenant Isolation
// ---------------------------------------------------------------------------

/**
 * Validate that a request is properly tenant-scoped.
 * All OpenClaw operations must specify a tenant_id.
 */
export function validateTenantScope(tenant_id: unknown): string {
  const parsed = z.string().uuid().safeParse(tenant_id);
  if (!parsed.success) {
    throw new Error('Tenant isolation violation: valid tenant_id (UUID) is required for all operations');
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Action Wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a skill action with OASIS governance, PHI checks, and event emission.
 * This is the main entry point for executing OpenClaw tasks through the bridge.
 */
export async function executeWithGovernance(params: {
  skill: string;
  action: string;
  tenant_id: string;
  input: unknown;
  goal?: string;
  user_role?: string;
  enforceGovernance?: boolean;
  executeAction: (input: unknown) => Promise<unknown>;
}): Promise<{ success: boolean; result?: unknown; blocked?: string }> {
  const { skill, action, tenant_id, input, goal, user_role, enforceGovernance = true, executeAction } = params;

  // 1. Validate tenant scope
  validateTenantScope(tenant_id);

  // 2. PHI gate
  const phiCheck = phiGate(goal ?? JSON.stringify(input));
  if (phiCheck.contains_phi) {
    await emitOasisEvent({
      type: 'openclaw.phi_detected',
      tenant_id,
      payload: { skill, action, must_use_local_llm: true },
    });
  }

  // 3. Governance check
  if (enforceGovernance) {
    const governance = await checkGovernance();
    if (!governance.allowed) {
      await emitOasisEvent({
        type: 'openclaw.action_blocked',
        tenant_id,
        payload: { skill, action, reason: governance.reason },
      });
      return { success: false, blocked: governance.reason };
    }
  }

  // 4. Emit start event
  await emitOasisEvent({
    type: 'openclaw.action_started',
    tenant_id,
    payload: { skill, action, goal, user_role },
  });

  // 5. Execute
  try {
    const result = await executeAction(input);

    // 6. Emit success
    await emitOasisEvent({
      type: 'openclaw.action_completed',
      tenant_id,
      payload: { skill, action, success: true },
    });

    return { success: true, result };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // 7. Emit failure
    await emitOasisEvent({
      type: 'openclaw.action_failed',
      tenant_id,
      payload: { skill, action, error: errorMsg },
    });

    throw err;
  }
}
