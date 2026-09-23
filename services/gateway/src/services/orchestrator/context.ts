/**
 * VTID-04319 (Orchestrator v2, P1): the Principal & Context Resolver
 * (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.1).
 *
 * One function answers "who is asking, as which role, from where, over which
 * channel" for every agent path. P1 ships it read-only: it is exposed at
 * GET /api/v1/orchestrator/context, but no existing
 * decision is re-routed through it yet (that is P2's policy engine). The
 * pieces it combines already existed separately:
 *   - platform role: orchestrator/active-role.ts (VTID-04318), the ORB's rule;
 *   - surface: orb/live/surface.ts resolveOrbSurface (VTID-03848);
 *   - org role: partner_organization_members (commerce partner onboarding).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveOrbSurface, type OrbSurface } from '../../orb/live/surface';
import { pickEffectiveRole } from './active-role';

export type AgentChannel = 'voice' | 'chat' | 'web' | 'system' | 'ci';
export const AGENT_CHANNELS: readonly AgentChannel[] = ['voice', 'chat', 'web', 'system', 'ci'];

export interface AgentOrgContext {
  org_id: string;
  org_key: string | null;
  org_role: string;
  commerce_vertical: string | null;
}

export interface AgentContext {
  user_id: string | null;
  tenant_id: string | null;
  platform_role: string | null;
  /** user_tenants.active_role, kept so a role_preferences override is visible. */
  tenant_active_role: string | null;
  role_source: 'role_preferences' | 'user_tenants' | 'none';
  orgs: AgentOrgContext[];
  surface: OrbSurface;
  channel: AgentChannel;
  exafy_admin: boolean;
  locale: string | null;
  resolved_at: string;
}

export interface ContextInputs {
  user_id: string | null;
  tenant_id: string | null;
  exafy_admin?: boolean;
  role_preference?: string | null;
  tenant_active_role?: string | null;
  orgs?: AgentOrgContext[];
  current_route?: string | null;
  is_mobile?: boolean | null;
  explicit_surface?: string | null;
  channel?: string | null;
  locale?: string | null;
  now?: Date;
}

export function normalizeChannel(v: unknown): AgentChannel {
  return typeof v === 'string' && (AGENT_CHANNELS as readonly string[]).includes(v) ? (v as AgentChannel) : 'web';
}

/** Pure: combines already-fetched facts into the context. */
export function buildAgentContext(i: ContextInputs): AgentContext {
  const platform_role = pickEffectiveRole(i.role_preference, i.tenant_active_role);
  const pref = typeof i.role_preference === 'string' && i.role_preference.trim() ? i.role_preference.trim() : null;
  const tenantRole = typeof i.tenant_active_role === 'string' && i.tenant_active_role.trim() ? i.tenant_active_role.trim() : null;
  return {
    user_id: i.user_id,
    tenant_id: i.tenant_id,
    platform_role,
    tenant_active_role: tenantRole,
    role_source: pref ? 'role_preferences' : tenantRole ? 'user_tenants' : 'none',
    orgs: i.orgs ?? [],
    surface: resolveOrbSurface({
      currentRoute: i.current_route ?? null,
      isMobile: i.is_mobile ?? null,
      explicit: i.explicit_surface ?? null,
    }),
    channel: normalizeChannel(i.channel),
    exafy_admin: i.exafy_admin === true,
    locale: i.locale ?? null,
    resolved_at: (i.now ?? new Date()).toISOString(),
  };
}

/**
 * Fetch the facts and build the context. Every read fails soft (logged, the
 * field stays empty) — the resolver describes, it does not gate, in P1.
 */
export async function resolveAgentContext(
  sb: SupabaseClient,
  i: Omit<ContextInputs, 'role_preference' | 'tenant_active_role' | 'orgs'>,
): Promise<AgentContext> {
  let role_preference: string | null = null;
  let tenant_active_role: string | null = null;
  let orgs: AgentOrgContext[] = [];

  if (i.user_id) {
    const uid = i.user_id;
    const tid = i.tenant_id;
    const [prefRes, tenantRes, orgRes] = await Promise.all([
      tid
        ? sb.from('role_preferences').select('role').eq('user_id', uid).eq('tenant_id', tid)
            .order('updated_at', { ascending: false }).limit(1)
        : Promise.resolve({ data: [], error: null } as any),
      tid
        ? sb.from('user_tenants').select('active_role').eq('user_id', uid).eq('tenant_id', tid).limit(1)
        : Promise.resolve({ data: [], error: null } as any),
      sb.from('partner_organization_members')
        .select('role, partner_organization_id, partner_organizations(id, org_key, commerce_vertical)')
        .eq('user_id', uid),
    ]);
    if (prefRes.error) console.warn(`[orchestrator/context] role_preferences: ${prefRes.error.message}`);
    else role_preference = (prefRes.data as any[])?.[0]?.role ?? null;
    if (tenantRes.error) console.warn(`[orchestrator/context] user_tenants: ${tenantRes.error.message}`);
    else tenant_active_role = (tenantRes.data as any[])?.[0]?.active_role ?? null;
    if (orgRes.error) console.warn(`[orchestrator/context] partner_organization_members: ${orgRes.error.message}`);
    else {
      orgs = ((orgRes.data as any[]) || []).map((m) => {
        const org = Array.isArray(m.partner_organizations) ? m.partner_organizations[0] : m.partner_organizations;
        return {
          org_id: String(org?.id ?? m.partner_organization_id),
          org_key: org?.org_key ?? null,
          org_role: String(m.role),
          commerce_vertical: org?.commerce_vertical ?? null,
        };
      });
    }
  }

  return buildAgentContext({ ...i, role_preference, tenant_active_role, orgs });
}
