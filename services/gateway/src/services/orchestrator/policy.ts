/**
 * VTID-04325 (Orchestrator v2, P2 — shadow): default capability grants per
 * role (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.2, owner decision §8.2).
 *
 * Pure policy: given an AgentContext (VTID-04319) and a requested action
 * (domain + tier), answer allow / escalate / deny with the reason. Nothing in
 * the gateway enforces this yet — it is exposed read-only at
 * GET /api/v1/orchestrator/policy so the defaults can be reviewed against
 * real traffic before any path is switched onto it.
 *
 * Three ceilings, the effective one is the lowest:
 *   1. the ROLE ceiling per domain (ROLE_DEFAULTS below);
 *   2. the CHANNEL ceiling — voice can at most draft (a spoken "yes" is not a
 *      reliable commit signal, same rule the BackOffice orchestrator uses,
 *      VTID-03842); chat and web can commit;
 *   3. for commerce, the ORG role (owner/admin commit, member draft);
 *      for backoffice, the ERP capability grant tier when one is supplied.
 *
 * `high` is never allowed directly: when the ceiling reaches commit it
 * escalates to maker-checker (a second person approves, requester ≠
 * approver), and it is only approvable over web. exafy_admin does not
 * bypass any of this — it is a separate trust flag, not a policy tier.
 */

import type { AgentChannel, AgentContext } from './context';

export type PolicyDomain =
  | 'community' | 'health' | 'professional' | 'staff' | 'admin'
  | 'backoffice' | 'commerce' | 'dev' | 'ops';

export const POLICY_DOMAINS: readonly PolicyDomain[] = [
  'community', 'health', 'professional', 'staff', 'admin',
  'backoffice', 'commerce', 'dev', 'ops',
];

export type PolicyTier = 'none' | 'read' | 'draft' | 'commit' | 'high';
const TIER_RANK: Record<PolicyTier, number> = { none: 0, read: 1, draft: 2, commit: 3, high: 4 };
export const POLICY_TIERS: readonly PolicyTier[] = ['none', 'read', 'draft', 'commit', 'high'];

type RoleCeilings = Partial<Record<PolicyDomain, PolicyTier>>;

/**
 * Role ceilings. A domain that is not listed is `none`. Vitana roles are
 * switchable modes (VTID-03993): a member acts on their own health data in
 * community or patient mode, not while in professional or staff mode.
 */
export const ROLE_DEFAULTS: Readonly<Record<string, RoleCeilings>> = Object.freeze({
  community: { community: 'commit', health: 'commit' },
  patient: { community: 'commit', health: 'commit' },
  professional: { community: 'read', health: 'read', professional: 'draft' },
  staff: { community: 'read', staff: 'draft' },
  backoffice: { community: 'read', backoffice: 'read' },
  admin: { community: 'read', professional: 'read', staff: 'read', admin: 'commit' },
  developer: { community: 'read', admin: 'read', backoffice: 'read', dev: 'commit', ops: 'read' },
  infra: { dev: 'read', ops: 'commit' },
  // VTID-04362: an unauthenticated ORB session (pre-login /maxina) may only
  // read community information — its catalog is navigation + knowledge.
  anonymous: { community: 'read' },
});

export const CHANNEL_CEILINGS: Readonly<Record<AgentChannel, PolicyTier>> = Object.freeze({
  voice: 'draft',
  chat: 'commit',
  web: 'commit',
  system: 'commit',
  ci: 'commit',
});

/** Channels a maker-checker approval may be given from. */
export const APPROVAL_CHANNELS: readonly AgentChannel[] = ['web'];

export const ORG_ROLE_CEILINGS: Readonly<Record<string, PolicyTier>> = Object.freeze({
  owner: 'commit',
  admin: 'commit',
  member: 'draft',
  // VTID-04400: the roles partner_organization_members actually stores
  // (routes/partner-orgs.ts ORG_ROLES). Without them every real membership
  // resolved to 'none' and no commerce agent could ever run.
  org_admin: 'commit',
  staff: 'draft',
  professional: 'draft',
});

function minTier(a: PolicyTier, b: PolicyTier): PolicyTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}
function maxTier(a: PolicyTier, b: PolicyTier): PolicyTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export function isPolicyDomain(v: unknown): v is PolicyDomain {
  return typeof v === 'string' && (POLICY_DOMAINS as readonly string[]).includes(v);
}
export function isPolicyTier(v: unknown): v is PolicyTier {
  return typeof v === 'string' && (POLICY_TIERS as readonly string[]).includes(v);
}

export interface PolicyExtras {
  /** Highest ERP capability tier the user holds (erp_capability_grants), if known. */
  backoffice_grant_tier?: PolicyTier | null;
}

/** The ceiling from role (and org / grants), before the channel is applied. */
export function roleCeiling(ctx: Pick<AgentContext, 'platform_role' | 'orgs'>, domain: PolicyDomain, extras: PolicyExtras = {}): PolicyTier {
  if (domain === 'commerce') {
    // Commerce authority comes from organisation membership, never from the
    // platform role.
    let best: PolicyTier = 'none';
    for (const o of ctx.orgs ?? []) best = maxTier(best, ORG_ROLE_CEILINGS[String(o.org_role || '').toLowerCase()] ?? 'none');
    return best;
  }
  const role = String(ctx.platform_role || '').toLowerCase();
  let ceiling: PolicyTier = ROLE_DEFAULTS[role]?.[domain] ?? 'none';
  if (domain === 'backoffice' && role === 'backoffice' && extras.backoffice_grant_tier && isPolicyTier(extras.backoffice_grant_tier)) {
    ceiling = extras.backoffice_grant_tier;
  }
  return ceiling;
}

/** Role/org ceiling, then capped by the channel. */
export function effectiveCeiling(ctx: Pick<AgentContext, 'platform_role' | 'orgs' | 'channel'>, domain: PolicyDomain, extras: PolicyExtras = {}): PolicyTier {
  return minTier(roleCeiling(ctx, domain, extras), CHANNEL_CEILINGS[ctx.channel] ?? 'read');
}

export type PolicyDecisionKind = 'allow' | 'escalate' | 'deny';

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  domain: PolicyDomain;
  requested: PolicyTier;
  role_ceiling: PolicyTier;
  channel_ceiling: PolicyTier;
  effective_ceiling: PolicyTier;
  reason: string;
}

export function evaluatePolicy(
  ctx: Pick<AgentContext, 'platform_role' | 'orgs' | 'channel'>,
  domain: PolicyDomain,
  requested: PolicyTier,
  extras: PolicyExtras = {},
): PolicyDecision {
  const role_ceiling = roleCeiling(ctx, domain, extras);
  const channel_ceiling = CHANNEL_CEILINGS[ctx.channel] ?? 'read';
  const effective_ceiling = minTier(role_ceiling, channel_ceiling);
  const base = { domain, requested, role_ceiling, channel_ceiling, effective_ceiling };

  if (requested === 'none') return { ...base, decision: 'allow', reason: 'nothing requested' };

  if (requested === 'high') {
    // High-risk is never direct: it needs a commit-level requester and a
    // second approver on an approval channel.
    if (TIER_RANK[role_ceiling] >= TIER_RANK.commit) {
      return { ...base, decision: 'escalate', reason: `high-risk ${domain} action queues for maker-checker approval (${APPROVAL_CHANNELS.join('/')})` };
    }
    return { ...base, decision: 'deny', reason: `role ceiling for ${domain} is ${role_ceiling}; high-risk needs commit` };
  }

  if (TIER_RANK[requested] <= TIER_RANK[effective_ceiling]) {
    return { ...base, decision: 'allow', reason: `${requested} within ${effective_ceiling}` };
  }
  if (TIER_RANK[requested] <= TIER_RANK[role_ceiling]) {
    // The role may do it, this channel may not: hand off to a channel that can.
    return { ...base, decision: 'escalate', reason: `${ctx.channel} is capped at ${channel_ceiling}; confirm ${requested} in chat or web` };
  }
  return { ...base, decision: 'deny', reason: `role ceiling for ${domain} is ${role_ceiling}` };
}

/** Every domain's effective ceiling for this context. */
export function ceilingsFor(ctx: Pick<AgentContext, 'platform_role' | 'orgs' | 'channel'>, extras: PolicyExtras = {}): Record<PolicyDomain, PolicyTier> {
  const out = {} as Record<PolicyDomain, PolicyTier>;
  for (const d of POLICY_DOMAINS) out[d] = effectiveCeiling(ctx, d, extras);
  return out;
}

/** The whole default table, for review. */
export function policyDefaults() {
  return {
    domains: POLICY_DOMAINS,
    tiers: POLICY_TIERS,
    roles: ROLE_DEFAULTS,
    channels: CHANNEL_CEILINGS,
    approval_channels: APPROVAL_CHANNELS,
    org_roles: ORG_ROLE_CEILINGS,
    enforced: false,
  };
}

/**
 * VTID-04362: evaluate one ORB tool call from its catalog entry
 * (tool-catalog.ts). Same verdicts as evaluatePolicy, plus one carve-out from
 * plan §3.2: a user-own, low-risk commit (`self`) may be committed by voice
 * when the role may commit in that domain — logging water or setting an
 * alarm must not bounce the user to a screen.
 */
export function evaluateToolCall(
  ctx: Pick<AgentContext, 'platform_role' | 'orgs' | 'channel'>,
  tool: { domain: PolicyDomain; tier: PolicyTier; self: boolean },
  extras: PolicyExtras = {},
): PolicyDecision {
  const base = evaluatePolicy(ctx, tool.domain, tool.tier, extras);
  if (
    base.decision === 'escalate'
    && ctx.channel === 'voice'
    && tool.self
    && tool.tier === 'commit'
    && TIER_RANK[base.role_ceiling] >= TIER_RANK.commit
  ) {
    return { ...base, decision: 'allow', reason: 'user-own low-risk commit confirmed by voice' };
  }
  return base;
}
