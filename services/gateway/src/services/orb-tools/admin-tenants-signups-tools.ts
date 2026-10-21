/**
 * Admin voice tools — Tenants & Settings (B2) + Signups & Invitations (B3),
 * Wave 4 of docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * Thin dispatch layer over routes/admin-tenants.ts, tenant-admin/settings.ts,
 * admin-signups.ts, tenant-admin/invitations.ts. admin_get_feature_flags/
 * admin_set_feature_flag/admin_update_branding all key off the same
 * tenant_settings row (no dedicated flags/branding endpoints exist);
 * admin_set_feature_flag does a read-modify-write since the PUT route
 * replaces the whole feature_flags object rather than merging one key.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall, clampLimit } from './developer-tools';
import { adminGate, authHeaders, NO_ADMIN_SESSION } from './admin-users-rbac-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

// ---------------------------------------------------------------------------
// B2. Tenants & Settings
// ---------------------------------------------------------------------------

export const admin_list_tenants: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const qs = new URLSearchParams();
  if (typeof args.query === 'string' && args.query) qs.set('query', args.query);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/tenants?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_list_tenants failed (${status}): ${String(body.error ?? 'unknown')}` };
  const tenants = (Array.isArray((body as Record<string, unknown>).tenants) ? (body as Record<string, unknown>).tenants : []) as Array<{ name: string }>;
  if (tenants.length === 0) return { ok: true, result: { tenants: [] }, text: 'No tenants matched.' };
  return { ok: true, result: { tenants }, text: `${tenants.length} tenants: ${tenants.slice(0, 8).map((t) => t.name).join(', ')}.` };
};

export const admin_get_tenant: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const tenantId = String(args.tenant_id ?? '').trim();
  if (!tenantId) return { ok: false, error: 'admin_get_tenant requires tenant_id.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/tenants/${encodeURIComponent(tenantId)}`, { headers: authHeaders(id) });
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No tenant found with id ${tenantId}.` }
      : { ok: false, error: `admin_get_tenant failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  return { ok: true, result: body, text: `Tenant detail retrieved.` };
};

async function getSettings(id: OrbToolIdentity, tenantId: string) {
  return gatewayApiCall(`/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/settings`, { headers: authHeaders(id) });
}

export const admin_update_tenant_profile: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const tenantId = String(args.tenant_id ?? id.tenant_id ?? '').trim();
  const profile = args.profile as Record<string, unknown> | undefined;
  if (!tenantId || !profile) return { ok: false, error: 'admin_update_tenant_profile requires tenant_id and profile.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, tenant_id: tenantId, profile },
      text: `About to replace the tenant profile for ${tenantId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/settings`, {
    method: 'PUT',
    headers: authHeaders(id),
    body: { profile },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update the tenant profile: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Tenant profile updated.` };
};

export const admin_get_feature_flags: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const tenantId = String(args.tenant_id ?? id.tenant_id ?? '').trim();
  if (!tenantId) return { ok: false, error: 'admin_get_feature_flags requires tenant_id.' };
  const { ok, status, body } = await getSettings(id, tenantId);
  if (!ok) return { ok: false, error: `admin_get_feature_flags failed (${status}): ${String(body.error ?? 'unknown')}` };
  const flags = (body.feature_flags ?? {}) as Record<string, unknown>;
  const entries = Object.entries(flags);
  return { ok: true, result: { feature_flags: flags }, text: entries.length === 0 ? 'No feature flags set.' : `Flags: ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}.` };
};

export const admin_set_feature_flag: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const tenantId = String(args.tenant_id ?? id.tenant_id ?? '').trim();
  const key = String(args.key ?? '').trim();
  if (!tenantId || !key || args.value === undefined) return { ok: false, error: 'admin_set_feature_flag requires tenant_id, key, and value.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, tenant_id: tenantId, key, value: args.value },
      text: `About to set feature flag "${key}" to ${JSON.stringify(args.value)} for tenant ${tenantId}. Confirm, then call again with confirm=true.`,
    };
  }
  const current = await getSettings(id, tenantId);
  if (!current.ok) return { ok: false, error: `Could not read current flags (${current.status}).` };
  const flags = { ...((current.body.feature_flags ?? {}) as Record<string, unknown>), [key]: args.value };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/settings`, {
    method: 'PUT',
    headers: authHeaders(id),
    body: { feature_flags: flags },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not set the flag: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, feature_flags: flags }, text: `Flag "${key}" set to ${JSON.stringify(args.value)}.` };
};

export const admin_update_branding: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const tenantId = String(args.tenant_id ?? id.tenant_id ?? '').trim();
  const branding = args.branding as Record<string, unknown> | undefined;
  if (!tenantId || !branding) return { ok: false, error: 'admin_update_branding requires tenant_id and branding.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, tenant_id: tenantId, branding },
      text: `About to replace the branding settings for ${tenantId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/settings`, {
    method: 'PUT',
    headers: authHeaders(id),
    body: { branding },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update branding: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Branding updated.` };
};

export const admin_list_tenant_integrations: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const tenantId = String(args.tenant_id ?? id.tenant_id ?? '').trim();
  if (!tenantId) return { ok: false, error: 'admin_list_tenant_integrations requires tenant_id.' };
  const { ok, status, body } = await getSettings(id, tenantId);
  if (!ok) return { ok: false, error: `admin_list_tenant_integrations failed (${status}): ${String(body.error ?? 'unknown')}` };
  const integrations = (body.integrations ?? {}) as Record<string, unknown>;
  return { ok: true, result: { integrations }, text: `Integrations: ${JSON.stringify(integrations)}.` };
};

// ---------------------------------------------------------------------------
// B3. Signups & Invitations
// ---------------------------------------------------------------------------

export const admin_list_signups: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const qs = new URLSearchParams({ limit: String(clampLimit(args.limit, 20, 200)) });
  for (const k of ['stage', 'tenant_id', 'search'] as const) {
    if (typeof args[k] === 'string' && args[k]) qs.set(k, args[k] as string);
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/signups?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_list_signups failed (${status}): ${String(body.error ?? 'unknown')}` };
  const rows = (Array.isArray((body as Record<string, unknown>).signups) ? (body as Record<string, unknown>).signups : []) as Array<{ stage?: string }>;
  return { ok: true, result: { signups: rows }, text: rows.length === 0 ? 'No signups matched.' : `${rows.length} recent signups.` };
};

export const admin_get_signup_stats: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const qs = new URLSearchParams();
  if (typeof args.days === 'number') qs.set('days', String(args.days));
  if (typeof args.tenant_id === 'string' && args.tenant_id) qs.set('tenant_id', args.tenant_id);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/signups/stats?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_get_signup_stats failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: `Signup funnel stats retrieved.` };
};

export const admin_list_signup_attempts: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const qs = new URLSearchParams({ limit: String(clampLimit(args.limit, 20, 200)) });
  for (const k of ['status', 'search'] as const) {
    if (typeof args[k] === 'string' && args[k]) qs.set(k, args[k] as string);
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/signups/attempts?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_list_signup_attempts failed (${status}): ${String(body.error ?? 'unknown')}` };
  const rows = (Array.isArray((body as Record<string, unknown>).attempts) ? (body as Record<string, unknown>).attempts : []) as unknown[];
  return { ok: true, result: { attempts: rows }, text: rows.length === 0 ? 'No signup attempts matched.' : `${rows.length} signup attempts.` };
};

export const admin_repair_signup: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const attemptId = String(args.attempt_id ?? '').trim();
  if (!attemptId) return { ok: false, error: 'admin_repair_signup requires attempt_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, attempt_id: attemptId },
      text: `About to repair signup attempt ${attemptId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/signups/${encodeURIComponent(attemptId)}/repair`, {
    method: 'POST',
    headers: authHeaders(id),
  });
  if (!ok) return { ok: true, result: { repaired: false, status, detail: body }, text: `Could not repair that signup: ${String(body.error ?? `gateway returned ${status}`)}.` };
  const repaired = Boolean(body.repaired);
  return { ok: true, result: { repaired, detail: body }, text: repaired ? `Signup repaired.` : `Signup was already complete — nothing to repair.` };
};

export const admin_create_invitation: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const tenantId = String(args.tenant_id ?? id.tenant_id ?? '').trim();
  const email = String(args.email ?? '').trim();
  if (!tenantId || !email) return { ok: false, error: 'admin_create_invitation requires tenant_id and email.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, tenant_id: tenantId, email },
      text: `About to invite ${email} to tenant ${tenantId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/invitations`, {
    method: 'POST',
    headers: authHeaders(id),
    body: { email, roles: Array.isArray(args.roles) ? args.roles : ['community'], message: typeof args.message === 'string' ? args.message : undefined },
  });
  if (!ok) {
    if (status === 409) return { ok: true, result: { created: false, reason: 'already_invited' }, text: `${email} already has a pending invitation.` };
    return { ok: true, result: { created: false, status, detail: body }, text: `Could not invite ${email}: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { created: true, detail: body }, text: `Invited ${email}.` };
};

export const admin_list_invitations: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const tenantId = String(args.tenant_id ?? id.tenant_id ?? '').trim();
  if (!tenantId) return { ok: false, error: 'admin_list_invitations requires tenant_id.' };
  const qs = new URLSearchParams();
  if (typeof args.status === 'string' && args.status) qs.set('status', args.status);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/invitations?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_list_invitations failed (${status}): ${String(body.error ?? 'unknown')}` };
  const rows = (Array.isArray((body as Record<string, unknown>).invitations) ? (body as Record<string, unknown>).invitations : []) as Array<{ email?: string }>;
  return { ok: true, result: { invitations: rows }, text: rows.length === 0 ? 'No open invitations.' : `${rows.length} invitations: ${rows.slice(0, 8).map((r) => r.email).join(', ')}.` };
};

export const admin_revoke_invitation: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const tenantId = String(args.tenant_id ?? id.tenant_id ?? '').trim();
  const invitationId = String(args.invitation_id ?? '').trim();
  if (!tenantId || !invitationId) return { ok: false, error: 'admin_revoke_invitation requires tenant_id and invitation_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, invitation_id: invitationId },
      text: `About to revoke invitation ${invitationId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/invitations/${encodeURIComponent(invitationId)}/revoke`, {
    method: 'POST',
    headers: authHeaders(id),
  });
  if (!ok) return { ok: true, result: { revoked: false, status, detail: body }, text: `Could not revoke that invitation: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { revoked: true, detail: body }, text: `Invitation revoked.` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ADMIN_TENANTS_SIGNUPS_TOOL_HANDLERS: Record<string, Handler> = {
  admin_list_tenants,
  admin_get_tenant,
  admin_update_tenant_profile,
  admin_get_feature_flags,
  admin_set_feature_flag,
  admin_update_branding,
  admin_list_tenant_integrations,
  admin_list_signups,
  admin_get_signup_stats,
  admin_list_signup_attempts,
  admin_repair_signup,
  admin_create_invitation,
  admin_list_invitations,
  admin_revoke_invitation,
};

export const ADMIN_TENANTS_SIGNUPS_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'admin_list_tenants', description: 'ADMIN ONLY. List tenants.', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'admin_get_tenant', description: 'ADMIN ONLY. Tenant detail.', parameters: { type: 'object', properties: { tenant_id: { type: 'string', description: 'Required.' } }, required: ['tenant_id'] } },
  {
    name: 'admin_update_tenant_profile',
    description: 'ADMIN ONLY. Replace a tenant\'s profile settings. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { tenant_id: { type: 'string' }, profile: { type: 'object', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['profile'] },
  },
  { name: 'admin_get_feature_flags', description: 'ADMIN ONLY. Read a tenant\'s feature flags.', parameters: { type: 'object', properties: { tenant_id: { type: 'string' } } } },
  {
    name: 'admin_set_feature_flag',
    description: 'ADMIN ONLY. Flip a single feature flag for a tenant. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { tenant_id: { type: 'string' }, key: { type: 'string', description: 'Required.' }, value: { description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['key', 'value'] },
  },
  {
    name: 'admin_update_branding',
    description: 'ADMIN ONLY. Replace a tenant\'s branding settings. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { tenant_id: { type: 'string' }, branding: { type: 'object', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['branding'] },
  },
  { name: 'admin_list_tenant_integrations', description: 'ADMIN ONLY. Integrations status for a tenant.', parameters: { type: 'object', properties: { tenant_id: { type: 'string' } } } },
  { name: 'admin_list_signups', description: 'ADMIN ONLY. Recent signups.', parameters: { type: 'object', properties: { stage: { type: 'string' }, tenant_id: { type: 'string' }, search: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'admin_get_signup_stats', description: 'ADMIN ONLY. Signup funnel stats.', parameters: { type: 'object', properties: { days: { type: 'integer' }, tenant_id: { type: 'string' } } } },
  { name: 'admin_list_signup_attempts', description: 'ADMIN ONLY. Failed/pending signup attempts.', parameters: { type: 'object', properties: { status: { type: 'string' }, search: { type: 'string' }, limit: { type: 'integer' } } } },
  {
    name: 'admin_repair_signup',
    description: 'ADMIN ONLY. Repair a broken signup (creates missing profile rows). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { attempt_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['attempt_id'] },
  },
  {
    name: 'admin_create_invitation',
    description: 'ADMIN ONLY. Invite someone to a tenant. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { tenant_id: { type: 'string' }, email: { type: 'string', description: 'Required.' }, roles: { type: 'array', items: { type: 'string' } }, message: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['email'] },
  },
  { name: 'admin_list_invitations', description: 'ADMIN ONLY. Open invitations for a tenant.', parameters: { type: 'object', properties: { tenant_id: { type: 'string' }, status: { type: 'string' } } } },
  {
    name: 'admin_revoke_invitation',
    description: 'ADMIN ONLY. Revoke a pending invitation. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { tenant_id: { type: 'string' }, invitation_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['invitation_id'] },
  },
];
