/**
 * Admin voice tools — Notifications & Broadcast (Wave 3, plan section B11).
 *
 * Thin dispatch layer over routes/admin-notifications.ts and
 * routes/admin-notification-categories.ts. Per research: there is no true
 * draft/preview primitive backing "compose" — /compose always sends
 * immediately. admin_compose_broadcast is therefore implemented as a
 * client-side-only audience-size preview (direct Supabase reads), never
 * calling /compose; admin_send_broadcast is the only tool that actually
 * dispatches. "Broadcasts" list is really the general user_notifications
 * log — flagged honestly in the tool text.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall, clampLimit, relAge } from './developer-tools';
import { adminGate, authHeaders, NO_ADMIN_SESSION } from './admin-users-rbac-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

async function resolveAudienceCount(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<{ count: number; description: string } | { error: string }> {
  const tenantId = typeof args.tenant_id === 'string' ? args.tenant_id : id.tenant_id;
  if (Array.isArray(args.recipient_ids) && args.recipient_ids.length > 0) {
    return { count: args.recipient_ids.length, description: `${args.recipient_ids.length} explicit recipients` };
  }
  if (!tenantId) return { error: 'A tenant_id is required to resolve the audience.' };
  if (args.send_to_all === true) {
    const { count, error } = await sb.from('user_tenants').select('user_id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
    if (error) return { error: error.message };
    return { count: count ?? 0, description: `all ${count ?? 0} members of the tenant` };
  }
  if (typeof args.recipient_role === 'string' && args.recipient_role) {
    const { count, error } = await sb
      .from('user_tenants')
      .select('user_id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('active_role', args.recipient_role);
    if (error) return { error: error.message };
    return { count: count ?? 0, description: `${count ?? 0} members with role "${args.recipient_role}"` };
  }
  return { error: 'admin_compose_broadcast requires recipient_ids, or recipient_role + tenant_id, or send_to_all + tenant_id.' };
}

// ---------------------------------------------------------------------------
// 1. admin_compose_broadcast — preview only, no /compose call
// ---------------------------------------------------------------------------

export const admin_compose_broadcast: Handler = async (args, id, sb) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const title = String(args.title ?? '').trim();
  const bodyText = String(args.body ?? '').trim();
  if (!title || !bodyText) return { ok: false, error: 'admin_compose_broadcast requires title and body.' };
  const audience = await resolveAudienceCount(args, id, sb);
  if ('error' in audience) return { ok: false, error: audience.error };
  if (audience.count > 500) {
    return { ok: true, result: { audience }, text: `This would reach ${audience.count} recipients, which exceeds the 500-recipient send limit. Narrow the audience.` };
  }
  return {
    ok: true,
    result: { preview: true, title, body: bodyText, audience },
    text: `Draft ready: "${title}" — "${bodyText}" — would reach ${audience.description}. There is no draft-storage backend; call admin_send_broadcast when ready to actually send.`,
  };
};

// ---------------------------------------------------------------------------
// 2. admin_send_broadcast — POST /api/v1/admin/notifications/compose
// ---------------------------------------------------------------------------

export const admin_send_broadcast: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const title = String(args.title ?? '').trim();
  const bodyText = String(args.body ?? '').trim();
  if (!title || !bodyText) return { ok: false, error: 'admin_send_broadcast requires title and body.' };
  const hasAudience = Array.isArray(args.recipient_ids) && args.recipient_ids.length > 0
    ? true
    : args.send_to_all === true || typeof args.recipient_role === 'string';
  if (!hasAudience) return { ok: false, error: 'admin_send_broadcast requires recipient_ids, or recipient_role, or send_to_all (with tenant_id).' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, title },
      text: `About to send this notification NOW — this cannot be undone or previewed further. "${title}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/notifications/compose', {
    method: 'POST',
    headers: authHeaders(id),
    body: {
      title,
      body: bodyText,
      recipient_ids: args.recipient_ids,
      recipient_role: args.recipient_role,
      send_to_all: args.send_to_all,
      tenant_id: typeof args.tenant_id === 'string' ? args.tenant_id : id.tenant_id,
      type: args.type,
      channel: args.channel,
      priority: args.priority,
    },
  });
  if (!ok) return { ok: true, result: { sent: false, status, detail: body }, text: `Broadcast was not sent: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { sent: true, detail: body }, text: `Broadcast sent to ${String(body.sent_to ?? 'the audience')}.` };
};

// ---------------------------------------------------------------------------
// 3. admin_list_broadcasts — GET /api/v1/admin/notifications/sent
// ---------------------------------------------------------------------------

export const admin_list_broadcasts: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const qs = new URLSearchParams({ limit: String(clampLimit(args.limit, 20, 200)) });
  for (const k of ['type', 'user_id', 'search'] as const) {
    if (typeof args[k] === 'string' && args[k]) qs.set(k, args[k] as string);
  }
  if (typeof args.days === 'number') qs.set('days', String(args.days));
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/notifications/sent?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_list_broadcasts failed (${status}): ${String(body.error ?? 'unknown')}` };
  const rows = (Array.isArray((body as Record<string, unknown>).data) ? (body as Record<string, unknown>).data : []) as Array<{ title?: string; created_at?: string }>;
  if (rows.length === 0) return { ok: true, result: { data: [] }, text: 'No notifications sent in that window.' };
  const lines = rows.slice(0, 8).map((r) => `${r.title ?? '(untitled)'} (${relAge(r.created_at)})`);
  return {
    ok: true,
    result: { data: rows },
    text: `${rows.length} notifications logged (this is the general notification log, not broadcast-only — no separate broadcast marker exists yet): ${lines.join('. ')}`,
  };
};

// ---------------------------------------------------------------------------
// 4. admin_notification_pref_stats — GET .../preferences/stats
// ---------------------------------------------------------------------------

export const admin_notification_pref_stats: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const qs = new URLSearchParams();
  const tenantId = typeof args.tenant_id === 'string' ? args.tenant_id : id.tenant_id;
  if (tenantId) qs.set('tenant_id', tenantId);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/notifications/preferences/stats?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_notification_pref_stats failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: 'Notification preference stats retrieved.' };
};

// ---------------------------------------------------------------------------
// 5. admin_create_notification_category — POST /api/v1/admin/notification-categories
// ---------------------------------------------------------------------------

const NOTIF_CATEGORY_TYPES = ['chat', 'calendar', 'community'];

export const admin_create_notification_category: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const type = String(args.type ?? '').trim();
  const displayName = String(args.display_name ?? '').trim();
  if (!NOTIF_CATEGORY_TYPES.includes(type) || !displayName) {
    return { ok: false, error: `admin_create_notification_category requires type (one of ${NOTIF_CATEGORY_TYPES.join(', ')}) and display_name.` };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, type, display_name: displayName },
      text: `About to create notification category "${displayName}" (${type}). Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/notification-categories', {
    method: 'POST',
    headers: authHeaders(id),
    body: {
      type,
      display_name: displayName,
      description: typeof args.description === 'string' ? args.description : undefined,
      icon: typeof args.icon === 'string' ? args.icon : undefined,
      sort_order: typeof args.sort_order === 'number' ? args.sort_order : undefined,
      default_enabled: typeof args.default_enabled === 'boolean' ? args.default_enabled : undefined,
      mapped_types: Array.isArray(args.mapped_types) ? args.mapped_types : undefined,
      tenant_id: typeof args.tenant_id === 'string' ? args.tenant_id : id.tenant_id,
    },
  });
  if (!ok) return { ok: true, result: { created: false, status, detail: body }, text: `Could not create the category: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { created: true, detail: body }, text: `Category "${displayName}" created.` };
};

// ---------------------------------------------------------------------------
// 6. admin_update_notification_category — PATCH .../notification-categories/:id
// ---------------------------------------------------------------------------

export const admin_update_notification_category: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const categoryId = String(args.category_id ?? '').trim();
  if (!categoryId) return { ok: false, error: 'admin_update_notification_category requires category_id.' };
  if (args.type !== undefined) return { ok: false, error: 'The category type cannot be changed after creation.' };
  const patch: Record<string, unknown> = {};
  for (const k of ['display_name', 'description', 'icon', 'sort_order', 'is_active', 'default_enabled', 'mapped_types'] as const) {
    if (args[k] !== undefined) patch[k] = args[k];
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'admin_update_notification_category requires at least one field to change.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, category_id: categoryId, patch },
      text: `About to update notification category ${categoryId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/notification-categories/${encodeURIComponent(categoryId)}`, {
    method: 'PATCH',
    headers: authHeaders(id),
    body: patch,
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update the category: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Category ${categoryId} updated.` };
};

// ---------------------------------------------------------------------------
// 7. admin_test_notification_category — POST .../notification-categories/:id/test
// ---------------------------------------------------------------------------

export const admin_test_notification_category: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const categoryId = String(args.category_id ?? '').trim();
  if (!categoryId) return { ok: false, error: 'admin_test_notification_category requires category_id.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/notification-categories/${encodeURIComponent(categoryId)}/test`, {
    method: 'POST',
    headers: authHeaders(id),
  });
  if (!ok) return { ok: true, result: { sent: false, status, detail: body }, text: `Test notification failed: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { sent: true, detail: body }, text: `Test notification sent to your own account (self-test only — there is no target-user parameter on this endpoint).` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ADMIN_NOTIFICATIONS_TOOL_HANDLERS: Record<string, Handler> = {
  admin_compose_broadcast,
  admin_send_broadcast,
  admin_list_broadcasts,
  admin_notification_pref_stats,
  admin_create_notification_category,
  admin_update_notification_category,
  admin_test_notification_category,
};

export const ADMIN_NOTIFICATIONS_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'admin_compose_broadcast',
    description: 'ADMIN ONLY. Preview a broadcast draft (audience size + text) WITHOUT sending. There is no server-side draft storage.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Required.' },
        body: { type: 'string', description: 'Required.' },
        recipient_ids: { type: 'array', items: { type: 'string' } },
        recipient_role: { type: 'string' },
        send_to_all: { type: 'boolean' },
        tenant_id: { type: 'string' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'admin_send_broadcast',
    description: 'ADMIN ONLY. Send a notification NOW to the resolved audience (max 500 recipients). TWO-STEP confirm — no undo.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Required.' },
        body: { type: 'string', description: 'Required.' },
        recipient_ids: { type: 'array', items: { type: 'string' } },
        recipient_role: { type: 'string' },
        send_to_all: { type: 'boolean' },
        tenant_id: { type: 'string' },
        type: { type: 'string' }, channel: { type: 'string' }, priority: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'admin_list_broadcasts',
    description: 'ADMIN ONLY. Sent notification history (general log, not broadcast-only).',
    parameters: { type: 'object', properties: { type: { type: 'string' }, user_id: { type: 'string' }, search: { type: 'string' }, days: { type: 'integer' }, limit: { type: 'integer' } } },
  },
  {
    name: 'admin_notification_pref_stats',
    description: 'ADMIN ONLY. Notification opt-in/out stats plus 30-day send/read counts.',
    parameters: { type: 'object', properties: { tenant_id: { type: 'string' } } },
  },
  {
    name: 'admin_create_notification_category',
    description: 'ADMIN ONLY. Create a new notification category. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'chat, calendar, or community. Required.' },
        display_name: { type: 'string', description: 'Required.' },
        description: { type: 'string' }, icon: { type: 'string' }, sort_order: { type: 'integer' },
        default_enabled: { type: 'boolean' }, mapped_types: { type: 'array', items: { type: 'string' } },
        tenant_id: { type: 'string', description: 'Omit for a global category.' }, confirm: { type: 'boolean' },
      },
      required: ['type', 'display_name'],
    },
  },
  {
    name: 'admin_update_notification_category',
    description: 'ADMIN ONLY. Edit a notification category (type is immutable). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        category_id: { type: 'string', description: 'Required.' },
        display_name: { type: 'string' }, description: { type: 'string' }, icon: { type: 'string' },
        sort_order: { type: 'integer' }, is_active: { type: 'boolean' }, default_enabled: { type: 'boolean' },
        mapped_types: { type: 'array', items: { type: 'string' } }, confirm: { type: 'boolean' },
      },
      required: ['category_id'],
    },
  },
  {
    name: 'admin_test_notification_category',
    description: 'ADMIN ONLY. Send a test notification for a category to your own account (self-test only).',
    parameters: { type: 'object', properties: { category_id: { type: 'string', description: 'Required.' } }, required: ['category_id'] },
  },
];
