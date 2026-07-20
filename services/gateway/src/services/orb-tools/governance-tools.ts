/**
 * Developer voice tools — Governance (Wave 2, plan section C2).
 *
 * Thin dispatch layer over routes/governance.ts and routes/governance-controls.ts.
 * Those routes trust caller-supplied x-tenant-id / x-user-id / x-user-role
 * headers rather than enforcing real per-request auth (see
 * governance-controller.ts / governance-controls.ts) — handlers here forward
 * an 'admin' role header for the internal self-call since developerGate()
 * has already restricted the caller to developer/admin/exafy_admin.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { developerGate, clampLimit, relAge, gatewayApiCall } from './developer-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

function adminHeaders(id: OrbToolIdentity): Record<string, string> {
  return { 'x-user-id': id.user_id, 'x-user-role': 'admin' };
}

// ---------------------------------------------------------------------------
// 16. dev_evaluate_governance — POST /api/v1/governance/evaluate
// ---------------------------------------------------------------------------

export const dev_evaluate_governance: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const action = String(args.action ?? '').trim();
  const service = String(args.service ?? '').trim();
  const environment = String(args.environment ?? '').trim();
  if (!action || !service || !environment) {
    return { ok: false, error: 'dev_evaluate_governance requires action, service and environment.' };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/governance/evaluate', {
    method: 'POST',
    body: { action, service, environment, vtid: typeof args.vtid === 'string' ? args.vtid : undefined },
  });
  if (!ok) return { ok: false, error: `dev_evaluate_governance failed (${status}): ${String(body.error ?? 'unknown')}` };
  const violations = (Array.isArray(body.violations) ? body.violations : []) as Array<{ message?: string }>;
  return {
    ok: true,
    result: body,
    text: body.allowed
      ? `Allowed (level ${String(body.level ?? '?')}).`
      : `Blocked (level ${String(body.level ?? '?')}): ${violations.map((v) => v.message).filter(Boolean).join('. ') || 'no details'}.`,
  };
};

// ---------------------------------------------------------------------------
// 17. dev_governance_status — GET /api/v1/governance/controls (closest
// existing snapshot — there is no dedicated /status route)
// ---------------------------------------------------------------------------

export const dev_governance_status: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/governance/controls', { headers: adminHeaders(id) });
  if (!ok || body.ok !== true) return { ok: false, error: `dev_governance_status failed (${status}): ${String(body.error ?? 'unknown')}` };
  const controls = (Array.isArray(body.data) ? body.data : []) as Array<{ key: string; enabled: boolean }>;
  const disabled = controls.filter((c) => !c.enabled);
  return {
    ok: true,
    result: { controls },
    text: `${controls.length} governance controls. ${disabled.length === 0 ? 'All enabled.' : `Disabled: ${disabled.map((c) => c.key).join(', ')}.`}`,
  };
};

// ---------------------------------------------------------------------------
// 18. dev_list_governance_rules — GET /api/v1/governance/rules
// ---------------------------------------------------------------------------

export const dev_list_governance_rules: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const qs = new URLSearchParams();
  for (const k of ['category', 'status', 'level', 'search'] as const) {
    if (typeof args[k] === 'string' && args[k]) qs.set(k, args[k] as string);
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/governance/rules?${qs.toString()}`);
  if (!ok || body.ok !== true) return { ok: false, error: `dev_list_governance_rules failed (${status}): ${String(body.error ?? 'unknown')}` };
  const rows = (Array.isArray(body.data) ? body.data : []) as Array<{ id: string; title: string; level: string; status: string }>;
  if (rows.length === 0) return { ok: true, result: { data: [] }, text: 'No governance rules matched.' };
  const lines = rows.slice(0, 8).map((r) => `${r.id} "${r.title}" — level ${r.level}, ${r.status}`);
  return { ok: true, result: { data: rows }, text: `${rows.length} rules: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 19. dev_get_governance_rule — GET /api/v1/governance/rules/:ruleCode
// ---------------------------------------------------------------------------

export const dev_get_governance_rule: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const ruleCode = String(args.rule_code ?? args.ruleCode ?? '').trim();
  if (!ruleCode) return { ok: false, error: 'dev_get_governance_rule requires a rule_code.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/governance/rules/${encodeURIComponent(ruleCode)}`);
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No governance rule found for ${ruleCode}.` }
      : { ok: false, error: `dev_get_governance_rule failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  return {
    ok: true,
    result: { found: true, rule: body },
    text: `${String(body.ruleCode)} "${String(body.name ?? '')}" — ${String(body.status ?? 'unknown')}. ${String(body.description ?? '')}`,
  };
};

// ---------------------------------------------------------------------------
// 20. dev_list_violations — GET /api/v1/governance/violations
// ---------------------------------------------------------------------------

export const dev_list_violations: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/governance/violations');
  if (!ok) return { ok: false, error: `dev_list_violations failed (${status}).` };
  const rows = (Array.isArray(body) ? body : []) as Array<{ ruleCode: string; severity: string; status: string; description: string }>;
  if (rows.length === 0) return { ok: true, result: { violations: [] }, text: 'No open governance violations.' };
  const open = rows.filter((r) => r.status === 'Open');
  const lines = (open.length ? open : rows).slice(0, 8).map((r) => `${r.ruleCode} — ${r.severity}, ${r.status}: ${r.description}`);
  return { ok: true, result: { violations: rows }, text: `${rows.length} violations (${open.length} open): ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 21. dev_list_enforcements — GET /api/v1/governance/enforcements
// ---------------------------------------------------------------------------

export const dev_list_enforcements: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/governance/enforcements');
  if (!ok) return { ok: false, error: `dev_list_enforcements failed (${status}).` };
  const rows = (Array.isArray(body) ? body : []) as Array<{ rule_id: string; action: string; status: string; executed_at: string }>;
  if (rows.length === 0) return { ok: true, result: { enforcements: [] }, text: 'No enforcement actions recorded.' };
  const lines = rows.slice(0, 8).map((r) => `${r.action} on rule ${r.rule_id} — ${r.status} (${relAge(r.executed_at)})`);
  return { ok: true, result: { enforcements: rows }, text: `${rows.length} enforcement actions: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 22. dev_governance_feed — GET /api/v1/governance/feed
// ---------------------------------------------------------------------------

export const dev_governance_feed: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/governance/feed');
  if (!ok) return { ok: false, error: `dev_governance_feed failed (${status}).` };
  const rows = (Array.isArray(body) ? body : []) as Array<{ message: string; timestamp: string }>;
  if (rows.length === 0) return { ok: true, result: { feed: [] }, text: 'No recent governance activity.' };
  const lines = rows.slice(0, 8).map((r) => `${r.message} (${relAge(r.timestamp)})`);
  return { ok: true, result: { feed: rows }, text: `${rows.length} recent governance events: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 23. dev_list_proposals — GET /api/v1/governance/proposals
// ---------------------------------------------------------------------------

export const dev_list_proposals: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const qs = new URLSearchParams();
  for (const k of ['status', 'ruleCode'] as const) {
    if (typeof args[k] === 'string' && args[k]) qs.set(k, args[k] as string);
  }
  qs.set('limit', String(clampLimit(args.limit, 10, 100)));
  const { ok, status, body } = await gatewayApiCall(`/api/v1/governance/proposals?${qs.toString()}`);
  if (!ok) return { ok: false, error: `dev_list_proposals failed (${status}).` };
  const rows = (Array.isArray(body) ? body : []) as Array<{ proposalId: string; type: string; status: string; ruleCode?: string }>;
  if (rows.length === 0) return { ok: true, result: { proposals: [] }, text: 'No governance proposals found.' };
  const lines = rows.slice(0, 8).map((r) => `${r.proposalId} — ${r.type}${r.ruleCode ? ` (${r.ruleCode})` : ''}, ${r.status}`);
  return { ok: true, result: { proposals: rows }, text: `${rows.length} proposals: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 24. dev_create_proposal — POST /api/v1/governance/proposals
// ---------------------------------------------------------------------------

export const dev_create_proposal: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const type = String(args.type ?? '').trim();
  if (!['New Rule', 'Change Rule', 'Deprecate Rule'].includes(type)) {
    return { ok: false, error: 'dev_create_proposal requires type: "New Rule", "Change Rule", or "Deprecate Rule".' };
  }
  const proposedRule = String(args.proposed_rule ?? args.proposedRule ?? '').trim();
  if (!proposedRule) return { ok: false, error: 'dev_create_proposal requires proposed_rule text.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, type, proposedRule },
      text: `About to create a "${type}" governance proposal: "${proposedRule}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/governance/proposals', {
    method: 'POST',
    body: {
      type,
      ruleCode: typeof args.rule_code === 'string' ? args.rule_code : undefined,
      proposedRule,
      rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
      source: 'orb-voice',
    },
  });
  if (!ok) return { ok: true, result: { created: false, status, detail: body }, text: `Could not create the proposal: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { created: true, proposal: body }, text: `Proposal ${String(body.proposalId ?? '')} created.` };
};

// ---------------------------------------------------------------------------
// 25. dev_update_proposal — PATCH /api/v1/governance/proposals/:proposalId/status
// ---------------------------------------------------------------------------

export const dev_update_proposal: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const proposalId = String(args.proposal_id ?? args.proposalId ?? '').trim();
  if (!proposalId) return { ok: false, error: 'dev_update_proposal requires proposal_id.' };
  const newStatus = String(args.status ?? '').trim();
  if (!['Draft', 'Under Review', 'Approved', 'Rejected', 'Implemented'].includes(newStatus)) {
    return { ok: false, error: 'dev_update_proposal requires status: Draft, Under Review, Approved, Rejected, or Implemented.' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, proposalId, status: newStatus },
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
// 26. dev_get_control — GET /api/v1/governance/controls/:key
// ---------------------------------------------------------------------------

export const dev_get_control: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const key = String(args.key ?? '').trim();
  if (!key) return { ok: false, error: 'dev_get_control requires a control key, e.g. "vtid_allocator_enabled".' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/governance/controls/${encodeURIComponent(key)}`, { headers: adminHeaders(id) });
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No control key "${key}" found.` }
      : { ok: false, error: `dev_get_control failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  const data = (body.data ?? {}) as { enabled?: boolean; reason?: string };
  return { ok: true, result: body, text: `${key} is ${data.enabled ? 'enabled' : 'disabled'}${data.reason ? ` (${data.reason})` : ''}.` };
};

// ---------------------------------------------------------------------------
// 27. dev_set_control — POST /api/v1/governance/controls/:key
// ---------------------------------------------------------------------------

export const dev_set_control: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const key = String(args.key ?? '').trim();
  if (!key) return { ok: false, error: 'dev_set_control requires a control key.' };
  const enabled = Boolean(args.enabled);
  const reason = String(args.reason ?? '').trim();
  if (!reason) return { ok: false, error: 'dev_set_control requires a reason.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, key, enabled, reason },
      text: `About to set control "${key}" to ${enabled ? 'enabled' : 'disabled'} — reason: "${reason}". This can change platform-wide behavior. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall(`/api/v1/governance/controls/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: adminHeaders(id),
    body: {
      enabled,
      reason,
      duration_minutes: typeof args.duration_minutes === 'number' ? args.duration_minutes : undefined,
    },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update control "${key}": ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Control "${key}" is now ${enabled ? 'enabled' : 'disabled'}.` };
};

// ---------------------------------------------------------------------------
// 28. dev_get_control_history — GET /api/v1/governance/controls/:key/history
// ---------------------------------------------------------------------------

export const dev_get_control_history: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const key = String(args.key ?? '').trim();
  if (!key) return { ok: false, error: 'dev_get_control_history requires a control key.' };
  const limit = clampLimit(args.limit, 10, 200);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/governance/controls/${encodeURIComponent(key)}/history?limit=${limit}`, { headers: adminHeaders(id) });
  if (!ok) return { ok: false, error: `dev_get_control_history failed (${status}): ${String(body.error ?? 'unknown')}` };
  const rows = (Array.isArray(body.data) ? body.data : []) as Array<{ from_enabled: boolean; to_enabled: boolean; reason: string; created_at: string }>;
  if (rows.length === 0) return { ok: true, result: { history: [] }, text: `No history for control "${key}".` };
  const lines = rows.slice(0, 8).map((r) => `${r.from_enabled ? 'on' : 'off'} → ${r.to_enabled ? 'on' : 'off'}: ${r.reason} (${relAge(r.created_at)})`);
  return { ok: true, result: { history: rows }, text: `${rows.length} changes to "${key}": ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const GOVERNANCE_TOOL_HANDLERS: Record<string, Handler> = {
  dev_evaluate_governance,
  dev_governance_status,
  dev_list_governance_rules,
  dev_get_governance_rule,
  dev_list_violations,
  dev_list_enforcements,
  dev_governance_feed,
  dev_list_proposals,
  dev_create_proposal,
  dev_update_proposal,
  dev_get_control,
  dev_set_control,
  dev_get_control_history,
};

export const GOVERNANCE_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'dev_evaluate_governance',
    description: 'DEVELOPER ONLY. Evaluate whether an action would be allowed by governance rules for a service/environment.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Required.' },
        service: { type: 'string', description: 'Required.' },
        environment: { type: 'string', description: 'Required.' },
        vtid: { type: 'string' },
      },
      required: ['action', 'service', 'environment'],
    },
  },
  {
    name: 'dev_governance_status',
    description: 'DEVELOPER ONLY. Governance control-plane snapshot: which control keys are enabled/disabled.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_list_governance_rules',
    description: 'DEVELOPER ONLY. List governance rules, optionally filtered by category/status/level/search.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        status: { type: 'string' },
        level: { type: 'string' },
        search: { type: 'string' },
      },
    },
  },
  {
    name: 'dev_get_governance_rule',
    description: 'DEVELOPER ONLY. Get one governance rule by its code, with recent evaluations.',
    parameters: {
      type: 'object',
      properties: { rule_code: { type: 'string', description: 'Required.' } },
      required: ['rule_code'],
    },
  },
  {
    name: 'dev_list_violations',
    description: 'DEVELOPER ONLY. List open/recent governance violations.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_list_enforcements',
    description: 'DEVELOPER ONLY. List recent governance enforcement actions.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_governance_feed',
    description: 'DEVELOPER ONLY. Recent governance activity feed.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_list_proposals',
    description: 'DEVELOPER ONLY. List governance rule-change proposals, optionally filtered by status/rule_code.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Draft, Under Review, Approved, Rejected, Implemented.' },
        ruleCode: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'dev_create_proposal',
    description: 'DEVELOPER ONLY. Create a governance rule-change proposal. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '"New Rule", "Change Rule", or "Deprecate Rule". Required.' },
        rule_code: { type: 'string', description: 'Required for Change/Deprecate.' },
        proposed_rule: { type: 'string', description: 'Required.' },
        rationale: { type: 'string' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['type', 'proposed_rule'],
    },
  },
  {
    name: 'dev_update_proposal',
    description: 'DEVELOPER ONLY. Change a proposal\'s status (Draft/Under Review/Approved/Rejected/Implemented). TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string', description: 'Required.' },
        status: { type: 'string', description: 'Required.' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['proposal_id', 'status'],
    },
  },
  {
    name: 'dev_get_control',
    description: 'DEVELOPER ONLY. Read a governance control key (e.g. vtid_allocator_enabled, autopilot_execution_enabled).',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Required.' } },
      required: ['key'],
    },
  },
  {
    name: 'dev_set_control',
    description: 'DEVELOPER ONLY. Flip a governance control key on/off — a real kill-switch, requires a reason. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Required.' },
        enabled: { type: 'boolean', description: 'Required.' },
        reason: { type: 'string', description: 'Required.' },
        duration_minutes: { type: 'integer', description: 'Optional auto-expiry.' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['key', 'enabled', 'reason'],
    },
  },
  {
    name: 'dev_get_control_history',
    description: 'DEVELOPER ONLY. Change history for a governance control key.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Required.' },
        limit: { type: 'integer' },
      },
      required: ['key'],
    },
  },
];
