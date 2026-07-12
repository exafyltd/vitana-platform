/**
 * Developer voice tools — Observability (Wave 2, plan section C9).
 *
 * Backed by routes/admin-health.ts, telemetry.ts, events.ts, orb-agent-trace.ts,
 * supervisor-summary.ts, voice-lab.ts, conversation-hub.ts, agents-registry.ts.
 * Several routes require the caller's own session JWT (requireAuth /
 * requireExafyAdmin) — forwarded from identity.user_jwt when present, with a
 * clear fallback message when it isn't (never fabricated).
 * dev_service_health / dev_build_info are scoped to this gateway instance —
 * there is no cross-service health aggregator today (plan-gap, flagged).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { developerGate, clampLimit, relAge, gatewayApiCall } from './developer-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

function authHeaders(id: OrbToolIdentity): Record<string, string> {
  return id.user_jwt ? { Authorization: `Bearer ${id.user_jwt}` } : {};
}

const NO_SESSION: OrbToolResult = {
  ok: true,
  result: { reason: 'no_session' },
  text: "I need a signed-in session to read that — I don't have one for this voice session.",
};

// ---------------------------------------------------------------------------
// 109. dev_build_info — GET /api/v1/admin/build-info (this gateway instance)
// ---------------------------------------------------------------------------

export const dev_build_info: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { ok, status, body } = await gatewayApiCall('/api/v1/admin/build-info');
  if (!ok) return { ok: false, error: `dev_build_info failed (${status}): ${String(body.error ?? 'unknown')}` };
  return {
    ok: true,
    result: body,
    text: `Gateway is running ${String(body.git_commit ?? 'unknown commit')} (${String(body.cloud_run_revision ?? 'unknown revision')}) in ${String(body.env ?? 'unknown env')}. (Scoped to this gateway instance — no cross-service aggregator exists yet.)`,
  };
};

// ---------------------------------------------------------------------------
// 110. dev_service_health — GET /api/v1/admin/health + /alive (this instance)
// ---------------------------------------------------------------------------

export const dev_service_health: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const [healthRes, aliveRes] = await Promise.all([
    gatewayApiCall('/api/v1/admin/health'),
    gatewayApiCall('/alive'),
  ]);
  return {
    ok: true,
    result: { health: healthRes.body, alive: aliveRes.ok },
    text: `Gateway health: ${String(healthRes.body.status ?? (healthRes.ok ? 'ok' : 'unknown'))}, /alive is ${aliveRes.ok ? 'responding' : 'not responding'}. (No cross-service aggregator exists yet — this covers the gateway only.)`,
  };
};

// ---------------------------------------------------------------------------
// 111. dev_error_rate — direct oasis_events read (no dedicated endpoint)
// ---------------------------------------------------------------------------

export const dev_error_rate: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const hours = Math.max(1, Math.min(168, Number(args.hours) || 24));
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data, error } = await sb
    .from('oasis_events')
    .select('status')
    .gte('created_at', since)
    .limit(5000);
  if (error) return { ok: false, error: `dev_error_rate failed: ${error.message}` };
  const rows = (data ?? []) as Array<{ status: string | null }>;
  const total = rows.length;
  const errors = rows.filter((r) => r.status === 'error' || r.status === 'failure').length;
  const rate = total > 0 ? (errors / total) * 100 : 0;
  return {
    ok: true,
    result: { total, errors, rate_percent: Number(rate.toFixed(2)), window_hours: hours },
    text: `Over the last ${hours}h: ${errors} of ${total} OASIS events were errors (${rate.toFixed(1)}%).`,
  };
};

// ---------------------------------------------------------------------------
// 112. dev_latency_summary — direct oasis_events read of voice.latency.measured
// ---------------------------------------------------------------------------

export const dev_latency_summary: Handler = async (args, id, sb) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const hours = Math.max(1, Math.min(168, Number(args.hours) || 24));
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data, error } = await sb
    .from('oasis_events')
    .select('payload')
    .eq('topic', 'voice.latency.measured')
    .gte('created_at', since)
    .limit(2000);
  if (error) return { ok: false, error: `dev_latency_summary failed: ${error.message}` };
  const values = ((data ?? []) as Array<{ payload: Record<string, unknown> | null }>)
    .map((r) => Number(r.payload?.total_ms))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (values.length === 0) {
    return { ok: true, result: { count: 0 }, text: `No voice latency samples in the last ${hours}h.` };
  }
  const pct = (p: number) => values[Math.min(values.length - 1, Math.floor((p / 100) * values.length))];
  const p50 = pct(50);
  const p95 = pct(95);
  return {
    ok: true,
    result: { count: values.length, p50_ms: p50, p95_ms: p95, window_hours: hours },
    text: `Voice turn latency over the last ${hours}h (${values.length} samples): p50 ${p50}ms, p95 ${p95}ms.`,
  };
};

// ---------------------------------------------------------------------------
// 113. dev_telemetry_snapshot — GET /api/v1/telemetry/snapshot (requireAuth)
// ---------------------------------------------------------------------------

export const dev_telemetry_snapshot: Handler = async (_args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  if (!id.user_jwt) return NO_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/telemetry/snapshot', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_telemetry_snapshot failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: 'Telemetry snapshot retrieved.' };
};

// ---------------------------------------------------------------------------
// 114. dev_recent_events — GET /api/v1/oasis/events
// ---------------------------------------------------------------------------

export const dev_recent_events: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const limit = clampLimit(args.limit, 10, 100);
  const { ok, status, body } = await gatewayApiCall(`/api/v1/oasis/events?limit=${limit}`);
  if (!ok) return { ok: false, error: `dev_recent_events failed (${status}): ${String(body.error ?? 'unknown')}` };
  const rows = (Array.isArray(body.data) ? body.data : []) as Array<{ type?: string; topic?: string; message?: string; created_at?: string }>;
  if (rows.length === 0) return { ok: true, result: { data: [] }, text: 'No recent events.' };
  const lines = rows.slice(0, 8).map((r) => `${r.type || r.topic || 'event'}${r.message ? ` — ${r.message}` : ''} (${relAge(r.created_at)})`);
  return { ok: true, result: { data: rows }, text: `${rows.length} recent events: ${lines.join('. ')}` };
};

// ---------------------------------------------------------------------------
// 115. dev_agent_trace — GET /api/v1/orb/agent-trace(/recent)
// ---------------------------------------------------------------------------

export const dev_agent_trace: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const limit = clampLimit(args.limit, 5, 20);
  const path = id.user_jwt
    ? `/api/v1/orb/agent-trace?limit=${limit}${typeof args.phase === 'string' ? `&phase=${encodeURIComponent(args.phase)}` : ''}`
    : `/api/v1/orb/agent-trace/recent`;
  const { ok, status, body } = await gatewayApiCall(path, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_agent_trace failed (${status}): ${String(body.error ?? 'unknown')}` };
  const traces = (Array.isArray(body.traces) ? body.traces : Array.isArray(body.data) ? body.data : []) as Array<Record<string, unknown>>;
  if (traces.length === 0) return { ok: true, result: { traces: [] }, text: 'No agent traces found.' };
  return { ok: true, result: { traces }, text: `${traces.length} recent agent trace${traces.length === 1 ? '' : 's'} retrieved.` };
};

// ---------------------------------------------------------------------------
// 116. dev_supervisor_summary — GET /api/v1/supervisor/summary
// (requireServiceRole — needs the gateway's own service token, not a user JWT)
// ---------------------------------------------------------------------------

export const dev_supervisor_summary: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const serviceToken = process.env.GATEWAY_SERVICE_TOKEN;
  if (!serviceToken) {
    return { ok: true, result: { reason: 'no_service_token' }, text: 'Supervisor summary is unavailable — no gateway service token configured.' };
  }
  const windowHours = Math.max(1, Math.min(168, Number(args.window_hours) || 24));
  const { ok, status, body } = await gatewayApiCall(`/api/v1/supervisor/summary?window_hours=${windowHours}`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  if (!ok) return { ok: false, error: `dev_supervisor_summary failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: `Supervisor summary over the last ${windowHours}h retrieved.` };
};

// ---------------------------------------------------------------------------
// 117. dev_get_session_turns — GET /api/v1/voice-lab/live/sessions/:id/turns
// ---------------------------------------------------------------------------

export const dev_get_session_turns: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const sessionId = String(args.session_id ?? '').trim();
  if (!sessionId) return { ok: false, error: 'dev_get_session_turns requires session_id.' };
  if (!id.user_jwt) return NO_SESSION;
  const { ok, status, body } = await gatewayApiCall(`/api/v1/voice-lab/live/sessions/${encodeURIComponent(sessionId)}/turns`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_get_session_turns failed (${status}): ${String(body.error ?? 'unknown')}` };
  const turns = (Array.isArray(body.turns) ? body.turns : []) as Array<{ turn_number: number; turn_ms?: number }>;
  if (turns.length === 0) return { ok: true, result: { turns: [] }, text: `No turns recorded for session ${sessionId}.` };
  return { ok: true, result: { turns }, text: `${turns.length} turns for session ${sessionId}.` };
};

// ---------------------------------------------------------------------------
// 118. dev_get_session_diagnostics — GET .../sessions/:id/diagnostics
// ---------------------------------------------------------------------------

export const dev_get_session_diagnostics: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const sessionId = String(args.session_id ?? '').trim();
  if (!sessionId) return { ok: false, error: 'dev_get_session_diagnostics requires session_id.' };
  if (!id.user_jwt) return NO_SESSION;
  const { ok, status, body } = await gatewayApiCall(`/api/v1/voice-lab/live/sessions/${encodeURIComponent(sessionId)}/diagnostics`, { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `dev_get_session_diagnostics failed (${status}): ${String(body.error ?? 'unknown')}` };
  return { ok: true, result: body, text: `Diagnostics retrieved for session ${sessionId}.` };
};

// ---------------------------------------------------------------------------
// 119/122. dev_conversation_decisions / dev_greeting_decisions —
// GET /api/v1/admin/conversation/decisions (requireAuth + requireExafyAdmin)
// identical backing route, kept as two tools per the plan.
// ---------------------------------------------------------------------------

async function fetchConversationDecisions(args: OrbToolArgs, id: OrbToolIdentity): Promise<OrbToolResult> {
  if (!id.user_jwt) return NO_SESSION;
  const limit = clampLimit(args.limit, 10, 100);
  const windowHours = Math.max(1, Math.min(168, Number(args.window_hours) || 24));
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/conversation/decisions?limit=${limit}&window_hours=${windowHours}`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { ok: false, error: `conversation decisions failed (${status}): ${String(body.error ?? 'unknown')}` };
  const rows = (Array.isArray(body.data) ? body.data : []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return { ok: true, result: { data: [] }, text: 'No greeting/NBA decisions in that window.' };
  return { ok: true, result: { data: rows }, text: `${rows.length} decisions over the last ${windowHours}h.` };
}

export const dev_conversation_decisions: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  return fetchConversationDecisions(args, id);
};

export const dev_greeting_decisions: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  return fetchConversationDecisions(args, id);
};

// ---------------------------------------------------------------------------
// 120. dev_tool_failures — GET /api/v1/admin/conversation/tool-failures
// ---------------------------------------------------------------------------

async function fetchToolFailures(args: OrbToolArgs, id: OrbToolIdentity) {
  if (!id.user_jwt) return { rows: [] as Array<Record<string, unknown>>, error: NO_SESSION };
  const limit = clampLimit(args.limit, 20, 200);
  const windowHours = Math.max(1, Math.min(168, Number(args.window_hours) || 24));
  const { ok, status, body } = await gatewayApiCall(
    `/api/v1/admin/conversation/tool-failures?limit=${limit}&window_hours=${windowHours}`,
    { headers: authHeaders(id) },
  );
  if (!ok) return { rows: [], error: { ok: false, error: `tool failures failed (${status}): ${String(body.error ?? 'unknown')}` } as OrbToolResult };
  return { rows: (Array.isArray(body.data) ? body.data : []) as Array<Record<string, unknown>>, error: null };
}

export const dev_tool_failures: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { rows, error } = await fetchToolFailures(args, id);
  if (error) return error;
  if (rows.length === 0) return { ok: true, result: { data: [] }, text: 'No recent tool failures.' };
  const byTool = new Map<string, number>();
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const tool = String(meta.tool ?? 'unknown');
    byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
  }
  const lines = [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => `${t}: ${n}`);
  return { ok: true, result: { data: rows, by_tool: Object.fromEntries(byTool) }, text: `${rows.length} tool failures: ${lines.join(', ')}.` };
};

// ---------------------------------------------------------------------------
// 121. dev_tool_health — built from the same tool-failures feed (no dedicated
// health-dashboard endpoint exists per plan-gap analysis)
// ---------------------------------------------------------------------------

export const dev_tool_health: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const { rows, error } = await fetchToolFailures(args, id);
  if (error) return error;
  if (rows.length === 0) return { ok: true, result: { healthy: true }, text: 'No tool failures recorded — tools look healthy.' };
  const byTool = new Map<string, number>();
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const tool = String(meta.tool ?? 'unknown');
    byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
  }
  const worst = [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return {
    ok: true,
    result: { healthy: false, failure_counts: Object.fromEntries(byTool) },
    text: `Tool health rollup (from recent failures, no dedicated dashboard yet): worst offenders — ${worst.map(([t, n]) => `${t} (${n})`).join(', ')}.`,
  };
};

// ---------------------------------------------------------------------------
// 123. dev_get_agent_detail — GET /api/v1/agents/registry/:agent_id
// ---------------------------------------------------------------------------

export const dev_get_agent_detail: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const agentId = String(args.agent_id ?? '').trim();
  if (!agentId) return { ok: false, error: 'dev_get_agent_detail requires agent_id.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/agents/registry/${encodeURIComponent(agentId)}`);
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `No agent found with id "${agentId}".` }
      : { ok: false, error: `dev_get_agent_detail failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  return {
    ok: true,
    result: { found: true, agent: body },
    text: `${String(body.display_name ?? agentId)} (${String(body.tier ?? 'unknown tier')}) — ${String(body.derived_status ?? body.status ?? 'unknown status')}.`,
  };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const OBSERVABILITY_TOOL_HANDLERS: Record<string, Handler> = {
  dev_build_info,
  dev_service_health,
  dev_error_rate,
  dev_latency_summary,
  dev_telemetry_snapshot,
  dev_recent_events,
  dev_agent_trace,
  dev_supervisor_summary,
  dev_get_session_turns,
  dev_get_session_diagnostics,
  dev_conversation_decisions,
  dev_tool_failures,
  dev_tool_health,
  dev_greeting_decisions,
  dev_get_agent_detail,
};

export const OBSERVABILITY_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'dev_build_info',
    description: 'DEVELOPER ONLY. Running revision/build info for this gateway instance.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_service_health',
    description: 'DEVELOPER ONLY. Health + /alive check for this gateway instance.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_error_rate',
    description: 'DEVELOPER ONLY. Recent OASIS event error rate over a time window.',
    parameters: { type: 'object', properties: { hours: { type: 'integer', description: 'Window size, default 24.' } } },
  },
  {
    name: 'dev_latency_summary',
    description: 'DEVELOPER ONLY. Voice turn latency percentiles (p50/p95) over a time window.',
    parameters: { type: 'object', properties: { hours: { type: 'integer', description: 'Window size, default 24.' } } },
  },
  {
    name: 'dev_telemetry_snapshot',
    description: 'DEVELOPER ONLY. Telemetry snapshot: recent events + pipeline stage counters.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'dev_recent_events',
    description: 'DEVELOPER ONLY. Recent OASIS/system events, most recent first.',
    parameters: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  {
    name: 'dev_agent_trace',
    description: 'DEVELOPER ONLY. Recent ORB agent trace(s).',
    parameters: { type: 'object', properties: { phase: { type: 'string' }, limit: { type: 'integer' } } },
  },
  {
    name: 'dev_supervisor_summary',
    description: 'DEVELOPER ONLY. Supervisor summary: dataset/shadow/finetune/canary/backlog sections.',
    parameters: { type: 'object', properties: { window_hours: { type: 'integer' } } },
  },
  {
    name: 'dev_get_session_turns',
    description: 'DEVELOPER ONLY. Per-turn timeline for a voice session.',
    parameters: { type: 'object', properties: { session_id: { type: 'string', description: 'Required.' } }, required: ['session_id'] },
  },
  {
    name: 'dev_get_session_diagnostics',
    description: 'DEVELOPER ONLY. Diagnostics analysis for a voice session.',
    parameters: { type: 'object', properties: { session_id: { type: 'string', description: 'Required.' } }, required: ['session_id'] },
  },
  {
    name: 'dev_conversation_decisions',
    description: 'DEVELOPER ONLY. Recent greeting/next-best-action decisions. Requires exafy_admin session.',
    parameters: { type: 'object', properties: { limit: { type: 'integer' }, window_hours: { type: 'integer' } } },
  },
  {
    name: 'dev_tool_failures',
    description: 'DEVELOPER ONLY. Recent voice-tool failures, grouped by tool. Requires exafy_admin session.',
    parameters: { type: 'object', properties: { limit: { type: 'integer' }, window_hours: { type: 'integer' } } },
  },
  {
    name: 'dev_tool_health',
    description: 'DEVELOPER ONLY. Tool health rollup derived from recent failures (no dedicated dashboard exists). Requires exafy_admin session.',
    parameters: { type: 'object', properties: { window_hours: { type: 'integer' } } },
  },
  {
    name: 'dev_greeting_decisions',
    description: 'DEVELOPER ONLY. Greeting-monitor view of recent conversation decisions (same source as dev_conversation_decisions). Requires exafy_admin session.',
    parameters: { type: 'object', properties: { limit: { type: 'integer' }, window_hours: { type: 'integer' } } },
  },
  {
    name: 'dev_get_agent_detail',
    description: 'DEVELOPER ONLY. Detail for one registered agent by id.',
    parameters: { type: 'object', properties: { agent_id: { type: 'string', description: 'Required.' } }, required: ['agent_id'] },
  },
];
