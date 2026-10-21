/**
 * Vitana Automations Skill for OpenClaw
 *
 * Wraps the AP-XXXX automation registry and execution engine.
 * Supports listing, executing, and monitoring automations
 * with domain/role filtering and heartbeat orchestration.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ListAutomationsSchema = z.object({
  tenant_id: z.string().uuid(),
  domain: z.string().max(100).optional(),
  status: z.enum(['active', 'paused', 'disabled']).optional(),
  role: z.string().max(50).optional(),
});

const ExecuteAutomationSchema = z.object({
  tenant_id: z.string().uuid(),
  automation_id: z.string().min(1).max(50),
  params: z.record(z.unknown()).optional(),
});

const RegistrySummarySchema = z.object({
  tenant_id: z.string().uuid(),
});

const DispatchEventSchema = z.object({
  tenant_id: z.string().uuid(),
  event_type: z.string().min(1).max(255),
  payload: z.record(z.unknown()),
});

const RunHistorySchema = z.object({
  tenant_id: z.string().uuid(),
  automation_id: z.string().max(50).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE required');
  return createClient(url, key);
}

async function callGateway(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<unknown> {
  const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
  const res = await fetch(`${gatewayUrl}/api/v1/automations${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Automations endpoint ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * List automations from the registry with optional filters.
   */
  async list(input: unknown) {
    const { tenant_id, domain, status, role } = ListAutomationsSchema.parse(input);
    const params = new URLSearchParams();
    params.set('tenant_id', tenant_id);
    if (domain) params.set('domain', domain);
    if (status) params.set('status', status);
    if (role) params.set('role', role);

    const data = await callGateway(`/registry?${params.toString()}`, 'GET');
    return { success: true, automations: data };
  },

  /**
   * Get a summary dashboard of the automation registry.
   */
  async summary(input: unknown) {
    const { tenant_id } = RegistrySummarySchema.parse(input);
    const data = await callGateway(`/registry/summary?tenant_id=${tenant_id}`, 'GET');
    return { success: true, summary: data };
  },

  /**
   * Execute an automation manually by AP-XXXX ID.
   */
  async execute(input: unknown) {
    const { tenant_id, automation_id, params } = ExecuteAutomationSchema.parse(input);

    const data = await callGateway(`/execute/${automation_id}`, 'POST', {
      tenant_id,
      params: params ?? {},
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'automations.execute',
      actor: 'openclaw-autopilot',
      details: { automation_id, params },
      created_at: new Date().toISOString(),
    });

    return { success: true, result: data };
  },

  /**
   * Dispatch an OASIS event to trigger matching automations.
   */
  async dispatch(input: unknown) {
    const { tenant_id, event_type, payload } = DispatchEventSchema.parse(input);

    const data = await callGateway('/dispatch', 'POST', {
      tenant_id,
      event_type,
      payload,
      source: 'openclaw-autopilot',
    });

    const supabase = getSupabase();
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'automations.dispatch',
      actor: 'openclaw-autopilot',
      details: { event_type },
      created_at: new Date().toISOString(),
    });

    return { success: true, result: data };
  },

  /**
   * Trigger a heartbeat cycle to run due automations.
   */
  async heartbeat(input: unknown) {
    const { tenant_id } = RegistrySummarySchema.parse(input);

    const data = await callGateway('/heartbeat', 'POST', {
      tenant_id,
      source: 'openclaw-autopilot',
    });

    return { success: true, result: data };
  },

  /**
   * Get recent automation run history.
   */
  async run_history(input: unknown) {
    const { tenant_id, automation_id, limit } = RunHistorySchema.parse(input);
    const supabase = getSupabase();

    let query = supabase
      .from('automation_runs')
      .select('id, automation_id, status, started_at, finished_at, error')
      .eq('tenant_id', tenant_id)
      .order('started_at', { ascending: false })
      .limit(limit);

    if (automation_id) query = query.eq('automation_id', automation_id);

    const { data, error } = await query;
    if (error) throw new Error(`run_history failed: ${error.message}`);
    return { success: true, runs: data, count: data?.length ?? 0 };
  },
};

export const SKILL_META = {
  name: 'vitana-automations',
  description: 'Automation registry, execution, heartbeat, and event dispatch for AP-XXXX workflows',
  actions: Object.keys(actions),
};
