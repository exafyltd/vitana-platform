/**
 * Developer voice tools — Self-Healing (C8), Wave 5 of
 * docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * Thin dispatch layer over routes/self-healing.ts (mounted at
 * /api/v1/self-healing — served anonymously, no auth middleware at all;
 * `developerGate()` is the only real access control) plus a "healing"
 * subset of routes/voice-lab.ts (mounted at /api/v1/voice-lab, gated by
 * requireAuth — those three forward id.user_jwt as Bearer).
 *
 * dev_report_incident uses the real POST /report endpoint's documented
 * `routine-incident://<service>/<slug>` synthetic-endpoint convention —
 * this is an existing, intentional pattern in the route (not invented).
 * dev_verify_heal's backing route is a POST (a live blast-radius check),
 * not a read, despite the plan labeling it R — it's non-destructive
 * (verification only) so it isn't confirm-gated. dev_list_quarantine has
 * no true "list all"; the only route is a single {class, signature} pair
 * lookup, so both are required arguments here rather than a browsable list.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall, clampLimit, developerGate } from './developer-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

const NO_DEV_SESSION: OrbToolResult = {
  ok: true,
  result: { reason: 'no_dev_session' },
  text: "This needs a signed-in session — I don't have one for this voice session.",
};

function authHeaders(id: OrbToolIdentity): Record<string, string> {
  return id.user_jwt ? { Authorization: `Bearer ${id.user_jwt}` } : {};
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'incident';
}

// ---------------------------------------------------------------------------
// 1. dev_report_incident — POST /api/v1/self-healing/report
// (uses the routine-incident:// synthetic-endpoint convention)
// ---------------------------------------------------------------------------

export const dev_report_incident: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const service = String(args.service ?? '').trim();
  const summary = String(args.summary ?? '').trim();
  if (!service || !summary) return { ok: false, error: 'dev_report_incident requires service and summary.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, service, summary },
      text: `About to file an incident for "${service}": "${summary}". Confirm, then call again with confirm=true.`,
    };
  }
  const endpoint = `routine-incident://${slugify(service)}/${slugify(summary)}`;
  const { ok, status, body } = await gatewayApiCall('/api/v1/self-healing/report', {
    method: 'POST',
    body: {
      total: 1,
      live: 0,
      services: [{ service, endpoint, status: 'down', detail: summary }],
    },
  });
  if (!ok) return { ok: true, result: { filed: false, status, detail: body }, text: `Could not file the incident: ${String(body.error ?? `gateway returned ${status}`)}.` };
  const vtids = (Array.isArray(body.details) ? body.details : []) as Array<{ vtid?: string }>;
  const vtid = vtids.find((d) => d.vtid)?.vtid;
  return { ok: true, result: { filed: true, detail: body }, text: vtid ? `Incident filed as ${vtid}.` : `Incident report submitted.` };
};

// ---------------------------------------------------------------------------
// 2. dev_healing_config — GET /api/v1/self-healing/config
// ---------------------------------------------------------------------------

export const dev_healing_config: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/self-healing/config');
  if (!ok) return { ok: false, error: `dev_healing_config failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: `Self-healing is ${body.enabled ? 'enabled' : 'disabled'}, autonomy level ${Number(body.autonomy_level ?? 0)} (${String(body.autonomy_name ?? 'unknown')}).` };
};

// ---------------------------------------------------------------------------
// 3. dev_set_healing_mode — PATCH /api/v1/self-healing/config
// ---------------------------------------------------------------------------

export const dev_set_healing_mode: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const level = Number(args.autonomy_level);
  if (!Number.isInteger(level) || level < 0 || level > 4) {
    return { ok: false, error: 'dev_set_healing_mode requires autonomy_level, an integer 0-4.' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, autonomy_level: level },
      text: `About to set self-healing autonomy level to ${level}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/self-healing/config', {
    method: 'PATCH',
    body: { autonomy_level: level },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not change the autonomy level: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Self-healing autonomy level set to ${level} (${String(body.autonomy_name ?? '')}).` };
};

// ---------------------------------------------------------------------------
// 4. dev_healing_kill_switch — POST /api/v1/self-healing/kill-switch
// ---------------------------------------------------------------------------

export const dev_healing_kill_switch: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const action = String(args.action ?? '').trim();
  if (!['activate', 'deactivate'].includes(action)) {
    return { ok: false, error: 'dev_healing_kill_switch requires action: activate or deactivate.' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, action },
      text: `About to ${action} the self-healing kill switch. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/self-healing/kill-switch', {
    method: 'POST',
    body: { action, reason: typeof args.reason === 'string' ? args.reason : undefined },
  });
  if (!ok) return { ok: true, result: { changed: false, status, detail: body }, text: `Could not flip the kill switch: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { changed: true, detail: body }, text: `Self-healing kill switch is now ${String(body.status ?? action)}.` };
};

// ---------------------------------------------------------------------------
// 5. dev_healing_history — GET /api/v1/self-healing/history
// ---------------------------------------------------------------------------

export const dev_healing_history: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const limit = clampLimit(args.limit, 50, 100);
  const qs = new URLSearchParams({ limit: String(limit) });
  if (typeof args.failure_class === 'string' && args.failure_class) qs.set('failure_class', args.failure_class);
  if (typeof args.outcome === 'string' && args.outcome) qs.set('outcome', args.outcome);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/self-healing/history?${qs.toString()}`);
  if (!ok) return { ok: false, error: `dev_healing_history failed (${status}): ${String(body.error ?? 'unknown')}` };
  const items = (Array.isArray(body.items) ? body.items : []) as unknown[];
  if (items.length === 0) return { ok: true, result: { items: [] }, text: 'No healing history yet.' };
  return { ok: true, result: { items, total: body.total }, text: `${items.length} of ${Number(body.total ?? items.length)} healing events.` };
};

// ---------------------------------------------------------------------------
// 6. dev_healing_metrics — GET /api/v1/self-healing/metrics/summary
// ---------------------------------------------------------------------------

export const dev_healing_metrics: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const days = clampLimit(args.days, 7, 90);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/self-healing/metrics/summary?days=${days}`);
  if (!ok) return { ok: false, error: `dev_healing_metrics failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body.metrics ?? body, text: `Self-healing metrics for the last ${days} days retrieved.` };
};

// ---------------------------------------------------------------------------
// 7/8. dev_approve_heal / dev_reject_heal
// ---------------------------------------------------------------------------

async function decideHeal(args: OrbToolArgs, id: OrbToolIdentity, decision: 'approve' | 'reject'): Promise<OrbToolResult> {
  const denied = developerGate(id);
  if (denied) return denied;
  const healId = String(args.heal_id ?? '').trim();
  if (!healId) return { ok: false, error: `dev_${decision}_heal requires heal_id.` };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, heal_id: healId },
      text: `About to ${decision} pending heal ${healId}. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/self-healing/${decision}`, {
    method: 'POST',
    body: { id: healId, reason: typeof args.reason === 'string' ? args.reason : undefined },
  });
  if (!ok) return { ok: true, result: { decided: false, status, detail: body }, text: `Could not ${decision} the heal: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { decided: true, detail: body }, text: `Heal ${healId} ${decision}d.` };
}

export const dev_approve_heal: Handler = async (args, id) => decideHeal(args, id, 'approve');
export const dev_reject_heal: Handler = async (args, id) => decideHeal(args, id, 'reject');

// ---------------------------------------------------------------------------
// 9. dev_verify_heal — POST /api/v1/self-healing/verify/:vtid (inspection, no confirm)
// ---------------------------------------------------------------------------

export const dev_verify_heal: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const vtid = String(args.vtid ?? '').trim();
  if (!vtid) return { ok: false, error: 'dev_verify_heal requires vtid.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/self-healing/verify/${encodeURIComponent(vtid)}`, { method: 'POST' });
  if (!ok) return { ok: false, error: `dev_verify_heal failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body.result ?? body, text: `Blast-radius verification for ${vtid} complete.` };
};

// ---------------------------------------------------------------------------
// 10. dev_rollback_heal — POST /api/v1/self-healing/rollback/:vtid
// ---------------------------------------------------------------------------

export const dev_rollback_heal: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const vtid = String(args.vtid ?? '').trim();
  if (!vtid) return { ok: false, error: 'dev_rollback_heal requires vtid.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, vtid },
      text: `About to roll back the heal for ${vtid} to its pre-fix snapshot. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/self-healing/rollback/${encodeURIComponent(vtid)}`, { method: 'POST' });
  if (!ok) {
    return status === 404
      ? { ok: true, result: { rolled_back: false, reason: 'no_snapshot' }, text: `No pre-fix snapshot exists for ${vtid} — nothing to roll back to.` }
      : { ok: true, result: { rolled_back: false, status, detail: body }, text: `Could not roll back: ${String(body.error ?? `gateway returned ${status}`)}.` };
  }
  return { ok: true, result: { rolled_back: true }, text: String(body.message ?? `${vtid} rolled back.`) };
};

// ---------------------------------------------------------------------------
// 11. dev_list_quarantine — GET /api/v1/voice-lab/healing/quarantine (requires class+signature)
// ---------------------------------------------------------------------------

export const dev_list_quarantine: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const cls = String(args.failure_class ?? '').trim();
  const signature = String(args.signature ?? '').trim();
  if (!cls || !signature) {
    return { ok: false, error: 'dev_list_quarantine requires both failure_class and signature — there is no "list all quarantined items" endpoint, only a single lookup.' };
  }
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/voice-lab/healing/quarantine?class=${encodeURIComponent(cls)}&signature=${encodeURIComponent(signature)}`,
    { headers: authHeaders(id) },
  );
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No quarantine entry for that class/signature pair.` }
      : { ok: false, error: `dev_list_quarantine failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  return { ok: true, result: body, text: `Quarantine entry found for ${cls}/${signature}.` };
};

// ---------------------------------------------------------------------------
// 12. dev_release_quarantine — POST /api/v1/voice-lab/healing/quarantine/release
// ---------------------------------------------------------------------------

export const dev_release_quarantine: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const cls = String(args.failure_class ?? '').trim();
  const signature = String(args.signature ?? '').trim();
  if (!cls || !signature) return { ok: false, error: 'dev_release_quarantine requires failure_class and signature.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, failure_class: cls, signature },
      text: `About to release ${cls}/${signature} from quarantine. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/voice-lab/healing/quarantine/release', {
    method: 'POST',
    headers: authHeaders(id),
    body: { class: cls, signature, reason: typeof args.reason === 'string' ? args.reason : undefined },
  });
  if (!ok) return { ok: true, result: { released: false, status, detail: body }, text: `Could not release from quarantine: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { released: true, detail: body }, text: `Released from quarantine — new status: ${String(body.new_status ?? 'unknown')}.` };
};

// ---------------------------------------------------------------------------
// 13. dev_shadow_comparison — GET /api/v1/voice-lab/healing/shadow-comparison
// ---------------------------------------------------------------------------

export const dev_shadow_comparison: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_DEV_SESSION;
  const windowHours = clampLimit(args.window_hours, 48, 720);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/voice-lab/healing/shadow-comparison?window_hours=${windowHours}`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_shadow_comparison failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: `Shadow comparison over the last ${windowHours}h: match rate ${Number(body.match_rate ?? 0)}.` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const SELF_HEALING_TOOL_HANDLERS: Record<string, Handler> = {
  dev_report_incident,
  dev_healing_config,
  dev_set_healing_mode,
  dev_healing_kill_switch,
  dev_healing_history,
  dev_healing_metrics,
  dev_approve_heal,
  dev_reject_heal,
  dev_verify_heal,
  dev_rollback_heal,
  dev_list_quarantine,
  dev_release_quarantine,
  dev_shadow_comparison,
};

export const SELF_HEALING_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'dev_report_incident',
    description: 'DEVELOPER ONLY. File a manual incident for a service. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { service: { type: 'string', description: 'Required.' }, summary: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['service', 'summary'] },
  },
  { name: 'dev_healing_config', description: 'DEVELOPER ONLY. Self-healing enabled state + autonomy level.', parameters: { type: 'object', properties: {} } },
  {
    name: 'dev_set_healing_mode',
    description: 'DEVELOPER ONLY. Set the self-healing autonomy level (0-4). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { autonomy_level: { type: 'number', description: '0-4. Required.' }, confirm: { type: 'boolean' } }, required: ['autonomy_level'] },
  },
  {
    name: 'dev_healing_kill_switch',
    description: 'DEVELOPER ONLY. Activate or deactivate the self-healing kill switch. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { action: { type: 'string', description: 'activate or deactivate. Required.' }, reason: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['action'] },
  },
  { name: 'dev_healing_history', description: 'DEVELOPER ONLY. Recent self-healing events.', parameters: { type: 'object', properties: { limit: { type: 'number' }, failure_class: { type: 'string' }, outcome: { type: 'string' } } } },
  { name: 'dev_healing_metrics', description: 'DEVELOPER ONLY. Self-healing metrics summary over N days (default 7).', parameters: { type: 'object', properties: { days: { type: 'number' } } } },
  {
    name: 'dev_approve_heal',
    description: 'DEVELOPER ONLY. Approve a pending heal. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { heal_id: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['heal_id'] },
  },
  {
    name: 'dev_reject_heal',
    description: 'DEVELOPER ONLY. Reject a pending heal. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { heal_id: { type: 'string', description: 'Required.' }, reason: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['heal_id'] },
  },
  { name: 'dev_verify_heal', description: 'DEVELOPER ONLY. Run a blast-radius verification check for a heal.', parameters: { type: 'object', properties: { vtid: { type: 'string', description: 'Required.' } }, required: ['vtid'] } },
  {
    name: 'dev_rollback_heal',
    description: 'DEVELOPER ONLY. Roll back a heal to its pre-fix snapshot. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { vtid: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['vtid'] },
  },
  {
    name: 'dev_list_quarantine',
    description: 'DEVELOPER ONLY. Look up a quarantine entry by failure class + signature (no browsable list exists).',
    parameters: { type: 'object', properties: { failure_class: { type: 'string', description: 'Required.' }, signature: { type: 'string', description: 'Required.' } }, required: ['failure_class', 'signature'] },
  },
  {
    name: 'dev_release_quarantine',
    description: 'DEVELOPER ONLY. Release a class/signature pair from quarantine. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { failure_class: { type: 'string', description: 'Required.' }, signature: { type: 'string', description: 'Required.' }, reason: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['failure_class', 'signature'] },
  },
  { name: 'dev_shadow_comparison', description: 'DEVELOPER ONLY. Staging shadow-comparison report over a time window (default 48h).', parameters: { type: 'object', properties: { window_hours: { type: 'number' } } } },
];
