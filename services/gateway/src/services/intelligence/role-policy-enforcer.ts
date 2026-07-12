/**
 * Role policy enforcer — Phase 1 W3-E1 (BOOTSTRAP-ROLE-AUTH-ENFORCER).
 *
 * Runtime ENFORCEMENT layer on top of the assistant role registry
 * (VTID-03240). Given the active assistant role and a requested
 * tool/source, it validates the request against the registry's
 * closed-world (deny-by-default) policy and returns an allow/deny
 * decision WITH a machine-readable reason.
 *
 * This module does NOT define policy — it only reads the registry's
 * `isToolAllowed` / `isContextSourceAllowed` helpers and wraps them with
 * reasons + a feature gate. The registry remains the single source of
 * truth; do NOT relax any allowlist here.
 *
 * ── Gating semantics ───────────────────────────────────────────────
 * Gated by FEATURE_ROLE_POLICY_ENFORCE_ENV (off | staging-only |
 * staging+prod), default off — same flag pattern as the W3 shadow.
 *
 *   - Flag OFF (default):   `enforced=false`. Callers MUST treat every
 *                           decision as advisory — LOG the violation
 *                           (shadow), never block. `assertToolAllowed`
 *                           still returns the correct allow/deny verdict
 *                           so callers can record it.
 *   - Flag ON:              `enforced=true`. Callers SHOULD block on a
 *                           deny verdict.
 *
 * The enforcer NEVER throws and NEVER blocks on its own; it returns a
 * decision. The decision to block lives with the caller (so a single
 * misbehaving call site can never hard-fail every assistant turn). The
 * `enforced` field tells the caller whether the flag is live.
 */

import { isFeatureLive } from '../feature-flags';
import {
  type AssistantRoleProfile,
  getRoleProfile,
  isContextSourceAllowed,
  isToolAllowed,
} from './assistant-role-registry';

export const FEATURE_NAME = 'ROLE_POLICY_ENFORCE';

/** Why a request was allowed or denied. Machine-readable for telemetry. */
export type RolePolicyReason =
  | 'allowed'
  | 'denied_by_policy' // closed-world default OR explicit denylist hit
  | 'unknown_role'; // active_role did not resolve to a profile

export interface RolePolicyDecision {
  /** True iff the requested tool/source passes the role's policy. */
  allowed: boolean;
  /** Machine-readable reason for the verdict. */
  reason: RolePolicyReason;
  /**
   * True iff FEATURE_ROLE_POLICY_ENFORCE is live in this environment.
   * When false, callers MUST treat `allowed=false` as advisory (log
   * only, do NOT block). When true, callers SHOULD block on deny.
   */
  enforced: boolean;
  /** The resolved role (canonical) or the raw input if unrecognized. */
  role: string | null;
  /** The tool/source name that was evaluated. */
  target: string;
  /** 'tool' | 'source' — what kind of target was checked. */
  kind: 'tool' | 'source';
  /** Human-readable one-liner for logs. */
  message: string;
}

/**
 * True iff the enforcer is live in this environment. When false, callers
 * run in shadow mode (log violations, never block).
 */
export function isEnforcementLive(): boolean {
  return isFeatureLive(FEATURE_NAME);
}

function denyMessage(kind: 'tool' | 'source', target: string, role: string | null): string {
  return `role '${role ?? '(null)'}' is NOT permitted ${kind} '${target}' (deny-by-default closed-world policy)`;
}

function allowMessage(kind: 'tool' | 'source', target: string, role: string | null): string {
  return `role '${role ?? '(null)'}' permitted ${kind} '${target}'`;
}

function decide(
  kind: 'tool' | 'source',
  role: string | null | undefined,
  target: string,
  check: (profile: AssistantRoleProfile, target: string) => boolean,
): RolePolicyDecision {
  const enforced = isEnforcementLive();
  const profile = getRoleProfile(role);

  // Unknown role → deny-by-default (closed world). An unrecognized role
  // never gets a tool/source.
  if (!profile) {
    return {
      allowed: false,
      reason: 'unknown_role',
      enforced,
      role: role ?? null,
      target,
      kind,
      message: `unrecognized role '${role ?? '(null)'}' — denying ${kind} '${target}' by default`,
    };
  }

  const allowed = check(profile, target);
  return {
    allowed,
    reason: allowed ? 'allowed' : 'denied_by_policy',
    enforced,
    role: profile.role,
    target,
    kind,
    message: allowed
      ? allowMessage(kind, target, profile.role)
      : denyMessage(kind, target, profile.role),
  };
}

/**
 * Validate that `role` is permitted to dispatch `toolName` under the
 * registry's closed-world policy. Returns a decision; never throws,
 * never blocks. Caller inspects `enforced` to decide whether to block.
 */
export function assertToolAllowed(
  role: string | null | undefined,
  toolName: string,
): RolePolicyDecision {
  return decide('tool', role, toolName, isToolAllowed);
}

/**
 * Validate that `role` is permitted to consult context-source `source`
 * under the registry's closed-world policy. Returns a decision; never
 * throws, never blocks.
 */
export function assertSourceAllowed(
  role: string | null | undefined,
  source: string,
): RolePolicyDecision {
  return decide('source', role, source, isContextSourceAllowed);
}

export interface ShadowLogContext {
  /** Surface that requested the tool/source (orb-live, /orb/tool, etc). */
  surface?: string;
  /** Correlation id (session / request) for cockpit drill-down. */
  session_id?: string;
  /** Optional actor id. */
  actor_id?: string;
}

/**
 * Shadow-log a denied decision. Safe to call from hot paths. In shadow
 * mode (flag off) this records the violation that WOULD have been
 * blocked; with the flag on the caller is expected to block, and this
 * log records that it was an enforced block. No-op for `allowed`
 * decisions.
 *
 * Uses console.warn (structured prefix) so it shows in Cloud Run logs
 * without coupling the enforcer to the OASIS event pipeline — the W3
 * shadow already emits the structured OASIS telemetry for the full
 * context-pack view.
 */
export function logPolicyViolation(
  decision: RolePolicyDecision,
  ctx: ShadowLogContext = {},
): void {
  if (decision.allowed) return;
  const mode = decision.enforced ? 'ENFORCED' : 'SHADOW';
  // eslint-disable-next-line no-console
  console.warn(
    `[role-policy-enforcer][${mode}] ${decision.message}` +
      (ctx.surface ? ` surface=${ctx.surface}` : '') +
      (ctx.session_id ? ` session=${ctx.session_id}` : '') +
      (ctx.actor_id ? ` actor=${ctx.actor_id}` : ''),
  );
}

/**
 * Convenience for call sites: check a tool, log on violation, and return
 * whether the caller SHOULD block. In shadow mode this always returns
 * false (never block) while still logging the violation. With the flag
 * on it returns true on a deny verdict.
 */
export function shouldBlockTool(
  role: string | null | undefined,
  toolName: string,
  ctx: ShadowLogContext = {},
): boolean {
  const decision = assertToolAllowed(role, toolName);
  logPolicyViolation(decision, ctx);
  return decision.enforced && !decision.allowed;
}

// ---------------------------------------------------------------------------
// VTID-ASSISTANT-ROLES — scoped role-aware enforcement
// ---------------------------------------------------------------------------

export const ROLE_AWARE_FEATURE_NAME = 'ROLE_AWARE_ASSISTANT';

/**
 * Roles whose registry tool allowlists have been RECONCILED with the real
 * ORB_TOOL_REGISTRY names and may therefore be enforced without denying
 * legitimate tools. The global FEATURE_ROLE_POLICY_ENFORCE flag stays off
 * until community/patient/professional/staff names are reconciled too —
 * this scoped path lets the developer/admin lanes go live first.
 *
 * 'exafy_admin' is intentionally absent: it is not an AssistantRole (no
 * profile) and the super-admin lane is never voice-policy-restricted.
 */
const RECONCILED_ROLES = new Set(['developer', 'admin']);

/**
 * Scoped variant of shouldBlockTool: enforces the registry policy ONLY for
 * roles in RECONCILED_ROLES, gated by FEATURE_ROLE_AWARE_ASSISTANT_ENV.
 * All other roles fall through to the existing global shadow behavior
 * (log-only unless FEATURE_ROLE_POLICY_ENFORCE is live).
 */
export function shouldBlockToolRoleAware(
  role: string | null | undefined,
  toolName: string,
  ctx: ShadowLogContext = {},
): boolean {
  const normalizedRole = String(role ?? '').toLowerCase();
  if (RECONCILED_ROLES.has(normalizedRole) && isFeatureLive(ROLE_AWARE_FEATURE_NAME)) {
    const decision = assertToolAllowed(normalizedRole, toolName);
    if (!decision.allowed) {
      logPolicyViolation({ ...decision, enforced: true }, ctx);
      return true;
    }
    return false;
  }
  // Not a reconciled role (or feature off) — existing global behavior.
  return shouldBlockTool(role, toolName, ctx);
}

/**
 * Convenience for call sites: check a context source, log on violation,
 * and return whether the caller SHOULD block.
 */
export function shouldBlockSource(
  role: string | null | undefined,
  source: string,
  ctx: ShadowLogContext = {},
): boolean {
  const decision = assertSourceAllowed(role, source);
  logPolicyViolation(decision, ctx);
  return decision.enforced && !decision.allowed;
}
