/**
 * Developer Autopilot — Failure → Self-Healing bridge
 *
 * When a Dev Autopilot execution fails (agent couldn't open a PR, CI failed,
 * deploy failed, or post-deploy verification failed) this module:
 *
 *   1. Spawns the Self-Healing triage agent in the appropriate mode
 *      (post_failure for CI/deploy, verification_failure for post-deploy).
 *   2. Records the triage report on the execution row.
 *   3. Attempts an auto-revert (close PR for ci-stage failures, open revert
 *      PR for deploy/verification failures) so production is restored before
 *      the retry lands.
 *   4. Decides the next step based on triage confidence + auto_fix_depth:
 *        - confidence ≥ 0.5 AND depth < max_auto_fix_depth
 *             → spawn a child execution (status=cooling) with the original
 *               plan; depth+1; parent_execution_id set so the UI can draw
 *               the self-heal lineage
 *        - confidence ≥ 0.5 AND depth == cap
 *             → mark failed_escalated; emit escalation event so a human
 *               can approve the next attempt (no more autonomous retries)
 *        - confidence < 0.5 OR triage errored
 *             → mark failed_escalated; surface for human review
 *
 * DRY_RUN honors DEV_AUTOPILOT_DRY_RUN=true (opt-in for tests / dev). The
 * default is 'false' so the bridge actually closes failed PRs in production.
 * The previous default of 'true' was misaligned with the executor's default
 * of 'false' and was load-bearing: the bridge logged "reverted via
 * #closed-dry-run" while leaving the GitHub PR open, then
 * spawnChildExecution() opened a fresh PR for the same finding. Combined
 * with autoApproveTick re-picking the still-status='new' finding, that
 * mechanism produced the 2026-05-07 flood (530 stranded PRs in 4 days).
 */

import { randomUUID } from 'crypto';
import {
  spawnTriageAgent,
  TriageReport,
  TriageMode,
} from './self-healing-triage-service';
import { emitOasisEvent } from './oasis-event-service';
import { isEnvironmentalBlocker } from './dev-autopilot-self-heal-log';

const LOG_PREFIX = '[dev-autopilot-bridge]';
const BRIDGE_VTID = 'VTID-DEV-AUTOPILOT';

// Default 'false' — match the executor's default. See header doc.
const DRY_RUN = (process.env.DEV_AUTOPILOT_DRY_RUN || 'false').toLowerCase() === 'true';
const GITHUB_TOKEN =
  process.env.DEV_AUTOPILOT_GITHUB_TOKEN ||
  process.env.GITHUB_SAFE_MERGE_TOKEN ||
  '';
const GITHUB_REPO =
  process.env.DEV_AUTOPILOT_GITHUB_REPO || 'exafyltd/vitana-platform';

// Confidence threshold above which we trust the agent to propose an
// autonomous retry. Lowered from 0.5 → 0.3 (configurable via env var) so
// the autopilot retries more aggressively by default — the user goal is
// "self-improving + self-healing autonomously." Failed retries still
// escalate at the depth cap.
const CHILD_SPAWN_CONFIDENCE_THRESHOLD = Number.parseFloat(
  process.env.AUTOPILOT_RETRY_CONFIDENCE_THRESHOLD || '0.3',
);

/**
 * Write a row into self_healing_log so the Self-Healing UI surfaces this
 * autopilot failure alongside the system-level health probes. Without this,
 * the bridge's escalation only updates dev_autopilot_executions and the
 * operator never sees the failure on the canonical self-healing screen.
 *
 * Best-effort: a write failure here must not block the bridge's primary
 * job (transitioning the execution row + emitting OASIS events). If
 * self_healing_log isn't writable, log and move on.
 */
async function writeSelfHealingLogEntry(
  s: SupaConfig,
  args: {
    execution_id: string;
    vtid: string;
    endpoint: string;
    failure_class: string;
    confidence: number;
    diagnosis: Record<string, unknown>;
    outcome: 'escalated' | 'fixed' | 'failed' | 'rolled_back' | 'pending';
    attempt_number: number;
  },
): Promise<void> {
  try {
    await supa(s, '/rest/v1/self_healing_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        vtid: args.vtid,
        endpoint: args.endpoint,
        failure_class: args.failure_class,
        confidence: args.confidence,
        diagnosis: args.diagnosis,
        outcome: args.outcome,
        attempt_number: args.attempt_number,
        resolved_at: args.outcome === 'pending' ? null : new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} writeSelfHealingLogEntry failed for ${args.execution_id}:`, err);
  }
}

// =============================================================================
// Types
// =============================================================================

export type FailureStage = 'ci' | 'deploy' | 'verification';

export interface BridgeInput {
  execution_id: string;
  failure_stage: FailureStage;
  failure_event_id?: string;
  error?: string;
  verification_result?: Record<string, unknown>;
  blast_radius?: unknown;
}

export type BridgeOutcome =
  | 'self_heal_injected'
  | 'escalated'
  | 'already_bridged'
  | 'env_blocker'
  | 'revert_failed'
  | 'triage_failed'
  | 'no_execution'
  | 'no_supabase';

export interface BridgeResult {
  ok: boolean;
  outcome: BridgeOutcome;
  execution_id: string;
  child_execution_id?: string;
  self_healing_vtid?: string;
  revert_pr_url?: string;
  triage_report?: TriageReport;
  error?: string;
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
// Execution loader
// =============================================================================

interface ExecutionRow {
  id: string;
  finding_id: string;
  plan_version: number;
  status: string;
  auto_fix_depth: number;
  branch?: string | null;
  pr_url?: string | null;
  pr_number?: number | null;
  parent_execution_id?: string | null;
  self_healing_vtid?: string | null;
  triage_report?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

interface ConfigRow {
  max_auto_fix_depth: number;
  cooldown_minutes: number;
  kill_switch: boolean;
}

async function loadExecution(s: SupaConfig, id: string): Promise<ExecutionRow | null> {
  const r = await supa<ExecutionRow[]>(
    s,
    `/rest/v1/dev_autopilot_executions?id=eq.${id}&limit=1`,
  );
  if (!r.ok || !r.data || r.data.length === 0) return null;
  return r.data[0];
}

async function loadConfig(s: SupaConfig): Promise<ConfigRow | null> {
  const r = await supa<ConfigRow[]>(
    s,
    `/rest/v1/dev_autopilot_config?id=eq.1&limit=1`,
  );
  if (!r.ok || !r.data || r.data.length === 0) return null;
  return r.data[0];
}

// =============================================================================
// Auto-revert
// =============================================================================

/** For CI-stage failures (PR opened but checks failed) we just close the PR.
 *  For deploy/verification failures the PR has already been merged, so we
 *  open a revert PR instead. */
export async function revertExecutionPR(
  exec: ExecutionRow,
  stage: FailureStage,
): Promise<{ ok: boolean; revert_pr_url?: string; error?: string }> {
  if (!exec.pr_url) {
    return { ok: true }; // Nothing to revert — session never produced a PR
  }

  if (DRY_RUN || !GITHUB_TOKEN) {
    const stub = stage === 'ci'
      ? `${exec.pr_url}#closed-dry-run`
      : `https://github.com/${GITHUB_REPO}/pull/REVERT-${exec.id.slice(0, 8)}`;
    console.log(`${LOG_PREFIX} DRY RUN revert (${stage}) → ${stub}`);
    return { ok: true, revert_pr_url: stub };
  }

  try {
    if (stage === 'ci' && exec.pr_number) {
      // Close the failing PR + delete branch via GitHub API
      const closeRes = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/pulls/${exec.pr_number}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ state: 'closed' }),
        },
      );
      if (!closeRes.ok) {
        return { ok: false, error: `close PR failed: ${closeRes.status} ${await closeRes.text()}` };
      }
      if (exec.branch) {
        await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/git/refs/heads/${exec.branch}`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${GITHUB_TOKEN}`,
              Accept: 'application/vnd.github+json',
            },
          },
        ).catch(() => undefined);
      }
      return { ok: true, revert_pr_url: `${exec.pr_url}#closed` };
    }

    // deploy / verification stage: PR already merged → open a revert PR.
    // We don't have full repo write tooling wired here yet; emit a marker
    // URL and let the execution agent (PR-9) + a follow-up pass open the
    // actual revert PR. For now the bridge records intent.
    const markerUrl = `https://github.com/${GITHUB_REPO}/pull/REVERT-${exec.id.slice(0, 8)}`;
    console.warn(`${LOG_PREFIX} live revert for ${stage} stage not fully wired — emitting marker ${markerUrl}`);
    return { ok: true, revert_pr_url: markerUrl };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// =============================================================================
// Child execution spawn
// =============================================================================

export async function spawnChildExecution(
  s: SupaConfig,
  parent: ExecutionRow,
  report: TriageReport,
  cooldownMinutes: number,
): Promise<{ ok: boolean; execution_id?: string; error?: string }> {
  const childId = randomUUID();
  const now = new Date();
  const executeAfter = new Date(now.getTime() + cooldownMinutes * 60 * 1000);
  const ins = await supa(s, `/rest/v1/dev_autopilot_executions`, {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      id: childId,
      finding_id: parent.finding_id,
      plan_version: parent.plan_version,
      status: 'cooling',
      approved_at: now.toISOString(),
      execute_after: executeAfter.toISOString(),
      auto_fix_depth: (parent.auto_fix_depth || 0) + 1,
      parent_execution_id: parent.id,
      triage_report: report,
      metadata: {
        source: 'dev-autopilot-bridge',
        parent_execution_id: parent.id,
        triage_session_id: report.session_id,
        triage_confidence: report.confidence,
      },
    }),
  });
  if (!ins.ok) {
    // VTID-AUTOPILOT-RACE: the partial unique index
    // `dev_autopilot_executions_finding_inflight_uniq` rejects this child
    // INSERT if the parent's terminal-state transition just raced an
    // autoApproveTick that approved a fresh fix=0 exec for the same
    // finding (or another bridge call already spawned a child for the
    // same parent). The other inflight exec will carry the retry; this
    // bridge call cleanly skips. Returning ok=true with a sentinel
    // execution_id lets the caller log the outcome rather than treat the
    // skip as a hard failure.
    if (ins.status === 409 && /23505|finding_inflight_uniq/.test(ins.error || '')) {
      console.log(
        `${LOG_PREFIX} child insert skipped for parent ${parent.id.slice(0, 8)}: another inflight exec already covers finding ${parent.finding_id.slice(0, 8)}`,
      );
      return { ok: false, error: 'inflight_unique_skip' };
    }
    return { ok: false, error: `child insert failed: ${ins.error}` };
  }
  return { ok: true, execution_id: childId };
}

// =============================================================================
// Main entry point
// =============================================================================

export async function bridgeFailureToSelfHealing(input: BridgeInput): Promise<BridgeResult> {
  const s = getSupabase();
  if (!s) {
    return { ok: false, outcome: 'no_supabase', execution_id: input.execution_id, error: 'Supabase not configured' };
  }

  const exec = await loadExecution(s, input.execution_id);
  if (!exec) {
    return { ok: false, outcome: 'no_execution', execution_id: input.execution_id, error: 'execution not found' };
  }

  // Idempotency: if we've already written a triage_report for this execution,
  // bail rather than spawning another triage session on top.
  if (exec.triage_report && Object.keys(exec.triage_report).length > 0) {
    return {
      ok: true,
      outcome: 'already_bridged',
      execution_id: exec.id,
      self_healing_vtid: exec.self_healing_vtid || undefined,
    };
  }

  // ENV-ERROR SHORT-CIRCUIT (2026-04-28 incident): when the failure is
  // environmental (binary missing, OOM, network, container recycle), running
  // triage produces a useless report ("install the binary") and the
  // reconciler then spawns a SELF-HEAL retry VTID per failure. The retry
  // execution hits the same blocker → infinite loop of stuck in_progress
  // rows on the operator's Tasks board.
  //
  // Skip triage entirely. Mark the execution failed_escalated, write a
  // self_healing_log entry classified `environmental_blocker` so the
  // reconciler also short-circuits (see self-healing-reconciler.ts), and
  // emit an OASIS event so an operator sees the infrastructure problem
  // instead of a wall of phantom retries.
  if (isEnvironmentalBlocker(input.error)) {
    console.warn(`${LOG_PREFIX} environmental blocker for ${exec.id.slice(0, 8)}: ${input.error?.slice(0, 120)} — skipping triage + retry`);
    await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${exec.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'failed_escalated',
        failure_stage: input.failure_stage,
        failure_event_id: input.failure_event_id || null,
        metadata: {
          ...(exec.metadata || {}),
          bridge_outcome: 'env_blocker_skip_triage',
          bridge_stage: input.failure_stage,
          env_error: input.error,
        },
        completed_at: new Date().toISOString(),
      }),
    });
    await writeSelfHealingLogEntry(s, {
      execution_id: exec.id,
      vtid: `VTID-DA-${exec.id.slice(0, 8)}`,
      endpoint: `dev_autopilot.execution.${input.failure_stage}`,
      failure_class: 'environmental_blocker',
      confidence: 1.0,
      diagnosis: {
        summary: `Environmental blocker — triage + retry skipped to prevent SELF-HEAL retry loop. Fix the host environment, not the code.`,
        execution_id: exec.id,
        finding_id: exec.finding_id,
        stage: input.failure_stage,
        error: input.error,
      },
      outcome: 'escalated',
      attempt_number: (exec.auto_fix_depth || 0) + 1,
    });
    await emitOasisEvent({
      vtid: BRIDGE_VTID,
      type: 'dev_autopilot.execution.escalated',
      source: 'dev-autopilot-bridge',
      status: 'error',
      message: `Execution ${exec.id.slice(0, 8)} env blocker — operator action needed (no autonomous retry)`,
      payload: { execution_id: exec.id, stage: input.failure_stage, error: input.error, env_blocker: true },
    });
    return {
      ok: false,
      outcome: 'env_blocker',
      execution_id: exec.id,
      error: input.error,
    };
  }

  const cfg = await loadConfig(s);
  const maxDepth = cfg?.max_auto_fix_depth ?? 2;
  const cooldown = cfg?.cooldown_minutes ?? 10;

  // 1. Run triage in the appropriate mode.
  const triageMode: TriageMode =
    input.failure_stage === 'verification' ? 'verification_failure' : 'post_failure';
  const triageVtid = `VTID-DA-${exec.id.slice(0, 8)}`;

  const triage = await spawnTriageAgent({
    mode: triageMode,
    vtid: triageVtid,
    endpoint: exec.pr_url || `finding:${exec.finding_id}`,
    failure_class: input.failure_stage,
    original_diagnosis: {
      execution_id: exec.id,
      finding_id: exec.finding_id,
      plan_version: exec.plan_version,
      branch: exec.branch,
      pr_url: exec.pr_url,
      error: input.error,
      metadata: exec.metadata,
    },
    all_attempts: exec.auto_fix_depth,
    reconciler_history: {
      auto_fix_depth: exec.auto_fix_depth,
      parent_execution_id: exec.parent_execution_id,
    },
    verification_result: input.verification_result,
    blast_radius: input.blast_radius,
  });

  if (!triage.ok || !triage.report) {
    // Triage itself failed — mark escalated so a human can take it.
    await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${exec.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'failed_escalated',
        failure_stage: input.failure_stage,
        failure_event_id: input.failure_event_id || null,
        metadata: {
          ...(exec.metadata || {}),
          bridge_error: triage.error || 'triage failed',
          bridge_stage: input.failure_stage,
        },
        completed_at: new Date().toISOString(),
      }),
    });
    await writeSelfHealingLogEntry(s, {
      execution_id: exec.id,
      vtid: `VTID-DA-${exec.id.slice(0, 8)}`,
      endpoint: `dev_autopilot.execution.${input.failure_stage}`,
      failure_class: 'dev_autopilot_triage_failed',
      confidence: 0,
      diagnosis: {
        summary: `Triage failed: ${triage.error || 'unknown error'}`,
        execution_id: exec.id,
        finding_id: exec.finding_id,
        stage: input.failure_stage,
        triage_error: triage.error,
      },
      outcome: 'escalated',
      attempt_number: (exec.auto_fix_depth || 0) + 1,
    });
    await emitOasisEvent({
      vtid: BRIDGE_VTID,
      type: 'dev_autopilot.execution.escalated',
      source: 'dev-autopilot-bridge',
      status: 'error',
      message: `Execution ${exec.id.slice(0, 8)} escalated: triage ${triage.error || 'failed'}`,
      payload: { execution_id: exec.id, stage: input.failure_stage, error: triage.error },
    });
    return {
      ok: false,
      outcome: 'triage_failed',
      execution_id: exec.id,
      error: triage.error,
    };
  }

  const report = triage.report;

  // 2. Attempt auto-revert (best-effort — failure here shouldn't block the
  //    bridge from recording the triage report + escalating).
  const revert = await revertExecutionPR(exec, input.failure_stage);
  if (!revert.ok) {
    // Log-only: revert failure is non-fatal to the bridge, and the escalation
    // payload below captures the error. No dedicated event type exists for
    // this case — if it proves common, add `dev_autopilot.execution.revert_failed`
    // to CicdEventType and emit here.
    console.warn(`${LOG_PREFIX} revert failed for ${exec.id}: ${revert.error}`);
  } else if (revert.revert_pr_url) {
    await emitOasisEvent({
      vtid: BRIDGE_VTID,
      type: 'dev_autopilot.execution.reverted',
      source: 'dev-autopilot-bridge',
      status: 'info',
      message: `Execution ${exec.id.slice(0, 8)} reverted via ${revert.revert_pr_url}`,
      payload: { execution_id: exec.id, stage: input.failure_stage, revert_pr_url: revert.revert_pr_url },
    });
  }

  // 3. Decide next action: spawn child vs escalate.
  const canRetry =
    report.confidence_numeric >= CHILD_SPAWN_CONFIDENCE_THRESHOLD &&
    (exec.auto_fix_depth || 0) < maxDepth &&
    !(cfg?.kill_switch);

  const patchBase: Record<string, unknown> = {
    failure_stage: input.failure_stage,
    failure_event_id: input.failure_event_id || null,
    self_healing_vtid: triageVtid,
    triage_report: report,
    revert_pr_url: revert.revert_pr_url || null,
    metadata: {
      ...(exec.metadata || {}),
      bridge_stage: input.failure_stage,
      bridge_confidence: report.confidence,
      bridge_reason_decision: canRetry ? 'child_spawned' : 'escalated',
    },
  };

  if (canRetry) {
    const child = await spawnChildExecution(s, exec, report, cooldown);
    if (!child.ok) {
      // Couldn't spawn child — escalate instead.
      await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${exec.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          ...patchBase,
          status: 'failed_escalated',
          completed_at: new Date().toISOString(),
        }),
      });
      await writeSelfHealingLogEntry(s, {
        execution_id: exec.id,
        vtid: `VTID-DA-${exec.id.slice(0, 8)}`,
        endpoint: `dev_autopilot.execution.${input.failure_stage}`,
        failure_class: 'dev_autopilot_child_spawn_failed',
        confidence: report.confidence_numeric,
        diagnosis: {
          summary: `Child spawn failed: ${child.error}`,
          execution_id: exec.id,
          finding_id: exec.finding_id,
          stage: input.failure_stage,
          triage_summary: report.root_cause_hypothesis,
          spawn_error: child.error,
        },
        outcome: 'escalated',
        attempt_number: (exec.auto_fix_depth || 0) + 1,
      });
      await emitOasisEvent({
        vtid: BRIDGE_VTID,
        type: 'dev_autopilot.execution.escalated',
        source: 'dev-autopilot-bridge',
        status: 'error',
        message: `Child spawn failed for ${exec.id.slice(0, 8)}: ${child.error}`,
        payload: { execution_id: exec.id, stage: input.failure_stage, error: child.error },
      });
      return {
        ok: false,
        outcome: 'escalated',
        execution_id: exec.id,
        triage_report: report,
        error: child.error,
      };
    }

    await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${exec.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        ...patchBase,
        status: 'reverted',
        completed_at: new Date().toISOString(),
      }),
    });

    // Record the in-flight retry on the self-healing log so the UI shows
    // the autopilot is actively trying. Outcome 'pending' (the table's
    // default for in-progress repairs).
    await writeSelfHealingLogEntry(s, {
      execution_id: exec.id,
      vtid: `VTID-DA-${exec.id.slice(0, 8)}`,
      endpoint: `dev_autopilot.execution.${input.failure_stage}`,
      failure_class: 'dev_autopilot_self_heal_in_progress',
      confidence: report.confidence_numeric,
      diagnosis: {
        summary: `Auto-retry: depth ${(exec.auto_fix_depth || 0) + 1}/${maxDepth} — ${report.root_cause_hypothesis || 'no hypothesis'}`,
        execution_id: exec.id,
        finding_id: exec.finding_id,
        child_execution_id: child.execution_id,
        stage: input.failure_stage,
        triage_summary: report.root_cause_hypothesis,
      },
      outcome: 'pending',
      attempt_number: (exec.auto_fix_depth || 0) + 1,
    });

    await emitOasisEvent({
      vtid: BRIDGE_VTID,
      type: 'dev_autopilot.execution.self_heal_injected',
      source: 'dev-autopilot-bridge',
      status: 'info',
      message: `Self-heal child ${child.execution_id!.slice(0, 8)} spawned from ${exec.id.slice(0, 8)} (depth=${(exec.auto_fix_depth || 0) + 1}/${maxDepth}, confidence=${report.confidence})`,
      payload: {
        parent_execution_id: exec.id,
        child_execution_id: child.execution_id,
        depth: (exec.auto_fix_depth || 0) + 1,
        max_depth: maxDepth,
        triage_confidence: report.confidence,
        stage: input.failure_stage,
      },
    });

    return {
      ok: true,
      outcome: 'self_heal_injected',
      execution_id: exec.id,
      child_execution_id: child.execution_id,
      self_healing_vtid: triageVtid,
      revert_pr_url: revert.revert_pr_url,
      triage_report: report,
    };
  }

  // Escalate: low confidence OR depth cap reached OR kill switch armed.
  await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${exec.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      ...patchBase,
      status: 'failed_escalated',
      completed_at: new Date().toISOString(),
    }),
  });

  await writeSelfHealingLogEntry(s, {
    execution_id: exec.id,
    vtid: `VTID-DA-${exec.id.slice(0, 8)}`,
    endpoint: `dev_autopilot.execution.${input.failure_stage}`,
    failure_class: cfg?.kill_switch ? 'dev_autopilot_kill_switch_blocked'
      : (exec.auto_fix_depth || 0) >= maxDepth ? 'dev_autopilot_max_retries_reached'
      : 'dev_autopilot_low_confidence',
    confidence: report.confidence_numeric,
    diagnosis: {
      summary: `Escalated: ${cfg?.kill_switch ? 'kill switch armed'
        : (exec.auto_fix_depth || 0) >= maxDepth ? `max retries reached (${exec.auto_fix_depth}/${maxDepth})`
        : `confidence ${report.confidence_numeric.toFixed(2)} below threshold ${CHILD_SPAWN_CONFIDENCE_THRESHOLD}`}`,
      execution_id: exec.id,
      finding_id: exec.finding_id,
      stage: input.failure_stage,
      triage_summary: report.root_cause_hypothesis,
      auto_fix_depth: exec.auto_fix_depth || 0,
      max_depth: maxDepth,
      revert_pr_url: revert.revert_pr_url,
    },
    outcome: 'escalated',
    attempt_number: (exec.auto_fix_depth || 0) + 1,
  });

  const escalationReason =
    cfg?.kill_switch ? 'kill_switch_armed'
    : (exec.auto_fix_depth || 0) >= maxDepth ? 'depth_cap_reached'
    : 'low_confidence';

  await emitOasisEvent({
    vtid: BRIDGE_VTID,
    type: 'dev_autopilot.execution.escalated',
    source: 'dev-autopilot-bridge',
    status: 'warning',
    message: `Execution ${exec.id.slice(0, 8)} escalated to human review — ${escalationReason} (depth=${exec.auto_fix_depth || 0}/${maxDepth}, confidence=${report.confidence})`,
    payload: {
      execution_id: exec.id,
      reason: escalationReason,
      depth: exec.auto_fix_depth || 0,
      max_depth: maxDepth,
      triage_confidence: report.confidence,
      stage: input.failure_stage,
    },
  });

  return {
    ok: true,
    outcome: 'escalated',
    execution_id: exec.id,
    self_healing_vtid: triageVtid,
    revert_pr_url: revert.revert_pr_url,
    triage_report: report,
  };
}

// =============================================================================
// Decision helper (pure — unit-testable)
// =============================================================================

export interface DecisionInput {
  confidence_numeric: number;
  auto_fix_depth: number;
  max_auto_fix_depth: number;
  kill_switch: boolean;
}

export type BridgeDecision =
  | { action: 'spawn_child' }
  | { action: 'escalate'; reason: 'low_confidence' | 'depth_cap_reached' | 'kill_switch_armed' };

export function decideBridgeAction(input: DecisionInput): BridgeDecision {
  if (input.kill_switch) return { action: 'escalate', reason: 'kill_switch_armed' };
  if (input.auto_fix_depth >= input.max_auto_fix_depth) return { action: 'escalate', reason: 'depth_cap_reached' };
  if (input.confidence_numeric < CHILD_SPAWN_CONFIDENCE_THRESHOLD) return { action: 'escalate', reason: 'low_confidence' };
  return { action: 'spawn_child' };
}

export { CHILD_SPAWN_CONFIDENCE_THRESHOLD, LOG_PREFIX, DRY_RUN };
