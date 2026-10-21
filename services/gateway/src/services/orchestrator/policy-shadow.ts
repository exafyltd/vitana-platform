/**
 * VTID-04362 (Orchestrator v2, P2 — shadow): what the policy engine WOULD
 * decide for every real ORB tool call, recorded in memory and never enforced
 * (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.2, §5 P2).
 *
 * Every dispatch through dispatchOrbTool() classifies the tool
 * (tool-catalog.ts), evaluates it for the caller's role on the voice channel
 * (policy.ts evaluateToolCall) and records the verdict here. The shadow
 * window is how the default grants get reviewed against real traffic before
 * anything is switched to enforce: every `deny` and `escalate` below is a
 * call that enforcement would have changed.
 *
 * Bounded by construction: at most MAX_AGGREGATE_KEYS aggregate rows
 * (role|tool|decision) and a ring of the last RECENT_LIMIT non-allow
 * decisions. Per process, reset on deploy — this is a review aid, not a
 * ledger; the OASIS/agent_runs record is P3/P7 work.
 *
 * recordToolDecision() never throws: a shadow must not be able to break the
 * call it observes.
 */

import { classifyOrbTool } from './tool-catalog';
import { evaluateToolCall, type PolicyDecisionKind } from './policy';
import type { AgentChannel } from './context';

export const MAX_AGGREGATE_KEYS = 2000;
export const RECENT_LIMIT = 200;

export interface ShadowAggregate {
  role: string;
  tool: string;
  domain: string;
  tier: string;
  decision: PolicyDecisionKind;
  reason: string;
  count: number;
  last_at: string;
}

export interface ShadowRecent {
  at: string;
  role: string;
  tool: string;
  domain: string;
  tier: string;
  decision: PolicyDecisionKind;
  reason: string;
  session_id: string | null;
}

const aggregates = new Map<string, ShadowAggregate>();
const recent: ShadowRecent[] = [];
let totalCalls = 0;
let droppedKeys = 0;
let errors = 0;
let since = new Date().toISOString();

export interface ShadowCallInput {
  tool: string;
  role: string | null | undefined;
  channel?: AgentChannel;
  session_id?: string | null;
  now?: Date;
}

/** Evaluate and record one tool call. Returns the decision, or null on any internal error. */
export function recordToolDecision(input: ShadowCallInput): PolicyDecisionKind | null {
  try {
    const role = String(input.role || '').toLowerCase() || 'anonymous';
    const channel: AgentChannel = input.channel ?? 'voice';
    const cap = classifyOrbTool(input.tool);
    const verdict = evaluateToolCall({ platform_role: role, orgs: [], channel }, cap);
    const at = (input.now ?? new Date()).toISOString();
    totalCalls++;

    const key = `${role}|${input.tool}|${verdict.decision}`;
    const existing = aggregates.get(key);
    if (existing) {
      existing.count++;
      existing.last_at = at;
      existing.reason = verdict.reason;
    } else if (aggregates.size < MAX_AGGREGATE_KEYS) {
      aggregates.set(key, {
        role, tool: input.tool, domain: cap.domain, tier: cap.tier,
        decision: verdict.decision, reason: verdict.reason, count: 1, last_at: at,
      });
    } else {
      droppedKeys++;
    }

    if (verdict.decision !== 'allow') {
      recent.push({
        at, role, tool: input.tool, domain: cap.domain, tier: cap.tier,
        decision: verdict.decision, reason: verdict.reason, session_id: input.session_id ?? null,
      });
      if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
    }
    return verdict.decision;
  } catch {
    errors++;
    return null;
  }
}

export interface ShadowSnapshot {
  enforced: false;
  since: string;
  total_calls: number;
  by_decision: Record<PolicyDecisionKind, number>;
  aggregates: ShadowAggregate[];
  recent_non_allow: ShadowRecent[];
  dropped_keys: number;
  errors: number;
}

export function shadowSnapshot(): ShadowSnapshot {
  const by_decision: Record<PolicyDecisionKind, number> = { allow: 0, escalate: 0, deny: 0 };
  const rows = [...aggregates.values()];
  for (const r of rows) by_decision[r.decision] += r.count;
  // Non-allow first (what enforcement would change), then by volume.
  const rank: Record<PolicyDecisionKind, number> = { deny: 0, escalate: 1, allow: 2 };
  rows.sort((a, b) => rank[a.decision] - rank[b.decision] || b.count - a.count);
  return {
    enforced: false,
    since,
    total_calls: totalCalls,
    by_decision,
    aggregates: rows.map((r) => ({ ...r })),
    recent_non_allow: [...recent].reverse(),
    dropped_keys: droppedKeys,
    errors,
  };
}

/** Test/ops helper: clear the window. */
export function resetShadow(now: Date = new Date()): void {
  aggregates.clear();
  recent.length = 0;
  totalCalls = 0;
  droppedKeys = 0;
  errors = 0;
  since = now.toISOString();
}
