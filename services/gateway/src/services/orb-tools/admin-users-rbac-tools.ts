/**
 * Admin voice tools — Users & RBAC (Wave 3, plan section B1).
 *
 * Thin dispatch layer over existing routes/admin-users.ts,
 * admin-users-lookup.ts, role-admin.ts, admin-trust-tier.ts,
 * tenant-admin/overview.ts. No new backend behaviour.
 *
 * Every route here requires a real Supabase JWT (requireAdminAuth /
 * verifyAdminAccess / canManageRoles / requireTenantAdmin) — handlers
 * forward the caller's own session JWT (identity.user_jwt) as Bearer and
 * fail clearly (no fabricated credentials) when it isn't present.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall, relAge, clampLimit } from './developer-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

const ADMIN_ROLES = new Set(['admin', 'exafy_admin']);

/** Returns a deny result when the identity may not use admin tools, else null. */
export function adminGate(id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_id) {
    return { ok: false, error: 'admin tools require an authenticated user.' };
  }
  const role = String(id.role ?? '').toLowerCase();
  if (!ADMIN_ROLES.has(role)) {
    return { ok: false, error: 'admin_role_required' };
  }
  return null;
}

export const NO_ADMIN_SESSION: OrbToolResult = {
  ok: true,
  result: { reason: 'no_admin_session' },
  text: "This needs a signed-in admin session — I don't have one for this voice session.",
};

export function authHeaders(id: OrbToolIdentity): Record<string, string> {
  return id.user_jwt ? { Authorization: `Bearer ${id.user_jwt}` } : {};
}

// ---------------------------------------------------------------------------
// 1. admin_lookup_user — GET /api/v1/admin/users/lookup
// ---------------------------------------------------------------------------

export const admin_lookup_user: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const token = String(args.query ?? args.token ?? '').trim();
  if (!token) return { ok: false, error: 'admin_lookup_user requires a query (name, email, or vitana_id).' };
  const limit = clampLimit(args.limit, 10, 50);
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/users/lookup?token=${encodeURIComponent(token)}&limit=${limit}`,
    { headers: authHeaders(id) },
  );
  if (!ok || body.ok !== true) return { ok: false, error: `admin_lookup_user failed (${status}): ${String(body.error ?? 'unknown')}` };
  const candidates = (Array.isArray(body.candidates) ? body.candidates : []) as Array<Record<string, unknown>>;
  if (candidates.length === 0) return { ok: true, result: { candidates: [] }, text: `No users matched "${token}".` };
  return { ok: true, result: { candidates }, text: `${candidates.length} matches for "${token}".` };
};

// ---------------------------------------------------------------------------
// 2. admin_list_users — GET /api/v1/admin/users
// ---------------------------------------------------------------------------

export const admin_list_users: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const qs = new URLSearchParams({ limit: String(clampLimit(args.limit, 20, 200)) });
  if (typeof args.query === 'string' && args.query) qs.set('query', args.query);
  if (typeof args.role === 'string' && args.role) qs.set('role', args.role);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/users?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok || body.ok !== true) return { ok: false, error: `admin_list_users failed (${status}): ${String(body.error ?? 'unknown')}` };
  const users = (Array.isArray(body.users) ? body.users : []) as Array<{ email: string; active_role?: string }>;
  if (users.length === 0) return { ok: true, result: { users: [] }, text: 'No users matched.' };
  const lines = users.slice(0, 8).map((u) => `${u.email} (${u.active_role ?? 'unknown role'})`);
  return { ok: true, result: { users }, text: `${users.length} users: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 3. admin_get_user_detail — GET /api/v1/admin/users/:userId
// ---------------------------------------------------------------------------

export const admin_get_user_detail: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const userId = String(args.user_id ?? '').trim();
  if (!userId) return { ok: false, error: 'admin_get_user_detail requires user_id.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/users/${encodeURIComponent(userId)}`, { headers: authHeaders(id) });
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No user found with id ${userId}.` }
      : { ok: false, error: `admin_get_user_detail failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  const user = (body.user ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    result: { found: true, user },
    text: `${String(user.email ?? userId)} — ${String(user.active_role ?? 'unknown role')}, status ${String(user.status ?? 'unknown')}.`,
  };
};

// ---------------------------------------------------------------------------
// 4. admin_roles_summary — GET /api/v1/admin/users/roles-summary
// ---------------------------------------------------------------------------

export const admin_roles_summary: Handler = async (_args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/users/roles-summary', { headers: authHeaders(id) });
  if (!ok || body.ok !== true) return { ok: false, error: `admin_roles_summary failed (${status}): ${String(body.error ?? 'unknown')}` };
  const roles = (Array.isArray(body.roles) ? body.roles : []) as Array<{ role: string; user_count: number }>;
  const lines = roles.map((r) => `${r.role}: ${r.user_count}`);
  return { ok: true, result: { roles }, text: `Role distribution: ${lines.join(', ')}.` };
};

// ---------------------------------------------------------------------------
// 5. admin_grant_role — POST /api/v1/roles/grant
// ---------------------------------------------------------------------------

export const admin_grant_role: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const userId = String(args.user_id ?? '').trim();
  const role = String(args.role ?? '').trim();
  if (!userId || !role) return { ok: false, error: 'admin_grant_role requires user_id and role.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, user_id: userId, role },
      text: `About to grant role "${role}" to user ${userId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/roles/grant', {
    method: 'POST',
    headers: authHeaders(id),
    body: { user_id: userId, role, tenant_id: typeof args.tenant_id === 'string' ? args.tenant_id : id.tenant_id },
  });
  if (!ok) return { ok: true, result: { granted: false, status, detail: body }, text: `Could not grant "${role}": ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { granted: true, detail: body }, text: `Granted "${role}" to ${userId}.` };
};

// ---------------------------------------------------------------------------
// 6. admin_revoke_role — POST /api/v1/roles/revoke
// ---------------------------------------------------------------------------

export const admin_revoke_role: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const userId = String(args.user_id ?? '').trim();
  const role = String(args.role ?? '').trim();
  if (!userId || !role) return { ok: false, error: 'admin_revoke_role requires user_id and role.' };
  if (role === 'community') return { ok: false, error: 'The community role cannot be revoked — it is the floor role.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, user_id: userId, role },
      text: `About to revoke role "${role}" from user ${userId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/roles/revoke', {
    method: 'POST',
    headers: authHeaders(id),
    body: { user_id: userId, role, tenant_id: typeof args.tenant_id === 'string' ? args.tenant_id : id.tenant_id },
  });
  if (!ok) return { ok: true, result: { revoked: false, status, detail: body }, text: `Could not revoke "${role}": ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { revoked: true, detail: body }, text: `Revoked "${role}" from ${userId}.` };
};

// ---------------------------------------------------------------------------
// 7. admin_set_trust_tier — POST /api/v1/admin/users/:vitana_id/trust-tier
// (operator/exafy_admin only, per the route's own gate)
// ---------------------------------------------------------------------------

const VALID_TRUST_TIERS = ['unverified', 'community_verified', 'pro_verified', 'id_verified'];

export const admin_set_trust_tier: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (String(id.role ?? '').toLowerCase() !== 'exafy_admin') {
    return { ok: false, error: 'admin_set_trust_tier requires an exafy_admin session (operator-only).' };
  }
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const vitanaId = String(args.vitana_id ?? '').trim();
  const tier = String(args.tier ?? '').trim();
  if (!vitanaId || !VALID_TRUST_TIERS.includes(tier)) {
    return { ok: false, error: `admin_set_trust_tier requires vitana_id and tier (one of ${VALID_TRUST_TIERS.join(', ')}).` };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, vitana_id: vitanaId, tier },
      text: `About to set trust tier "${tier}" for ${vitanaId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/users/${encodeURIComponent(vitanaId)}/trust-tier`, {
    method: 'POST',
    headers: authHeaders(id),
    body: { tier, reason: typeof args.reason === 'string' ? args.reason : undefined },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not set trust tier: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Trust tier for ${vitanaId} set to "${tier}".` };
};

// ---------------------------------------------------------------------------
// 8. admin_get_at_risk_members — GET /api/v1/admin/tenants/:tenantId/overview/at-risk
// ---------------------------------------------------------------------------

export const admin_get_at_risk_members: Handler = async (_args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  if (!id.tenant_id) return { ok: false, error: 'admin_get_at_risk_members requires a tenant context.' };
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/overview/at-risk`,
    { headers: authHeaders(id) },
  );
  if (!ok || body.ok !== true) return { ok: false, error: `admin_get_at_risk_members failed (${status}): ${String(body.error ?? 'unknown')}` };
  const members = (Array.isArray(body.at_risk) ? body.at_risk : []) as Array<{ email: string; last_seen?: string }>;
  if (members.length === 0) return { ok: true, result: { at_risk: [] }, text: 'No at-risk members flagged right now.' };
  const lines = members.slice(0, 8).map((m) => `${m.email} — last seen ${relAge(m.last_seen)}`);
  return {
    ok: true,
    result: { at_risk: members },
    text: `${members.length} at-risk members (based on profile inactivity, not real session telemetry yet): ${lines.join('. ')}`,
  };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ADMIN_USERS_RBAC_TOOL_HANDLERS: Record<string, Handler> = {
  admin_lookup_user,
  admin_list_users,
  admin_get_user_detail,
  admin_roles_summary,
  admin_grant_role,
  admin_revoke_role,
  admin_set_trust_tier,
  admin_get_at_risk_members,
};

export const ADMIN_USERS_RBAC_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'admin_lookup_user',
    description: 'ADMIN ONLY. Find a user by name, email, or vitana_id.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Required.' }, limit: { type: 'integer' } },
      required: ['query'],
    },
  },
  {
    name: 'admin_list_users',
    description: 'ADMIN ONLY. List/filter users by search query or role.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, role: { type: 'string' }, limit: { type: 'integer' } },
    },
  },
  {
    name: 'admin_get_user_detail',
    description: 'ADMIN ONLY. Full user record by user_id.',
    parameters: { type: 'object', properties: { user_id: { type: 'string', description: 'Required.' } }, required: ['user_id'] },
  },
  {
    name: 'admin_roles_summary',
    description: 'ADMIN ONLY. Role distribution counts.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'admin_grant_role',
    description: 'ADMIN ONLY. Grant a role to a user. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Required.' },
        role: { type: 'string', description: 'community, patient, professional, staff, admin, developer, or infra. Required.' },
        tenant_id: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['user_id', 'role'],
    },
  },
  {
    name: 'admin_revoke_role',
    description: 'ADMIN ONLY. Revoke a role from a user (cannot revoke community). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Required.' },
        role: { type: 'string', description: 'Required.' },
        tenant_id: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['user_id', 'role'],
    },
  },
  {
    name: 'admin_set_trust_tier',
    description: 'ADMIN ONLY (exafy_admin/operator only). Change a user\'s trust tier. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        vitana_id: { type: 'string', description: 'Required.' },
        tier: { type: 'string', description: 'unverified, community_verified, pro_verified, or id_verified. Required.' },
        reason: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['vitana_id', 'tier'],
    },
  },
  {
    name: 'admin_get_at_risk_members',
    description: 'ADMIN ONLY. At-risk members overview for the current tenant (profile-inactivity heuristic).',
    parameters: { type: 'object', properties: {} },
  },
];
