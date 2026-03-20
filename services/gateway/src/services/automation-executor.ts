/**
 * Automation Executor — Runs AP-XXXX automations
 *
 * VTID: VTID-01250 (Autopilot Automations Engine)
 *
 * Three execution modes:
 * 1. Cron — triggered by Cloud Scheduler via POST /api/v1/automations/cron/:automationId
 * 2. Heartbeat — triggered by the heartbeat loop (every N minutes)
 * 3. Event — triggered by OASIS events matching a topic
 *
 * Each execution creates an `automation_runs` record for audit.
 * Governance flags (EXECUTION_DISARMED, AUTOPILOT_LOOP_ENABLED) are checked before every run.
 */

import { randomUUID } from 'crypto';
import { AutomationDefinition, AutomationContext, RunStatus, TriggerType, RoleTarget } from '../types/automations';
import { getAutomation, getHeartbeatAutomations, getEventAutomations, automationTargetsRole } from './automation-registry';
import { notifyUserAsync } from './notification-service';

// ── Environment ─────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// ── Supabase service client ─────────────────────────────────
let _serviceClient: any = null;
async function getServiceClient() {
  if (_serviceClient) return _serviceClient;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return null;
  const { createClient } = await import('@supabase/supabase-js');
  _serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
  return _serviceClient;
}

// ── OASIS event emission ────────────────────────────────────
async function emitOasisEvent(topic: string, metadata: Record<string, unknown>): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        id: randomUUID(),
        created_at: new Date().toISOString(),
        vtid: 'VTID-01250',
        topic,
        service: 'automation-executor',
        role: 'AUTOPILOT',
        model: 'automations-engine',
        status: 'info',
        message: `Automation event: ${topic}`,
        metadata,
      }),
    });
  } catch (err) {
    console.warn('[AutomationExecutor] Failed to emit OASIS event:', err);
  }
}

// ── Governance check ────────────────────────────────────────
async function isExecutionArmed(): Promise<boolean> {
  try {
    const { isAutopilotExecutionArmed } = await import('./system-controls-service');
    return isAutopilotExecutionArmed();
  } catch {
    // If service not available, default to armed (allow execution)
    return true;
  }
}

// ── Create automation run record ────────────────────────────
async function createRun(
  tenantId: string,
  automationId: string,
  triggerType: TriggerType,
  triggerSource?: string
): Promise<string> {
  const supabase = await getServiceClient();
  if (!supabase) throw new Error('Supabase not configured');

  const runId = randomUUID();
  const { error } = await supabase.from('automation_runs').insert({
    id: runId,
    tenant_id: tenantId,
    automation_id: automationId,
    trigger_type: triggerType,
    trigger_source: triggerSource,
    status: 'running',
    started_at: new Date().toISOString(),
  });
  if (error) console.warn(`[AutomationExecutor] Failed to create run: ${error.message}`);
  return runId;
}

// ── Complete automation run ─────────────────────────────────
async function completeRun(
  runId: string,
  status: RunStatus,
  usersAffected: number,
  actionsTaken: number,
  errorMessage?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const supabase = await getServiceClient();
  if (!supabase) return;

  await supabase.from('automation_runs').update({
    status,
    users_affected: usersAffected,
    actions_taken: actionsTaken,
    error_message: errorMessage,
    metadata: metadata || {},
    completed_at: new Date().toISOString(),
  }).eq('id', runId);
}

// ── Handler registry (maps handler name → function) ─────────
// Individual handler functions are imported from domain-specific modules
const handlers: Record<string, (ctx: AutomationContext) => Promise<{ usersAffected: number; actionsTaken: number }>> = {};

/**
 * Register a handler function for an automation.
 * Called by domain services during initialization.
 */
export function registerHandler(
  handlerName: string,
  fn: (ctx: AutomationContext) => Promise<{ usersAffected: number; actionsTaken: number }>
): void {
  handlers[handlerName] = fn;
  console.log(`[AutomationExecutor] Registered handler: ${handlerName}`);
}

// =============================================================================
// Role-aware user query
// =============================================================================

/**
 * Query users in a tenant filtered by the automation's target roles.
 * Uses the user_tenants M:N table which stores active_role per tenant membership.
 * If targetRoles is 'all', returns all users without role filtering.
 */
async function queryUsersByRole(
  supabase: any,
  tenantId: string,
  targetRoles: RoleTarget,
  selectColumns: string = 'user_id, active_role',
): Promise<Array<{ user_id: string; active_role: string }>> {
  let query = supabase
    .from('user_tenants')
    .select(selectColumns)
    .eq('tenant_id', tenantId);

  if (targetRoles !== 'all') {
    query = query.in('active_role', targetRoles);
  }

  const { data, error } = await query;
  if (error) {
    console.warn(`[AutomationExecutor] queryUsersByRole failed: ${error.message}`);
    return [];
  }
  return data || [];
}

// =============================================================================
// Core execution function
// =============================================================================

/**
 * Execute a single automation by ID.
 * Creates a run record, executes the handler, and logs the result.
 */
export async function executeAutomation(
  automationId: string,
  tenantId: string,
  triggerType: TriggerType,
  triggerSource?: string,
  eventPayload?: Record<string, unknown>
): Promise<{ ok: boolean; runId?: string; error?: string; skipped?: boolean }> {
  const definition = getAutomation(automationId);
  if (!definition) {
    return { ok: false, error: `Unknown automation: ${automationId}` };
  }

  // Skip PLANNED automations
  if (definition.status === 'PLANNED' || definition.status === 'DEPRECATED') {
    return { ok: true, skipped: true, error: `Automation ${automationId} is ${definition.status}` };
  }

  // Check handler exists
  if (!definition.handler || !handlers[definition.handler]) {
    return { ok: false, error: `No handler registered for ${automationId} (${definition.handler})` };
  }

  // Governance check
  const armed = await isExecutionArmed();
  if (!armed) {
    console.log(`[AutomationExecutor] Execution disarmed, skipping ${automationId}`);
    return { ok: true, skipped: true, error: 'EXECUTION_DISARMED' };
  }

  const supabase = await getServiceClient();
  if (!supabase) return { ok: false, error: 'Supabase not configured' };

  const targetRoles: RoleTarget = definition.targetRoles;

  // Create run record
  const runId = await createRun(tenantId, automationId, triggerType, triggerSource);
  const logs: string[] = [];

  // Build context
  const ctx: AutomationContext = {
    tenantId,
    targetRoles,
    supabase,
    run: {
      id: runId,
      tenant_id: tenantId,
      automation_id: automationId,
      trigger_type: triggerType,
      trigger_source: triggerSource,
      target_roles: targetRoles,
      status: 'running',
      users_affected: 0,
      actions_taken: 0,
      metadata: eventPayload || {},
      started_at: new Date().toISOString(),
    },
    log: (msg: string) => {
      logs.push(`[${new Date().toISOString()}] ${msg}`);
      console.log(`[${automationId}] ${msg}`);
    },
    notify: (userId: string, type: string, payload) => {
      notifyUserAsync(userId, tenantId, type, payload, supabase);
    },
    emitEvent: async (topic: string, metadata: Record<string, unknown>) => {
      await emitOasisEvent(topic, { ...metadata, automation_id: automationId, run_id: runId });
    },
    queryTargetUsers: async (selectColumns?: string) => {
      return queryUsersByRole(supabase, tenantId, targetRoles, selectColumns);
    },
  };

  try {
    ctx.log(`Starting execution (trigger: ${triggerType})`);
    const result = await handlers[definition.handler](ctx);

    await completeRun(runId, 'completed', result.usersAffected, result.actionsTaken, undefined, {
      logs,
      event_payload: eventPayload,
    });

    await emitOasisEvent(`autopilot.automation.completed`, {
      automation_id: automationId,
      run_id: runId,
      target_roles: targetRoles,
      users_affected: result.usersAffected,
      actions_taken: result.actionsTaken,
    });

    ctx.log(`Completed: ${result.usersAffected} users, ${result.actionsTaken} actions`);
    return { ok: true, runId };

  } catch (err: any) {
    const errorMsg = err.message || String(err);
    ctx.log(`Failed: ${errorMsg}`);

    await completeRun(runId, 'failed', 0, 0, errorMsg, { logs, event_payload: eventPayload });

    await emitOasisEvent(`autopilot.automation.failed`, {
      automation_id: automationId,
      run_id: runId,
      error: errorMsg,
    });

    return { ok: false, runId, error: errorMsg };
  }
}

// =============================================================================
// Heartbeat loop — runs all heartbeat automations on their intervals
// =============================================================================

const lastHeartbeatRun: Record<string, number> = {}; // automation_id → last run timestamp ms

/**
 * Run one heartbeat cycle. Called every minute by the heartbeat loop.
 * Only executes automations whose interval has elapsed since last run.
 */
export async function runHeartbeatCycle(tenantId: string): Promise<{
  executed: string[];
  skipped: string[];
  failed: string[];
}> {
  const heartbeatAutomations = getHeartbeatAutomations();
  const now = Date.now();
  const executed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const def of heartbeatAutomations) {
    const intervalMs = (def.triggerConfig?.intervalMinutes || 60) * 60 * 1000;
    const lastRun = lastHeartbeatRun[def.id] || 0;

    if (now - lastRun < intervalMs) {
      skipped.push(def.id);
      continue;
    }

    lastHeartbeatRun[def.id] = now;
    const result = await executeAutomation(def.id, tenantId, 'heartbeat', 'heartbeat-loop');

    if (result.ok && !result.skipped) {
      executed.push(def.id);
    } else if (result.error) {
      failed.push(def.id);
    } else {
      skipped.push(def.id);
    }
  }

  return { executed, skipped, failed };
}

// =============================================================================
// Event dispatch — matches OASIS events to automations
// =============================================================================

/**
 * Dispatch an OASIS event to matching automations.
 */
export async function dispatchEvent(
  tenantId: string,
  eventTopic: string,
  eventPayload: Record<string, unknown>
): Promise<{ dispatched: string[]; errors: string[] }> {
  const matching = getEventAutomations(eventTopic);
  const dispatched: string[] = [];
  const errors: string[] = [];

  for (const def of matching) {
    const result = await executeAutomation(def.id, tenantId, 'event', eventTopic, eventPayload);
    if (result.ok) {
      dispatched.push(def.id);
    } else {
      errors.push(`${def.id}: ${result.error}`);
    }
  }

  return { dispatched, errors };
}

// =============================================================================
// Run history queries
// =============================================================================

export async function getRunHistory(
  tenantId: string,
  automationId?: string,
  limit: number = 50
): Promise<any[]> {
  const supabase = await getServiceClient();
  if (!supabase) return [];

  let query = supabase
    .from('automation_runs')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (automationId) {
    query = query.eq('automation_id', automationId);
  }

  const { data } = await query;
  return data || [];
}

export async function getActiveRuns(tenantId: string): Promise<any[]> {
  const supabase = await getServiceClient();
  if (!supabase) return [];

  const { data } = await supabase
    .from('automation_runs')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'running')
    .order('started_at', { ascending: false });

  return data || [];
}
