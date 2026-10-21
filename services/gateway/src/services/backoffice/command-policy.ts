/**
 * VTID-03842 — BackOffice command policy engine (pure, no I/O).
 *
 * Implements docs/backoffice/GOLDEN-WORKFLOWS.md §1.3 (tiers), §3.3
 * (separation of duties) and §4.3 (payload escalations) as a single function
 * the command route, the approval route, the Operator chat and ORB voice all
 * go through. Everything here is unit-tested exhaustively; the route layer
 * only fetches rows and calls the bridge.
 */
import { APPROVE_LEVEL_CAPABILITIES, type ErpCapability } from '../../constants/erp-capabilities';
import type { BackOfficeCommandSpec, CommandTier } from '../../constants/backoffice-commands';

export type CommandChannel = 'web' | 'chat' | 'voice' | 'system';

export interface PolicyActor {
  user_id: string;
  active_role: string | null;
  is_exafy_admin: boolean;
  capabilities: readonly string[];
  channel: CommandChannel;
}

export interface TenantPolicy {
  /** §4.3: any Commit command at or above this amount escalates to High-risk. AED, default 25,000. */
  high_risk_amount_threshold: number;
  /** §1.3: High-risk approval needs an MFA-backed session (aal2). */
  require_mfa_for_high: boolean;
}

export const DEFAULT_TENANT_POLICY: TenantPolicy = { high_risk_amount_threshold: 25_000, require_mfa_for_high: true };

export type PolicyOutcome = 'execute' | 'queue' | 'reject';

export interface PolicyDecision {
  tier: CommandTier;
  outcome: PolicyOutcome;
  /** machine-readable reason on reject/queue */
  reason?: string;
  /** which capability the requester lacked (on reject) or satisfied (on execute/queue) */
  required_capability?: string;
  /** what an approver must hold (High-risk only) */
  approve_capability: ErpCapability | null;
  /** §4.3 attributes that changed the tier, in evaluation order */
  escalations: string[];
}

const PLATFORM_READ_ONLY_ROLES = new Set(['developer', 'infra']);
const TIER_RANK: Record<CommandTier, number> = { read: 0, draft: 1, commit: 2, high: 3 };

function parseAmount(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

/** §4.3 threshold approver: "finance.approve or accounting.close per domain". */
export function thresholdApprover(spec: BackOfficeCommandSpec): ErpCapability {
  if (spec.type.startsWith('accounting.')) return 'accounting.close';
  return 'finance.approve';
}

export function holdsAny(actor: Pick<PolicyActor, 'capabilities' | 'is_exafy_admin'>, caps: readonly string[]): boolean {
  if (actor.is_exafy_admin) return true;
  return caps.some((c) => actor.capabilities.includes(c));
}

/**
 * Decide what happens to one command BEFORE any ERPClaw call.
 * `confirmed` is the requester's explicit desktop confirmation for Commit tier
 * (§1.3 "explicit confirmation naming the business outcome").
 */
export function evaluateCommand(
  spec: BackOfficeCommandSpec,
  payload: Record<string, unknown>,
  actor: PolicyActor,
  policy: TenantPolicy,
  confirmed: boolean,
): PolicyDecision {
  const escalations: string[] = [];
  let tier: CommandTier = spec.tier;
  let approve: ErpCapability | null = (spec.approveCapability as ErpCapability | null) ?? null;

  // 1. Requester capability (any-of). Exafy super-admins hold everything (§3.2).
  if (!holdsAny(actor, spec.capabilities)) {
    return { tier, outcome: 'reject', reason: 'capability_missing', required_capability: spec.capabilities[0], approve_capability: approve, escalations };
  }

  // 2. §3.3 rule 5: developer/infra ceiling is Read, enforced here, not by convention.
  if (!actor.is_exafy_admin && actor.active_role && PLATFORM_READ_ONLY_ROLES.has(actor.active_role) && tier !== 'read') {
    return { tier, outcome: 'reject', reason: 'platform_role_read_only', required_capability: spec.capabilities[0], approve_capability: approve, escalations };
  }

  // 3. §4.3 payload escalations (only a Commit can escalate; High stays High; Read/Draft never escalate).
  if (tier === 'commit') {
    if (spec.action === 'submit-payment' && payload.kind === 'pay') {
      tier = 'high'; approve = 'finance.pay'; escalations.push('kind:pay');
    }
    const tags = Array.isArray(payload.tags) ? payload.tags.map(String) : [];
    if (spec.action === 'submit-journal-entry' && tags.includes('payroll')) {
      tier = 'high'; approve = 'payroll.approve'; escalations.push('tags:payroll');
    }
    const amount = parseAmount(payload.amount);
    if (amount !== null && amount >= policy.high_risk_amount_threshold) {
      if (tier !== 'high') { tier = 'high'; approve = thresholdApprover(spec); }
      escalations.push(`amount>=${policy.high_risk_amount_threshold}`);
    }
  }
  if (tier === 'high' && !approve) approve = thresholdApprover(spec);

  // 4. Channel ceilings (§3.3 rule 4, §4.3): voice ≤ Draft; chat ≤ Commit (High-risk queues, never confirms in chat).
  if (actor.channel === 'voice' && TIER_RANK[tier] >= TIER_RANK.commit) {
    return { tier, outcome: 'reject', reason: 'voice_not_permitted', approve_capability: approve, escalations };
  }

  // 5. Commit needs the explicit confirmation; High-risk always queues for a different approver.
  if (tier === 'high') {
    return { tier, outcome: 'queue', reason: 'awaiting_approval', approve_capability: approve, escalations };
  }
  if (tier === 'commit' && !confirmed) {
    return { tier, outcome: 'reject', reason: 'confirmation_required', approve_capability: null, escalations };
  }
  return { tier, outcome: 'execute', approve_capability: null, escalations };
}

export interface ApprovalActor extends PolicyActor {
  /** session assurance level from the JWT (`aal2` = MFA-backed) */
  aal: string | null;
}

export interface ApprovalCheck { ok: boolean; reason?: string }

/**
 * May `approver` decide a queued High-risk command? §1.3/§3.3: requester ≠
 * approver (no exception, including Exafy super-admins), approver holds the
 * approve-level capability, MFA-backed session, never by voice or chat.
 */
export function evaluateApproval(
  approver: ApprovalActor,
  requesterId: string,
  approveCapability: ErpCapability | null,
  policy: TenantPolicy,
): ApprovalCheck {
  if (approver.user_id === requesterId) return { ok: false, reason: 'self_approval_forbidden' };
  if (approver.channel !== 'web') return { ok: false, reason: 'approval_requires_approvals_screen' };
  if (!approveCapability || !APPROVE_LEVEL_CAPABILITIES.includes(approveCapability) && approveCapability !== 'erp.admin') {
    return { ok: false, reason: 'no_approve_capability_on_request' };
  }
  if (!holdsAny(approver, [approveCapability])) return { ok: false, reason: 'approver_capability_missing' };
  if (!approver.is_exafy_admin && approver.active_role && PLATFORM_READ_ONLY_ROLES.has(approver.active_role)) {
    return { ok: false, reason: 'platform_role_read_only' };
  }
  if (policy.require_mfa_for_high && approver.aal !== 'aal2') return { ok: false, reason: 'mfa_required' };
  return { ok: true };
}

/**
 * §3.3 rule 2 — minimum staffing: at least two distinct people in the tenant
 * hold the approve capability (the requester does not count as one of them
 * for their own request). Otherwise the request still queues, with reason
 * `no_eligible_approver`, and Settings › Access shows the gap.
 */
export function eligibleApproverCount(holders: readonly string[], requesterId: string): number {
  return new Set(holders.filter((u) => u !== requesterId)).size;
}
