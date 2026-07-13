/**
 * Developer voice tools — Dev Access, Simulator & Meta (Wave 6, plan
 * section C12, final wave of docs/VOICE_TOOLS_EXPANSION_PLAN.md).
 *
 * Thin dispatch layer over three real route families plus one direct
 * composite of already-built handlers:
 *   - routes/dev-access.ts (exafy_admin dev-hub access list/grant/revoke,
 *     `app_metadata.exafy_admin`, distinct from admin_grant_role's
 *     community-facing RBAC roles)
 *   - routes/dev-auth.ts (`/token`, dev-sandbox-only token minting, gated by
 *     env + X-DEV-SECRET rather than a user JWT — mirrored here via
 *     process.env.DEV_AUTH_SECRET, same pattern as dev_supervisor_summary
 *     in observability-tools.ts)
 *   - routes/conversation-hub.ts (`/admin/conversation/preview`, the
 *     Simulator) and routes/voice-journey-context.ts (`/state`)
 *   - routes/voice-tools-catalog.ts (`/catalog/stats`, `/catalog/:name` —
 *     reads the same tool-manifest.json this whole project maintains)
 *   - dev_system_briefing composites 5 already-built handlers directly
 *     (dev_service_health, dev_list_deployments, dev_count_approvals,
 *     dev_list_violations, dev_cicd_health) rather than adding a 6th
 *     backend — no new business logic, just one spoken roll-up.
 *
 * dev_run_routine_now is SKIPPED — "routine" in this codebase means the
 * Claude Code Remote scheduled-trigger concept (create_trigger/fire_trigger),
 * which has no server-side representation in vitana-platform at all; there
 * is no route, table, or workflow to fire a "routine" from voice. Stays
 * `status: planned`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { developerGate, clampLimit, gatewayApiCall } from './developer-tools';
import { adminGate, authHeaders, NO_ADMIN_SESSION } from './admin-users-rbac-tools';
import { dev_service_health } from './observability-tools';
import { dev_list_deployments } from './deployment-release-tools';
import { dev_count_approvals } from './developer-tools';
import { dev_list_violations } from './governance-tools';
import { dev_cicd_health } from './cicd-pr-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

function requireExafyAdmin(id: OrbToolIdentity): OrbToolResult | null {
  const denied = adminGate(id);
  if (denied) return denied;
  if (String(id.role ?? '').toLowerCase() !== 'exafy_admin') {
    return { ok: false, error: 'This tool requires an exafy_admin session (operator-only).' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. dev_list_dev_users — GET /api/v1/dev-access/users
// ---------------------------------------------------------------------------

export const dev_list_dev_users: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/dev-access/users${query ? `?query=${encodeURIComponent(query)}` : ''}`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `dev_list_dev_users failed (${status}): ${String(body.error ?? 'unknown')}` };
  const users = (Array.isArray(body.users) ? body.users : []) as Array<{ email: string }>;
  if (users.length === 0) return { ok: true, result: { users: [] }, text: 'No exafy_admin dev-hub users found.' };
  return { ok: true, result: { users }, text: `${users.length} dev-hub users: ${users.slice(0, 10).map((u) => u.email).join(', ')}.` };
};

// ---------------------------------------------------------------------------
// 2. dev_grant_access — POST /api/v1/dev-access/grant
// ---------------------------------------------------------------------------

export const dev_grant_access: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const email = String(args.email ?? '').trim();
  if (!email) return { ok: false, error: 'dev_grant_access requires email.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, email },
      text: `About to grant exafy_admin dev-hub access to ${email}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/dev-access/grant', {
    method: 'POST',
    headers: authHeaders(id),
    body: { email },
  });
  if (!ok) {
    return status === 404
      ? { ok: true, result: { granted: false, reason: 'user_not_found' }, text: `No user found with email ${email}.` }
      : { ok: true, result: { granted: false, status, detail: body }, text: `Could not grant access: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { granted: true, detail: body }, text: String(body.message ?? `Dev access granted to ${email}.`) };
};

// ---------------------------------------------------------------------------
// 3. dev_revoke_access — POST /api/v1/dev-access/revoke
// ---------------------------------------------------------------------------

export const dev_revoke_access: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const email = String(args.email ?? '').trim();
  if (!email) return { ok: false, error: 'dev_revoke_access requires email.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, email },
      text: `About to revoke exafy_admin dev-hub access from ${email}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/dev-access/revoke', {
    method: 'POST',
    headers: authHeaders(id),
    body: { email },
  });
  if (!ok) {
    if (status === 400 && body.error === 'SELF_REVOKE_FORBIDDEN') {
      return { ok: true, result: { revoked: false, reason: 'self_revoke_forbidden' }, text: "You can't revoke your own dev-hub access." };
    }
    return status === 404
      ? { ok: true, result: { revoked: false, reason: 'user_not_found' }, text: `No user found with email ${email}.` }
      : { ok: true, result: { revoked: false, status, detail: body }, text: `Could not revoke access: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { revoked: true, detail: body }, text: String(body.message ?? `Dev access revoked from ${email}.`) };
};

// ---------------------------------------------------------------------------
// 4. dev_mint_token — POST /api/v1/dev/auth/token (dev-sandbox only)
// ---------------------------------------------------------------------------

const MINT_ROLES = new Set(['patient', 'community', 'professional', 'staff', 'admin', 'developer', 'infra']);

export const dev_mint_token: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  const email = String(args.email ?? '').trim();
  const role = String(args.role ?? '').trim().toLowerCase();
  if (!email || !MINT_ROLES.has(role)) {
    return { ok: false, error: `dev_mint_token requires email and role (one of ${Array.from(MINT_ROLES).join(', ')}).` };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, email, role },
      text: `About to mint a ${role} session token for ${email} (dev-sandbox only). Confirm, then call again with confirm=true.`,
    };
  }
  const devSecret = process.env.DEV_AUTH_SECRET;
  if (!devSecret) {
    return { ok: true, result: { reason: 'no_dev_secret' }, text: 'Token minting is unavailable — no DEV_AUTH_SECRET configured (this only works in the dev-sandbox environment).' };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/dev/auth/token', {
    method: 'POST',
    headers: { 'X-DEV-SECRET': devSecret },
    body: { email, role, tenant_id: typeof args.tenant_id === 'string' ? args.tenant_id : undefined },
  });
  if (!ok) {
    if (status === 403 && body.error === 'DEV_AUTH_DISABLED') {
      return { ok: true, result: { minted: false, reason: 'not_dev_sandbox' }, text: 'Token minting only works in the dev-sandbox environment — this environment is not dev-sandbox.' };
    }
    return status === 404
      ? { ok: true, result: { minted: false, reason: 'user_not_found' }, text: `No user found with email ${email}.` }
      : { ok: true, result: { minted: false, status, detail: body }, text: `Could not mint a token: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return {
    ok: true,
    result: { minted: true, expires_in: body.expires_in, email, role },
    text: `Minted a ${role} token for ${email}, valid for ${Math.round(Number(body.expires_in ?? 0) / 60)} minutes. (Not repeating the token itself aloud.)`,
  };
};

// ---------------------------------------------------------------------------
// 5. dev_open_hub_panel — navigation-only (Command Hub screens)
// ---------------------------------------------------------------------------

export const dev_open_hub_panel: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const screenId = String(args.screen_id ?? '').trim();
  if (!screenId) return { ok: false, error: 'dev_open_hub_panel requires screen_id, e.g. "DEVHUB.OVERVIEW.SYSTEM_OVERVIEW" or "DEVHUB.ADMIN.USERS".' };
  // Dynamic import (not a static one) — orb-tools-shared.ts imports this
  // module's declarations, so a static import back would create a load-order
  // cycle. Resolving lazily at call time sidesteps it.
  const { tool_navigate_to_screen } = await import('../orb-tools-shared');
  return tool_navigate_to_screen({ ...args, screen_id: screenId }, id, sb);
};

// ---------------------------------------------------------------------------
// 6. dev_run_simulator — GET /api/v1/admin/conversation/preview
// ---------------------------------------------------------------------------

export const dev_run_simulator: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const userId = String(args.user_id ?? '').trim();
  if (!userId) return { ok: false, error: 'dev_run_simulator requires user_id.' };
  const qs = new URLSearchParams({ user_id: userId });
  if (typeof args.lang === 'string' && args.lang) qs.set('lang', args.lang);
  if (typeof args.timezone === 'string' && args.timezone) qs.set('timezone', args.timezone);
  if (typeof args.bucket === 'string' && args.bucket) qs.set('bucket', args.bucket);
  if (args.first_time === true) qs.set('first_time', 'true');
  if (args.briefing_due === true) qs.set('briefing_due', 'true');
  if (typeof args.current_route === 'string' && args.current_route) qs.set('current_route', args.current_route);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/conversation/preview?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_run_simulator failed (${status}): ${String(body.error ?? 'unknown')}` };
  const data = (body.data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    result: data,
    text: `Simulated register "${String(data.register ?? 'unknown')}" for ${userId}${data.chosen_nba ? `, chosen NBA: ${JSON.stringify(data.chosen_nba)}` : ''}.`,
  };
};

// ---------------------------------------------------------------------------
// 7. dev_journey_context — GET /api/v1/voice/journey-context/state
// ---------------------------------------------------------------------------

export const dev_journey_context: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const userId = String(args.user_id ?? '').trim();
  const tenantId = String(args.tenant_id ?? id.tenant_id ?? '').trim();
  if (!userId || !tenantId) return { ok: false, error: 'dev_journey_context requires user_id (and a tenant context).' };
  const qs = new URLSearchParams({ userId, tenantId });
  const { ok, status, body } = await gatewayApiCall(`/api/v1/voice/journey-context/state?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_journey_context failed (${status}): ${String(body.error ?? 'unknown')}` };
  const rows = (Array.isArray(body.rows) ? body.rows : []) as Array<{ signal_name: string; value: unknown }>;
  if (rows.length === 0) return { ok: true, result: { rows: [] }, text: `No durable assistant-state signals stored for user ${userId}.` };
  return { ok: true, result: { rows, source_health: body.source_health }, text: `${rows.length} assistant-state signals: ${rows.slice(0, 8).map((r) => r.signal_name).join(', ')}.` };
};

// ---------------------------------------------------------------------------
// 8. dev_voice_catalog_stats — GET /api/v1/voice-tools/catalog/stats
// ---------------------------------------------------------------------------

export const dev_voice_catalog_stats: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/voice-tools/catalog/stats');
  if (!ok) return { ok: false, error: `dev_voice_catalog_stats failed (${status}): ${String(body.error ?? 'unknown')}` };
  const byStatus = (body.by_status ?? {}) as Record<string, number>;
  return {
    ok: true,
    result: body,
    text: `${Number(body.total ?? 0)} voice tools total — ${Number(byStatus.live ?? 0)} live, ${Number(byStatus.planned ?? 0)} planned.`,
  };
};

// ---------------------------------------------------------------------------
// 9. dev_get_voice_tool_detail — GET /api/v1/voice-tools/catalog/:name
// ---------------------------------------------------------------------------

export const dev_get_voice_tool_detail: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const name = String(args.name ?? '').trim();
  if (!name) return { ok: false, error: 'dev_get_voice_tool_detail requires name.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/voice-tools/catalog/${encodeURIComponent(name)}`);
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No voice tool named "${name}" in the catalog.` }
      : { ok: false, error: `dev_get_voice_tool_detail failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  const tool = (body.tool ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    result: tool,
    text: `"${name}" — status ${String(tool.status ?? 'unknown')}, wired into ${Array.isArray(tool.wired_in) ? (tool.wired_in as string[]).join(' + ') || 'nothing yet' : 'unknown'}.`,
  };
};

// ---------------------------------------------------------------------------
// 10. dev_system_briefing — composite of 5 already-built handlers
// ---------------------------------------------------------------------------

export const dev_system_briefing: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const limit = clampLimit(args.limit, 5, 20);
  const [health, deployments, approvals, violations, cicd] = await Promise.all([
    dev_service_health({}, id, sb),
    dev_list_deployments({ limit }, id, sb),
    dev_count_approvals({}, id, sb),
    dev_list_violations({}, id, sb),
    dev_cicd_health({}, id, sb),
  ]);
  const parts = [health, deployments, approvals, violations, cicd]
    .filter((r): r is Extract<OrbToolResult, { ok: true }> => r.ok === true && Boolean(r.text))
    .map((r) => r.text as string);
  return {
    ok: true,
    result: { health: health.ok ? health.result : null, deployments: deployments.ok ? deployments.result : null, approvals: approvals.ok ? approvals.result : null, violations: violations.ok ? violations.result : null, cicd: cicd.ok ? cicd.result : null },
    text: `System briefing — ${parts.join(' ')}`,
  };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const DEV_ACCESS_SIMULATOR_META_TOOL_HANDLERS: Record<string, Handler> = {
  dev_list_dev_users,
  dev_grant_access,
  dev_revoke_access,
  dev_mint_token,
  dev_open_hub_panel,
  dev_run_simulator,
  dev_journey_context,
  dev_voice_catalog_stats,
  dev_get_voice_tool_detail,
  dev_system_briefing,
};

export const DEV_ACCESS_SIMULATOR_META_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'dev_list_dev_users', description: 'EXAFY_ADMIN ONLY. List users with exafy_admin dev-hub access.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Optional email substring filter.' } } } },
  {
    name: 'dev_grant_access',
    description: 'EXAFY_ADMIN ONLY. Grant exafy_admin dev-hub access to a user by email. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { email: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['email'] },
  },
  {
    name: 'dev_revoke_access',
    description: 'EXAFY_ADMIN ONLY. Revoke exafy_admin dev-hub access from a user by email (cannot self-revoke). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { email: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['email'] },
  },
  {
    name: 'dev_mint_token',
    description: 'EXAFY_ADMIN ONLY. Mint a dev-sandbox session token for a user (works only in the dev-sandbox environment). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Required.' },
        role: { type: 'string', description: 'patient, community, professional, staff, admin, developer, or infra. Required.' },
        tenant_id: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['email', 'role'],
    },
  },
  { name: 'dev_open_hub_panel', description: 'DEVELOPER ONLY. Navigate to a Command Hub screen/panel by screen_id.', parameters: { type: 'object', properties: { screen_id: { type: 'string', description: 'e.g. DEVHUB.OVERVIEW.SYSTEM_OVERVIEW. Required.' } }, required: ['screen_id'] } },
  {
    name: 'dev_run_simulator',
    description: 'EXAFY_ADMIN ONLY. Dry-run the conversation-opening decision (register + next-best-actions) for a user, without speaking or emitting.',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Required.' },
        lang: { type: 'string' },
        timezone: { type: 'string' },
        bucket: { type: 'string', description: 'Temporal bucket, e.g. same_day.' },
        first_time: { type: 'boolean' },
        briefing_due: { type: 'boolean' },
        current_route: { type: 'string' },
      },
      required: ['user_id'],
    },
  },
  {
    name: 'dev_journey_context',
    description: 'EXAFY_ADMIN ONLY. Durable assistant-state signals stored for a user (journey/onboarding context).',
    parameters: { type: 'object', properties: { user_id: { type: 'string', description: 'Required.' }, tenant_id: { type: 'string' } }, required: ['user_id'] },
  },
  { name: 'dev_voice_catalog_stats', description: 'DEVELOPER ONLY. Aggregate counts of this voice tool catalog (by status, surface, role, wiring).', parameters: { type: 'object', properties: {} } },
  { name: 'dev_get_voice_tool_detail', description: 'DEVELOPER ONLY. Full manifest entry for one voice tool by name.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Required.' } }, required: ['name'] } },
  { name: 'dev_system_briefing', description: 'DEVELOPER ONLY. Combined roll-up: service health, recent deployments, pending approvals, governance violations, CI/CD health.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
];
