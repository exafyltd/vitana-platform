/**
 * Admin action tools (VTID-ASSISTANT-ROLES).
 *
 * Tenant-scoped voice tools for the ADMIN assistant lane. Complements the
 * existing insight-centric admin voice tools (admin-voice-tools.ts) with
 * the briefing, tenant overview, moderation queue, signup funnel,
 * invitations, and role management.
 *
 * TENANT ISOLATION BY CONSTRUCTION:
 *   - tenantId comes from the caller's session identity (id.tenant_id),
 *     NEVER from model-supplied arguments.
 *   - Write tools self-call the tenant-admin REST routes with the CALLER'S
 *     OWN JWT, so requireTenantAdmin re-verifies tenant + role server-side.
 *     The assistant acts with the admin's authority — never above it.
 *
 * Every state-changing handler goes through runGuardedAction (action brake,
 * two-step confirm, rate limit, OASIS decision audit).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { runGuardedAction } from './action-guard';
import {
  buildAdminBriefing,
  renderAdminBriefingBlock,
} from '../assistant-briefing/admin-briefing-service';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

const ADMIN_ROLES = new Set(['admin', 'exafy_admin']);

/** Deny unless the identity is an admin with a tenant. Mirrors developerGate. */
export function adminGate(id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_id) return { ok: false, error: 'admin tools require an authenticated user.' };
  const role = String(id.role ?? '').toLowerCase();
  if (!ADMIN_ROLES.has(role)) return { ok: false, error: 'admin_role_required' };
  if (!id.tenant_id) return { ok: false, error: 'admin tools require a tenant context.' };
  return null;
}

function gatewayBaseUrl(): string {
  return process.env.GATEWAY_URL || `http://localhost:${process.env.PORT || 8080}`;
}

/** Self-call a tenant-admin route WITH THE CALLER'S JWT (authority = caller). */
async function tenantAdminApi(
  id: OrbToolIdentity,
  pathAfterTenant: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (id.user_jwt) headers['Authorization'] = `Bearer ${id.user_jwt}`;
  const res = await fetch(
    `${gatewayBaseUrl()}/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id as string)}${pathAfterTenant}`,
    {
      method: init?.method || 'GET',
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    },
  );
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* keep {} */
  }
  return { ok: res.ok, status: res.status, body };
}

function needJwt(id: OrbToolIdentity): OrbToolResult | null {
  if (!id.user_jwt) {
    return {
      ok: false,
      error: 'This action needs your own credentials in the session so the platform can re-verify your admin rights. Please use the admin console for this one.',
    };
  }
  return null;
}

function failText(action: string, status: number, body: Record<string, unknown>): string {
  if (status === 403) return `${action} was refused: the platform did not recognize you as an admin of this tenant.`;
  return `${action} did not go through (${status}): ${String(body.error ?? body.message ?? 'unknown error')}.`;
}

// ---------------------------------------------------------------------------
// T0 — briefing, overview, moderation queue, funnel, members, invitations
// ---------------------------------------------------------------------------

export const admin_get_briefing: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  try {
    const since = typeof args.since === 'string' && args.since ? args.since : null;
    const envelope = await buildAdminBriefing(id.tenant_id as string, since);
    return { ok: true, result: envelope, text: renderAdminBriefingBlock(envelope) };
  } catch (err) {
    return { ok: false, error: `admin_get_briefing failed: ${String((err as Error)?.message || err)}` };
  }
};

export const admin_get_overview: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const jwtMissing = needJwt(id);
  if (jwtMissing) return jwtMissing;
  const section = ['summary', 'at-risk', 'activity', 'alerts'].includes(String(args.section))
    ? String(args.section)
    : 'summary';
  try {
    const { ok, status, body } = await tenantAdminApi(id, `/overview/${section}`);
    if (!ok || body.ok !== true) return { ok: false, error: failText('Fetching the overview', status, body) };
    if (section === 'summary') {
      const kpi = (body.kpi ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        result: body,
        text: `Tenant overview: ${String(kpi.total_members ?? '?')} members, ${String(kpi.new_signups_7d ?? '?')} signups this week (${String(kpi.new_signups_delta_pct ?? '?')}% vs prior), ${String(kpi.pending_invitations ?? '?')} pending invitations, ${String(kpi.kb_documents ?? '?')} knowledge documents.`,
      };
    }
    if (section === 'alerts') {
      const alerts = (Array.isArray(body.alerts) ? body.alerts : []) as Array<Record<string, unknown>>;
      return {
        ok: true,
        result: body,
        text: alerts.length === 0
          ? 'No error alerts for this tenant in the last 24 hours.'
          : `${alerts.length} alert${alerts.length === 1 ? '' : 's'}: ${alerts.slice(0, 3).map((a) => String(a.message ?? '').slice(0, 100)).join('. ')}`,
      };
    }
    if (section === 'at-risk') {
      const atRisk = (Array.isArray(body.at_risk) ? body.at_risk : []) as Array<Record<string, unknown>>;
      return {
        ok: true,
        result: body,
        text: atRisk.length === 0
          ? 'No members currently look at-risk of churning.'
          : `${atRisk.length} member${atRisk.length === 1 ? '' : 's'} at risk (inactive): ${atRisk.slice(0, 5).map((m) => String(m.display_name || m.email || 'unknown')).join(', ')}.`,
      };
    }
    return { ok: true, result: body, text: 'Recent tenant activity fetched — details are in the result payload.' };
  } catch (err) {
    return { ok: false, error: `admin_get_overview failed: ${String((err as Error)?.message || err)}` };
  }
};

export const admin_list_moderation_queue: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const jwtMissing = needJwt(id);
  if (jwtMissing) return jwtMissing;
  try {
    const status = ['pending', 'flagged', 'approved', 'rejected'].includes(String(args.status))
      ? String(args.status)
      : 'pending';
    const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
    const { ok, status: httpStatus, body } = await tenantAdminApi(id, `/content/items?status=${status}&limit=${limit}`);
    if (!ok || body.ok !== true) return { ok: false, error: failText('Listing the moderation queue', httpStatus, body) };
    const items = (Array.isArray(body.items) ? body.items : []) as Array<Record<string, unknown>>;
    if (items.length === 0) {
      return { ok: true, result: { items: [] }, text: `The moderation queue has no ${status} items.` };
    }
    const lines = items.map((it, i) =>
      `${i + 1}. ${String(it.media_type ?? 'item')} "${String(it.title ?? it.filename ?? '(untitled)')}" — uploaded ${String(it.created_at ?? 'unknown')}`);
    return {
      ok: true,
      result: { items },
      text: `${items.length} ${status} item${items.length === 1 ? '' : 's'} in moderation: ${lines.join(' ')} ` +
        'To act, use admin_approve_content or admin_reject_content with the item id from the result payload — one item at a time.',
    };
  } catch (err) {
    return { ok: false, error: `admin_list_moderation_queue failed: ${String((err as Error)?.message || err)}` };
  }
};

export const admin_get_signup_funnel: Handler = async (_args, id, sb) => {
  const denied = adminGate(id);
  if (denied) return denied;
  try {
    const weekStart = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const { data, error } = await sb
      .from('signup_attempts')
      .select('status')
      .eq('tenant_id', id.tenant_id as string)
      .gte('started_at', weekStart)
      .limit(500);
    if (error) return { ok: false, error: error.message };
    const rows = (data ?? []) as Array<{ status: string }>;
    const byStatus = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    const order = ['started', 'email_sent', 'verified', 'profile_created', 'onboarded', 'abandoned'];
    const line = order.filter((s) => byStatus[s]).map((s) => `${byStatus[s]} ${s.replace('_', ' ')}`).join(', ');
    return {
      ok: true,
      result: { total_7d: rows.length, by_status: byStatus },
      text: rows.length === 0
        ? 'No signups started in the last 7 days.'
        : `Signup funnel, last 7 days: ${rows.length} started overall — ${line}. The gap between "started" and "onboarded" is where people drop off.`,
    };
  } catch (err) {
    return { ok: false, error: `admin_get_signup_funnel failed: ${String((err as Error)?.message || err)}` };
  }
};

export const admin_find_member: Handler = async (args, id, sb) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const query = String(args.query ?? '').trim();
  if (!query) return { ok: false, error: 'admin_find_member requires a name or email fragment.' };
  try {
    const needle = query.replace(/[,()%]/g, '');
    const { data, error } = await sb
      .from('user_tenants')
      .select('user_id, active_role, created_at, app_users!inner(email, display_name)')
      .eq('tenant_id', id.tenant_id as string)
      .or(`email.ilike.%${needle}%,display_name.ilike.%${needle}%`, { referencedTable: 'app_users' })
      .limit(5);
    if (error) return { ok: false, error: error.message };
    const rows = (data ?? []) as Array<Record<string, any>>;
    if (rows.length === 0) {
      return { ok: true, result: { members: [] }, text: `No member matching "${query}" in this tenant.` };
    }
    const lines = rows.map((r, i) => {
      const u = r.app_users ?? {};
      return `${i + 1}. ${String(u.display_name || u.email || r.user_id)} — role ${String(r.active_role)}, joined ${String(r.created_at ?? 'unknown')}`;
    });
    return {
      ok: true,
      result: { members: rows },
      text: `${rows.length} match${rows.length === 1 ? '' : 'es'}: ${lines.join(' ')}`,
    };
  } catch (err) {
    return { ok: false, error: `admin_find_member failed: ${String((err as Error)?.message || err)}` };
  }
};

export const admin_list_invitations: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const jwtMissing = needJwt(id);
  if (jwtMissing) return jwtMissing;
  try {
    const status = ['pending', 'accepted', 'revoked'].includes(String(args.status)) ? String(args.status) : 'pending';
    const { ok, status: httpStatus, body } = await tenantAdminApi(id, `/invitations?status=${status}`);
    if (!ok || body.ok !== true) return { ok: false, error: failText('Listing invitations', httpStatus, body) };
    const invitations = (Array.isArray(body.invitations) ? body.invitations : []) as Array<Record<string, unknown>>;
    if (invitations.length === 0) {
      return { ok: true, result: { invitations: [] }, text: `No ${status} invitations.` };
    }
    const lines = invitations.slice(0, 8).map((inv, i) =>
      `${i + 1}. ${String(inv.email)} (${(Array.isArray(inv.roles) ? inv.roles : []).join('/') || 'community'})`);
    return {
      ok: true,
      result: { invitations },
      text: `${invitations.length} ${status} invitation${invitations.length === 1 ? '' : 's'}: ${lines.join(' ')}`,
    };
  } catch (err) {
    return { ok: false, error: `admin_list_invitations failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// T1/T2 — guarded writes
// ---------------------------------------------------------------------------

export const admin_invite_member: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const jwtMissing = needJwt(id);
  if (jwtMissing) return jwtMissing;
  const email = String(args.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) return { ok: false, error: 'admin_invite_member requires a valid email address — spell it out and confirm it with the admin.' };
  const roles = Array.isArray(args.roles) && (args.roles as unknown[]).length > 0
    ? (args.roles as unknown[]).map(String)
    : ['community'];
  return runGuardedAction(args, id, {
    tool: 'admin_invite_member',
    tier: 1,
    readBack: `This sends a tenant invitation to ${email} with role${roles.length === 1 ? '' : 's'} ${roles.join(', ')}. It can be revoked afterwards with admin_revoke_invitation.`,
    execute: async () => {
      const { ok, status, body } = await tenantAdminApi(id, '/invitations', {
        method: 'POST',
        body: { email, roles },
      });
      if (status === 409) return { ok: false, error: `${email} already has a pending invitation.` };
      if (!ok || body.ok !== true) return { ok: false, error: failText('Sending the invitation', status, body) };
      return { ok: true, result: body, text: `Invitation sent to ${email}.` };
    },
  });
};

export const admin_revoke_invitation: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const jwtMissing = needJwt(id);
  if (jwtMissing) return jwtMissing;
  const invitationId = String(args.invitation_id ?? '').trim();
  if (!invitationId) return { ok: false, error: 'admin_revoke_invitation requires invitation_id (from admin_list_invitations).' };
  return runGuardedAction(args, id, {
    tool: 'admin_revoke_invitation',
    tier: 1,
    readBack: `This revokes invitation ${invitationId.slice(0, 8)}… — the recipient's link stops working. A new invitation can always be sent later.`,
    execute: async () => {
      const { ok, status, body } = await tenantAdminApi(id, `/invitations/${encodeURIComponent(invitationId)}/revoke`, { method: 'POST' });
      if (!ok || body.ok !== true) return { ok: false, error: failText('Revoking the invitation', status, body) };
      return { ok: true, result: body, text: 'Invitation revoked.' };
    },
  });
};

export const admin_approve_content: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const jwtMissing = needJwt(id);
  if (jwtMissing) return jwtMissing;
  const itemId = String(args.item_id ?? '').trim();
  if (!itemId) return { ok: false, error: 'admin_approve_content requires item_id (from admin_list_moderation_queue).' };
  return runGuardedAction(args, id, {
    tool: 'admin_approve_content',
    tier: 2,
    readBack: `This APPROVES content item ${itemId.slice(0, 8)}… and makes it PUBLIC to the community. It can be re-flagged later if needed.`,
    execute: async () => {
      const { ok, status, body } = await tenantAdminApi(id, `/content/items/${encodeURIComponent(itemId)}/approve`, { method: 'POST' });
      if (!ok || body.ok !== true) return { ok: false, error: failText('Approving the content', status, body) };
      return { ok: true, result: body, text: 'Content approved and published.' };
    },
  });
};

export const admin_reject_content: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const jwtMissing = needJwt(id);
  if (jwtMissing) return jwtMissing;
  const itemId = String(args.item_id ?? '').trim();
  if (!itemId) return { ok: false, error: 'admin_reject_content requires item_id.' };
  return runGuardedAction(args, id, {
    tool: 'admin_reject_content',
    tier: 2,
    readBack: `This REJECTS content item ${itemId.slice(0, 8)}… — it is hidden from the community. The uploader is affected; make sure the admin has heard what the item is.`,
    execute: async () => {
      const { ok, status, body } = await tenantAdminApi(id, `/content/items/${encodeURIComponent(itemId)}/reject`, { method: 'POST' });
      if (!ok || body.ok !== true) return { ok: false, error: failText('Rejecting the content', status, body) };
      return { ok: true, result: body, text: 'Content rejected and hidden.' };
    },
  });
};

const GRANTABLE_ROLES = new Set(['community', 'patient', 'professional', 'staff', 'admin']);

export const admin_grant_role: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const jwtMissing = needJwt(id);
  if (jwtMissing) return jwtMissing;
  const userId = String(args.user_id ?? '').trim();
  const role = String(args.role ?? '').trim().toLowerCase();
  if (!userId) return { ok: false, error: 'admin_grant_role requires user_id (find it with admin_find_member).' };
  if (!GRANTABLE_ROLES.has(role)) {
    return { ok: false, error: `admin_grant_role can grant: ${[...GRANTABLE_ROLES].join(', ')}. Developer and infra roles are super-admin-only (VTID-01230) and cannot be granted by voice.` };
  }
  return runGuardedAction(args, id, {
    tool: 'admin_grant_role',
    tier: 2,
    readBack: `This GRANTS the role "${role}" to user ${userId.slice(0, 8)}… in this tenant. ${role === 'admin' ? 'That gives them FULL admin control of this tenant — including the ability to change roles themselves. ' : ''}It can be revoked afterwards with admin_revoke_role.`,
    execute: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (id.user_jwt) headers['Authorization'] = `Bearer ${id.user_jwt}`;
      const res = await fetch(`${gatewayBaseUrl()}/api/v1/roles/grant`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ user_id: userId, role }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || body.ok !== true) return { ok: false, error: failText('Granting the role', res.status, body) };
      return { ok: true, result: body, text: `Role ${role} granted.` };
    },
  });
};

export const admin_revoke_role: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const jwtMissing = needJwt(id);
  if (jwtMissing) return jwtMissing;
  const userId = String(args.user_id ?? '').trim();
  const role = String(args.role ?? '').trim().toLowerCase();
  if (!userId) return { ok: false, error: 'admin_revoke_role requires user_id.' };
  if (role === 'community') return { ok: false, error: 'The community base role cannot be revoked.' };
  if (!GRANTABLE_ROLES.has(role)) {
    return { ok: false, error: `admin_revoke_role can revoke: ${[...GRANTABLE_ROLES].filter((r) => r !== 'community').join(', ')}.` };
  }
  return runGuardedAction(args, id, {
    tool: 'admin_revoke_role',
    tier: 2,
    readBack: `This REVOKES the role "${role}" from user ${userId.slice(0, 8)}… in this tenant. They immediately lose the access that role carries.`,
    execute: async () => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (id.user_jwt) headers['Authorization'] = `Bearer ${id.user_jwt}`;
      const res = await fetch(`${gatewayBaseUrl()}/api/v1/roles/revoke`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ user_id: userId, role }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || body.ok !== true) return { ok: false, error: failText('Revoking the role', res.status, body) };
      return { ok: true, result: body, text: `Role ${role} revoked.` };
    },
  });
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ADMIN_ACTION_TOOL_HANDLERS: Record<string, Handler> = {
  admin_get_briefing,
  admin_get_overview,
  admin_list_moderation_queue,
  admin_get_signup_funnel,
  admin_find_member,
  admin_list_invitations,
  admin_invite_member,
  admin_revoke_invitation,
  admin_approve_content,
  admin_reject_content,
  admin_grant_role,
  admin_revoke_role,
};

const CONFIRM_PARAM = {
  confirm: { type: 'boolean', description: 'Set true ONLY after the admin explicitly confirmed the read-back. First call MUST omit this.' },
};

export const ADMIN_ACTION_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'admin_get_briefing',
    description: [
      'ADMIN ONLY. Fetch the current tenant briefing: status, what changed since the last session,',
      'ranked immediate-attention items (moderation SLA, insights, alerts, stuck signups), and the',
      'recommended next step. Call when the admin asks "what\'s the status", "brief me", "was ist los".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { since: { type: 'string', description: 'Optional ISO timestamp for the delta window.' } },
    },
  },
  {
    name: 'admin_get_overview',
    description: [
      'ADMIN ONLY. Read the tenant overview: summary (KPIs), at-risk members, activity, or alerts.',
      'Call when the admin asks "how many members", "who is at risk", "any alerts".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { section: { type: 'string', description: 'summary (default), at-risk, activity, or alerts.' } },
    },
  },
  {
    name: 'admin_list_moderation_queue',
    description: [
      'ADMIN ONLY. List content items awaiting moderation (pending or flagged) for this tenant.',
      'Call when the admin asks "what needs moderation", "show reported content", "moderation queue".',
      'Then walk through them ONE at a time with admin_approve_content / admin_reject_content.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'pending (default), flagged, approved, rejected.' },
        limit: { type: 'integer', description: 'Max items, 1-20. Use 5.' },
      },
    },
  },
  {
    name: 'admin_get_signup_funnel',
    description: 'ADMIN ONLY. Summarize the 7-day signup funnel (started → onboarded, where people drop off).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'admin_find_member',
    description: [
      'ADMIN ONLY. Find a member of THIS tenant by name or email fragment; returns user_id, role, join date.',
      'Call before role changes ("make Anna a staff member" → find Anna first, read the match back).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name or email fragment.' } },
      required: ['query'],
    },
  },
  {
    name: 'admin_list_invitations',
    description: 'ADMIN ONLY. List tenant invitations by status (pending default, accepted, revoked).',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', description: 'pending (default), accepted, or revoked.' } },
    },
  },
  {
    name: 'admin_invite_member',
    description: [
      'ADMIN ONLY. Send a tenant invitation to an email address with roles (default community).',
      'ALWAYS read the email address back letter-perfect before confirming. TWO-STEP confirm.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Recipient email — read it back to the admin before confirming.' },
        roles: { type: 'array', items: { type: 'string' }, description: 'Roles, default ["community"].' },
        ...CONFIRM_PARAM,
      },
      required: ['email'],
    },
  },
  {
    name: 'admin_revoke_invitation',
    description: 'ADMIN ONLY. Revoke a pending invitation. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        invitation_id: { type: 'string', description: 'Invitation id from admin_list_invitations.' },
        ...CONFIRM_PARAM,
      },
      required: ['invitation_id'],
    },
  },
  {
    name: 'admin_approve_content',
    description: [
      'ADMIN ONLY. APPROVE a moderation item — it becomes public to the community.',
      'Describe the item to the admin first. TWO-STEP confirm. One item at a time.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'Item id from admin_list_moderation_queue.' },
        ...CONFIRM_PARAM,
      },
      required: ['item_id'],
    },
  },
  {
    name: 'admin_reject_content',
    description: [
      'ADMIN ONLY. REJECT a moderation item — it is hidden from the community (affects the uploader).',
      'Describe the item to the admin first. TWO-STEP confirm. One item at a time.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'Item id from admin_list_moderation_queue.' },
        ...CONFIRM_PARAM,
      },
      required: ['item_id'],
    },
  },
  {
    name: 'admin_grant_role',
    description: [
      'ADMIN ONLY. Grant a role (community/patient/professional/staff/admin) to a member of this tenant.',
      'Developer and infra are super-admin-only and CANNOT be granted by voice. Find the member first',
      'with admin_find_member and read the match back. TWO-STEP confirm.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Target user id from admin_find_member.' },
        role: { type: 'string', description: 'community, patient, professional, staff, or admin.' },
        ...CONFIRM_PARAM,
      },
      required: ['user_id', 'role'],
    },
  },
  {
    name: 'admin_revoke_role',
    description: 'ADMIN ONLY. Revoke a granted role from a member (community base role cannot be revoked). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Target user id.' },
        role: { type: 'string', description: 'Role to revoke.' },
        ...CONFIRM_PARAM,
      },
      required: ['user_id', 'role'],
    },
  },
];
