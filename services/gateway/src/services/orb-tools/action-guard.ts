/**
 * Assistant action guard (VTID-ASSISTANT-ROLES).
 *
 * One shared discipline for every state-changing voice tool in the
 * developer and admin assistant lanes:
 *
 *   1. GLOBAL BRAKE — `assistant_actions_enabled` system control. Follows
 *      the isAutopilotExecutionArmed() pattern (VTID-01194): missing row =
 *      enabled (it is an emergency brake, not an enable gate). Disarming it
 *      via POST /api/v1/governance/controls/assistant_actions_enabled
 *      reduces both lanes to read-only without a redeploy.
 *   2. TWO-STEP CONFIRM — standardizes the confirm-flow convention already
 *      established by dev_approve_pr: first call without `confirm` returns
 *      a read-back; the handler executes only on confirm=true.
 *   3. RATE LIMIT — per-session cap on confirmed writes so a runaway LLM
 *      loop can't machine-gun mutations.
 *   4. AUDIT — every EXECUTED action emits an OASIS decision event
 *      (`vtid.decision.assistant_action`) with actor, role, tool, and an
 *      args digest. Proposals (unconfirmed first calls) are NOT emitted —
 *      OASIS records decisions, not loops (CLAUDE.md §6).
 */

import { createHash } from 'crypto';
import { emitOasisEvent } from '../oasis-event-service';
import { getSystemControl } from '../system-controls-service';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';

export type ActionTier = 1 | 2;

/** Per-session confirmed-write budget (rolling minute). */
const RATE_LIMIT_PER_MINUTE = 6;
const rateBuckets = new Map<string, number[]>();

export const ASSISTANT_ACTIONS_CONTROL_KEY = 'assistant_actions_enabled';

/**
 * Global brake check. Missing control = enabled (emergency-brake
 * semantics). Explicit `enabled=false` row = every T1/T2 tool refuses.
 */
export async function areAssistantActionsEnabled(): Promise<boolean> {
  try {
    const control = await getSystemControl(ASSISTANT_ACTIONS_CONTROL_KEY);
    if (!control) return true;
    return control.enabled !== false;
  } catch {
    // Control-plane read failure: fail toward safety for actions.
    return false;
  }
}

function rateLimitExceeded(sessionKey: string): boolean {
  const now = Date.now();
  const bucket = (rateBuckets.get(sessionKey) ?? []).filter((t) => now - t < 60_000);
  if (bucket.length >= RATE_LIMIT_PER_MINUTE) {
    rateBuckets.set(sessionKey, bucket);
    return true;
  }
  bucket.push(now);
  rateBuckets.set(sessionKey, bucket);
  // Bounded map — sessions are short-lived.
  if (rateBuckets.size > 500) {
    const firstKey = rateBuckets.keys().next().value;
    if (firstKey) rateBuckets.delete(firstKey);
  }
  return false;
}

export function argsDigest(args: OrbToolArgs): string {
  const clean = { ...args };
  delete (clean as Record<string, unknown>).confirm;
  try {
    return createHash('sha256').update(JSON.stringify(clean)).digest('hex').slice(0, 12);
  } catch {
    return 'unhashable';
  }
}

export interface GuardedActionSpec {
  /** Tool name (for read-backs + audit). */
  tool: string;
  /** 1 = reversible write, 2 = destructive/outward-facing. */
  tier: ActionTier;
  /**
   * The read-back the assistant must speak BEFORE the user confirms:
   * what will happen, who/what it affects, how to reverse it.
   */
  readBack: string;
  /** Executes the action. Only called after all gates pass. */
  execute: () => Promise<OrbToolResult>;
}

/**
 * Run a state-changing tool through the guard. Returns either:
 *   - a `requires_confirmation` result (first, unconfirmed call),
 *   - a refusal (brake engaged / rate limit),
 *   - or the execute() result, with the OASIS decision event emitted.
 */
export async function runGuardedAction(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  spec: GuardedActionSpec,
): Promise<OrbToolResult> {
  if (!(await areAssistantActionsEnabled())) {
    return {
      ok: false,
      error:
        'assistant_actions_disabled: the assistant action brake is engaged ' +
        `(system control '${ASSISTANT_ACTIONS_CONTROL_KEY}'). Read tools still work; ` +
        'a human must re-enable actions from the Command Hub governance controls.',
    };
  }

  if (args.confirm !== true) {
    return {
      ok: true,
      result: {
        requires_confirmation: true,
        tool: spec.tool,
        tier: spec.tier,
        args_digest: argsDigest(args),
      },
      text:
        `CONFIRMATION REQUIRED (tier ${spec.tier}): ${spec.readBack} ` +
        `Read this back to the user and ask for an explicit yes. Only after they confirm, ` +
        `call ${spec.tool} again with the SAME arguments plus confirm=true. ` +
        `If they decline or hesitate, do not call again.`,
    };
  }

  const sessionKey = id.session_id || `user:${id.user_id}`;
  if (rateLimitExceeded(sessionKey)) {
    return {
      ok: false,
      error:
        'assistant_action_rate_limited: too many state-changing actions in the last minute. ' +
        'Pause, summarize what has been done so far, and continue only if the user asks.',
    };
  }

  const result = await spec.execute();

  // Audit the executed decision — success or failure, both are decisions.
  emitOasisEvent({
    vtid: 'VTID-ASSISTANT-ROLES',
    type: 'vtid.decision.assistant_action' as any,
    source: 'orb-action-guard',
    status: result.ok === false ? 'warning' : 'info',
    message: `Assistant executed ${spec.tool} (tier ${spec.tier}) for role ${id.role ?? 'unknown'}${result.ok === false ? ' — FAILED' : ''}`,
    payload: {
      tool: spec.tool,
      tier: spec.tier,
      role: id.role ?? null,
      user_id: id.user_id,
      tenant_id: id.tenant_id,
      session_id: id.session_id ?? null,
      args_digest: argsDigest(args),
      outcome_ok: result.ok !== false,
      error: result.ok === false ? result.error : undefined,
    },
  }).catch(() => {});

  return result;
}
