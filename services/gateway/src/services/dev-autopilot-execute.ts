/**
 * Developer Autopilot — Execution service
 *
 * Takes an approved-and-cooled execution row and drives it through:
 *
 *   cooling   → running   (claim + Managed Agents session starts)
 *   running   → ci        (edits applied, PR opened)
 *   ci        → merging   (PR-9 watcher: CI green)
 *   merging   → deploying (PR-9: merged; AUTO-DEPLOY fires)
 *   deploying → verifying (PR-9: deploy.gateway.success received)
 *   verifying → completed (PR-9: verification window passed clean)
 *
 * This module handles the cooling→running→ci stages plus kill-switch /
 * concurrency checks. CI + deploy + verification watchers land in PR-9.
 *
 * Dry-run mode (DEV_AUTOPILOT_DRY_RUN=true) skips the real Managed Agents
 * session and GitHub API call, producing a synthetic PR URL so the UI and
 * pipeline can be tested without touching repo state.
 *
 * Agent ID resolution (env-driven, falls back to triage agent so we ship
 * before dedicated execution agent provisioning):
 *   DEV_AUTOPILOT_EXECUTION_AGENT_ID → falls back to TRIAGE_AGENT_ID
 *   DEV_AUTOPILOT_EXECUTION_ENV_ID   → falls back to TRIAGE_ENVIRONMENT_ID
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  evaluateSafetyGate,
  SafetyContext,
  SafetyPlan,
  SafetyDecision,
} from './dev-autopilot-safety';

const LOG_PREFIX = '[dev-autopilot-execute]';
const EXEC_VTID = 'VTID-DEV-AUTOPILOT';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_BASE = 'https://api.anthropic.com';
const BETA_HEADER = 'managed-agents-2026-04-01';
const SESSION_TIMEOUT_MS = 600_000; // 10 min per execution session
const DRY_RUN = (process.env.DEV_AUTOPILOT_DRY_RUN || 'true').toLowerCase() === 'true';
const BACKGROUND_TICK_MS = 30_000;

function getExecutionAgentIds(): { agent_id: string; environment_id: string } {
  return {
    agent_id: process.env.DEV_AUTOPILOT_EXECUTION_AGENT_ID
           || process.env.TRIAGE_AGENT_ID
           || 'agent_011Ca1RTRZADaWdZsKAKjs3B',
    environment_id: process.env.DEV_AUTOPILOT_EXECUTION_ENV_ID
                 || process.env.TRIAGE_ENVIRONMENT_ID
                 || 'env_01VrvRRUWP91wiFQrmWaUcEh',
  };
}

// =============================================================================
// Types
// =============================================================================

export interface ApprovalInput {
  finding_id: string;
  approved_by?: string;
}

export interface ApprovalResult {
  ok: boolean;
  execution?: ExecutionRow;
  decision?: SafetyDecision;
  error?: string;
}

export interface ExecutionRow {
  id: string;
  finding_id: string;
  plan_version: number;
  status: string;
  approved_by?: string;
  approved_at?: string;
  execute_after?: string;
  branch?: string;
  pr_url?: string;
  pr_number?: number;
  auto_fix_depth: number;
  parent_execution_id?: string;
}

// =============================================================================
// Supabase helpers
// =============================================================================

interface SupaConfig { url: string; key: string; }
function getSupabase(): SupaConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return { url, key };
}

async function supa<T>(
  s: SupaConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; data?: T; status: number; error?: string }> {
  try {
    const res = await fetch(`${s.url}${path}`, {
      ...init,
      headers: {
        apikey: s.key,
        Authorization: `Bearer ${s.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(init.headers || {}),
      },
    });
    if (!res.ok) return { ok: false, status: res.status, error: `${res.status}: ${await res.text()}` };
    if (res.status === 204 || res.status === 201) {
      const text = await res.text();
      if (!text) return { ok: true, status: res.status };
      try {
        return { ok: true, status: res.status, data: JSON.parse(text) as T };
      } catch { return { ok: true, status: res.status }; }
    }
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 500, error: String(err) };
  }
}

// =============================================================================
// Safety context loader
// =============================================================================

interface ConfigRow {
  kill_switch: boolean;
  daily_budget: number;
  concurrency_cap: number;
  cooldown_minutes: number;
  max_auto_fix_depth: number;
  allow_scope: string[];
  deny_scope: string[];
}

async function loadConfig(s: SupaConfig): Promise<ConfigRow | null> {
  const r = await supa<ConfigRow[]>(s, `/rest/v1/dev_autopilot_config?id=eq.1&limit=1`);
  if (!r.ok || !r.data || r.data.length === 0) return null;
  return r.data[0];
}

async function countApprovedToday(s: SupaConfig): Promise<number> {
  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);
  const r = await supa<unknown[]>(
    s,
    `/rest/v1/dev_autopilot_executions?approved_at=gte.${todayUTC.toISOString()}&select=id`,
  );
  return r.ok && Array.isArray(r.data) ? r.data.length : 0;
}

async function countRunningExecutions(s: SupaConfig): Promise<number> {
  const r = await supa<unknown[]>(
    s,
    `/rest/v1/dev_autopilot_executions?status=in.(running,ci,merging,deploying,verifying)&select=id`,
  );
  return r.ok && Array.isArray(r.data) ? r.data.length : 0;
}

// =============================================================================
// Approval entry point
// =============================================================================

export async function approveAutoExecute(input: ApprovalInput): Promise<ApprovalResult> {
  const s = getSupabase();
  if (!s) return { ok: false, error: 'Supabase not configured' };

  // 1. Load finding
  const recR = await supa<Array<{
    id: string;
    risk_class: 'low' | 'medium' | 'high' | null;
    source_type: string;
    spec_snapshot: Record<string, unknown>;
  }>>(
    s,
    `/rest/v1/autopilot_recommendations?id=eq.${input.finding_id}&select=id,risk_class,source_type,spec_snapshot&limit=1`,
  );
  if (!recR.ok || !recR.data) return { ok: false, error: recR.error || 'finding lookup failed' };
  const rec = recR.data[0];
  if (!rec) return { ok: false, error: 'finding not found' };
  if (rec.source_type !== 'dev_autopilot') return { ok: false, error: 'not a dev_autopilot finding' };

  // 2. Load latest plan version
  const planR = await supa<Array<{ version: number; files_referenced: string[]; plan_markdown: string }>>(
    s,
    `/rest/v1/dev_autopilot_plan_versions?finding_id=eq.${input.finding_id}&order=version.desc&limit=1`,
  );
  if (!planR.ok || !planR.data || planR.data.length === 0) {
    return { ok: false, error: 'plan version required — generate a plan before approving' };
  }
  const plan = planR.data[0];

  // 3. Load config + stats
  const cfg = await loadConfig(s);
  if (!cfg) return { ok: false, error: 'dev_autopilot_config missing' };
  const approvedToday = await countApprovedToday(s);

  // 4. Evaluate safety gate
  const files = (plan.files_referenced || []).map(String);
  const deletions = extractDeletions(plan.plan_markdown);
  const safetyPlan: SafetyPlan = {
    risk_class: (rec.risk_class || 'medium') as 'low' | 'medium' | 'high',
    files_to_modify: files,
    files_to_delete: deletions,
  };
  const safetyCtx: SafetyContext = {
    config: {
      kill_switch: cfg.kill_switch,
      daily_budget: cfg.daily_budget,
      concurrency_cap: cfg.concurrency_cap,
      max_auto_fix_depth: cfg.max_auto_fix_depth,
      allow_scope: cfg.allow_scope,
      deny_scope: cfg.deny_scope,
    },
    approved_today: approvedToday,
    auto_fix_depth: 0,
  };
  const decision = evaluateSafetyGate(safetyPlan, safetyCtx);
  if (!decision.ok) {
    return { ok: false, decision, error: 'safety gate blocked approval' };
  }

  // 5. Create execution row (status=cooling, execute_after = now + cooldown)
  const now = new Date();
  const executeAfter = new Date(now.getTime() + cfg.cooldown_minutes * 60 * 1000);
  const execId = randomUUID();
  const ins = await supa(s, `/rest/v1/dev_autopilot_executions`, {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      id: execId,
      finding_id: input.finding_id,
      plan_version: plan.version,
      status: 'cooling',
      approved_by: input.approved_by || null,
      approved_at: now.toISOString(),
      execute_after: executeAfter.toISOString(),
      auto_fix_depth: 0,
    }),
  });
  if (!ins.ok) return { ok: false, error: `execution insert failed: ${ins.error}` };

  await emitOasisEvent({
    vtid: EXEC_VTID,
    type: 'dev_autopilot.execution.approved',
    source: 'dev-autopilot',
    status: 'info',
    message: `Execution ${execId.slice(0, 8)} approved — cooldown until ${executeAfter.toISOString()}`,
    payload: {
      execution_id: execId,
      finding_id: input.finding_id,
      plan_version: plan.version,
      execute_after: executeAfter.toISOString(),
    },
  });

  return {
    ok: true,
    decision,
    execution: {
      id: execId,
      finding_id: input.finding_id,
      plan_version: plan.version,
      status: 'cooling',
      approved_by: input.approved_by,
      approved_at: now.toISOString(),
      execute_after: executeAfter.toISOString(),
      auto_fix_depth: 0,
    },
  };
}

/** Extract "delete" intent from the plan markdown — best-effort heuristic.
 *  Looks for bullet lines like "- delete services/.../foo.ts" in the Files
 *  section. Used by the safety gate to allow dead-code deletions without a
 *  test-file addition. */
export function extractDeletions(markdown: string): string[] {
  const out = new Set<string>();
  const deleteLinePattern = /(?:delete|remove|drop)\s+[`]?((?:services|supabase|scripts|\.github|specs|src)\/[a-zA-Z0-9_./\-]+\.(?:ts|tsx|js|jsx|sql|yml|yaml|json|md))[`]?/gi;
  for (const m of markdown.matchAll(deleteLinePattern)) {
    out.add(m[1]);
  }
  return Array.from(out);
}

// =============================================================================
// Cancel (during cooldown only)
// =============================================================================

export async function cancelExecution(executionId: string): Promise<{ ok: boolean; error?: string }> {
  const s = getSupabase();
  if (!s) return { ok: false, error: 'Supabase not configured' };
  const r = await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${executionId}&status=eq.cooling`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'cancelled', cancelled_at: new Date().toISOString() }),
  });
  if (!r.ok) return { ok: false, error: r.error };
  await emitOasisEvent({
    vtid: EXEC_VTID,
    type: 'dev_autopilot.execution.cancelled',
    source: 'dev-autopilot',
    status: 'info',
    message: `Execution ${executionId.slice(0, 8)} cancelled during cooldown`,
    payload: { execution_id: executionId },
  });
  return { ok: true };
}

// =============================================================================
// Background executor — picks up cooling→running transitions
// =============================================================================

async function anthropicRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(`${ANTHROPIC_BASE}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': BETA_HEADER,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function runExecutionSession(
  s: SupaConfig,
  executionId: string,
): Promise<{ ok: boolean; pr_url?: string; branch?: string; pr_number?: number; session_id?: string; error?: string }> {
  // Load execution + finding + plan
  const execR = await supa<Array<ExecutionRow & { finding_id: string; plan_version: number }>>(
    s,
    `/rest/v1/dev_autopilot_executions?id=eq.${executionId}&limit=1`,
  );
  if (!execR.ok || !execR.data || execR.data.length === 0) {
    return { ok: false, error: 'execution row not found' };
  }
  const exec = execR.data[0];

  const planR = await supa<Array<{ plan_markdown: string; files_referenced: string[] }>>(
    s,
    `/rest/v1/dev_autopilot_plan_versions?finding_id=eq.${exec.finding_id}&version=eq.${exec.plan_version}&limit=1`,
  );
  if (!planR.ok || !planR.data || planR.data.length === 0) {
    return { ok: false, error: 'plan version not found' };
  }
  const plan = planR.data[0];

  const branch = `dev-autopilot/${executionId.slice(0, 8)}`;
  const vtidLike = `VTID-DA-${executionId.slice(0, 8)}`;

  if (DRY_RUN || !ANTHROPIC_API_KEY) {
    console.log(`${LOG_PREFIX} DRY RUN — skipping real session for ${executionId} (files: ${plan.files_referenced.length})`);
    const stubPr = `https://github.com/exafyltd/vitana-platform/pull/DRY-RUN-${executionId.slice(0, 8)}`;
    return {
      ok: true,
      pr_url: stubPr,
      pr_number: 0,
      branch,
      session_id: `dry_${executionId.slice(0, 8)}`,
    };
  }

  // Live Managed Agents session. Writing files + opening PRs requires dedicated
  // tool configuration on the agent. For the initial live run we spawn the
  // session with the plan as its prompt and let the operator provision the
  // dedicated execution agent ID in env. Until a dedicated agent is wired the
  // safer behavior is to return an explanatory failure so the bridge routes
  // it to human review rather than silently no-op.
  const { agent_id, environment_id } = getExecutionAgentIds();
  const sessionR = await anthropicRequest<{ id: string }>('/v1/sessions', {
    method: 'POST',
    body: {
      agent: { type: 'agent', id: agent_id, version: 1 },
      environment_id,
      title: `Dev Autopilot execute: ${exec.finding_id}`,
      resources: [
        {
          type: 'github_repository',
          url: 'https://github.com/exafyltd/vitana-platform',
          authorization_token: process.env.DEV_AUTOPILOT_GITHUB_TOKEN
            || process.env.GITHUB_SAFE_MERGE_TOKEN
            || '',
          mount_path: '/workspace/repo',
          checkout: { type: 'branch', name: 'main' },
        },
      ],
    },
  });
  if (!sessionR.ok || !sessionR.data) {
    return { ok: false, error: `Session creation failed: ${sessionR.error}` };
  }
  const sessionId = sessionR.data.id;

  const prompt = [
    `# Developer Autopilot — Execute plan ${exec.finding_id} (plan v${exec.plan_version})`,
    ``,
    `Branch to create: \`${branch}\``,
    `Commit message should reference ${vtidLike}.`,
    ``,
    `Plan:`,
    `\`\`\`markdown`,
    plan.plan_markdown,
    `\`\`\``,
    ``,
    `Execute the plan exactly as written. Do not expand scope. After edits,`,
    `open a PR against main with the plan_markdown as the body. Run tests`,
    `locally if you can; abort if they fail.`,
  ].join('\n');

  await anthropicRequest(`/v1/sessions/${sessionId}/events`, {
    method: 'POST',
    body: {
      events: [{ type: 'user.message', content: [{ type: 'text', text: prompt }] }],
    },
  });

  // Poll. Full tool-use integration (write_file / open_pr) requires a dedicated
  // agent configuration beyond what the triage agent provides. For the first
  // live rollout we just collect output + a placeholder PR URL from the agent
  // text. Operators should provision DEV_AUTOPILOT_EXECUTION_AGENT_ID before
  // flipping DEV_AUTOPILOT_DRY_RUN=false.
  const seen = new Set<string>();
  const texts: string[] = [];
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  let done = false;
  let sawAgentMessage = false;
  let sawUserMessage = false;
  while (!done && Date.now() < deadline) {
    const ev = await anthropicRequest<{ data?: Array<{ id: string; type: string; content?: Array<{ type: string; text?: string }>; stop_reason?: { type?: string } }> }>(
      `/v1/sessions/${sessionId}/events`,
    );
    if (!ev.ok) return { ok: false, error: `events poll failed: ${ev.error}`, session_id: sessionId, branch };
    const events = ev.data?.data || [];
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (e.type === 'user.message') {
        sawUserMessage = true;
      } else if (e.type === 'agent.message' && e.content) {
        sawAgentMessage = true;
        for (const b of e.content) {
          if (b.type === 'text' && b.text) texts.push(b.text);
        }
      } else if (e.type === 'session.status_idle' && e.stop_reason?.type !== 'requires_action') {
        // Don't exit on the pre-user-message idle state — session is idle
        // between create and user.message arrival.
        if (sawAgentMessage && sawUserMessage) done = true;
      } else if (e.type === 'session.status_terminated') {
        done = true;
      }
    }
    if (!done && events.length === 0) await new Promise(r => setTimeout(r, 3000));
  }

  // Best-effort PR URL extraction from the agent's output
  const text = texts.join('\n');
  const prMatch = text.match(/https:\/\/github\.com\/exafyltd\/vitana-platform\/pull\/(\d+)/);
  if (!prMatch) {
    return {
      ok: false,
      error: 'Agent session ended without producing a PR URL. Provision DEV_AUTOPILOT_EXECUTION_AGENT_ID with file-write + open_pr tools and retry.',
      session_id: sessionId,
      branch,
    };
  }
  return {
    ok: true,
    pr_url: prMatch[0],
    pr_number: parseInt(prMatch[1], 10),
    branch,
    session_id: sessionId,
  };
}

/** Main tick — called every BACKGROUND_TICK_MS. Idempotent. */
export async function backgroundExecutorTick(): Promise<void> {
  const s = getSupabase();
  if (!s) return;

  // 1. Honor kill switch
  const cfg = await loadConfig(s);
  if (!cfg || cfg.kill_switch) return;

  // 2. Concurrency cap
  const running = await countRunningExecutions(s);
  const slots = Math.max(0, cfg.concurrency_cap - running);
  if (slots === 0) return;

  // 3. Pick cooling executions past execute_after, oldest first
  const now = new Date().toISOString();
  const readyR = await supa<ExecutionRow[]>(
    s,
    `/rest/v1/dev_autopilot_executions?status=eq.cooling&execute_after=lte.${now}&order=execute_after.asc&limit=${slots}&select=id,finding_id,plan_version,auto_fix_depth`,
  );
  if (!readyR.ok || !readyR.data || readyR.data.length === 0) return;

  for (const exec of readyR.data) {
    // Atomic claim: transition cooling → running only if still cooling
    const claim = await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${exec.id}&status=eq.cooling`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'running', updated_at: new Date().toISOString() }),
    });
    if (!claim.ok) {
      console.warn(`${LOG_PREFIX} claim failed for ${exec.id}: ${claim.error}`);
      continue;
    }

    await emitOasisEvent({
      vtid: EXEC_VTID,
      type: 'dev_autopilot.execution.running',
      source: 'dev-autopilot',
      status: 'info',
      message: `Execution ${exec.id.slice(0, 8)} running`,
      payload: { execution_id: exec.id, finding_id: exec.finding_id },
    });

    // Fire-and-forget so one long-running session doesn't block sibling claims
    runExecutionSession(s, exec.id).then(async (result) => {
      if (result.ok && result.pr_url) {
        await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${exec.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'ci',
            pr_url: result.pr_url,
            pr_number: result.pr_number || null,
            branch: result.branch || null,
            execution_session_id: result.session_id || null,
          }),
        });
        await emitOasisEvent({
          vtid: EXEC_VTID,
          type: 'dev_autopilot.execution.pr_opened',
          source: 'dev-autopilot',
          status: 'success',
          message: `Execution ${exec.id.slice(0, 8)} opened ${result.pr_url}`,
          payload: { execution_id: exec.id, pr_url: result.pr_url, branch: result.branch },
        });
      } else {
        await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${exec.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'failed',
            execution_session_id: result.session_id || null,
            metadata: { error: result.error || 'unknown execution failure' },
            completed_at: new Date().toISOString(),
          }),
        });
        await emitOasisEvent({
          vtid: EXEC_VTID,
          type: 'dev_autopilot.execution.failed',
          source: 'dev-autopilot',
          status: 'error',
          message: `Execution ${exec.id.slice(0, 8)} failed: ${result.error || 'unknown'}`,
          payload: { execution_id: exec.id, error: result.error },
        });

        // Bridge: route the failure through self-healing triage + auto-revert.
        // Fire-and-forget so one slow triage doesn't block the executor tick.
        // Loaded lazily to avoid a module-level circular import.
        try {
          const { bridgeFailureToSelfHealing } = require('./dev-autopilot-bridge');
          bridgeFailureToSelfHealing({
            execution_id: exec.id,
            failure_stage: 'ci',
            error: result.error,
          }).catch((err: unknown) => {
            console.error(`${LOG_PREFIX} bridge error for ${exec.id}:`, err);
          });
        } catch (err) {
          console.error(`${LOG_PREFIX} bridge load error for ${exec.id}:`, err);
        }
      }
    }).catch((err) => {
      console.error(`${LOG_PREFIX} unhandled executor error for ${exec.id}:`, err);
    });
  }
}

let backgroundTickerStarted = false;
export function startBackgroundExecutor(): void {
  if (backgroundTickerStarted) return;
  backgroundTickerStarted = true;
  console.log(`${LOG_PREFIX} starting background executor (tick=${BACKGROUND_TICK_MS}ms, dry_run=${DRY_RUN})`);
  setInterval(() => {
    backgroundExecutorTick().catch((err) => {
      console.error(`${LOG_PREFIX} tick error:`, err);
    });
  }, BACKGROUND_TICK_MS);
}

export { LOG_PREFIX, DRY_RUN, BACKGROUND_TICK_MS };
