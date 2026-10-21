/**
 * Admin voice tools — Autopilot Admin (B13) + Analytics & Intent Engine
 * (B14), Wave 4 of docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * B13 is a thin dispatch layer over routes/admin-autopilot.ts (mounted at
 * /api/v1/admin/autopilot, requireTenantAdmin — tenant resolved from the
 * caller's own JWT/targetTenantId, no :tenantId path segment on this router).
 *
 * B14 combines routes/tenant-admin/product-analytics.ts (5 read-only
 * summaries, requireTenantAdmin) with routes/admin-intent-engine.ts (5
 * intent-engine tools, requireAdminAuth = exafy_admin only — gated further
 * here to match). `admin_archive_intent` maps to POST /archive, which
 * batch-archives old *matches* by age (there's no per-intent archive route);
 * documented in the tool description rather than faking a narrower endpoint.
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

function requireExafyAdmin(id: OrbToolIdentity): OrbToolResult | null {
  const denied = adminGate(id);
  if (denied) return denied;
  if (String(id.role ?? '').toLowerCase() !== 'exafy_admin') {
    return { ok: false, error: 'This tool requires an exafy_admin session (operator-only).' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// B13.1 admin_get_autopilot_settings — GET /api/v1/admin/autopilot/settings
// ---------------------------------------------------------------------------

export const admin_get_autopilot_settings: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/autopilot/settings', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_get_autopilot_settings failed (${status}): ${String(body.error ?? 'unknown')}` };
  const data = (body.data ?? {}) as Record<string, unknown>;
  return { ok: true, result: data, text: `Autopilot is ${data.enabled ? 'enabled' : 'disabled'} for this tenant.` };
};

// ---------------------------------------------------------------------------
// B13.2 admin_update_autopilot_settings — PATCH .../settings
// ---------------------------------------------------------------------------

const AUTOPILOT_SETTINGS_FIELDS = [
  'enabled', 'max_recommendations_per_day', 'max_activations_per_day',
  'allowed_domains', 'allowed_risk_levels', 'auto_activate_threshold',
  'recommendation_retention_days', 'generation_schedule', 'wave_config',
];

export const admin_update_autopilot_settings: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const updates: Record<string, unknown> = {};
  for (const key of AUTOPILOT_SETTINGS_FIELDS) if (args[key] !== undefined) updates[key] = args[key];
  if (Object.keys(updates).length === 0) return { ok: false, error: `admin_update_autopilot_settings requires at least one of: ${AUTOPILOT_SETTINGS_FIELDS.join(', ')}.` };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, updates },
      text: `About to update autopilot settings: ${Object.keys(updates).join(', ')}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/autopilot/settings', {
    method: 'PATCH',
    headers: authHeaders(id),
    body: updates,
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update settings: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Autopilot settings updated.` };
};

// ---------------------------------------------------------------------------
// B13.3 admin_list_autopilot_bindings — GET .../bindings
// ---------------------------------------------------------------------------

export const admin_list_autopilot_bindings: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/autopilot/bindings', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_list_autopilot_bindings failed (${status}): ${String(body.error ?? 'unknown')}` };
  const bindings = (Array.isArray(body.data) ? body.data : []) as Array<Record<string, unknown>>;
  if (bindings.length === 0) return { ok: true, result: { bindings: [] }, text: 'No automation bindings configured.' };
  return { ok: true, result: { bindings }, text: `${bindings.length} automation bindings.` };
};

// ---------------------------------------------------------------------------
// B13.4 admin_create_autopilot_binding — POST .../bindings
// ---------------------------------------------------------------------------

export const admin_create_autopilot_binding: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const automationId = String(args.automation_id ?? '').trim();
  if (!automationId) return { ok: false, error: 'admin_create_autopilot_binding requires automation_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, automation_id: automationId },
      text: `About to create/update a binding for automation "${automationId}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/autopilot/bindings', {
    method: 'POST',
    headers: authHeaders(id),
    body: {
      automation_id: automationId,
      enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
      requires_approval: typeof args.requires_approval === 'boolean' ? args.requires_approval : undefined,
      max_runs_per_day: typeof args.max_runs_per_day === 'number' ? args.max_runs_per_day : undefined,
    },
  });
  if (!ok) return { ok: true, result: { created: false, status, detail: body }, text: `Could not create the binding: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { created: true, detail: body }, text: `Binding for "${automationId}" saved.` };
};

// ---------------------------------------------------------------------------
// B13.5 admin_delete_autopilot_binding — DELETE .../bindings/:bindingId
// ---------------------------------------------------------------------------

export const admin_delete_autopilot_binding: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const bindingId = String(args.binding_id ?? '').trim();
  if (!bindingId) return { ok: false, error: 'admin_delete_autopilot_binding requires binding_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, binding_id: bindingId },
      text: `About to remove automation binding ${bindingId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/autopilot/bindings/${encodeURIComponent(bindingId)}`, {
    method: 'DELETE',
    headers: authHeaders(id),
  });
  if (!ok) return { ok: true, result: { deleted: false, status, detail: body }, text: `Could not remove the binding: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { deleted: true }, text: `Binding ${bindingId} removed.` };
};

// ---------------------------------------------------------------------------
// B13.6 admin_list_autopilot_runs — GET .../runs
// ---------------------------------------------------------------------------

export const admin_list_autopilot_runs: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const limit = clampLimit(args.limit, 20, 100);
  const params = new URLSearchParams({ limit: String(limit) });
  if (typeof args.status === 'string') params.set('status', args.status);
  if (typeof args.automation_id === 'string') params.set('automation_id', args.automation_id);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/autopilot/runs?${params.toString()}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_list_autopilot_runs failed (${status}): ${String(body.error ?? 'unknown')}` };
  const runs = (Array.isArray(body.data) ? body.data : []) as Array<Record<string, unknown>>;
  if (runs.length === 0) return { ok: true, result: { runs: [] }, text: 'No automation runs found.' };
  return { ok: true, result: { runs }, text: `${runs.length} runs.` };
};

// ---------------------------------------------------------------------------
// B13.7 admin_autopilot_run_stats — GET .../runs/stats
// ---------------------------------------------------------------------------

export const admin_autopilot_run_stats: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/autopilot/runs/stats', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_autopilot_run_stats failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: 'Autopilot run stats retrieved.' };
};

// ---------------------------------------------------------------------------
// B13.8 admin_update_autopilot_wave — PATCH .../waves/:waveId
// ---------------------------------------------------------------------------

export const admin_update_autopilot_wave: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const waveId = String(args.wave_id ?? '').trim();
  if (!waveId) return { ok: false, error: 'admin_update_autopilot_wave requires wave_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, wave_id: waveId },
      text: `About to edit wave "${waveId}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/autopilot/waves/${encodeURIComponent(waveId)}`, {
    method: 'PATCH',
    headers: authHeaders(id),
    body: {
      enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
    },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update the wave: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Wave "${waveId}" updated.` };
};

// ---------------------------------------------------------------------------
// B14.1-5 Analytics summaries — GET .../analytics/{summary,assistant,journeys,features,interests}
// ---------------------------------------------------------------------------

async function analyticsRead(id: OrbToolIdentity, args: OrbToolArgs, endpoint: string, label: string): Promise<OrbToolResult> {
  const denied = adminGate(id);
  if (denied) return denied;
  if (!id.user_jwt || !id.tenant_id) return NO_ADMIN_SESSION;
  const days = clampLimit(args.days, 30, 90);
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/tenants/${encodeURIComponent(id.tenant_id)}/analytics/${endpoint}?days=${days}`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `${label} failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: `${label.replace('admin_', '').replace(/_/g, ' ')} for the last ${days} days retrieved.` };
}

export const admin_analytics_summary: Handler = async (args, id) => analyticsRead(id, args, 'summary', 'admin_analytics_summary');
export const admin_assistant_analytics: Handler = async (args, id) => analyticsRead(id, args, 'assistant', 'admin_assistant_analytics');
export const admin_journey_analytics: Handler = async (args, id) => analyticsRead(id, args, 'journeys', 'admin_journey_analytics');
export const admin_feature_analytics: Handler = async (args, id) => analyticsRead(id, args, 'features', 'admin_feature_analytics');
export const admin_interest_analytics: Handler = async (args, id) => analyticsRead(id, args, 'interests', 'admin_interest_analytics');

// ---------------------------------------------------------------------------
// B14.6 admin_intent_engine_stats — GET /api/v1/admin/intent-engine/stats
// (exafy_admin only, per requireAdminAuth)
// ---------------------------------------------------------------------------

export const admin_intent_engine_stats: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/intent-engine/stats', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `admin_intent_engine_stats failed (${status}): ${String(body.error ?? 'unknown')}` };
  const stats = (body.stats ?? {}) as Record<string, unknown>;
  return { ok: true, result: stats, text: `${Number(stats.open_intents ?? 0)} open intents, ${Number(stats.total_matches ?? 0)} total matches, ${Number(stats.stuck_open_24h ?? 0)} stuck >24h.` };
};

// ---------------------------------------------------------------------------
// B14.7 admin_close_intent — POST /api/v1/admin/intent-engine/intent/:id/close
// ---------------------------------------------------------------------------

export const admin_close_intent: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const intentId = String(args.intent_id ?? '').trim();
  if (!intentId) return { ok: false, error: 'admin_close_intent requires intent_id.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, intent_id: intentId },
      text: `About to force-close intent ${intentId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/admin/intent-engine/intent/${encodeURIComponent(intentId)}/close`, {
    method: 'POST',
    headers: authHeaders(id),
    body: { reason: typeof args.reason === 'string' ? args.reason : 'admin_action' },
  });
  if (!ok) return { ok: true, result: { closed: false, status, detail: body }, text: `Could not close the intent: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { closed: true }, text: `Intent ${intentId} force-closed.` };
};

// ---------------------------------------------------------------------------
// B14.8 admin_recompute_intent — POST /api/v1/admin/intent-engine/recompute
// ---------------------------------------------------------------------------

export const admin_recompute_intent: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const intentId = typeof args.intent_id === 'string' ? args.intent_id.trim() : undefined;
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, intent_id: intentId ?? 'all (daily fan-out)' },
      text: intentId ? `About to recompute matches for intent ${intentId}. Confirm, then call again with confirm=true.` : `About to recompute matches for ALL open intents (daily fan-out). Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/intent-engine/recompute', {
    method: 'POST',
    headers: authHeaders(id),
    body: intentId ? { intent_id: intentId } : {},
  });
  if (!ok) return { ok: true, result: { recomputed: false, status, detail: body }, text: `Recompute failed: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { recomputed: true, detail: body }, text: intentId ? `Recomputed matches for intent ${intentId}.` : `Daily recompute triggered for all open intents.` };
};

// ---------------------------------------------------------------------------
// B14.9 admin_resolve_dispute — POST /api/v1/admin/intent-engine/disputes/:disputeId/resolve
// ---------------------------------------------------------------------------

const DISPUTE_STATUSES = ['resolved', 'dismissed'];

export const admin_resolve_dispute: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const disputeId = String(args.dispute_id ?? '').trim();
  const status = String(args.status ?? '').trim();
  const resolution = String(args.resolution ?? '').trim();
  if (!disputeId || !DISPUTE_STATUSES.includes(status) || resolution.length < 5) {
    return { ok: false, error: `admin_resolve_dispute requires dispute_id, status (${DISPUTE_STATUSES.join('|')}), and resolution (min 5 chars).` };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, dispute_id: disputeId, status },
      text: `About to ${status} dispute ${disputeId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status: httpStatus, body } = await gatewayApiCall(`/api/v1/admin/intent-engine/disputes/${encodeURIComponent(disputeId)}/resolve`, {
    method: 'POST',
    headers: authHeaders(id),
    body: { status, resolution },
  });
  if (!ok) return { ok: true, result: { resolved: false, status: httpStatus, detail: body }, text: `Could not resolve the dispute: ${String(body.error ?? `gateway returned ${httpStatus}`)}.` };
  return { ok: true, result: { resolved: true, detail: body }, text: `Dispute ${disputeId} marked ${status}.` };
};

// ---------------------------------------------------------------------------
// B14.10 admin_archive_intent — POST /api/v1/admin/intent-engine/archive
// (batch-archives old MATCHES by age — no per-intent archive route exists)
// ---------------------------------------------------------------------------

export const admin_archive_intent: Handler = async (args, id) => {
  const denied = requireExafyAdmin(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_ADMIN_SESSION;
  const olderThanDays = Number(args.older_than_days ?? 90);
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, older_than_days: olderThanDays },
      text: `About to archive intent matches older than ${olderThanDays} days (this is a batch job by age, not a single-intent action). Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/intent-engine/archive', {
    method: 'POST',
    headers: authHeaders(id),
    body: { older_than_days: olderThanDays },
  });
  if (!ok) return { ok: true, result: { archived: false, status, detail: body }, text: `Archive failed: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { archived: true, detail: body }, text: `Archived ${Number(body.archived ?? 0)} old intent matches, ${Number(body.remaining ?? 0)} remaining.` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ADMIN_AUTOPILOT_ANALYTICS_TOOL_HANDLERS: Record<string, Handler> = {
  admin_get_autopilot_settings,
  admin_update_autopilot_settings,
  admin_list_autopilot_bindings,
  admin_create_autopilot_binding,
  admin_delete_autopilot_binding,
  admin_list_autopilot_runs,
  admin_autopilot_run_stats,
  admin_update_autopilot_wave,
  admin_analytics_summary,
  admin_assistant_analytics,
  admin_journey_analytics,
  admin_feature_analytics,
  admin_interest_analytics,
  admin_intent_engine_stats,
  admin_close_intent,
  admin_recompute_intent,
  admin_resolve_dispute,
  admin_archive_intent,
};

export const ADMIN_AUTOPILOT_ANALYTICS_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'admin_get_autopilot_settings', description: 'Tenant autopilot settings (enabled, limits, schedule).', parameters: { type: 'object', properties: {} } },
  {
    name: 'admin_update_autopilot_settings',
    description: 'Update tenant autopilot settings. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        max_recommendations_per_day: { type: 'number' },
        max_activations_per_day: { type: 'number' },
        auto_activate_threshold: { type: 'number' },
        confirm: { type: 'boolean' },
      },
    },
  },
  { name: 'admin_list_autopilot_bindings', description: 'List automation bindings active for this tenant.', parameters: { type: 'object', properties: {} } },
  {
    name: 'admin_create_autopilot_binding',
    description: 'Create or update an automation binding. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { automation_id: { type: 'string', description: 'Required.' }, enabled: { type: 'boolean' }, requires_approval: { type: 'boolean' }, max_runs_per_day: { type: 'number' }, confirm: { type: 'boolean' } }, required: ['automation_id'] },
  },
  {
    name: 'admin_delete_autopilot_binding',
    description: 'Remove an automation binding. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { binding_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['binding_id'] },
  },
  { name: 'admin_list_autopilot_runs', description: 'List automation execution runs.', parameters: { type: 'object', properties: { limit: { type: 'number' }, status: { type: 'string' }, automation_id: { type: 'string' } } } },
  { name: 'admin_autopilot_run_stats', description: 'Execution run statistics for the tenant.', parameters: { type: 'object', properties: {} } },
  {
    name: 'admin_update_autopilot_wave',
    description: 'Enable/disable an autopilot wave for this tenant. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { wave_id: { type: 'string', description: 'Required.' }, enabled: { type: 'boolean' }, confirm: { type: 'boolean' } }, required: ['wave_id'] },
  },
  { name: 'admin_analytics_summary', description: 'Product analytics KPI overview (users, sessions, top routes).', parameters: { type: 'object', properties: { days: { type: 'number', description: '1-90, default 30.' } } } },
  { name: 'admin_assistant_analytics', description: 'Assistant usage analytics (intents, topics, tools, p95 latency).', parameters: { type: 'object', properties: { days: { type: 'number' } } } },
  { name: 'admin_journey_analytics', description: 'User journey analytics (entry/exit routes, top paths, drop-offs).', parameters: { type: 'object', properties: { days: { type: 'number' } } } },
  { name: 'admin_feature_analytics', description: 'Feature adoption analytics (opens, completions, repeat users).', parameters: { type: 'object', properties: { days: { type: 'number' } } } },
  { name: 'admin_interest_analytics', description: 'Detected interest/topic analytics.', parameters: { type: 'object', properties: { days: { type: 'number' } } } },
  { name: 'admin_intent_engine_stats', description: 'Intent Engine dashboard stats (exafy_admin only).', parameters: { type: 'object', properties: {} } },
  {
    name: 'admin_close_intent',
    description: 'Force-close a user intent (exafy_admin only). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { intent_id: { type: 'string', description: 'Required.' }, reason: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['intent_id'] },
  },
  {
    name: 'admin_recompute_intent',
    description: 'Recompute matches for one intent, or trigger the daily fan-out for all open intents if intent_id is omitted (exafy_admin only). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { intent_id: { type: 'string' }, confirm: { type: 'boolean' } } },
  },
  {
    name: 'admin_resolve_dispute',
    description: 'Resolve or dismiss an intent-match dispute (exafy_admin only). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { dispute_id: { type: 'string', description: 'Required.' }, status: { type: 'string', description: 'resolved or dismissed. Required.' }, resolution: { type: 'string', description: 'Min 5 chars. Required.' }, confirm: { type: 'boolean' } }, required: ['dispute_id', 'status', 'resolution'] },
  },
  {
    name: 'admin_archive_intent',
    description: 'Batch-archive old intent matches by age (exafy_admin only; this is a batch job, not single-intent). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { older_than_days: { type: 'number', description: 'Default 90, min 7.' }, confirm: { type: 'boolean' } } },
  },
];
