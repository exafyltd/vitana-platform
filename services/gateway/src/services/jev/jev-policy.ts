/**
 * VTID-04754: the Jev plane × data-class policy (docs/JEV-INTEGRATION-PLAN.md §10.3).
 *
 * Every decision declares the planes it may run on and the class of data it
 * sends to TypeSafe. Every call is checked here before the tenant budget and
 * before any token is spent. Pure: the caller supplies the tenant flag.
 *
 *   telemetry, business  — allowed on the internal plane now
 *   member_content       — member plane rules (JEV_COMMUNITY_ENABLED + tenant
 *                          flag lists 'member' + a monthly budget), whoever
 *                          the caller is — including Community Autopilot
 *   phi                  — refused until a TypeSafe DPA/zero-retention
 *                          agreement is signed AND a PHI redaction gate
 *                          exists. Both are code changes, so no flag opens it.
 *
 * Planes: patient is off. system_autopilot may send telemetry; member data
 * follows the member rules. partner_org needs the tenant flag to list it.
 */

import { z } from 'zod';
import { isJevCommunityEnabled, JevPlane, JEV_PLANES } from './jev-access';

export const JEV_DATA_CLASSES = ['telemetry', 'business', 'member_content', 'phi'] as const;
export type JevDataClass = (typeof JEV_DATA_CLASSES)[number];

/** Spend with no tenant (ops/CI telemetry) is counted under this id. */
export const JEV_PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';

/** tenant_settings.feature_flags.jev */
export interface JevTenantFlag {
  enabled: boolean;
  planes: JevPlane[];
  monthly_budget_usd: number | null;
}

/**
 * Applied when a tenant has no jev flag: the internal planes run (owner
 * decision 2026-09-25, internal is unlimited by design), nothing member-facing
 * does. An explicit flag always wins, including enabled:false for internal.
 */
export const JEV_DEFAULT_TENANT_FLAG: JevTenantFlag = Object.freeze({
  enabled: true,
  planes: ['internal', 'system_autopilot'],
  monthly_budget_usd: null,
}) as JevTenantFlag;

const flagSchema = z.object({
  enabled: z.boolean(),
  planes: z.array(z.enum(JEV_PLANES)).default([]),
  monthly_budget_usd: z.number().finite().nonnegative().nullable().optional(),
});

/** Parses the raw flag. Absent → default; malformed → null (callers fail closed). */
export function parseJevTenantFlag(raw: unknown): JevTenantFlag | null {
  if (raw === undefined || raw === null) return JEV_DEFAULT_TENANT_FLAG;
  const parsed = flagSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { enabled: parsed.data.enabled, planes: parsed.data.planes, monthly_budget_usd: parsed.data.monthly_budget_usd ?? null };
}

export type JevPolicyDenyReason =
  | 'plane_not_permitted_for_decision'
  | 'phi_refused_no_dpa'
  | 'patient_plane_off'
  | 'community_not_enabled'
  | 'autopilot_data_not_permitted'
  | 'tenant_jev_disabled'
  | 'tenant_plane_off'
  | 'member_budget_missing';

export type JevPolicyResult = { allowed: true } | { allowed: false; reason: JevPolicyDenyReason };

export interface JevPolicyInput {
  plane: JevPlane;
  data: JevDataClass;
  decisionPlanes: readonly JevPlane[];
  flag: JevTenantFlag;
  env?: NodeJS.ProcessEnv;
}

export function evaluateJevPolicy(p: JevPolicyInput): JevPolicyResult {
  const env = p.env ?? process.env;
  if (p.data === 'phi') return { allowed: false, reason: 'phi_refused_no_dpa' };
  if (p.plane === 'patient') return { allowed: false, reason: 'patient_plane_off' };
  if (!p.decisionPlanes.includes(p.plane)) return { allowed: false, reason: 'plane_not_permitted_for_decision' };
  if (!p.flag.enabled) return { allowed: false, reason: 'tenant_jev_disabled' };

  const memberRules = p.plane === 'member' || p.data === 'member_content';
  if (memberRules) {
    if (!isJevCommunityEnabled(env)) return { allowed: false, reason: 'community_not_enabled' };
    if (!p.flag.planes.includes('member')) return { allowed: false, reason: 'tenant_plane_off' };
    if (!(p.flag.monthly_budget_usd && p.flag.monthly_budget_usd > 0)) return { allowed: false, reason: 'member_budget_missing' };
  } else if (p.plane === 'system_autopilot' && p.data !== 'telemetry') {
    return { allowed: false, reason: 'autopilot_data_not_permitted' };
  }

  if (!p.flag.planes.includes(p.plane)) return { allowed: false, reason: 'tenant_plane_off' };
  return { allowed: true };
}

/** Telemetry is platform data; everything else belongs to one tenant. */
export function isTenantScoped(data: JevDataClass): boolean {
  return data !== 'telemetry';
}
