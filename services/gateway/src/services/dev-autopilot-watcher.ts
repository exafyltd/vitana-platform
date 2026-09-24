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
import { probeEndpoint, isJsonHealthy, resolveProbeTarget } from './self-healing-probe';
import { applyExecTerminalSideEffects, terminalizeVtidLedgerForExecution } from './dev-autopilot-execute';
import { filterOwnedExecutions } from './dev-autopilot-env-ownership';
import { collectCiFailureEvidence, renderCiEvidence } from './dev-autopilot-ci-logs';
import { isLlmMergeReviewEnabled, runLlmMergeReview } from './dev-autopilot-llm-review';
import { deployTopicsInFilter, normalizeDeployEvent } from './dev-autopilot-deploy-topics';
import { currentEnv } from './dev-autopilot-env-ownership';

const LOG_PREFIX = '[dev-autopilot-watcher]';
const WATCHER_VTID = 'VTID-DEV-AUTOPILOT';

// Historical: this module defaulted to DRY_RUN=true so an unconfigured
// gateway would synthesise CI pass / merge / deploy outcomes instead of
// touching GitHub. That was safe for initial rollout but left every real
// PR sitting OPEN forever — the autopilot opened it, CI went green, and
// nothing merged it.
//
// DEV_AUTOPILOT_WATCHER_LIVE=true forces the watcher into live mode
// (query GitHub, auto-merge green PRs, follow deploy events). Takes
// precedence over DEV_AUTOPILOT_DRY_RUN. Default stays OFF so deploys
// from older EXEC-DEPLOY configs keep the dry-run behaviour until
// explicitly opted in.
const DRY_RUN = (() => {
  if ((process.env.DEV_AUTOPILOT_WATCHER_LIVE || '').toLowerCase() === 'true') return false;
  return (process.env.DEV_AUTOPILOT_DRY_RUN || 'true').toLowerCase() === 'true';
})();
const GITHUB_REPO =
  process.env.DEV_AUTOPILOT_GITHUB_REPO || 'exafyltd/vitana-platform';
// VTID-04005: split form for the Actions job-log reader (owner/repo API paths).
const [GITHUB_OWNER, GITHUB_REPO_NAME] = (GITHUB_REPO.includes('/') ? GITHUB_REPO : `exafyltd/${GITHUB_REPO}`).split('/', 2);
// Risk classes we'll auto-merge. High risk should go through human review
// regardless of CI state; the safety gate on approve already rejects them,
// but this is defense-in-depth in case something reaches 'ci' status via
// an API path that bypassed the gate.
const AUTO_MERGE_ALLOWED_RISK = new Set(['low', 'medium']);

const CI_TICK_MS = 60_000;          // 1 min — checks API rate limit budget
const DEPLOY_TICK_MS = 60_000;      // 1 min
const VERIFY_TICK_MS = 60_000;      // 1 min
// VTID-02701: shortened from 30m → 5m. The original window was a defense-
// in-depth backstop watching for production error spikes after deploy.
// In practice that's already covered upstream by Cloud Run's Post-Deploy
// Smoke Tests (5 health checks) and Playwright Visual Verification (UI
// sanity), both of which fail the deploy before we ever reach
// `verifying`. Once those pass, the marginal value of waiting another
// 30m before declaring a ticket resolved is low — and the cost is high:
// every autopilot ticket stays `in_progress` for half an hour after the
// fix is already live in prod, which is a poor signal to supervisors
// and slows the autonomous loop. 5m still catches anything that spikes
// instantly post-deploy, with VTID-02699's blast-radius filter
// preventing internal autopilot noise from false-failing the window.
const VERIFICATION_WINDOW_MS = 5 * 60_000; // 5 minutes
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

/** Load the finding's risk_class so the CI watcher can refuse to auto-merge
 * anything that looks high-risk, even if it somehow passed the approve gate. */
async function loadFindingRiskClass(s: SupaConfig, findingId: string): Promise<'low' | 'medium' | 'high' | 'unknown'> {
  const r = await supa<Array<{ risk_class: 'low' | 'medium' | 'high' | null }>>(
    s,
    `/rest/v1/autopilot_recommendations?id=eq.${findingId}&select=risk_class&limit=1`,
  );
  if (!r.ok || !r.data || !r.data[0]) return 'unknown';
  return (r.data[0].risk_class || 'unknown') as 'low' | 'medium' | 'high' | 'unknown';
}

/** Returns true when the watcher is safe to auto-merge this PR. */
export function shouldAutoMerge(
  riskClass: 'low' | 'medium' | 'high' | 'unknown',
): { ok: boolean; reason?: string } {
  if (riskClass === 'unknown') return { ok: false, reason: 'risk_class unknown — refusing auto-merge' };
  if (!AUTO_MERGE_ALLOWED_RISK.has(riskClass)) {
    return { ok: false, reason: `risk_class=${riskClass} exceeds auto-merge allowlist` };
  }
  return { ok: true };
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
  // VTID-04005: only rows this environment claimed (or legacy unstamped rows).
  return r.ok && r.data ? filterOwnedExecutions(r.data, LOG_PREFIX) : [];
}

/**
 * Resolve the HTTP target to re-probe for an execution's original finding.
 * Checks the finding's spec_snapshot for an endpoint-like field, in priority
 * order, and returns the first that is an actual HTTP target. Returns null when
 * the finding has no probeable endpoint (e.g. a source-file code fix) — the
 * caller then falls back to blast-radius-only verification.
 */
async function loadFindingProbeTarget(s: SupaConfig, findingId: string): Promise<string | null> {
  const r = await supa<Array<{ spec_snapshot: Record<string, unknown> | null }>>(
    s,
    `/rest/v1/autopilot_recommendations?id=eq.${findingId}&select=spec_snapshot&limit=1`,
  );
  const snap = r.ok && r.data && r.data[0] ? r.data[0].spec_snapshot : null;
  if (!snap) return null;
  for (const key of ['probe_endpoint', 'endpoint', 'file_path']) {
    const target = resolveProbeTarget(typeof snap[key] === 'string' ? (snap[key] as string) : null);
    if (target) return target;
  }
  return null;
}

/** VTID-04377: the finding's own ledger VTID (VTID-04246), excluded from blast radius. */
async function loadFindingVtid(s: SupaConfig, findingId: string): Promise<string | null> {
  if (!findingId) return null;
  const r = await supa<Array<{ activated_vtid: string | null }>>(
    s,
    `/rest/v1/autopilot_recommendations?id=eq.${findingId}&select=activated_vtid&limit=1`,
  );
  const v = r.ok && r.data && r.data[0] ? r.data[0].activated_vtid : null;
  return typeof v === 'string' && v ? v : null;
}

// =============================================================================
// Pure analyzers (unit-testable)
// =============================================================================

/** VTID-04379: max times the watcher merges main into one PR before leaving it to a human. */
export const MAX_BRANCH_UPDATES = 5;

/** VTID-04379: pure. `merge` = up to date, go on; `update` = merge main in; `give_up` = keeps falling behind. */
export function decideBranchUpdate(behindBy: number, updatesSoFar: number): 'merge' | 'update' | 'give_up' {
  if (!(behindBy > 0)) return 'merge';
  return updatesSoFar >= MAX_BRANCH_UPDATES ? 'give_up' : 'update';
}

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

/**
 * VTID-04003: Build the human-readable CI failure reason that is handed to
 * the self-healing triage agent as its ONLY evidence.
 *
 * Before this helper existed, the gate used an inline ternary whose
 * `'blocked'` branch returned the literal `'branch-protection blocked'` for
 * every blocked PR — even when `analyzeCiStatus` had produced concrete
 * `failedNames`. GitHub reports `blocked` exactly when a REQUIRED check has
 * failed (or a required review is missing), so that literal dropped the real
 * root cause (e.g. `validate-pr` failed) and the triage agent invented a
 * "branch protection is misconfigured" story. See PR #3351 / execution
 * 0643b701.
 *
 * This function is pure and deterministic so it can be unit-tested directly.
 */
export function buildCiFailureReason(mergeableState: string, failedNames: string[]): string {
  const names = failedNames && failedNames.length > 0 ? failedNames.join(', ') : '';
  if (mergeableState === 'dirty') {
    return names ? `merge conflict (dirty); failing checks: ${names}` : 'merge conflict (dirty)';
  }
  if (mergeableState === 'blocked') {
    if (names) return `blocked: required check(s) failed: ${names}`;
    return 'blocked: branch protection or a required check GitHub has not reported yet (no failing check names available)';
  }
  if (mergeableState === 'unstable') {
    return `unstable: GitHub reports non-passing checks (failing names so far: ${names || '(none reported yet — wait)'})`;
  }
  if (names) return `failing checks: ${names}`;
  return `unexpected mergeable_state=${mergeableState}`;
}

export function shouldSynthesizeDryRunOutcome(
  dryRun: boolean,
  prUrl: string | null | undefined,
): 'synthesize' | 'skip' | 'live' {
  const url = typeof prUrl === 'string' ? prUrl : '';
  if (url.indexOf('DRY-RUN-') >= 0) return 'synthesize';
  return dryRun ? 'skip' : 'live';
}

export type DeployOutcome = 'success' | 'failed' | 'pending';

export function findDeployOutcomeForExecution(
  events: Array<{ type: string; payload?: Record<string, unknown>; created_at?: string; status?: string }>,
  exec: { pr_url?: string | null; pr_number?: number | null; branch?: string | null; updated_at?: string; metadata?: Record<string, unknown> | null },
): DeployOutcome {
  // VTID-02697: Match on whatever signal we have. The `branch` check used to
  // be the primary post-merge fallback, but the EXEC-DEPLOY workflow emits
  // `deploy.gateway.success` with `metadata.branch = "main"` (because the
  // workflow runs against main after merge). The exec, however, stores its
  // FEATURE branch (e.g. `dev-autopilot/abc12345`). Result: branch never
  // matches and the deploy reconciler hits its 30m timeout, marking the
  // execution failed — even though the deploy genuinely succeeded.
  //
  // Fix: when the CI watcher auto-merges the PR, it now stamps the merge
  // commit SHA on `exec.metadata.merge_sha`. Match by that against the
  // event's `metadata.git_commit` for a definitive post-merge link.
  const mergeSha = (exec.metadata as { merge_sha?: string } | null | undefined)?.merge_sha;
  const since = exec.updated_at ? new Date(exec.updated_at).getTime() : 0;
  const matches = events.filter((e) => {
    const created = e.created_at ? new Date(e.created_at).getTime() : 0;
    if (created < since) return false;
    const p = e.payload || {};
    if (exec.pr_url && p.pr_url === exec.pr_url) return true;
    if (exec.pr_number && (p.pr_number === exec.pr_number || p.pr === exec.pr_number)) return true;
    if (mergeSha && typeof p.git_commit === 'string' && p.git_commit === mergeSha) return true;
    if (exec.branch && (p.branch === exec.branch || p.head_branch === exec.branch)) return true;
    return false;
  });
  if (matches.length > 0) {
    // Fail beats success — if any failure event matches, treat as failed.
    if (matches.some((e) => e.type === 'deploy.gateway.failed' || e.status === 'error')) return 'failed';
    if (matches.some((e) => e.type === 'deploy.gateway.success')) return 'success';
  }

  // VTID-02700: post-merge fallback. The auto-deploy workflow collapses
  // queued commits — when 3 PRs merge in 30s, Cloud Run typically only
  // runs ONE deploy on the latest tip, and the intermediate merges
  // never get their own `deploy.gateway.success` event. If we required
  // a strict SHA match (VTID-02697), those intermediate execs would
  // sit in `deploying` until the 30m timeout and falsely fail.
  //
  // Reality: if a `deploy.gateway.success` event for `branch=main`
  // landed AFTER my exec's merge time and BEFORE my deploy timeout,
  // my merge_sha is in production (git is linear; whatever main was
  // when EXEC-DEPLOY checked out is what got deployed, and my merge
  // is an ancestor of that tip). Accept the most recent post-merge
  // success as proof of life.
  if (mergeSha) {
    const postMerge = events
      .filter((e) => {
        const created = e.created_at ? new Date(e.created_at).getTime() : 0;
        if (created < since) return false;
        const p = e.payload || {};
        return p.branch === 'main' || p.head_branch === 'main';
      });
    if (postMerge.some((e) => e.type === 'deploy.gateway.failed' || e.status === 'error')) {
      // A subsequent deploy failed — could mean my merge broke something.
      // Be conservative and treat as failed; if it's noise, the watcher
      // will surface it via the verification window's blast-radius check.
      return 'failed';
    }
    if (postMerge.some((e) => e.type === 'deploy.gateway.success')) {
      return 'success';
    }
  }

  return 'pending';
}

export interface VerificationAnalysis {
  state: 'pass' | 'fail' | 'pending';
  blastRadiusEvents: Array<{ type: string; vtid?: string }>;
  reason?: string;
}

export interface VerificationWindowOptions {
  /** The execution's own ledger VTID(s) (VTID-04246 activated_vtid); never blast radius. */
  ownVtids?: string[];
}

/**
 * VTID-04377: topics that are never production blast radius of THIS merge —
 * autopilot/self-heal/CI bookkeeping (VTID-02699), ledger lifecycle and
 * on-ramp events about other VTIDs (VTID-04043), and deploy results, which
 * the deploy watcher already judged before the row reached `verifying`.
 */
export function isVerificationNoiseTopic(type: string | undefined): boolean {
  if (typeof type !== 'string') return false;
  return (
    type.startsWith('dev_autopilot.') ||
    type.startsWith('self_healing.') ||
    type.startsWith('cicd.') ||
    type.startsWith('vtid.lifecycle.') ||
    type.startsWith('operator.execution_onramp.') ||
    type.startsWith('deploy.') ||
    type.startsWith('staging.deploy.') ||
    type.startsWith('prod.deploy.')
  );
}

export function analyzeVerificationWindow(
  events: Array<{ type: string; vtid?: string; status?: string; created_at?: string }>,
  windowStartIso: string,
  windowMs: number,
  ourVtidPrefix: string,
  opts: VerificationWindowOptions = {},
): VerificationAnalysis {
  const start = new Date(windowStartIso).getTime();
  const elapsed = Date.now() - start;
  const ownVtids = new Set((opts.ownVtids || []).filter(Boolean));
  const attributable = (e: { type: string; vtid?: string; status?: string }): boolean => {
    if (e.status !== 'error') return false;
    if (!e.vtid || e.vtid.startsWith(ourVtidPrefix) || ownVtids.has(e.vtid)) return false;
    // VTID-04377: BOOTSTRAP-* rows are sessions' own untracked work, not runtime errors.
    if (e.vtid.startsWith('BOOTSTRAP-')) return false;
    return !isVerificationNoiseTopic(e.type);
  };
  // VTID-04377: the baseline is the same-length span BEFORE the window. An
  // error type that was already firing at that rate is not this merge's doing
  // — the tenant-wide read used to fail (and revert) a correct PR for any
  // error that happened to land in its five minutes.
  const baseline = new Map<string, number>();
  for (const e of events) {
    const at = e.created_at ? new Date(e.created_at).getTime() : 0;
    if (at >= start || at < start - windowMs) continue;
    if (!attributable(e)) continue;
    baseline.set(e.type, (baseline.get(e.type) || 0) + 1);
  }
  // New error events emitted DURING the window that are NOT for our own
  // execution VTID lineage count as blast-radius signal.
  //
  // VTID-02699: Exclude `dev_autopilot.*` topics regardless of vtid.
  // Other autopilot executions' CI failures use the shared
  // `vtid: VTID-DEV-AUTOPILOT` and topic `dev_autopilot.execution.ci_failed`
  // — those represent OTHER executions failing in CI, not production
  // blast radius from THIS execution's deploy. Same for any internal
  // autopilot lifecycle errors. "Blast radius" should mean "user-facing
  // production errors after my deploy" — not noise from the autopilot
  // pipeline itself, especially during a multi-execution batch.
  // VTID-04043 (kept in isVerificationNoiseTopic): ledger lifecycle and
  // on-ramp bookkeeping about OTHER VTIDs — measured 2026-09-18, a chat cancel
  // of VTID-04040 failed + escalated VTID-04038 while its PR #3412 was green.
  const inWindow = events.filter((e) => {
    const at = e.created_at ? new Date(e.created_at).getTime() : 0;
    return at >= start && attributable(e);
  });
  const windowCounts = new Map<string, number>();
  for (const e of inWindow) windowCounts.set(e.type, (windowCounts.get(e.type) || 0) + 1);
  const blastRadius = inWindow.filter((e) => (windowCounts.get(e.type) || 0) > (baseline.get(e.type) || 0));
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

/**
 * VTID-04218: did a conditional PATCH actually move a row? PostgREST answers
 * a 0-row PATCH with 200 and `[]` when a representation is requested, so
 * "request succeeded" and "row moved" are different facts. Pure; exported
 * for tests.
 */
export function transitionMovedRow(r: { ok: boolean; data?: unknown }): boolean {
  if (!r.ok) return false;
  if (Array.isArray(r.data)) return r.data.length > 0;
  return true; // no representation returned — trust the status
}

export async function transitionStatus(
  s: SupaConfig,
  execId: string,
  fromStatus: string,
  toStatus: string,
  extras: Record<string, unknown> = {},
): Promise<boolean> {
  // Conditional update via WHERE — if another tick already moved the row,
  // this PATCH affects 0 rows. VTID-04218: ask for the representation so a
  // 0-row PATCH is reported as `false` (it used to return 204 and read as
  // success), and so a write that the database REFUSED (2026-09-21: the
  // Aurora cutover write-freeze revoked service_role writes for ~70 min
  // while the watcher kept merging PRs on GitHub with nothing recorded)
  // is visible to the caller — the live CI path now refuses to merge
  // when this returns false.
  const r = await supa<unknown[]>(s, `/rest/v1/dev_autopilot_executions?id=eq.${execId}&status=eq.${fromStatus}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: toStatus, updated_at: new Date().toISOString(), ...extras }),
  });
  const moved = transitionMovedRow(r);
  if (!moved) console.warn(`${LOG_PREFIX} transition ${execId.slice(0, 8)} ${fromStatus}→${toStatus} did not move a row${r.ok ? '' : `: ${r.error}`}`);
  // VTID-AUTOPILOT-DUPMERGE: fire shared terminal side effects on success.
  // Without this, the watcher's `verifying → completed` transition never
  // flips the recommendation `new → completed`, and autoApproveTick re-
  // approves the same finding on the next 30s tick. See
  // applyExecTerminalSideEffects() docstring for incident detail.
  // VTID-04472: every `→ failed` here is followed by bridgeFailure(), which
  // owns the ledger outcome (see bridgeFailure below).
  if (moved) applyExecTerminalSideEffects(s, execId, toStatus, { deferLedger: toStatus === 'failed' });
  return moved;
}

/**
 * VTID-04472: bridge outcomes that own the VTID ledger after a failure —
 * a self-heal child continues the VTID; every escalation path closes it
 * (closeLedgerForEscalation). Anything else (already bridged, no row, a
 * thrown call) leaves the execution `failed` with nobody to close the
 * ledger, so the watcher closes it itself.
 */
export const BRIDGE_OWNS_LEDGER: ReadonlySet<string> = new Set(['self_heal_injected', 'escalated', 'env_blocker', 'triage_failed']);

async function bridgeFailure(execId: string, stage: FailureStage, error?: string, extras: Record<string, unknown> = {}): Promise<void> {
  let outcome: string | null = null;
  try {
    const r = await bridgeFailureToSelfHealing({ execution_id: execId, failure_stage: stage, error, ...extras });
    outcome = r?.outcome ?? null;
  } catch (err) {
    console.error(`${LOG_PREFIX} bridge call failed for ${execId} (${stage}):`, err);
  }
  if (outcome && BRIDGE_OWNS_LEDGER.has(outcome)) return;
  const s = getSupabase();
  if (s) await terminalizeVtidLedgerForExecution(s, execId, 'failed');
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

    const dryRunOutcome = shouldSynthesizeDryRunOutcome(DRY_RUN, exec.pr_url);
    if (dryRunOutcome === 'skip') {
      console.log(`${LOG_PREFIX} execution ${exec.id} has a real pr_url; leaving for live watcher`);
      continue;
    }
    if (dryRunOutcome === 'synthesize') {
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

    // VTID-02694: trust GitHub's mergeable_state (which reflects branch
    // protection rules) instead of failing on any red check. Otherwise
    // the autopilot blocks on pre-existing-broken non-required checks
    // that humans merge through every day. mergeable_state values:
    //   'clean'    — required checks pass, no conflicts → merge OK
    //   'unstable' — required checks pass, some non-required fail → merge OK
    //   'blocked'  — required check failed OR review missing → fail
    //   'dirty'    — merge conflicts → fail
    //   'unknown' / 'has_hooks' / 'behind' — still settling → wait
    const mState = (prStatus as { pr?: { mergeable_state?: string } }).pr?.mergeable_state;

    // VTID-04379: CI on a PR proves the PR against the main it branched from,
    // not the main it will land on — two PRs green on their own broke main
    // together on 2026-09-21 (VTID-04219). Before a clean PR may merge, bring
    // it up to date; its CI then re-runs on the combined head and a later tick
    // judges that. `behind` used to be waited on forever.
    if (mState === 'clean' || mState === 'behind') {
      const pr = (prStatus as { pr?: { head?: { sha?: string }; base?: { ref?: string } } }).pr;
      const headSha = pr?.head?.sha;
      if (headSha) {
        let behindBy = 0;
        try {
          behindBy = await githubService.getBehindBy(GITHUB_REPO, pr?.base?.ref || 'main', headSha);
        } catch (err) {
          console.warn(`${LOG_PREFIX} [${exec.id.slice(0, 8)}] compare failed: ${err}; refusing merge this tick`);
          continue;
        }
        const updates = Number((exec.metadata as Record<string, unknown> | null)?.branch_updates || 0);
        const decision = decideBranchUpdate(behindBy, updates);
        if (decision === 'update') {
          try {
            await githubService.updatePullRequestBranch(GITHUB_REPO, exec.pr_number, headSha);
          } catch (err) {
            console.warn(`${LOG_PREFIX} [${exec.id.slice(0, 8)}] update-branch failed for #${exec.pr_number}: ${err}`);
            continue;
          }
          await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${exec.id}&status=eq.ci`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              updated_at: new Date().toISOString(),
              metadata: { ...(exec.metadata || {}), branch_updates: updates + 1, branch_updated_from: headSha, branch_behind_by: behindBy },
            }),
          });
          await emitOasisEvent({
            vtid: WATCHER_VTID,
            type: 'dev_autopilot.execution.branch_updated',
            source: 'dev-autopilot-watcher',
            status: 'info',
            message: `Execution ${exec.id.slice(0, 8)}: PR #${exec.pr_number} was ${behindBy} commit(s) behind main — updated, waiting for CI on the new head`,
            payload: { execution_id: exec.id, pr_url: exec.pr_url, behind_by: behindBy, from_head: headSha, update_number: updates + 1 },
          });
          continue;
        }
        if (decision === 'give_up') {
          console.warn(`${LOG_PREFIX} [${exec.id.slice(0, 8)}] PR #${exec.pr_number} still behind main after ${updates} updates; leaving it unmerged`);
          continue;
        }
      }
    }

    if (mState === 'unknown' || mState === 'has_hooks' || mState === 'behind' || !mState) {
      continue;
    }

    // VTID-02694c: tighten further after PRs #1244 and #1247 slipped through
    // VTID-02694b. Root cause was a race: when the watcher tick fetched
    // prStatus, several CI checks hadn't reported yet (not present in
    // prStatus.checks), so analysis.failedNames was [] and mState was
    // 'unstable' (which #1240 considered fine). Watcher merged. ~13 seconds
    // later the late checks reported FAILURE. Both PRs broke the build.
    //
    // GitHub docs state explicitly:
    //   'clean'    — Mergeable AND passing commit status (every reported
    //                check is success/neutral/skipped)
    //   'unstable' — Mergeable BUT non-passing commit status (at least one
    //                check is failing — required or not)
    //
    // So 'unstable' is GitHub's own signal that something is failing. We
    // were ignoring that signal. Fix: ONLY 'clean' allows merge. Combined
    // with the 'analysis.failedNames empty' check this gives belt-and-
    // suspenders against both the GitHub-not-reporting-yet race AND any
    // analyzer parsing miss.
    //
    // Plus: defense against the eventual-consistency race itself —
    // re-fetch prStatus after a short wait and verify gate AGAIN before
    // merging. If a late check has now reported a failure, we catch it.
    const hasAnyFailingChecks = analysis.failedNames.length > 0;
    if (mState !== 'clean' || hasAnyFailingChecks) {
      // VTID-04003: the failing-check names must survive into the reason.
      // GitHub reports `blocked` when a REQUIRED check failed, so collapsing
      // it to 'branch-protection blocked' hid the real root cause from the
      // self-healing triage agent.
      const failureReason = buildCiFailureReason(mState, analysis.failedNames);
      // VTID-04005: attach the failing jobs' real Actions log excerpts so
      // triage (and any self-heal child) reasons from evidence, not from a
      // check NAME. Best-effort — a log-fetch failure never blocks the
      // transition; it just leaves the reason as it was.
      const headSha = (prStatus as { pr?: { head?: { sha?: string } } }).pr?.head?.sha;
      const evidence = headSha
        ? await collectCiFailureEvidence({ owner: GITHUB_OWNER, repo: GITHUB_REPO_NAME, headSha, failedNames: analysis.failedNames })
        : [];
      // VTID-04012: pass the total failing-check count so the evidence says
      // explicitly when collectCiFailureEvidence's CI_LOG_MAX_JOBS cap left
      // some failing checks unfetched — otherwise triage reads a partial log
      // set as if it were the whole failure.
      const evidenceText = renderCiEvidence(evidence, undefined, analysis.failedNames.length);
      const failureReasonWithEvidence = evidenceText ? `${failureReason}\n\nCI log evidence:\n${evidenceText}` : failureReason;
      await transitionStatus(s, exec.id, 'ci', 'failed', {
        metadata: {
          ...(exec.metadata || {}),
          failed_checks: analysis.failedNames,
          mergeable_state: mState,
          gate_reason: failureReason,
          ci_log_excerpts: evidence,
        },
      });
      await emitOasisEvent({
        vtid: WATCHER_VTID,
        type: 'dev_autopilot.execution.ci_failed',
        source: 'dev-autopilot-watcher',
        status: 'error',
        message: `Execution ${exec.id.slice(0, 8)} CI failed: ${failureReason}`,
        payload: { execution_id: exec.id, pr_url: exec.pr_url, failed_checks: analysis.failedNames, mergeable_state: mState, gate_reason: failureReason, ci_log_jobs: evidence.map((e) => e.job_id) },
      });
      await bridgeFailure(exec.id, 'ci', failureReasonWithEvidence);
      continue;
    }

    // mState === 'clean' AND zero failing checks reported → tentative merge.
    // Belt-and-suspenders: wait 30s, re-fetch, re-evaluate gate. Catches the
    // late-reporting check race that broke PRs #1244 and #1247.
    await new Promise(r => setTimeout(r, 30_000));
    let recheckStatus: typeof prStatus | null = null;
    try {
      recheckStatus = await githubService.getPrStatus(GITHUB_REPO, exec.pr_number);
    } catch (err) {
      console.warn(`${LOG_PREFIX} [${exec.id.slice(0, 8)}] recheck getPrStatus failed: ${err}; refusing merge`);
      continue;
    }
    if (!recheckStatus) {
      console.warn(`${LOG_PREFIX} [${exec.id.slice(0, 8)}] recheck returned null; refusing merge`);
      continue;
    }
    const recheckAnalysis = analyzeCiStatus(recheckStatus.checks || []);
    const recheckMState = (recheckStatus as { pr?: { mergeable_state?: string } }).pr?.mergeable_state;
    if (recheckMState !== 'clean' || recheckAnalysis.failedNames.length > 0 || recheckAnalysis.state === 'pending') {
      const reason = `recheck after 30s: mergeable_state=${recheckMState}, failures=${JSON.stringify(recheckAnalysis.failedNames)}, state=${recheckAnalysis.state}`;
      await transitionStatus(s, exec.id, 'ci', 'failed', {
        metadata: {
          ...(exec.metadata || {}),
          failed_checks: recheckAnalysis.failedNames,
          mergeable_state: recheckMState,
          gate_reason: reason,
        },
      });
      await emitOasisEvent({
        vtid: WATCHER_VTID,
        type: 'dev_autopilot.execution.ci_failed',
        source: 'dev-autopilot-watcher',
        status: 'error',
        message: `Execution ${exec.id.slice(0, 8)} CI failed (recheck): ${reason}`,
        payload: { execution_id: exec.id, pr_url: exec.pr_url, failed_checks: recheckAnalysis.failedNames, mergeable_state: recheckMState, gate_reason: reason },
      });
      await bridgeFailure(exec.id, 'ci', reason);
      continue;
    }

    // Both gate evaluations passed. Proceed with merge.
    // VTID-04218: the merge is irreversible; the bookkeeping must land
    // first. If the ci→merging transition did not move the row (another
    // tick took it, or the database refused the write), do NOT merge —
    // leave the PR for the next tick / the reconciler.
    const enteredMerging = await transitionStatus(s, exec.id, 'ci', 'merging');
    if (!enteredMerging) {
      console.warn(`${LOG_PREFIX} [${exec.id.slice(0, 8)}] ci→merging not recorded; refusing to merge PR #${exec.pr_number} this tick`);
      continue;
    }
    await emitOasisEvent({
      vtid: WATCHER_VTID,
      type: 'dev_autopilot.execution.ci_passed',
      source: 'dev-autopilot-watcher',
      status: 'success',
      message: `Execution ${exec.id.slice(0, 8)} CI passed (mergeable_state=${mState})`,
      payload: {
        execution_id: exec.id,
        pr_url: exec.pr_url,
        checks: prStatus.checks.length,
        mergeable_state: mState,
        non_blocking_failures: analysis.failedNames,
      },
    });

    // Defense-in-depth: check risk class one more time before auto-merging.
    // The approve safety-gate already rejected high-risk, but an execution
    // row could theoretically reach 'ci' via an API path that bypassed it,
    // and auto-merge to main is irreversible.
    const riskClass = await loadFindingRiskClass(s, exec.finding_id);
    const gate = shouldAutoMerge(riskClass);
    if (!gate.ok) {
      await transitionStatus(s, exec.id, 'merging', 'failed', {
        metadata: {
          ...(exec.metadata || {}),
          auto_merge_declined: gate.reason,
          risk_class: riskClass,
        },
      });
      await emitOasisEvent({
        vtid: WATCHER_VTID,
        type: 'dev_autopilot.execution.auto_merge_declined',
        source: 'dev-autopilot-watcher',
        status: 'warning',
        message: `Auto-merge declined for ${exec.id.slice(0, 8)}: ${gate.reason}. PR ${exec.pr_url} left open for manual review.`,
        payload: { execution_id: exec.id, pr_url: exec.pr_url, risk_class: riskClass, reason: gate.reason },
      });
      await bridgeFailure(exec.id, 'ci', gate.reason || 'auto-merge declined');
      continue;
    }

    // VTID-03853: real LLM merge review — see dev-autopilot-llm-review.ts's
    // header comment for why this exists here specifically (this is the
    // ONLY gate in the pipeline that a diff's actual content ever passes
    // through before an autonomous merge). Off by default and fails open on
    // any infrastructure problem; only a real, parsed "block" verdict stops
    // the merge.
    if (isLlmMergeReviewEnabled()) {
      const review = await runLlmMergeReview({ repo: GITHUB_REPO, prNumber: exec.pr_number as number, vtid: WATCHER_VTID });
      await emitOasisEvent({
        vtid: WATCHER_VTID,
        type: review.passed ? 'dev_autopilot.execution.llm_review_passed' : 'dev_autopilot.execution.llm_review_blocked',
        source: 'dev-autopilot-watcher',
        status: review.ok ? (review.passed ? 'success' : 'warning') : 'error',
        message: `LLM merge review for ${exec.id.slice(0, 8)}: ${review.summary}`,
        payload: { execution_id: exec.id, pr_url: exec.pr_url, ok: review.ok, passed: review.passed, error: review.error, provider: review.provider, model: review.model, tool_calls: review.tool_calls, tools_used: review.tools_used },
      });
      if (!review.passed) {
        await transitionStatus(s, exec.id, 'merging', 'failed', {
          metadata: { ...(exec.metadata || {}), llm_review_blocked: review.summary },
        });
        await bridgeFailure(exec.id, 'ci', `LLM merge review blocked: ${review.summary}`);
        continue;
      }
    }

    try {
      const mergeRes = await githubService.mergePullRequest(
        GITHUB_REPO,
        exec.pr_number,
        `Dev Autopilot auto-merge: execution ${exec.id.slice(0, 8)}`,
        'squash',
      );
      if (mergeRes.merged) {
        // VTID-02697: stamp the merge commit SHA on the exec so the deploy
        // reconciler can match the post-merge `deploy.gateway.success` event
        // (which carries `metadata.git_commit = <merge SHA>` and
        // `metadata.branch = "main"`, NOT the feature branch).
        await transitionStatus(s, exec.id, 'merging', 'deploying', {
          metadata: { ...(exec.metadata || {}), merge_sha: mergeRes.sha },
        });
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
  //
  // VTID-04215: the topic list comes from `deployTopicsForEnv` — this
  // process's OWN AWS deploy topics (`staging.deploy.completed`/`.failed`
  // on staging, `prod.deploy.*` on production) plus the legacy GCP-era
  // ones. Until this change only the legacy topics were queried, and no
  // AWS workflow ever emits them, so every auto-merged execution sat in
  // `deploying` until the reconciler's 30-minute timeout failed it and the
  // bridge reverted the merge from main. `normalizeDeployEvent` maps the
  // AWS rows onto the `deploy.gateway.success|failed` + `branch:'main'`
  // shape `findDeployOutcomeForExecution` matches on.
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const r = await supa<Array<{ topic: string; metadata?: Record<string, unknown>; created_at?: string; status?: string }>>(
    s,
    `/rest/v1/oasis_events?topic=${deployTopicsInFilter(currentEnv())}&created_at=gte.${encodeURIComponent(since)}&select=topic,metadata,created_at,status&order=created_at.desc&limit=200`,
  );
  if (!r.ok || !r.data) return [];
  return r.data.map((row) => {
    const n = normalizeDeployEvent(row);
    return { type: n.type, payload: n.payload, created_at: n.created_at, status: n.status };
  });
}

export async function deployWatcherTick(): Promise<void> {
  const s = getSupabase();
  if (!s) return;
  if (await killSwitchArmed(s)) return;

  const execs = await loadExecutions(s, 'deploying');
  if (execs.length === 0) return;

  const events = await loadRecentDeployEvents(s);

  for (const exec of execs) {
    const dryRunOutcome = shouldSynthesizeDryRunOutcome(DRY_RUN, exec.pr_url);
    if (dryRunOutcome === 'skip') {
      console.log(`${LOG_PREFIX} execution ${exec.id} has a real pr_url; leaving for live watcher`);
      continue;
    }
    if (dryRunOutcome === 'synthesize') {
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
    // VTID-04377: from one window BEFORE the start, for the baseline.
    `/rest/v1/oasis_events?status=eq.error&created_at=gte.${encodeURIComponent(new Date(new Date(windowStartIso).getTime() - VERIFICATION_WINDOW_MS).toISOString())}&select=topic,vtid,status,created_at&order=created_at.desc&limit=1000`,
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
    const dryRunOutcome = shouldSynthesizeDryRunOutcome(DRY_RUN, exec.pr_url);
    if (dryRunOutcome === 'skip') {
      console.log(`${LOG_PREFIX} execution ${exec.id} has a real pr_url; leaving for live watcher`);
      continue;
    }
    if (dryRunOutcome === 'synthesize') {
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
    const ownVtid = await loadFindingVtid(s, exec.finding_id);
    const verdict = analyzeVerificationWindow(events, windowStart, VERIFICATION_WINDOW_MS, ourVtidPrefix, {
      ownVtids: ownVtid ? [ownVtid] : [],
    });

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

    // Blast radius is clean — but "no new errors" is not the same as "the
    // original failure is gone". If the finding has a probeable HTTP endpoint,
    // re-hit it now and require it healthy (2xx + JSON) before declaring the
    // fix verified. A fix that deploys cleanly but doesn't actually resolve the
    // original failure must NOT pass. Findings without a probeable endpoint
    // (source-file code fixes) fall back to the blast-radius verdict above.
    const probeTarget = await loadFindingProbeTarget(s, exec.finding_id);
    if (probeTarget) {
      const probe = await probeEndpoint(probeTarget);
      if (!isJsonHealthy(probe)) {
        await transitionStatus(s, exec.id, 'verifying', 'failed', {
          metadata: {
            ...(exec.metadata || {}),
            verification_reprobe: {
              endpoint: probeTarget,
              http_status: probe.http_status,
              healthy: false,
            },
          },
        });
        const reason = `original endpoint still failing after deploy (${probeTarget} → ${probe.http_status ?? 'no response'})`;
        await emitOasisEvent({
          vtid: WATCHER_VTID,
          type: 'dev_autopilot.execution.verification_failed',
          source: 'dev-autopilot-watcher',
          status: 'error',
          message: `Execution ${exec.id.slice(0, 8)} verification failed: ${reason}`,
          payload: { execution_id: exec.id, pr_url: exec.pr_url, reprobe: { endpoint: probeTarget, http_status: probe.http_status } },
        });
        await bridgeFailure(exec.id, 'verification', reason, {
          verification_result: { state: 'fail', reason: 'reprobe_unhealthy', endpoint: probeTarget, http_status: probe.http_status },
        });
        continue;
      }
    }

    // pass — blast radius clean AND (re-probe healthy OR no probeable endpoint)
    await transitionStatus(s, exec.id, 'verifying', 'completed', {
      completed_at: new Date().toISOString(),
    });
    await emitOasisEvent({
      vtid: WATCHER_VTID,
      type: 'dev_autopilot.execution.completed',
      source: 'dev-autopilot-watcher',
      status: 'success',
      message: probeTarget
        ? `Execution ${exec.id.slice(0, 8)} completed — verification clean + ${probeTarget} healthy`
        : `Execution ${exec.id.slice(0, 8)} completed — verification window clean`,
      payload: { execution_id: exec.id, pr_url: exec.pr_url, reprobed: probeTarget || null },
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