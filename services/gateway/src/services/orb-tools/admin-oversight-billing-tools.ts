/**
 * Admin voice tools — Community Oversight (B5) + Billing & Wallet Admin (B7),
 * Wave 4 of docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * B5 is a thin dispatch layer over routes/tenant-admin/community-admin.ts
 * (mounted at /api/v1/admin/tenants/:tenantId/community, requireTenantAdmin).
 * `admin_activity_feed` has no dedicated route — it's synthesized client-side
 * from the same community-admin reads (recent meetups/rooms) since no
 * separate activity-feed table/endpoint exists.
 *
 * B7: admin_credit_wallet/admin_debit_wallet call the exafy_admin-only
 * /api/v1/wallet/admin/{credit,spend} routes (routes/wallet-admin.ts) —
 * restricted to exafy_admin here too, matching the route's own gate.
 * admin_get_founding_status reads the public GET /api/v1/billing/founding-status.
 * admin_get_monetization_config / admin_run_monetization_detect call the D36
 * engine's GET /api/v1/monetization/config and POST /api/v1/monetization/detect.
 * admin_update_monetization_config is SKIPPED — the D36 config
 * (readiness_threshold, cooldowns, etc.) is hardcoded in
 * financial-monetization.ts with no write route or table backing it; faking
 * one would invent a feature that doesn't exist.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall, relAge, clampLimit } from './developer-tools';
import { adminGate, authHeaders, NO_ADMIN_SESSION } from './admin-users-rbac-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

const WALLET_CURRENCIES = new Set(['EUR', 'USD']);

// ---------------------------------------------------------------------------
// B5.1 admin_list_meetups — GET .../community/meetups
// ---------------------------------------------------------------------------

export const admin_list_meetups: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const limit = clampLimit(args.limit, 20, 100);
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/community/meetups?limit=${limit}`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `admin_list_meetups failed (${status}): ${String(body.error ?? 'unknown')}` };
  const meetups = (Array.isArray(body.meetups) ? body.meetups : []) as Array<Record<string, unknown>>;
  if (meetups.length === 0) return { ok: true, result: { meetups: [] }, text: 'No meetups found.' };
  return { ok: true, result: { meetups }, text: `${meetups.length} meetups.` };
};

// ---------------------------------------------------------------------------
// B5.2 admin_delete_meetup — DELETE .../community/meetups/:id
// ---------------------------------------------------------------------------

export const admin_delete_meetup: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const meetupId = String(args.meetup_id ?? '').trim();
  if (!meetupId) return { ok: false, error: 'admin_delete_meetup requires meetup_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, meetup_id: meetupId },
      text: `About to permanently delete meetup ${meetupId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/community/meetups/${encodeURIComponent(meetupId)}`,
    { method: 'DELETE', headers: authHeaders(id) },
  );
  if (!ok) return { ok: true, result: { deleted: false, status, detail: body }, text: `Could not delete the meetup: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { deleted: true }, text: `Meetup ${meetupId} deleted.` };
};

// ---------------------------------------------------------------------------
// B5.3 admin_list_groups — GET .../community/groups
// ---------------------------------------------------------------------------

export const admin_list_groups: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const limit = clampLimit(args.limit, 20, 100);
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/community/groups?limit=${limit}`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `admin_list_groups failed (${status}): ${String(body.error ?? 'unknown')}` };
  const groups = (Array.isArray(body.groups) ? body.groups : []) as Array<Record<string, unknown>>;
  if (groups.length === 0) return { ok: true, result: { groups: [] }, text: 'No groups found.' };
  return { ok: true, result: { groups }, text: `${groups.length} groups.` };
};

// ---------------------------------------------------------------------------
// B5.4 admin_list_live_rooms — GET .../community/live-rooms
// ---------------------------------------------------------------------------

export const admin_list_live_rooms: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const limit = clampLimit(args.limit, 20, 100);
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/community/live-rooms?limit=${limit}`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `admin_list_live_rooms failed (${status}): ${String(body.error ?? 'unknown')}` };
  const rooms = (Array.isArray(body.rooms) ? body.rooms : []) as Array<Record<string, unknown>>;
  if (rooms.length === 0) return { ok: true, result: { rooms: [] }, text: 'No live rooms found.' };
  return { ok: true, result: { rooms }, text: `${rooms.length} live rooms.` };
};

// ---------------------------------------------------------------------------
// B5.5 admin_list_creators — GET .../community/creators
// ---------------------------------------------------------------------------

export const admin_list_creators: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const limit = clampLimit(args.limit, 20, 100);
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/community/creators?limit=${limit}`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `admin_list_creators failed (${status}): ${String(body.error ?? 'unknown')}` };
  const creators = (Array.isArray(body.creators) ? body.creators : []) as Array<Record<string, unknown>>;
  if (creators.length === 0) return { ok: true, result: { creators: [] }, text: 'No creator profiles found.' };
  return { ok: true, result: { creators }, text: `${creators.length} creators.` };
};

// ---------------------------------------------------------------------------
// B5.6 admin_list_memberships — GET .../community/memberships
// ---------------------------------------------------------------------------

export const admin_list_memberships: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const limit = clampLimit(args.limit, 20, 100);
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/community/memberships?limit=${limit}`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `admin_list_memberships failed (${status}): ${String(body.error ?? 'unknown')}` };
  const memberships = (Array.isArray(body.memberships) ? body.memberships : []) as Array<Record<string, unknown>>;
  if (memberships.length === 0) return { ok: true, result: { memberships: [] }, text: 'No memberships found.' };
  return { ok: true, result: { memberships }, text: `${memberships.length} memberships.` };
};

// ---------------------------------------------------------------------------
// B5.7 admin_community_stats — GET .../community/stats
// ---------------------------------------------------------------------------

export const admin_community_stats: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/community/stats`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `admin_community_stats failed (${status}): ${String(body.error ?? 'unknown')}` };
  const stats = (body.stats ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    result: stats,
    text: `${Number(stats.meetups ?? 0)} meetups, ${Number(stats.groups ?? 0)} groups, ${Number(stats.live_rooms ?? 0)} live rooms, ${Number(stats.memberships ?? 0)} memberships.`,
  };
};

// ---------------------------------------------------------------------------
// B5.8 admin_activity_feed — synthesized from meetups + live-rooms
// (no dedicated activity-feed table/endpoint exists)
// ---------------------------------------------------------------------------

export const admin_activity_feed: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const [meetupsRes, roomsRes] = await Promise.all([
    gatewayApiCall(`/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/community/meetups?limit=5`, { headers: authHeaders(id) }),
    gatewayApiCall(`/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/community/live-rooms?limit=5`, { headers: authHeaders(id) }),
  ]);
  const meetups = (meetupsRes.ok && Array.isArray(meetupsRes.body.meetups) ? meetupsRes.body.meetups : []) as Array<Record<string, unknown>>;
  const rooms = (roomsRes.ok && Array.isArray(roomsRes.body.rooms) ? roomsRes.body.rooms : []) as Array<Record<string, unknown>>;
  const items: Array<{ kind: string; label: string; at: unknown }> = [
    ...meetups.map((m) => ({ kind: 'meetup', label: String(m.title ?? m.name ?? 'meetup'), at: m.created_at ?? m.start_time })),
    ...rooms.map((r) => ({ kind: 'live_room', label: String(r.title ?? 'room'), at: r.created_at })),
  ];
  if (items.length === 0) return { ok: true, result: { items: [] }, text: 'No recent community activity.' };
  const lines = items.slice(0, 8).map((it) => `${it.kind}: ${it.label}${it.at ? ` (${relAge(String(it.at))})` : ''}`);
  return { ok: true, result: { items }, text: `Recent activity: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// B7.1/2 admin_credit_wallet / admin_debit_wallet
// POST /api/v1/wallet/admin/{credit,spend} — exafy_admin only (route's own gate)
// ---------------------------------------------------------------------------

function requireExafyAdmin(id: OrbToolIdentity): OrbToolResult | null {
  const denied = adminGate(id);
  if (denied) return denied;
  if (String(id.role ?? '').toLowerCase() !== 'exafy_admin') {
    return { ok: false, error: 'This wallet adjustment requires an exafy_admin session (operator-only).' };
  }
  return null;
}

async function resolveWalletAccountId(
  sb: SupabaseClient,
  userId: string,
  currency: string,
): Promise<string | null> {
  const { data } = await sb
    .from('wallet_accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('currency', currency)
    .eq('status', 'active')
    .maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

async function adjustWallet(args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient, direction: 'credit' | 'spend'): Promise<OrbToolResult> {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const targetUserId = String(args.user_id ?? '').trim();
  const currency = String(args.currency ?? '').trim().toUpperCase();
  const amountMinor = Number(args.amount_minor);
  const description = typeof args.description === 'string' ? args.description : undefined;
  if (!targetUserId || !WALLET_CURRENCIES.has(currency) || !Number.isInteger(amountMinor) || amountMinor <= 0) {
    return { ok: false, error: `admin_${direction === 'credit' ? 'credit' : 'debit'}_wallet requires user_id, currency (EUR or USD), and a positive integer amount_minor.` };
  }
  const accountId = await resolveWalletAccountId(sb, targetUserId, currency);
  if (!accountId) return { ok: true, result: { adjusted: false, reason: 'no_wallet_account' }, text: `That user has no active ${currency} wallet account.` };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, user_id: targetUserId, currency, amount_minor: amountMinor },
      text: `About to ${direction === 'credit' ? 'credit' : 'debit'} ${amountMinor / 100} ${currency} ${direction === 'credit' ? 'to' : 'from'} that user's wallet. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/wallet/admin/${direction}`, {
    method: 'POST',
    headers: authHeaders(id),
    body: {
      account_id: accountId,
      amount_minor: amountMinor,
      currency,
      reference_type: 'manual',
      reference_id: `orb-admin-${direction}-${Date.now()}`,
      description: description ?? `Admin ${direction} via voice`,
    },
  });
  if (!ok) return { ok: true, result: { adjusted: false, status, detail: body }, text: `Could not ${direction} the wallet: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { adjusted: true, detail: body }, text: `Wallet ${direction === 'credit' ? 'credited' : 'debited'} ${amountMinor / 100} ${currency}.` };
}

export const admin_credit_wallet: Handler = async (args, id, sb) => adjustWallet(args, id, sb, 'credit');
export const admin_debit_wallet: Handler = async (args, id, sb) => adjustWallet(args, id, sb, 'spend');

// ---------------------------------------------------------------------------
// B7.3 admin_get_founding_status — GET /api/v1/billing/founding-status (public)
// ---------------------------------------------------------------------------

export const admin_get_founding_status: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/billing/founding-status', {});
  if (!ok) return { ok: false, error: `admin_get_founding_status failed (${status}): ${String(body.error ?? 'unknown')}` };
  if (!body.active) return { ok: true, result: body, text: 'No active Founding campaign.' };
  return {
    ok: true,
    result: body,
    text: `Founding campaign: ${Number(body.uses_count ?? 0)} of ${Number(body.max_uses ?? 0)} spots used.`,
  };
};

// ---------------------------------------------------------------------------
// B7.4 admin_get_monetization_config — GET /api/v1/monetization/config
// ---------------------------------------------------------------------------

export const admin_get_monetization_config: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/monetization/config', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_get_monetization_config failed (${status}): ${String(body.error ?? 'unknown')}` };
  const config = (body.config ?? {}) as Record<string, unknown>;
  return { ok: true, result: config, text: `Readiness threshold ${Number(config.readiness_threshold ?? 0)}, max ${Number(config.max_attempts_per_session ?? 0)} attempts per session, ${Number(config.rejection_cooldown_minutes ?? 0)}min cooldown.` };
};

// ---------------------------------------------------------------------------
// B7.5 admin_run_monetization_detect — POST /api/v1/monetization/detect
// ---------------------------------------------------------------------------

export const admin_run_monetization_detect: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const message = String(args.message ?? '').trim();
  if (!message) return { ok: false, error: 'admin_run_monetization_detect requires message.' };
  const { ok, status, body } = await gatewayApiCall('/api/v1/monetization/detect', {
    method: 'POST',
    headers: authHeaders(id),
    body: { message },
  });
  if (!ok) return { ok: false, error: `admin_run_monetization_detect failed (${status}): ${String(body.error ?? 'unknown')}` };
  const total = Number(body.total_count ?? 0);
  return { ok: true, result: body, text: total === 0 ? 'No financial or value signals detected.' : `${total} signals detected.` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ADMIN_OVERSIGHT_BILLING_TOOL_HANDLERS: Record<string, Handler> = {
  admin_list_meetups,
  admin_delete_meetup,
  admin_list_groups,
  admin_list_live_rooms,
  admin_list_creators,
  admin_list_memberships,
  admin_community_stats,
  admin_activity_feed,
  admin_credit_wallet,
  admin_debit_wallet,
  admin_get_founding_status,
  admin_get_monetization_config,
  admin_run_monetization_detect,
};

export const ADMIN_OVERSIGHT_BILLING_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'admin_list_meetups', description: 'List all community meetups (admin oversight).', parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
  {
    name: 'admin_delete_meetup',
    description: 'Permanently delete a meetup. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { meetup_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['meetup_id'] },
  },
  { name: 'admin_list_groups', description: 'List all community groups (admin oversight).', parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'admin_list_live_rooms', description: 'List all live rooms across the tenant (admin supervision).', parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'admin_list_creators', description: 'List creator/service profiles.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'admin_list_memberships', description: 'List community memberships.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'admin_community_stats', description: 'Community-wide counts: meetups, groups, live rooms, memberships.', parameters: { type: 'object', properties: {} } },
  { name: 'admin_activity_feed', description: 'Recent community activity (meetups + live rooms).', parameters: { type: 'object', properties: {} } },
  {
    name: 'admin_credit_wallet',
    description: 'Credit a user wallet by a manual amount (exafy_admin only). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Required.' },
        currency: { type: 'string', description: 'EUR or USD. Required.' },
        amount_minor: { type: 'number', description: 'Positive integer, minor units (cents). Required.' },
        description: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['user_id', 'currency', 'amount_minor'],
    },
  },
  {
    name: 'admin_debit_wallet',
    description: 'Debit a user wallet by a manual amount (exafy_admin only). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Required.' },
        currency: { type: 'string', description: 'EUR or USD. Required.' },
        amount_minor: { type: 'number', description: 'Positive integer, minor units (cents). Required.' },
        description: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['user_id', 'currency', 'amount_minor'],
    },
  },
  { name: 'admin_get_founding_status', description: 'Founding-member campaign progress (spots used / remaining).', parameters: { type: 'object', properties: {} } },
  { name: 'admin_get_monetization_config', description: 'Current monetization engine configuration (thresholds, cooldowns).', parameters: { type: 'object', properties: {} } },
  {
    name: 'admin_run_monetization_detect',
    description: 'Run financial/value signal detection on a sample message (debugging).',
    parameters: { type: 'object', properties: { message: { type: 'string', description: 'Required.' } }, required: ['message'] },
  },
];
