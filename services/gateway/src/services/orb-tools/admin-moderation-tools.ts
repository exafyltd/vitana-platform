/**
 * Admin voice tools — Content Moderation (Wave 3, plan section B4).
 *
 * Thin dispatch layer over routes/tenant-admin/content-moderation.ts
 * (media_uploads queue), gated by requireTenantAdmin. `admin_list_reports`
 * and `admin_get_report` have no real backing table (`content_reports`
 * doesn't exist) — per plan rule 4 ("no new backend features"), these
 * degrade honestly to the closest real capability (the flagged-item view)
 * rather than inventing a reports endpoint.
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

function contentBase(id: OrbToolIdentity): string | null {
  if (!id.tenant_id) return null;
  return `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/content`;
}

// ---------------------------------------------------------------------------
// 1. admin_list_moderation_queue — GET .../content/items
// ---------------------------------------------------------------------------

export const admin_list_moderation_queue: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const base = contentBase(id);
  if (!base) return { ok: false, error: 'admin_list_moderation_queue requires a tenant context.' };
  const qs = new URLSearchParams({ limit: String(clampLimit(args.limit, 20, 200)) });
  if (typeof args.status === 'string' && args.status) qs.set('status', args.status);
  if (typeof args.type === 'string' && args.type) qs.set('type', args.type);
  const { ok, status, body } = await gatewayApiCall(`${base}/items?${qs.toString()}`, { headers: authHeaders(id) });
  if (!ok || body.ok !== true) return { ok: false, error: `admin_list_moderation_queue failed (${status}): ${String(body.error ?? 'unknown')}` };
  const items = (Array.isArray(body.items) ? body.items : []) as Array<{ id: string; media_type?: string; status?: string }>;
  if (items.length === 0) return { ok: true, result: { items: [] }, text: 'The moderation queue is empty.' };
  const lines = items.slice(0, 8).map((it) => `${it.id} — ${it.media_type ?? 'media'}, ${it.status ?? 'unknown'}`);
  return { ok: true, result: { items }, text: `${items.length} items in the queue: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 2. admin_get_moderation_item — GET .../content/items/:id
// ---------------------------------------------------------------------------

export const admin_get_moderation_item: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const base = contentBase(id);
  if (!base) return { ok: false, error: 'admin_get_moderation_item requires a tenant context.' };
  const itemId = String(args.item_id ?? '').trim();
  if (!itemId) return { ok: false, error: 'admin_get_moderation_item requires item_id.' };
  const { ok, status, body } = await gatewayApiCall(`${base}/items/${encodeURIComponent(itemId)}`, { headers: authHeaders(id) });
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No moderation item found with id ${itemId}.` }
      : { ok: false, error: `admin_get_moderation_item failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  return { ok: true, result: { found: true, item: body }, text: `Item ${itemId} — status ${String((body as Record<string, unknown>).status ?? 'unknown')}.` };
};

// ---------------------------------------------------------------------------
// 3. admin_moderation_stats — GET .../content/items/stats
// ---------------------------------------------------------------------------

export const admin_moderation_stats: Handler = async (_args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const base = contentBase(id);
  if (!base) return { ok: false, error: 'admin_moderation_stats requires a tenant context.' };
  const { ok, status, body } = await gatewayApiCall(`${base}/items/stats`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_moderation_stats failed (${status}): ${String(body.error ?? 'unknown')}` };
  const total = Number((body as Record<string, unknown>).total ?? 0);
  return { ok: true, result: body, text: `${total} total items in moderation.` };
};

// ---------------------------------------------------------------------------
// 4/5/6. admin_approve_content / admin_reject_content / admin_flag_content
// ---------------------------------------------------------------------------

async function moderationAction(
  action: 'approve' | 'reject' | 'flag',
  args: OrbToolArgs,
  id: OrbToolIdentity,
): Promise<OrbToolResult> {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const base = contentBase(id);
  if (!base) return { ok: false, error: `admin_${action}_content requires a tenant context.` };
  const itemId = String(args.item_id ?? '').trim();
  if (!itemId) return { ok: false, error: `admin_${action}_content requires item_id.` };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, item_id: itemId, action },
      text: `About to ${action} content item ${itemId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`${base}/items/${encodeURIComponent(itemId)}/${action}`, {
    method: 'POST',
    headers: authHeaders(id),
  });
  if (!ok) return { ok: true, result: { done: false, status, detail: body }, text: `Could not ${action} item ${itemId}: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { done: true, detail: body }, text: `Item ${itemId} ${action}d.` };
}

export const admin_approve_content: Handler = (args, id) => moderationAction('approve', args, id);
export const admin_reject_content: Handler = (args, id) => moderationAction('reject', args, id);
export const admin_flag_content: Handler = (args, id) => moderationAction('flag', args, id);

// ---------------------------------------------------------------------------
// 7. admin_list_reports — no content_reports table; aliases to flagged items
// ---------------------------------------------------------------------------

export const admin_list_reports: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const base = contentBase(id);
  if (!base) return { ok: false, error: 'admin_list_reports requires a tenant context.' };
  const limit = clampLimit(args.limit, 20, 200);
  const { ok, status, body } = await gatewayApiCall(`${base}/items?status=flagged&limit=${limit}`, { headers: authHeaders(id) });
  if (!ok || body.ok !== true) return { ok: false, error: `admin_list_reports failed (${status}): ${String(body.error ?? 'unknown')}` };
  const items = (Array.isArray(body.items) ? body.items : []) as Array<{ id: string; media_type?: string }>;
  return {
    ok: true,
    result: { reports: items },
    text: items.length === 0
      ? 'No flagged content right now. (Note: there is no dedicated user-report table yet — this shows flagged media instead.)'
      : `${items.length} flagged items (closest available to "reports" — no dedicated report table exists yet): ${items.slice(0, 8).map((i) => i.id).join(', ')}.`,
  };
};

// ---------------------------------------------------------------------------
// 8. admin_get_report — no backing at all
// ---------------------------------------------------------------------------

export const admin_get_report: Handler = async (_args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  return {
    ok: true,
    result: { available: false },
    text: 'There is no user-report system in the backend yet — only flagged media items. Use admin_get_moderation_item for a flagged item instead.',
  };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ADMIN_MODERATION_TOOL_HANDLERS: Record<string, Handler> = {
  admin_list_moderation_queue,
  admin_get_moderation_item,
  admin_moderation_stats,
  admin_approve_content,
  admin_reject_content,
  admin_flag_content,
  admin_list_reports,
  admin_get_report,
};

export const ADMIN_MODERATION_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'admin_list_moderation_queue',
    description: 'ADMIN ONLY. List pending content-moderation items, optionally filtered by status/type.',
    parameters: { type: 'object', properties: { status: { type: 'string' }, type: { type: 'string' }, limit: { type: 'integer' } } },
  },
  {
    name: 'admin_get_moderation_item',
    description: 'ADMIN ONLY. Detail for one moderation queue item.',
    parameters: { type: 'object', properties: { item_id: { type: 'string', description: 'Required.' } }, required: ['item_id'] },
  },
  {
    name: 'admin_moderation_stats',
    description: 'ADMIN ONLY. Moderation queue stats (counts by status/type).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'admin_approve_content',
    description: 'ADMIN ONLY. Approve a moderation item (makes it public). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { item_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['item_id'] },
  },
  {
    name: 'admin_reject_content',
    description: 'ADMIN ONLY. Reject a moderation item (removes from public). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { item_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['item_id'] },
  },
  {
    name: 'admin_flag_content',
    description: 'ADMIN ONLY. Flag a moderation item for further review. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { item_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['item_id'] },
  },
  {
    name: 'admin_list_reports',
    description: 'ADMIN ONLY. List user reports. NOTE: no dedicated report table exists yet — shows flagged media instead.',
    parameters: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  {
    name: 'admin_get_report',
    description: 'ADMIN ONLY. Get one user report. NOTE: not implemented in the backend yet.',
    parameters: { type: 'object', properties: {} },
  },
];
