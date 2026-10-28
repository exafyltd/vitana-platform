/**
 * VTID-04318 (Orchestrator v2, P0): ONE rule for "which platform role is this
 * user acting as right now".
 *
 * Before this, two planes answered the question differently:
 *   - the ORB (`resolveEffectiveRole`, routes/orb-live.ts) read
 *     `role_preferences` first and fell back to `user_tenants.active_role`;
 *   - the community AP executor (`fetchUsersByRole`) filtered on
 *     `user_tenants.active_role` only.
 * A user who switched roles in the UI was therefore addressed as one role by
 * Vitana and targeted as another by the automations. Both now go through
 * `pickEffectiveRole`, so the same user resolves to the same role everywhere.
 *
 * The rule itself is unchanged from the ORB's: the UI preference
 * (`role_preferences`, the frontend's truth) wins when set; otherwise
 * `user_tenants.active_role`; otherwise null.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export function pickEffectiveRole(
  preference: string | null | undefined,
  tenantActiveRole: string | null | undefined,
): string | null {
  const pref = typeof preference === 'string' ? preference.trim() : '';
  if (pref) return pref;
  const tenant = typeof tenantActiveRole === 'string' ? tenantActiveRole.trim() : '';
  return tenant || null;
}

export interface TenantMemberRow {
  user_id: string;
  active_role: string | null;
  [column: string]: unknown;
}

/**
 * Resolve the effective role of every member of a tenant in two reads
 * (memberships + preferences), for fan-out callers such as the AP executor.
 * `role_preferences` rows are ordered newest first; the first row seen per
 * user wins, matching the ORB's single-user `order=updated_at.desc&limit=1`.
 *
 * Returns the member rows with `active_role` replaced by the effective role,
 * and the original value kept as `tenant_active_role`.
 */
export function applyEffectiveRoles(
  members: TenantMemberRow[],
  preferences: Array<{ user_id: string; role: string | null }>,
): Array<TenantMemberRow & { tenant_active_role: string | null }> {
  const prefByUser = new Map<string, string>();
  for (const p of preferences) {
    if (!p?.user_id || prefByUser.has(p.user_id)) continue;
    const role = typeof p.role === 'string' ? p.role.trim() : '';
    if (role) prefByUser.set(p.user_id, role);
  }
  return members.map((m) => ({
    ...m,
    tenant_active_role: m.active_role ?? null,
    active_role: pickEffectiveRole(prefByUser.get(m.user_id), m.active_role),
  }));
}

/**
 * Fetch members of `tenantId` with their effective role. A failed preference
 * read degrades to `user_tenants.active_role` only (logged), never to an
 * empty member list — the membership read is the one that must succeed.
 */
export async function fetchTenantMembersWithEffectiveRole(
  sb: SupabaseClient,
  tenantId: string,
  selectColumns: string = 'user_id, active_role',
): Promise<{ data: Array<TenantMemberRow & { tenant_active_role: string | null }> | null; error: { message: string } | null }> {
  const cols = new Set(selectColumns.split(',').map((c) => c.trim()).filter(Boolean));
  cols.add('user_id');
  cols.add('active_role');

  const [membersRes, prefsRes] = await Promise.all([
    sb.from('user_tenants').select(Array.from(cols).join(', ')).eq('tenant_id', tenantId),
    sb
      .from('role_preferences')
      .select('user_id, role, updated_at')
      .eq('tenant_id', tenantId)
      .order('updated_at', { ascending: false }),
  ]);

  if (membersRes.error) return { data: null, error: membersRes.error };
  if (prefsRes.error) {
    console.warn(
      `[orchestrator/active-role] role_preferences read failed for tenant=${tenantId}: ${prefsRes.error.message} — using user_tenants.active_role only`,
    );
  }
  const members = ((membersRes.data as unknown) as TenantMemberRow[]) || [];
  const prefs = prefsRes.error ? [] : ((prefsRes.data as any[]) || []);
  return { data: applyEffectiveRoles(members, prefs), error: null };
}
