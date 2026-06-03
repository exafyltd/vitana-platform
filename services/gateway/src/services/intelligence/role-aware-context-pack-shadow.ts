/**
 * Role-aware context pack — shadow mode (VTID-03241, Phase 1 W3-E1 PR 4).
 *
 * READS the active role and the assistant's existing context pack, then
 * emits a `assistant.role.context_pack.shadow` OASIS event describing
 * what WOULD have been allowed / blocked under the role registry's
 * policy (VTID-03240). DOES NOT mutate the live context pack. DOES NOT
 * change which tools the assistant dispatches.
 *
 * The shadow exists so we can validate the role registry against real
 * production traffic before any cutover. Once the shadow events
 * accumulate, a separate canary PR (later) flips the FEATURE flag and
 * starts enforcing the policy.
 *
 * Wire-up rule (caller responsibility, NOT enforced here): callers in
 * the context-pack-builder / assistant turn handler invoke
 * `emitRoleAwareContextPackShadow({ ... })` AFTER they've built their
 * actual context pack but BEFORE response generation. Fire-and-forget;
 * the shadow emit must never extend user-perceived latency.
 *
 * Gated by FEATURE_ROLE_AWARE_CONTEXT_SHADOW_ENV (off | staging-only |
 * staging+prod), default off. Same flag pattern as W1's latency
 * tracker and W2's shadow harness.
 */

import { emitOasisEvent } from '../oasis-event-service';
import { isFeatureLive } from '../feature-flags';
import {
  type AssistantRole,
  type AssistantRoleProfile,
  getRoleProfile,
  isContextSourceAllowed,
  isToolAllowed,
} from './assistant-role-registry';

const FEATURE_NAME = 'ROLE_AWARE_CONTEXT_SHADOW';

export interface RoleAwareShadowInput {
  /** Stable id for the turn / request — used to correlate shadow events. */
  session_id: string;
  /** Optional user id for cockpit drill-down. */
  actor_id?: string;
  /** Active role the surface is operating in. May be null/unknown. */
  active_role: string | null | undefined;
  /** Other roles this user holds (informational; not used for gating). */
  available_roles?: readonly string[];
  /** Surface that triggered the turn (orb-live, /orb/chat, command-hub, etc). */
  surface?: string;
  /**
   * Context source ids the live context-pack-builder actually consulted
   * for this turn. We compare against the role profile's allowlist to
   * compute would-block.
   */
  context_sources_consulted: readonly string[];
  /**
   * Tools the assistant has available to dispatch this turn. We compare
   * against the role profile's tool policy to compute would-deny.
   */
  tools_available: readonly string[];
  /** Tool the assistant actually dispatched, if any. */
  tool_dispatched?: string | null;
}

export interface RoleAwareShadowDecision {
  active_role: string | null;
  role_recognized: boolean;
  would_allow_context_sources: string[];
  would_block_context_sources: string[];
  would_allow_tools: string[];
  would_deny_tools: string[];
  dispatched_tool_would_pass: boolean | null;
  policy_match_rate: number | null;
}

/**
 * Pure decision function (no I/O). Exposed for tests and for the
 * cockpit's "what would happen if I switched role X" preview.
 */
export function decideRoleAwareShadow(input: RoleAwareShadowInput): RoleAwareShadowDecision {
  const profile: AssistantRoleProfile | null = getRoleProfile(input.active_role);

  if (!profile) {
    return {
      active_role: input.active_role ?? null,
      role_recognized: false,
      would_allow_context_sources: [],
      would_block_context_sources: [...input.context_sources_consulted],
      would_allow_tools: [],
      would_deny_tools: [...input.tools_available],
      dispatched_tool_would_pass: null,
      policy_match_rate: null,
    };
  }

  const wouldAllowSources: string[] = [];
  const wouldBlockSources: string[] = [];
  for (const sid of input.context_sources_consulted) {
    if (isContextSourceAllowed(profile, sid)) wouldAllowSources.push(sid);
    else wouldBlockSources.push(sid);
  }

  const wouldAllowTools: string[] = [];
  const wouldDenyTools: string[] = [];
  for (const t of input.tools_available) {
    if (isToolAllowed(profile, t)) wouldAllowTools.push(t);
    else wouldDenyTools.push(t);
  }

  const dispatchedTool = input.tool_dispatched ?? null;
  const dispatched_tool_would_pass = dispatchedTool == null
    ? null
    : isToolAllowed(profile, dispatchedTool);

  // policy_match_rate: fraction of (consulted sources + available tools)
  // that the role would have allowed. 1.0 = perfect alignment with the
  // policy; lower = policy would have blocked some inputs.
  const totalDecisions = input.context_sources_consulted.length + input.tools_available.length;
  const matchedDecisions = wouldAllowSources.length + wouldAllowTools.length;
  const policy_match_rate = totalDecisions > 0 ? matchedDecisions / totalDecisions : null;

  return {
    active_role: profile.role,
    role_recognized: true,
    would_allow_context_sources: wouldAllowSources,
    would_block_context_sources: wouldBlockSources,
    would_allow_tools: wouldAllowTools,
    would_deny_tools: wouldDenyTools,
    dispatched_tool_would_pass,
    policy_match_rate,
  };
}

/**
 * Fire-and-forget emit. Safe to call from hot paths. Returns true if
 * the shadow ran + emitted, false if the flag is off (no-op). Errors
 * inside the emit are caught and swallowed — this is telemetry, never
 * load-bearing.
 */
export async function emitRoleAwareContextPackShadow(
  input: RoleAwareShadowInput,
): Promise<boolean> {
  if (!isFeatureLive(FEATURE_NAME)) return false;

  const decision = decideRoleAwareShadow(input);

  try {
    await emitOasisEvent({
      vtid: 'VTID-03241',
      type: 'assistant.role.context_pack.shadow',
      source: 'gateway/role-aware-context-pack-shadow',
      status: decision.role_recognized ? 'info' : 'warning',
      message: decision.role_recognized
        ? `shadow ${decision.active_role}: ${decision.would_block_context_sources.length} src + ${decision.would_deny_tools.length} tool(s) would be blocked`
        : `shadow: unrecognized active_role '${input.active_role ?? '(null)'}'`,
      actor_id: input.actor_id,
      payload: {
        env: process.env.VITANA_ENV ?? 'unknown',
        session_id: input.session_id,
        surface: input.surface,
        active_role: decision.active_role,
        available_roles: input.available_roles ?? [],
        role_recognized: decision.role_recognized,
        consulted_sources: input.context_sources_consulted,
        available_tools: input.tools_available,
        tool_dispatched: input.tool_dispatched ?? null,
        would_allow_sources: decision.would_allow_context_sources,
        would_block_sources: decision.would_block_context_sources,
        would_allow_tools: decision.would_allow_tools,
        would_deny_tools: decision.would_deny_tools,
        dispatched_tool_would_pass: decision.dispatched_tool_would_pass,
        policy_match_rate: decision.policy_match_rate,
      },
    });
  } catch {
    // Telemetry must never break the turn.
  }
  return true;
}

/**
 * Helper for tests: synchronous decision without the emit. Same
 * behavior as decideRoleAwareShadow; named for clarity at the call
 * site that doesn't care about telemetry.
 */
export function shadowDecisionOnly(input: RoleAwareShadowInput): RoleAwareShadowDecision {
  return decideRoleAwareShadow(input);
}

export type { AssistantRole };
