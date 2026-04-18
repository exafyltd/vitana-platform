/**
 * Developer Autopilot — CI / deploy / verification watchers (PR-9)
 *
 * Drives executions through the second half of the lifecycle:
 *
 *   ci        → merging   when GitHub PR checks all pass
 *   merging   → deploying after the auto-merge call returns 200
 *   deploying → verifying when an OASIS deploy.gateway.success event lands
 *               for this execution's PR / branch / VTID
 *   verifying → completed after the verification window elapses with no
 *               new error events
 *
 * Each failure path routes through bridgeFailureToSelfHealing (PR-7) which
 * spawns a self-healing triage agent and either schedules a child execution
 * or escalates for human review.
 *
 * Three independent setIntervals — each tick is idempotent and safely
 * skipped when the kill switch is armed. DRY_RUN mode (default) synthesizes
 * success outcomes after short delays so the full pipeline is exercisable
 * end-to-end without touching GitHub or Cloud Run.
 */

import githubService from './github-service';
import { emitOasisEvent } from './oasis-event-service';
import { bridgeFailureToSelfHealing, FailureStage } from './dev-autopilot-bridge';

const LOG_PREFIX = '[dev-autopilot-watcher]';
const WATCHER_VTID = 'VTID-DEV-AUTOPILOT';

const DRY_RUN = (process.env.DEV_AUTOPILOT_DRY_RUN || 'true').toLowerCase() === 'true';
const GITHUB_REPO =
  process.env.DEV_AUTOPILOT_GITHUB_REPO || 'exafyltd/vitana-platform';

const CI_TICK_MS = 60_000;          // 1 min — checks API rate limit budget
const DEPLOY_TICK_MS = 60_000;      // 1 min
const VERIFY_TICK_MS = 60_000;      // 1 min
const VERIFICATION_WINDOW_MS = 30 * 60_000; // 30 minutes
const DRY_RUN_SETTLE_MS = 90_000;   // dry-run: synthesize outcomes after 90s

// =============================================================================
// Supabase
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
    return { ok: true, status: res.status, data: (await res.json()) as T };
  } catch (err) {
    return { ok: false, status: 500, error: String(err) };
  }
}

interface ConfigRow { kill_switch: boolean; }
async function killSwitchArmed(s: SupaConfig): Promise<boolean> {
  const r = await supa<ConfigRow[]>(s, `/rest/v1/dev_autopilot_config?id=eq.1&limit=1`);
  return !!(r.ok && r.data && r.data[0] && r.data[0].kill_switch);
}

interface ExecutionRow {
  id: string;
  finding_id: string;
  status: string;
  branch?: string | null;
  pr_url?: string | null;
  pr_number?: number | null;
  updated_at?: string;
  metadata?: Record<string, unknown> | null;
}

async function loadExecutions(s: SupaConfig, status: string): Promise<ExecutionRow[]> {
  const r = await supa<ExecutionRow[]>(
    s,
    `/rest/v1/dev_autopilot_executions?status=eq.${status}&select=id,finding_id,status,branch,pr_url,pr_number,updated_at,metadata&limit=50`,
  );
  return r.ok && r.data ? r.data : [];
}

// =============================================================================
// Pure analyzers (unit-testable)
// =============================================================================

export type CiStateName = 'passing' | 'failing' | 'pending';
export interface CiAnalysis {
  state: CiStateName;
  failedNames: string[];
}

export function analyzeCiStatus(
  checks: Array<{ name: string; status: string; conclusion?: string }>,
): CiAnalysis {
  if (checks.length === 0) return { state: 'pending', failedNames: [] };
  const failed: string[] = [];
  let pending = false;
  for (const c of checks) {
    if (c.status === 'failure' || c.conclusion === 'failure' || c.conclusion === 'cancelled' || c.conclusion === 'timed_out') {
      failed.push(c.name);
    } else if (c.status === 'pending' || c.status === 'in_progress' || c.status === 'queued' || (!c.conclusion && c.status !== 'success' && c.status !== 'neutral' && c.status !== 'skipped')) {
      pending = true;
    }
  }
  if (failed.length > 0) return { state: 'failing', failedNames: failed };
  if (pending) return { state: 'pending', failedNames: [] };
  return { state: 'passing', failedNames: [] };
}

export type DeployOutcome = 'success' | 'failed' | 'pending';

export function findDeployOutcomeForExecution(
  events: Array<{ type: string; payload?: Record<string, unknown>; created_at?: string; status?: string }>,
  exec: { pr_url?: string | null; pr_number?: number | null; branch?: string | null; updated_at?: string },
): DeployOutcome {
  // We match on whatever signal we have — pr_url (most specific), pr_number,
  // branch name, or fall back to time-window if none of the above match.
  const since = exec.updated_at ? new Date(exec.updated_at).getTime() : 0;
  const matches = events.filter((e) => {
    const created = e.created_at ? new Date(e.created_at).getTime() : 0;
    if (created < since) return false;
    const p = e.payload || {};
    if (exec.pr_url && p.pr_url === exec.pr_url) return true;
    if (exec.pr_number && (p.pr_number === exec.pr_number || p.pr === exec.pr_number)) return true;
    if (exec.branch && (p.branch === exec.branch || p.head_branch === exec.branch)) return true;
    return false;
  });
  if (matches.length === 0) return 'pending';
  // Fail beats success — if any failure event matches, treat as failed.
  if (matches.some((e) => e.type === 'deploy.gateway.failed' || e.status === 'error')) return 'failed';
  if (matches.some((e) => e.type === 'deploy.gateway.success')) return 'success';
  return 'pending';
}

export interface VerificationAnalysis {
  state: 'pass' | 'fail' | 'pending';
  blastRadiusEvents: Array<{ type: string; vtid?: string }>;
  reason?: string;
}

export function analyzeVerificationWindow(
  events: Array<{ type: string; vtid?: string; status?: string; created_at?: string }>,
  windowStartIso: string,
  windowMs: number,
  ourVtidPrefix: string,
): VerificationAnalysis {
  const start = new Date(windowStartIso).getTime();
  const elapsed = Date.now() - start;
  // New error events emitted DURING the window that are NOT for our own
  // execution VTID lineage count as blast-radius signal.
  const blastRadius = events.filter((e) => {
    const at = e.created_at ? new Date(e.created_at).getTime() : 0;
    if (at < start) return false;
    if (e.status !== 'error') return false;
    if (!e.vtid || e.vtid.startsWith(ourVtidPrefix)) return false;
    return true;
  });
  if (blastRadius.length > 0) {
    return {
      state: 'fail',
      blastRadiusEvents: blastRadius.map((e) => ({ type: e.type, vtid: e.vtid })),
      reason: `${blastRadius.length} unrelated error events during verification window`,
    };
  }
  if (elapsed >= windowMs) {
    return { state: 'pass', blastRadiusEvents: [] };
  }
  return { state: 'pending', blastRadiusEvents: [] };
}

// =============================================================================
// Status helpers
// =============================================================================

async function transitionStatus(
  s: SupaConfig,
  execId: string,
  fromStatus: string,
  toStatus: string,
  extras: Record<string, unknown> = {},
): Promise<boolean> {
  // Conditional update via WHERE — if another tick already moved the row,
  // this PATCH affects 0 rows and we treat it as a no-op.
  const r = await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${execId}&status=eq.${fromStatus}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: toStatus, updated_at: new Date().toISOString(), ...extras }),
  });
  return r.ok;
}

async function bridgeFailure(execId: string, stage: FailureStage, error?: string, extras: Record<string, unknown> = {}): Promise<void> {
  try {
    await bridgeFailureToSelfHealing({ execution_id: execId, failure_stage: stage, error, ...extras });
  } catch (err) {
    console.error(`${LOG_PREFIX} bridge call failed for ${execId} (${stage}):`, err);
  }
}

// =============================================================================
// CI watcher: ci → merging → deploying
// =============================================================================

export async function ciWatcherTick(): Promise<void> {
  const s = getSupabase();
  if (!s) return;
  if (await killSwitchArmed(s)) return;

  const execs = await loadExecutions(s, 'ci');
  for (const exec of execs) {
    if (!exec.pr_url) {
      console.warn(`${LOG_PREFIX} execution ${exec.id} in ci with no pr_url — bridging`);
      await transitionStatus(s, exec.id, 'ci', 'failed', { metadata: { ...(exec.metadata || {}), ci_error: 'pr_url missing' } });
      await bridgeFailure(exec.id, 'ci', 'pr_url missing on ci-stage execution');
      continue;
    }

    if (DRY_RUN || (exec.pr_url && exec.pr_url.indexOf('DRY-RUN-') >= 0)) {
      // Dry-run: settle to "passing" after DRY_RUN_SETTLE_MS elapsed since
      // the row entered ci. Synthetic merge → deploying transition.
      const since = exec.updated_at ? Date.now() - new Date(exec.updated_at).getTime() : Infinity;
      if (since < DRY_RUN_SETTLE_MS) continue;
      console.log(`${LOG_PREFIX} DRY RUN: synthesizing CI pass → merge → deploy for ${exec.id}`);
      await transitionStatus(s, exec.id, 'ci', 'merging');
      await emitOasisEvent({
        vtid: WATCHER_VTID,
        type: 'dev_autopilot.execution.ci_passed',
        source: 'dev-autopilot-watcher',
        status: 'success',
        message: `Execution ${exec.id.slice(0, 8)} CI passed (dry-run synthetic)`,
        payload: { execution_id: exec.id, pr_url: exec.pr_url },
      });
      // Skip merge call entirely in dry-run; jump straight to deploying
      await transitionStatus(s, exec.id, 'merging', 'deploying');
      await emitOasisEvent({
        vtid: WATCHER_VTID,
        type: 'dev_autopilot.execution.pr_merged',
        source: 'dev-autopilot-watcher',
        status: 'success',
        message: `Execution ${exec.id.slice(0, 8)} merged (dry-run synthetic)`,
        payload: { execution_id: exec.id, pr_url: exec.pr_url },
      });
      continue;
    }

    if (!exec.pr_number) {
      await transitionStatus(s, exec.id, 'ci', 'failed', { metadata: { ...(exec.metadata || {}), ci_error: 'pr_number missing' } });
      await bridgeFailure(exec.id, 'ci', 'pr_number missing — cannot poll checks');
      continue;
    }

    // Live: query GitHub
    let prStatus;
    try {
      prStatus = await githubService.getPrStatus(GITHUB_REPO, exec.pr_number);
    } catch (err) {
      console.warn(`${LOG_PREFIX} getPrStatus failed for #${exec.pr_number}:`, err);
      continue; // transient — retry next tick
    }

    const analysis = analyzeCiStatus(prStatus.checks || []);
    if (analysis.state === 'pending') continue;

    if (analysis.state === 'failing') {
      await transitionStatus(s, exec.id, 'ci', 'failed', {
        metadata: { ...(exec.metadata || {}), failed_checks: analysis.failedNames },
      });
      await emitOasisEvent({
        vtid: WATCHER_VTID,
        type: 'dev_autopilot.execution.ci_failed',
        source: 'dev-autopilot-watcher',
        status: 'error',
        message: `Execution ${exec.id.slice(0, 8)} CI failed: ${analysis.failedNames.join(', ')}`,
        payload: { execution_id: exec.id, pr_url: exec.pr_url, failed_checks: analysis.failedNames },
      });
      await bridgeFailure(exec.id, 'ci', `failing checks: ${analysis.failedNames.join(', ')}`);
      continue;
    }

    // Passing → merge
    await transitionStatus(s, exec.id, 'ci', 'merging');
    await emitOasisEvent({
      vtid: WATCHER_VTID,
      type: 'dev_autopilot.execution.ci_passed',
      source: 'dev-autopilot-watcher',
      status: 'success',
      message: `Execution ${exec.id.slice(0, 8)} CI passed`,
      payload: { execution_id: exec.id, pr_url: exec.pr_url, checks: prStatus.checks.length },
    });

    try {
      const mergeRes = await githubService.mergePullRequest(
        GITHUB_REPO,
        exec.pr_number,
        `Dev Autopilot auto-merge: execution ${exec.id.slice(0, 8)}`,
        'squash',
      );
      if (mergeRes.merged) {
        await transitionStatus(s, exec.id, 'merging', 'deploying');
        await emitOasisEvent({
          vtid: WATCHER_VTID,
          type: 'dev_autopilot.execution.pr_merged',
          source: 'dev-autopilot-watcher',
          status: 'success',
          message: `Execution ${exec.id.slice(0, 8)} merged ${mergeRes.sha.slice(0, 7)}`,
          payload: { execution_id: exec.id, pr_url: exec.pr_url, sha: mergeRes.sha },
        });
      } else {
        await transitionStatus(s, exec.id, 'merging', 'failed', {
          metadata: { ...(exec.metadata || {}), merge_error: mergeRes.message },
        });
        await bridgeFailure(exec.id, 'ci', `merge declined: ${mergeRes.message}`);
      }
    } catch (err) {
      await transitionStatus(s, exec.id, 'merging', 'failed', {
        metadata: { ...(exec.metadata || {}), merge_error: String(err) },
      });
      await bridgeFailure(exec.id, 'ci', `merge call threw: ${String(err)}`);
    }
  }
}

// =============================================================================
// Deploy watcher: deploying → verifying
// =============================================================================

async function loadRecentDeployEvents(s: SupaConfig): Promise<Array<{ type: string; payload?: Record<string, unknown>; created_at?: string; status?: string }>> {
  // Last 60 minutes of deploy events — narrow window keeps scans cheap.
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const r = await supa<Array<{ topic: string; metadata?: Record<string, unknown>; created_at?: string; status?: string }>>(
    s,
    `/rest/v1/oasis_events?topic=in.(deploy.gateway.success,deploy.gateway.failed,cicd.deploy.service.succeeded,cicd.deploy.service.failed)&created_at=gte.${encodeURIComponent(since)}&select=topic,metadata,created_at,status&order=created_at.desc&limit=200`,
  );
  if (!r.ok || !r.data) return [];
  return r.data.map((row) => ({
    type: row.topic,
    payload: row.metadata,
    created_at: row.created_at,
    status: row.status,
  }));
}

export async function deployWatcherTick(): Promise<void> {
  const s = getSupabase();
  if (!s) return;
  if (await killSwitchArmed(s)) return;

  const execs = await loadExecutions(s, 'deploying');
  if (execs.length === 0) return;

  const events = await loadRecentDeployEvents(s);

  for (const exec of execs) {
    if (DRY_RUN || (exec.pr_url && exec.pr_url.indexOf('DRY-RUN-') >= 0)) {
      const since = exec.updated_at ? Date.now() - new Date(exec.updated_at).getTime() : Infinity;
      if (since < DRY_RUN_SETTLE_MS) continue;
      await transitionStatus(s, exec.id, 'deploying', 'verifying');
      await emitOasisEvent({
        vtid: WATCHER_VTID,
        type: 'dev_autopilot.execution.deployed',
        source: 'dev-autopilot-watcher',
        status: 'success',
        message: `Execution ${exec.id.slice(0, 8)} deployed (dry-run synthetic)`,
        payload: { execution_id: exec.id, pr_url: exec.pr_url },
      });
      continue;
    }

    const outcome = findDeployOutcomeForExecution(events, exec);
    if (outcome === 'pending') continue;
    if (outcome === 'failed') {
      await transitionStatus(s, exec.id, 'deploying', 'failed', {
        metadata: { ...(exec.metadata || {}), deploy_error: 'deploy.gateway.failed received' },
      });
      await emitOasisEvent({
        vtid: WATCHER_VTID,
        type: 'dev_autopilot.execution.deploy_failed',
        source: 'dev-autopilot-watcher',
        status: 'error',
        message: `Execution ${exec.id.slice(0, 8)} deploy failed`,
        payload: { execution_id: exec.id, pr_url: exec.pr_url },
      });
      await bridgeFailure(exec.id, 'deploy', 'deploy.gateway.failed event received');
      continue;
    }
    // success
    await transitionStatus(s, exec.id, 'deploying', 'verifying');
    await emitOasisEvent({
      vtid: WATCHER_VTID,
      type: 'dev_autopilot.execution.deployed',
      source: 'dev-autopilot-watcher',
      status: 'success',
      message: `Execution ${exec.id.slice(0, 8)} deployed — entering verification window`,
      payload: { execution_id: exec.id, pr_url: exec.pr_url },
    });
  }
}

// =============================================================================
// Verification watcher: verifying → completed (or → failed via bridge)
// =============================================================================

async function loadRecentEventsForVerification(
  s: SupaConfig,
  windowStartIso: string,
): Promise<Array<{ type: string; vtid?: string; status?: string; created_at?: string }>> {
  const r = await supa<Array<{ topic: string; vtid?: string; status?: string; created_at?: string }>>(
    s,
    `/rest/v1/oasis_events?status=eq.error&created_at=gte.${encodeURIComponent(windowStartIso)}&select=topic,vtid,status,created_at&order=created_at.desc&limit=500`,
  );
  if (!r.ok || !r.data) return [];
  return r.data.map((row) => ({
    type: row.topic,
    vtid: row.vtid,
    status: row.status,
    created_at: row.created_at,
  }));
}

export async function verificationWatcherTick(): Promise<void> {
  const s = getSupabase();
  if (!s) return;
  if (await killSwitchArmed(s)) return;

  const execs = await loadExecutions(s, 'verifying');
  for (const exec of execs) {
    const windowStart = exec.updated_at || new Date().toISOString();
    if (DRY_RUN || (exec.pr_url && exec.pr_url.indexOf('DRY-RUN-') >= 0)) {
      const elapsed = Date.now() - new Date(windowStart).getTime();
      if (elapsed < DRY_RUN_SETTLE_MS) continue;
      await transitionStatus(s, exec.id, 'verifying', 'completed', {
        completed_at: new Date().toISOString(),
      });
      await emitOasisEvent({
        vtid: WATCHER_VTID,
        type: 'dev_autopilot.execution.completed',
        source: 'dev-autopilot-watcher',
        status: 'success',
        message: `Execution ${exec.id.slice(0, 8)} completed (dry-run synthetic)`,
        payload: { execution_id: exec.id, pr_url: exec.pr_url },
      });
      continue;
    }

    const events = await loadRecentEventsForVerification(s, windowStart);
    const ourVtidPrefix = `VTID-DA-${exec.id.slice(0, 8)}`;
    const verdict = analyzeVerificationWindow(events, windowStart, VERIFICATION_WINDOW_MS, ourVtidPrefix);

    if (verdict.state === 'pending') continue;

    if (verdict.state === 'fail') {
      await transitionStatus(s, exec.id, 'verifying', 'failed', {
        metadata: { ...(exec.metadata || {}), verification_blast_radius: verdict.blastRadiusEvents },
      });
      await emitOasisEvent({
        vtid: WATCHER_VTID,
        type: 'dev_autopilot.execution.verification_failed',
        source: 'dev-autopilot-watcher',
        status: 'error',
        message: `Execution ${exec.id.slice(0, 8)} verification failed: ${verdict.reason}`,
        payload: { execution_id: exec.id, pr_url: exec.pr_url, blast_radius: verdict.blastRadiusEvents },
      });
      await bridgeFailure(exec.id, 'verification', verdict.reason || 'verification window saw error events', {
        blast_radius: verdict.blastRadiusEvents,
        verification_result: { state: 'fail', reason: verdict.reason },
      });
      continue;
    }

    // pass
    await transitionStatus(s, exec.id, 'verifying', 'completed', {
      completed_at: new Date().toISOString(),
    });
    await emitOasisEvent({
      vtid: WATCHER_VTID,
      type: 'dev_autopilot.execution.completed',
      source: 'dev-autopilot-watcher',
      status: 'success',
      message: `Execution ${exec.id.slice(0, 8)} completed — verification window clean`,
      payload: { execution_id: exec.id, pr_url: exec.pr_url },
    });

    // If this was a self-heal child, also mark the parent self_healed.
    const parentId = (exec.metadata && (exec.metadata as Record<string, unknown>).parent_execution_id) as string | undefined;
    if (parentId) {
      await transitionStatus(s, parentId, 'reverted', 'self_healed', {
        completed_at: new Date().toISOString(),
      });
    }
  }
}

// =============================================================================
// Lifecycle
// =============================================================================

let watchersStarted = false;
const intervals: NodeJS.Timeout[] = [];

export function startWatchers(): void {
  if (watchersStarted) return;
  watchersStarted = true;
  console.log(`${LOG_PREFIX} starting watchers (ci=${CI_TICK_MS}ms, deploy=${DEPLOY_TICK_MS}ms, verify=${VERIFY_TICK_MS}ms, dry_run=${DRY_RUN})`);
  intervals.push(setInterval(() => { ciWatcherTick().catch((e) => console.error(`${LOG_PREFIX} ci tick:`, e)); }, CI_TICK_MS));
  intervals.push(setInterval(() => { deployWatcherTick().catch((e) => console.error(`${LOG_PREFIX} deploy tick:`, e)); }, DEPLOY_TICK_MS));
  intervals.push(setInterval(() => { verificationWatcherTick().catch((e) => console.error(`${LOG_PREFIX} verify tick:`, e)); }, VERIFY_TICK_MS));
}

export function stopWatchers(): void {
  while (intervals.length) {
    const t = intervals.pop();
    if (t) clearInterval(t);
  }
  watchersStarted = false;
}

export {
  CI_TICK_MS,
  DEPLOY_TICK_MS,
  VERIFY_TICK_MS,
  VERIFICATION_WINDOW_MS,
  DRY_RUN,
  DRY_RUN_SETTLE_MS,
};
