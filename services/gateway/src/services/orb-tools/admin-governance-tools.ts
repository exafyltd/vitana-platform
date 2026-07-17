/**
 * Admin voice tools — Governance & Controls (Wave 3, plan section B12).
 *
 * Admin-facing wrappers over the SAME routes/governance.ts and
 * routes/governance-controls.ts endpoints the developer governance tools
 * (services/orb-tools/governance-tools.ts) already call — just gated to
 * admin/exafy_admin instead of developer/admin/exafy_admin, and headed
 * for admin_* naming per the plan. No new backend behaviour.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { gatewayApiCall, clampLimit } from './developer-tools';
import { adminGate } from './admin-users-rbac-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

function adminHeaders(id: OrbToolIdentity): Record<string, string> {
  return { 'x-user-id': id.user_id, 'x-user-role': 'admin' };
}

// ---------------------------------------------------------------------------
// 1. admin_governance_status — GET /api/v1/governance/controls
// ---------------------------------------------------------------------------

export const admin_governance_status: Handler = async (_args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/governance/controls', { headers: adminHeaders(id) });
  if (!ok || body.ok !== true) return { ok: false, error: `admin_governance_status failed (${status}): ${String(body.error ?? 'unknown')}` };
  const controls = (Array.isArray(body.data) ? body.data : []) as Array<{ key: string; enabled: boolean }>;
  const disabled = controls.filter((c) => !c.enabled);
  return {
    ok: true,
    result: { controls },
    text: `${controls.length} governance controls. ${disabled.length === 0 ? 'All enabled.' : `Disabled: ${disabled.map((c) => c.key).join(', ')}.`}`,
  };
};

// ---------------------------------------------------------------------------
// 2. admin_list_governance_rules — GET /api/v1/governance/rules
// ---------------------------------------------------------------------------

export const admin_list_governance_rules: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const qs = new URLSearchParams();
  for (const k of ['category', 'status', 'level', 'search'] as const) {
    if (typeof args[k] === 'string' && args[k]) qs.set(k, args[k] as string);
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/governance/rules?${qs.toString()}`);
  if (!ok || body.ok !== true) return { ok: false, error: `admin_list_governance_rules failed (${status}): ${String(body.error ?? 'unknown')}` };
  const rows = (Array.isArray(body.data) ? body.data : []) as Array<{ id: string; title: string; level: string; status: string }>;
  if (rows.length === 0) return { ok: true, result: { data: [] }, text: 'No governance rules matched.' };
  return { ok: true, result: { data: rows }, text: `${rows.length} rules: ${rows.slice(0, 8).map((r) => `${r.id} "${r.title}" (${r.level})`).join('. ')}` };
};

// ---------------------------------------------------------------------------
// 3. admin_list_violations — GET /api/v1/governance/violations
// ---------------------------------------------------------------------------

export const admin_list_violations: Handler = async (_args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/governance/violations');
  if (!ok) return { ok: false, error: `admin_list_violations failed (${status}).` };
  const rows = (Array.isArray(body) ? body : []) as Array<{ ruleCode: string; severity: string; status: string }>;
  if (rows.length === 0) return { ok: true, result: { violations: [] }, text: 'No open governance violations.' };
  const open = rows.filter((r) => r.status === 'Open');
  return { ok: true, result: { violations: rows }, text: `${rows.length} violations (${open.length} open): ${open.slice(0, 8).map((r) => `${r.ruleCode} (${r.severity})`).join(', ')}.` };
};

// ---------------------------------------------------------------------------
// 4. admin_list_proposals — GET /api/v1/governance/proposals
// ---------------------------------------------------------------------------

export const admin_list_proposals: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const qs = new URLSearchParams();
  for (const k of ['status', 'ruleCode'] as const) {
    if (typeof args[k] === 'string' && args[k]) qs.set(k, args[k] as string);
  }
  qs.set('limit', String(clampLimit(args.limit, 10, 100)));
  const { ok, status, body } = await gatewayApiCall(`/api/v1/governance/proposals?${qs.toString()}`);
  if (!ok) return { ok: false, error: `admin_list_proposals failed (${status}).` };
  const rows = (Array.isArray(body) ? body : []) as Array<{ proposalId: string; type: string; status: string }>;
  if (rows.length === 0) return { ok: true, result: { proposals: [] }, text: 'No governance proposals found.' };
  return { ok: true, result: { proposals: rows }, text: `${rows.length} proposals: ${rows.slice(0, 8).map((r) => `${r.proposalId} (${r.status})`).join(', ')}.` };
};

// ---------------------------------------------------------------------------
// 5. admin_create_proposal — POST /api/v1/governance/proposals
// ---------------------------------------------------------------------------

export const admin_create_proposal: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const type = String(args.type ?? '').trim();
  if (!['New Rule', 'Change Rule', 'Deprecate Rule'].includes(type)) {
    return { ok: false, error: 'admin_create_proposal requires type: "New Rule", "Change Rule", or "Deprecate Rule".' };
  }
  const proposedRule = String(args.proposed_rule ?? '').trim();
  if (!proposedRule) return { ok: false, error: 'admin_create_proposal requires proposed_rule.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, type, proposedRule },
      text: `About to create a "${type}" governance proposal: "${proposedRule}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/governance/proposals', {
    method: 'POST',
    body: { type, ruleCode: typeof args.rule_code === 'string' ? args.rule_code : undefined, proposedRule, rationale: typeof args.rationale === 'string' ? args.rationale : undefined, source: 'orb-voice-admin' },
  });
  if (!ok) return { ok: true, result: { created: false, status, detail: body }, text: `Could not create the proposal: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { created: true, proposal: body }, text: `Proposal ${String(body.proposalId ?? '')} created.` };
};

// ---------------------------------------------------------------------------
// 6. admin_update_proposal_status — PATCH .../proposals/:proposalId/status
// ---------------------------------------------------------------------------

export const admin_update_proposal_status: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const proposalId = String(args.proposal_id ?? '').trim();
  const newStatus = String(args.status ?? '').trim();
  if (!proposalId || !['Draft', 'Under Review', 'Approved', 'Rejected', 'Implemented'].includes(newStatus)) {
    return { ok: false, error: 'admin_update_proposal_status requires proposal_id and a valid status.' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, proposal_id: proposalId, status: newStatus },
      text: `About to set ${proposalId} to "${newStatus}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/governance/proposals/${encodeURIComponent(proposalId)}/status`, {
    method: 'PATCH',
    body: { status: newStatus },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update ${proposalId}: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, proposal: body }, text: `${proposalId} is now "${newStatus}".` };
};

// ---------------------------------------------------------------------------
// 7. admin_get_control_key — GET /api/v1/governance/controls/:key
// ---------------------------------------------------------------------------

export const admin_get_control_key: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const key = String(args.key ?? '').trim();
  if (!key) return { ok: false, error: 'admin_get_control_key requires a control key.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/governance/controls/${encodeURIComponent(key)}`, { headers: adminHeaders(id) });
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No control key "${key}" found.` }
      : { ok: false, error: `admin_get_control_key failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  const data = (body.data ?? {}) as { enabled?: boolean };
  return { ok: true, result: body, text: `${key} is ${data.enabled ? 'enabled' : 'disabled'}.` };
};

// ---------------------------------------------------------------------------
// 8. admin_set_control_key — POST /api/v1/governance/controls/:key
// ---------------------------------------------------------------------------

export const admin_set_control_key: Handler = async (args, id) => {
  const denied = adminGate(id);
  if (denied) return denied;
  const key = String(args.key ?? '').trim();
  const enabled = Boolean(args.enabled);
  const reason = String(args.reason ?? '').trim();
  if (!key || !reason) return { ok: false, error: 'admin_set_control_key requires key and reason.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, key, enabled, reason },
      text: `About to set control "${key}" to ${enabled ? 'enabled' : 'disabled'} — reason: "${reason}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/governance/controls/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: adminHeaders(id),
    body: { enabled, reason, duration_minutes: typeof args.duration_minutes === 'number' ? args.duration_minutes : undefined },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update control "${key}": ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Control "${key}" is now ${enabled ? 'enabled' : 'disabled'}.` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const ADMIN_GOVERNANCE_TOOL_HANDLERS: Record<string, Handler> = {
  admin_governance_status,
  admin_list_governance_rules,
  admin_list_violations,
  admin_list_proposals,
  admin_create_proposal,
  admin_update_proposal_status,
  admin_get_control_key,
  admin_set_control_key,
};

export const ADMIN_GOVERNANCE_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  { name: 'admin_governance_status', description: 'ADMIN ONLY. Governance control-plane snapshot.', parameters: { type: 'object', properties: {} } },
  {
    name: 'admin_list_governance_rules',
    description: 'ADMIN ONLY. List governance rules.',
    parameters: { type: 'object', properties: { category: { type: 'string' }, status: { type: 'string' }, level: { type: 'string' }, search: { type: 'string' } } },
  },
  { name: 'admin_list_violations', description: 'ADMIN ONLY. List open/recent governance violations.', parameters: { type: 'object', properties: {} } },
  {
    name: 'admin_list_proposals',
    description: 'ADMIN ONLY. List governance rule-change proposals.',
    parameters: { type: 'object', properties: { status: { type: 'string' }, ruleCode: { type: 'string' }, limit: { type: 'integer' } } },
  },
  {
    name: 'admin_create_proposal',
    description: 'ADMIN ONLY. Create a governance rule-change proposal. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: { type: { type: 'string', description: 'Required.' }, rule_code: { type: 'string' }, proposed_rule: { type: 'string', description: 'Required.' }, rationale: { type: 'string' }, confirm: { type: 'boolean' } },
      required: ['type', 'proposed_rule'],
    },
  },
  {
    name: 'admin_update_proposal_status',
    description: 'ADMIN ONLY. Change a proposal\'s status. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { proposal_id: { type: 'string', description: 'Required.' }, status: { type: 'string', description: 'Required.' }, confirm: { type: 'boolean' } }, required: ['proposal_id', 'status'] },
  },
  { name: 'admin_get_control_key', description: 'ADMIN ONLY. Read a governance control key.', parameters: { type: 'object', properties: { key: { type: 'string', description: 'Required.' } }, required: ['key'] } },
  {
    name: 'admin_set_control_key',
    description: 'ADMIN ONLY. Flip a governance control key on/off — a real kill-switch, requires a reason. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Required.' }, enabled: { type: 'boolean', description: 'Required.' }, reason: { type: 'string', description: 'Required.' }, duration_minutes: { type: 'integer' }, confirm: { type: 'boolean' } },
      required: ['key', 'enabled', 'reason'],
    },
  },
];
