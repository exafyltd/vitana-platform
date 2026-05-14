/**
 * Developer Autopilot — Execution service
 *
 * Takes an approved-and-cooled execution row and drives it through:
 *
 *   cooling   → running   (claim + Messages API session starts)
 *   running   → ci        (edits applied, PR opened)
 *   ci        → merging   (PR-9 watcher: CI green)
 *   merging   → deploying (PR-9: merged; AUTO-DEPLOY fires)
 *   deploying → verifying (PR-9: deploy.gateway.success received)
 *   verifying → completed (PR-9: verification window passed clean)
 *
 * This module handles the cooling→running→ci stages plus kill-switch /
 * concurrency checks. CI + deploy + verification watchers land in PR-9.
 *
 * History / why NOT Managed Agents:
 *   The earlier implementation wired this through the Managed Agents API with
 *   a GitHub repo mount + a prompt that asked the agent to "write files and
 *   open a PR". Managed Agents with the triage agent don't have file-write
 *   or open_pr tools provisioned, so the session always ended without a PR
 *   URL — and provisioning a dedicated agent with those tools is a large
 *   operational bet. The Messages API + GitHub Contents API path below is
 *   deterministic, faster (~30-90s), and uses the same plumbing the planning
 *   service uses (dev-autopilot-planning.ts, PR #753).
 *
 * Dry-run mode (DEV_AUTOPILOT_DRY_RUN=true) skips the LLM + GitHub writes
 * and produces a synthetic PR URL so the UI and pipeline can be exercised
 * without touching repo state. Default is FALSE — live PRs are opened.
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  evaluateSafetyGate,
  SafetyContext,
  SafetyPlan,
  SafetyDecision,
} from './dev-autopilot-safety';
import { extractFilePaths, generatePlanVersion } from './dev-autopilot-planning';
import { isWorkerQueueEnabled, isWorkerOwnsPrEnabled, runWorkerTask, reclaimStuckWorkerTasks, reclaimStuckPendingWorkerTasks, type WorkerAttemptFailure } from './dev-autopilot-worker-queue';
import { writeAutopilotFailure, writeAutopilotSuccess } from './dev-autopilot-self-heal-log';
import { recordOutcome, recordExecOutcome } from './dev-autopilot-outcomes';
import { loadAutopilotContext } from './dev-autopilot/context-loader';
// VTID-02984 (PR-M1.x): shared allowlist for executable source_types so
// test-contract scanner recommendations (PR-L2/L3) reach the executor.
import {
  isExecutableSourceType,
  executableSourceTypesPostgrestIn,
} from './autopilot-executable-source-types';

const LOG_PREFIX = '[dev-autopilot-execute]';
const EXEC_VTID = 'VTID-DEV-AUTOPILOT';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_BASE = 'https://api.anthropic.com';
// Messages API timeout — Cloud Run's request timeout is 300s; we run in a
// background ticker so that's not the constraint. Still cap at 8 minutes so
// a pathological stuck call doesn't hold a concurrency slot forever.
// 12 min. Was 8 min; bumped after PR #846 added jest validation in the
// worker which can add 60-90s on the first attempt and ~5-15s on retries
// — combined with up to 3 retry attempts and an initial npm-install on
// a cold clone, the worker can legitimately hold a task for ~10 min on
// a hard case. The execute path is background-ticker scoped, so there's
// no Cloud Run request-wall constraint here.
const MESSAGES_TIMEOUT_MS = 720_000; // 12 min
const EXECUTION_MODEL = process.env.DEV_AUTOPILOT_EXECUTION_MODEL || 'claude-sonnet-4-6';
// Upper bound for total output tokens. One plan may touch up to ~5 files;
// ~3000 tokens/file is a generous budget. Sonnet 4.6 supports 16k out.
//
// 2026-05-04 (VTID-AUTOPILOT-TOKENS): bumped 16k → 32k after the smoke
// run on PR #1615 surfaced output truncation as the dominant first-attempt
// failure mode. The new conventions+imports-surface context block adds
// ~7-8k input tokens; combined with file content + plan, the model now
// frequently runs out of output budget mid-emit and produces a half-
// closed `<<<FILE …>>>` block. The bridge's depth-1 retry recovers
// (PRs #1618, #1619 in smoke), but each retry costs another full Vertex
// call. Gemini 3.1 Pro Preview supports 32k output; using it reduces
// the truncation rate to near-zero for typical 1-5 file plans.
const MESSAGES_MAX_TOKENS = 32000;
// Safety cap — refuse to execute plans that cite more files than this. Protects
// against a misbehaving plan trying to rewrite the world. The safety gate
// already enforces allow_scope but this adds a quantitative limit.
const MAX_FILES_PER_EXECUTION = 8;
// Per-file maximum content size (bytes) that we'll include in the prompt OR
// write back to GitHub. Plans that need larger files should be split. 200 KB
// is ~50k tokens — well inside Sonnet's 200k context.
const MAX_FILE_BYTES = 200_000;

const DRY_RUN = (process.env.DEV_AUTOPILOT_DRY_RUN || 'false').toLowerCase() === 'true';
const BACKGROUND_TICK_MS = 30_000;

// VTID-02703: Cloud Run Job runtime for the executor.
//   USE_JOB_RUNTIME    — when true, the gateway dispatches each claimed
//                        execution to the Cloud Run Job
//                        (autopilot-executor) instead of running
//                        runExecutionSession in-process. The Job survives
//                        container churn that kills long-running fire-and-
//                        forget Promises in the gateway service.
//   JOB_NAME / JOB_REGION / JOB_PROJECT — addressing the Job for the
//                        Cloud Run Admin API. Defaults match the deploy
//                        workflow (.github/workflows/DEPLOY-AUTOPILOT-JOB.yml).
const USE_JOB_RUNTIME = (process.env.DEV_AUTOPILOT_USE_JOB || 'false').toLowerCase() === 'true';
const JOB_NAME = process.env.DEV_AUTOPILOT_JOB_NAME || 'autopilot-executor';
const JOB_REGION = process.env.DEV_AUTOPILOT_JOB_REGION || 'us-central1';
const JOB_PROJECT = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'lovable-vitana-vers1';

const GITHUB_OWNER = process.env.DEV_AUTOPILOT_REPO_OWNER || 'exafyltd';
const GITHUB_REPO = process.env.DEV_AUTOPILOT_REPO_NAME || 'vitana-platform';
const GITHUB_BASE_BRANCH = process.env.DEV_AUTOPILOT_REPO_REF || 'main';

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

export interface SupaConfig { url: string; key: string; }
// VTID-02703: exported so the Cloud Run Job entry point reuses the same
// SupaConfig + env-read logic without duplication.
export function getSupabase(): SupaConfig | null {
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
  // Auto-approve gate for BASELINE scanner findings (dev_autopilot).
  // Defaults to disabled — opt-in per environment.
  auto_approve_enabled?: boolean;
  auto_approve_max_effort?: number;
  auto_approve_risk_classes?: string[];
  auto_approve_scanners?: string[];
  // Auto-approve gate for IMPACT rule findings (dev_autopilot_impact).
  // Independent toggle + allowlist so baseline and impact auto-approval
  // evolve separately. See Command Hub → Autopilot → Auto-Approve.
  auto_approve_impact_enabled?: boolean;
  auto_approve_impact_rules?: string[];
}

async function loadConfig(s: SupaConfig): Promise<ConfigRow | null> {
  const r = await supa<ConfigRow[]>(s, `/rest/v1/dev_autopilot_config?id=eq.1&limit=1`);
  if (!r.ok || !r.data || r.data.length === 0) return null;
  return r.data[0];
}

/**
 * Upsert worker validation failures into dev_autopilot_prompt_learnings.
 * Scoped by the finding's scanner so retrieval can target lessons from the
 * same scanner class (e.g. only pull missing-tests lessons for missing-tests
 * findings).
 *
 * The scanner is looked up once from the finding's spec_snapshot. A null
 * scanner is allowed (legacy rows without a scanner field still write, just
 * with scanner IS NULL) — the ON CONFLICT index treats (pattern_type,
 * pattern_key, NULL) as a distinct bucket.
 */
async function persistAttemptFailures(
  s: SupaConfig,
  failures: WorkerAttemptFailure[],
  ctx: { finding_id: string; execution_id?: string },
): Promise<void> {
  // Look up the finding's scanner once.
  const findingR = await supa<Array<{ spec_snapshot: { scanner?: string } | null }>>(
    s,
    `/rest/v1/autopilot_recommendations?id=eq.${ctx.finding_id}&select=spec_snapshot&limit=1`,
  );
  const scanner: string | null = findingR.ok && findingR.data && findingR.data[0]?.spec_snapshot?.scanner
    ? String(findingR.data[0].spec_snapshot.scanner)
    : null;

  const now = new Date().toISOString();
  for (const f of failures) {
    const pattern_type = f.stage === 'tsc'
      ? 'tsc_error'
      : f.stage === 'jest'
        ? 'jest_failure'
        : f.stage === 'parse' || f.stage === 'apply'
          ? 'parse_error'
          : 'validation_other';
    const body = {
      pattern_type,
      pattern_key: f.pattern_key.slice(0, 200),
      example_message: (f.example_message || '').slice(0, 500),
      scanner,
      finding_id: ctx.finding_id,
      execution_id: ctx.execution_id || null,
      last_seen_at: now,
    };
    // PostgREST upsert: merge-duplicates against the UNIQUE
    // (pattern_type, pattern_key, scanner) index. frequency stays at the
    // default (1) on conflict; the aggregator counts by rows, not by the
    // column, so an undercount of duplicates is acceptable.
    await supa(s,
      `/rest/v1/dev_autopilot_prompt_learnings?on_conflict=pattern_type,pattern_key,scanner`,
      {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(body),
      },
    );
  }
}

/**
 * Load up to 5 recent validation lessons for a scanner. Used by the
 * execution prompt builder so Claude's output avoids repeating known
 * traps. Best-effort — returns [] on any DB issue so execute flow never
 * blocks on this.
 */
async function loadExecutionLessons(
  s: SupaConfig,
  scanner: string,
): Promise<ExecutionLesson[]> {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const r = await supa<ExecutionLesson[]>(
      s,
      `/rest/v1/dev_autopilot_prompt_learnings?scanner=eq.${encodeURIComponent(scanner)}`
      + `&last_seen_at=gte.${since}`
      + `&order=last_seen_at.desc&limit=5`
      + `&select=pattern_type,pattern_key,example_message,mitigation_note`,
    );
    return r.ok && Array.isArray(r.data) ? r.data : [];
  } catch {
    return [];
  }
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
    source_ref: string | null;
    spec_snapshot: Record<string, unknown>;
    status: string;
  }>>(
    s,
    `/rest/v1/autopilot_recommendations?id=eq.${input.finding_id}&select=id,risk_class,source_type,source_ref,spec_snapshot,status&limit=1`,
  );
  if (!recR.ok || !recR.data) return { ok: false, error: recR.error || 'finding lookup failed' };
  const rec = recR.data[0];
  if (!rec) return { ok: false, error: 'finding not found' };
  // Accept any source_type from the shared executor allowlist
  // (autopilot-executable-source-types.ts). Reject anything else
  // (community, system, or future scanner shapes that haven't been
  // code-reviewed into the allowlist).
  if (!isExecutableSourceType(rec.source_type)) {
    return { ok: false, error: `not an executable source_type (source_type=${rec.source_type})` };
  }
  // VTID-02639 defense-in-depth: refuse to re-approve a finding that has
  // already shipped (status='completed') or been manually closed
  // (status='rejected'/'snoozed'/'activated'). autoApproveTick() now filters
  // by status='new' upstream, but a manual call here could still hit a
  // stale finding_id. Without this guard, the same finding can produce N
  // duplicate PRs — exactly the failure mode that forced the 2026-04-30
  // sweep (6 identical admin-notification-categories middleware refactors
  // closed in one batch).
  if (rec.status !== 'new') {
    return {
      ok: false,
      error: `finding status is '${rec.status}' — only 'new' findings can be approved`,
    };
  }

  // VTID-AUTOPILOT-PR-FLOOD: refuse to approve a finding that already has
  // a PR opened by an earlier execution where the PR was never merged.
  // The pre-existing in-flight check (autoApproveTick line ~2487) only
  // skips findings whose execution status is in
  // (cooling,running,ci,merging,deploying,verifying) — it does NOT cover
  // failed/reverted executions. The executor never closes the GitHub PR
  // on failure (see reconciler line ~1812 — it only OBSERVES PR state),
  // so each failed execution leaves a stranded open PR. autoApproveTick
  // then re-picks the still-status='new' finding, opens another PR, and
  // the cycle repeats. The 2026-05-07 sweep had to close 530 PRs from
  // a handful of findings (one had 290 stranded PRs alone) because the
  // retry cap (5 failures / 24h) wasn't enough to outrun a 30s tick
  // running for days. This guard makes "PR opened, not merged, prior
  // execution didn't reach 'completed' or 'self_healed'" a hard block
  // at approval time. Operator must close/merge the existing PR (which
  // flips its execution to 'completed' or 'auto_archived') before any
  // new attempt is approved.
  const openPrR = await supa<Array<{ id: string; pr_url: string | null; pr_number: number | null; status: string }>>(
    s,
    `/rest/v1/dev_autopilot_executions?finding_id=eq.${input.finding_id}`
    + `&pr_url=not.is.null`
    + `&status=not.in.(completed,self_healed,auto_archived)`
    + `&select=id,pr_url,pr_number,status&order=approved_at.desc&limit=1`,
  );
  if (openPrR.ok && openPrR.data && openPrR.data.length > 0) {
    const stranded = openPrR.data[0];
    return {
      ok: false,
      error: `finding ${input.finding_id.slice(0, 8)} already has an unmerged PR `
        + `(${stranded.pr_url || `#${stranded.pr_number}`}) from a prior execution `
        + `(status=${stranded.status}) — close or merge it before re-approving`,
    };
  }

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
  // Re-extract files_referenced from the stored plan_markdown rather than
  // trusting the cached column. Plans generated before the extractFilePaths
  // fix (PR #778) have a dirty files_referenced list that includes prose
  // noise like `services/gateway/package.json` / `jest.config.ts` / `tsconfig.json`
  // — those aren't in the plan's "Files to modify" section but got slurped
  // in by the old fallback scan and then tripped the safety gate's
  // file_outside_allow_scope rule forever. Re-extracting here makes the fix
  // retroactive for every existing plan without a regeneration pass.
  const freshFiles = extractFilePaths(plan.plan_markdown);
  // VTID-02693: for feedback findings, ALWAYS prefer the stored
  // files_referenced (= bridge's pre-validated proposed_files) over
  // freshFiles. The planner's plan_markdown sometimes lists only the
  // source file and omits the co-located test file in its "Files to
  // modify" section even though Devon's spec has both — that misses the
  // tests_missing safety check. proposed_files is the authoritative list
  // because the bridge already validated it against allow_scope.
  const isFeedbackFinding = rec.source_type === 'dev_autopilot'
    && typeof rec.source_ref === 'string'
    && rec.source_ref.startsWith('feedback_ticket:');
  let files = isFeedbackFinding && (plan.files_referenced || []).length > 0
    ? (plan.files_referenced || []).map(String)
    : (freshFiles.length > 0 ? freshFiles : (plan.files_referenced || []).map(String));
  // VTID-02687: fallback for stale plan_versions where neither
  // freshFiles nor files_referenced has anything — read proposed_files
  // off the recommendation directly.
  if (files.length === 0) {
    const proposed = (rec.spec_snapshot as { proposed_files?: unknown })?.proposed_files;
    if (Array.isArray(proposed)) {
      files = proposed.filter((p): p is string => typeof p === 'string' && p.includes('/'));
    }
  }
  const deletions = extractDeletions(plan.plan_markdown);
  const safetyPlan: SafetyPlan = {
    risk_class: (rec.risk_class || 'medium') as 'low' | 'medium' | 'high',
    files_to_modify: files,
    files_to_delete: deletions,
  };
  // VTID-02676: feedback-bridged findings bypass the kill_switch only.
  // All other gate rules still apply.
  const isFeedbackLane = rec.source_type === 'dev_autopilot'
    && typeof rec.source_ref === 'string'
    && rec.source_ref.startsWith('feedback_ticket:');

  // Pass the scanner identifier so the safety gate can apply per-scanner
  // scope overrides (e.g. npm-audit-scanner-v1 → allow package.json).
  // See dev-autopilot-safety.ts:applyScannerOverrides for the full list.
  const scannerForSafety = (rec.spec_snapshot as { scanner?: string } | null)?.scanner;
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
    is_feedback_lane: isFeedbackLane,
    scanner: scannerForSafety,
  };
  const decision = evaluateSafetyGate(safetyPlan, safetyCtx);
  if (!decision.ok) {
    // Surface safety-gate rejections on the Self-Healing screen so the
    // operator sees WHY the autopilot didn't proceed (allow_scope mismatch,
    // deny_scope hit, file count exceeds cap, etc.). Without this, blocked
    // approvals rot in silence — exactly what we just fixed for plan-gen.
    await writeAutopilotFailure(s, {
      stage: 'approve_safety',
      vtid: `VTID-DA-FIND-${input.finding_id.slice(0, 8)}`,
      endpoint: rec.spec_snapshot?.file_path
        ? String(rec.spec_snapshot.file_path)
        : 'autopilot.approve_safety',
      failure_class: 'dev_autopilot_safety_gate_blocked',
      confidence: 0,
      diagnosis: {
        summary: `Safety gate blocked approval: ${decision.violations?.map((v: { rule?: string; message?: string }) => v.rule || v.message).join(', ') || 'unknown reason'}`,
        finding_id: input.finding_id,
        approved_by: input.approved_by || null,
        risk_class: rec.risk_class,
        scanner: rec.spec_snapshot?.scanner,
        file_path: rec.spec_snapshot?.file_path,
        violations: decision.violations || [],
        files_to_modify: files,
        files_to_delete: deletions,
      },
      outcome: 'escalated',
      attempt_number: 1,
    });
    // VTID-AUTOPILOT-SAFETY-SPIN: when called from autoApproveTick (no
    // approved_by), snooze the recommendation for 7 days so the picker
    // doesn't re-evaluate it on every 30s tick. Without this, a blocked
    // finding generates ~120 safety-gate-eval cycles per hour AND ~120
    // self_healing_log escalation rows — 90k rows/day of pure noise per
    // blocked finding. The 7d snooze gives the operator a week to either
    // regenerate the plan or unsnooze; after that, autoApproveTick re-
    // evaluates (in case the plan or scope policy changed in the
    // meantime). Human-approved calls (approved_by present) skip this:
    // the human sees the violations in the API response and decides.
    // Feedback findings also skip — they get human triage attention.
    const isAutoApprove = !input.approved_by;
    if (isAutoApprove && !isFeedbackLane) {
      const snoozedUntil = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      const violationSummary = (decision.violations || [])
        .map((v: { rule?: string; message?: string }) => v.rule || v.message)
        .filter(Boolean)
        .slice(0, 3)
        .join('; ');
      await supa(
        s,
        `/rest/v1/autopilot_recommendations?id=eq.${input.finding_id}&status=eq.new`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'snoozed',
            snoozed_until: snoozedUntil,
            updated_at: new Date().toISOString(),
          }),
        },
      );
      console.log(
        `${LOG_PREFIX} [${input.finding_id.slice(0, 8)}] safety gate blocked auto-approve — snoozed 7d (${violationSummary})`,
      );
    }
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
  if (!ins.ok) {
    // VTID-AUTOPILOT-RACE: the partial unique index
    // `dev_autopilot_executions_finding_inflight_uniq` rejects a second
    // concurrent INSERT for a finding that already has an inflight exec.
    // PostgREST surfaces this as HTTP 409 + Postgres SQLSTATE 23505 in
    // the body. Treat it as a benign skip — another gateway instance got
    // there first; its exec is already cooling/running for this finding.
    // Without this, every Cloud Run multi-instance race produces a "execution
    // insert failed" autoApproveTick warning AND a stranded inflight row in
    // the loser's view, even though the winner is already making progress.
    if (ins.status === 409 && /23505|finding_inflight_uniq/.test(ins.error || '')) {
      console.log(
        `${LOG_PREFIX} [${input.finding_id.slice(0, 8)}] inflight-unique violation — another instance picked first, skipping`,
      );
      return { ok: false, error: 'inflight_unique_skip' };
    }
    return { ok: false, error: `execution insert failed: ${ins.error}` };
  }

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

  // Outcomes substrate: one row per decision. approved_by present → human
  // approval; absent → auto-exec via autoApproveTick. exec_outcome is
  // backfilled later when the worker reports completion/failure.
  await recordOutcome({
    finding_id: input.finding_id,
    decision: input.approved_by ? 'approved' : 'auto_exec',
    approver_user_id: input.approved_by || null,
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

// =============================================================================
// Bridge: operator-driven activation → execution row
// =============================================================================
//
// When a user clicks "Activate" on a dev_autopilot* recommendation in the
// Command Hub Autopilot popup, the activate route writes a vtid_ledger row
// and kicks this bridge fire-and-forget. We:
//   1. Generate a plan if none exists yet (dev_autopilot findings always
//      have one eventually via lazyPlanTick, but the operator just said
//      "go" — don't make them wait for the next 30s tick).
//   2. Skip if an in-flight execution already exists (idempotent — a
//      double-click or the reaper tick won't double-enqueue).
//   3. Call approveAutoExecute + immediately patch execute_after to NOW
//      so the next backgroundExecutorTick picks it up without a cooldown
//      wait. The cooldown exists to give the operator a chance to cancel
//      auto-approved findings; an explicit Activate click already IS the
//      operator's go-ahead.
//
// Returns a discriminated result so the caller can log success/failure but
// the activate-route response itself isn't gated on this — it's all
// fire-and-forget. The reaper tick later catches any failures here and
// retries them.
export async function bridgeActivationToExecution(
  findingId: string,
  approvedBy: string | null = null,
): Promise<{ ok: boolean; execution_id?: string; error?: string; skipped?: string; decision?: unknown }> {
  const s = getSupabase();
  if (!s) return { ok: false, error: 'Supabase not configured' };

  // 1. Verify this source_type is in the executor allowlist (the
  //    activate route only bridges allowlisted recs — community / system
  //    rows don't go through the executor).
  const recR = await supa<Array<{ id: string; source_type: string; status: string }>>(
    s,
    `/rest/v1/autopilot_recommendations?id=eq.${findingId}&select=id,source_type,status&limit=1`,
  );
  if (!recR.ok || !recR.data || !recR.data[0]) {
    return { ok: false, error: 'finding lookup failed' };
  }
  const rec = recR.data[0];
  if (!isExecutableSourceType(rec.source_type)) {
    return { ok: false, skipped: `source_type=${rec.source_type} not bridgeable` };
  }

  // 2. Skip if any in-flight execution already exists for this finding.
  //    Statuses we consider in-flight: cooling, running, ci, merging,
  //    deploying, verifying. Terminal states (completed, failed, *) are fine
  //    to re-enqueue from — but only the reaper does that, never this path
  //    (operator activation should be a no-op on re-click).
  const inflightR = await supa<Array<{ id: string; status: string }>>(
    s,
    `/rest/v1/dev_autopilot_executions?finding_id=eq.${findingId}` +
    `&status=in.(cooling,running,ci,merging,deploying,verifying)` +
    `&select=id,status&limit=1`,
  );
  if (inflightR.ok && inflightR.data && inflightR.data[0]) {
    return { ok: true, execution_id: inflightR.data[0].id, skipped: `existing ${inflightR.data[0].status} execution` };
  }

  // 3. Generate plan if none exists. lazyPlanTick would do this within 30s
  //    but the operator clicked Activate — we owe them a faster path.
  const planR = await supa<Array<{ version: number }>>(
    s,
    `/rest/v1/dev_autopilot_plan_versions?finding_id=eq.${findingId}&select=version&limit=1`,
  );
  if (!planR.ok || !planR.data || planR.data.length === 0) {
    const planResult = await generatePlanVersion(findingId);
    if (!planResult.ok) {
      return { ok: false, error: `plan generation failed: ${planResult.error}` };
    }
  }

  // 4. Approve. approveAutoExecute creates the execution row with
  //    execute_after = now + cooldown_minutes; we immediately patch
  //    execute_after back to now so the next tick claims it.
  const approval = await approveAutoExecute({ finding_id: findingId, approved_by: approvedBy || undefined });
  if (!approval.ok || !approval.execution) {
    // VTID-02669: surface decision.violations[] so the caller (and the UI)
    // can show exactly which gate rule blocked. Previously this swallowed
    // the array and only returned a generic message.
    return {
      ok: false,
      error: approval.error || 'approval failed',
      decision: approval.decision,
    };
  }
  const execId = approval.execution.id;
  await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${execId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ execute_after: new Date().toISOString() }),
  });

  await emitOasisEvent({
    vtid: EXEC_VTID,
    type: 'dev_autopilot.execution.bridged',
    source: 'dev-autopilot',
    status: 'info',
    message: `Operator activation bridged finding ${findingId.slice(0, 8)} → execution ${execId.slice(0, 8)} (cooldown skipped)`,
    payload: { execution_id: execId, finding_id: findingId, approved_by: approvedBy, source: 'operator_activate' },
  });

  return { ok: true, execution_id: execId };
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
// VTID-02641: plan-vs-diff coverage validator
// =============================================================================

/**
 * Minimum fraction of the plan's files the executor diff must touch before
 * we consider the diff "honest." Below this, the executor wandered off the
 * plan and we'd rather fail loudly than ship dead code.
 *
 * 0.6 picked deliberately:
 *   - 5/5  -> 1.00  pass
 *   - 4/5  -> 0.80  pass
 *   - 3/5  -> 0.60  pass (skip-test-file class)
 *   - 2/5  -> 0.40  fail
 *   - 1/4  -> 0.25  fail (PR #1102: 4-file plan, 1-file diff)
 */
const PLAN_DIFF_COVERAGE_THRESHOLD = 0.6;

export interface PlanDiffCoverage {
  ok: boolean;
  coverage: number;
  planCount: number;
  coveredCount: number;
  missing: string[];
}

/**
 * Pure function: given the plan's files_referenced and the executor diff's
 * file paths, decide whether enough of the plan was actually written.
 *
 * Returns ok=true when:
 *   - the plan listed 0 files (nothing to validate; defer to the existing
 *     "executor emitted zero files" check upstream); or
 *   - covered/plan >= threshold.
 *
 * Otherwise returns ok=false with the missing-file list so the caller can
 * surface a useful error to self-healing.
 */
export function validatePlanDiffCoverage(
  planFiles: string[],
  diffFiles: string[],
  threshold: number = PLAN_DIFF_COVERAGE_THRESHOLD,
): PlanDiffCoverage {
  if (!planFiles || planFiles.length === 0) {
    return { ok: true, coverage: 1, planCount: 0, coveredCount: 0, missing: [] };
  }
  const diffSet = new Set(diffFiles);
  const covered = planFiles.filter(p => diffSet.has(p));
  const missing = planFiles.filter(p => !diffSet.has(p));
  const coverage = covered.length / planFiles.length;
  return {
    ok: coverage >= threshold,
    coverage,
    planCount: planFiles.length,
    coveredCount: covered.length,
    missing,
  };
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
// GitHub Contents + Refs helpers — write files, create branches, open PRs
// =============================================================================

function getGithubToken(): string {
  return process.env.DEV_AUTOPILOT_GITHUB_TOKEN
      || process.env.GITHUB_SAFE_MERGE_TOKEN
      || process.env.GITHUB_TOKEN
      || '';
}

async function githubRequest<T>(
  path: string,
  init: { method?: string; body?: unknown; accept?: string } = {},
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const token = getGithubToken();
  if (!token) return { ok: false, status: 0, error: 'GITHUB_SAFE_MERGE_TOKEN not set' };
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      method: init.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: init.accept || 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'vitana-dev-autopilot-executor',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: init.body != null ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      return { ok: false, status: res.status, error: `${res.status}: ${body}` };
    }
    // 204 No Content responses have no body
    if (res.status === 204) return { ok: true, status: 204 };
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

async function fetchFileContent(
  path: string,
  ref: string,
): Promise<{ exists: boolean; content?: string; sha?: string; error?: string }> {
  const encoded = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  const r = await githubRequest<{ content: string; encoding: string; sha: string }>(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
  );
  if (!r.ok) {
    if (r.status === 404) return { exists: false };
    return { exists: false, error: r.error };
  }
  if (!r.data) return { exists: false };
  // GitHub returns base64-encoded content
  const decoded = Buffer.from(r.data.content || '', r.data.encoding as BufferEncoding || 'base64').toString('utf-8');
  return { exists: true, content: decoded, sha: r.data.sha };
}

async function getBranchSha(branch: string): Promise<{ ok: boolean; sha?: string; error?: string }> {
  const r = await githubRequest<{ object: { sha: string } }>(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  if (!r.ok || !r.data) return { ok: false, error: r.error || 'ref lookup failed' };
  return { ok: true, sha: r.data.object.sha };
}

async function createBranch(branch: string, baseBranch: string): Promise<{ ok: boolean; error?: string }> {
  const base = await getBranchSha(baseBranch);
  if (!base.ok || !base.sha) return { ok: false, error: `base branch lookup: ${base.error}` };

  // If the branch already exists (prior failed run), delete it first so we get
  // a clean tree. Safe because these branches are always autopilot-prefixed.
  const existing = await getBranchSha(branch);
  if (existing.ok) {
    const del = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/${encodeURIComponent(branch)}`,
      { method: 'DELETE' },
    );
    if (!del.ok) return { ok: false, error: `could not delete stale branch ${branch}: ${del.error}` };
  }

  const create = await githubRequest(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs`,
    { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: base.sha } },
  );
  if (!create.ok) return { ok: false, error: `create branch ${branch}: ${create.error}` };
  return { ok: true };
}

async function putFileToBranch(
  branch: string,
  path: string,
  content: string,
  message: string,
  existingSha?: string,
): Promise<{ ok: boolean; error?: string }> {
  const encoded = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  // GitHub's PUT contents API needs base64-encoded content.
  const base64 = Buffer.from(content, 'utf-8').toString('base64');
  const body: Record<string, unknown> = {
    message,
    content: base64,
    branch,
  };
  if (existingSha) body.sha = existingSha;
  const r = await githubRequest(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encoded}`,
    { method: 'PUT', body },
  );
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true };
}

async function openPullRequest(
  branch: string,
  baseBranch: string,
  title: string,
  body: string,
): Promise<{ ok: boolean; url?: string; number?: number; error?: string }> {
  const r = await githubRequest<{ html_url: string; number: number }>(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls`,
    {
      method: 'POST',
      body: {
        title: title.slice(0, 240),
        head: branch,
        base: baseBranch,
        body,
        maintainer_can_modify: true,
        draft: false,
      },
    },
  );
  if (!r.ok || !r.data) return { ok: false, error: r.error };
  return { ok: true, url: r.data.html_url, number: r.data.number };
}

// VTID-AUTOPILOT-NOEMPTY: count files that actually changed on `branch`
// vs `baseBranch`. The model occasionally emits a <<<FILE …>>> block whose
// content is byte-identical to the file already on main — `putFileToBranch`
// then writes a no-op commit (parent tree == new tree) and `openPullRequest`
// happily produces an empty PR that passes every CI check vacuously
// (tsc on a 0-line diff is trivially green, naming has no new files,
// tests don't run on unchanged code). Branch protection's `validate` is
// satisfied, the v3 merge gate fires, and the autopilot reports "merged"
// while shipping nothing. PRs #1626, #1630, #1634, #1635 (4 of 7 in the
// 2026-05-04 14:48 drain) were no-op merges of this kind. Adding this guard
// pre-PR means the bridge sees a real failure and can feed back to the
// LLM as "your output produced no actual diff — review the spec or surface
// the gap" instead of silently shipping nothing.
async function compareBranchFiles(
  branch: string,
  baseBranch: string,
): Promise<{ ok: boolean; changedFiles?: number; error?: string }> {
  const r = await githubRequest<{ files?: Array<unknown>; total_commits?: number }>(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branch)}`,
  );
  if (!r.ok || !r.data) return { ok: false, error: r.error || 'compare failed' };
  return { ok: true, changedFiles: (r.data.files || []).length };
}

// =============================================================================
// Messages API — ask Claude to produce the file contents
// =============================================================================

interface ExecutionLlmOutput {
  files: Array<{ path: string; action: 'create' | 'modify' | 'delete'; content?: string }>;
  pr_title: string;
  pr_body: string;
}

// Delimiter-based format. Before: we asked the model to emit JSON with source
// code inside string values. That forced correct escaping of every quote,
// backslash, and newline across thousands of characters of TypeScript. In
// practice the model occasionally emitted unescaped characters that broke
// JSON.parse with errors like "SyntaxError: Expected ',' or ']' after array
// element in JSON at position 46866" (execution 265fbf0f). Source code
// inside verbatim delimiter blocks sidesteps all of that.
function parseExecutionOutput(raw: string): ExecutionLlmOutput | { error: string } {
  const text = raw.trim();

  // pr_title: single line
  const titleMatch = text.match(/<<<PR_TITLE>>>\s*([\s\S]*?)\s*<<<END>>>/);
  if (!titleMatch) return { error: 'Missing <<<PR_TITLE>>>…<<<END>>> block' };
  const pr_title = titleMatch[1].trim();

  // pr_body: multi-line markdown
  const bodyMatch = text.match(/<<<PR_BODY>>>\s*([\s\S]*?)\s*<<<END>>>/);
  if (!bodyMatch) return { error: 'Missing <<<PR_BODY>>>…<<<END>>> block' };
  const pr_body = bodyMatch[1];

  // files: each block wraps raw content. Match header, then consume until the
  // NEAREST matching <<<END>>> that's followed by a recognised boundary
  // (another <<<FILE…>>> header, end of text, or whitespace to EOF).
  // Using non-greedy match is fine for clean files, but source may contain
  // "<<<END>>>" as a literal string; guard by requiring it at start of line.
  const fileRe = /<<<FILE\s+(create|modify|delete)\s+([^\s>]+)\s*>>>\s*\r?\n([\s\S]*?)\r?\n<<<END>>>/g;
  const files: ExecutionLlmOutput['files'] = [];
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(text)) !== null) {
    const action = m[1] as 'create' | 'modify' | 'delete';
    const path = m[2].trim();
    const content = action === 'delete' ? undefined : m[3];
    files.push({ path, action, content });
  }
  if (files.length === 0) {
    return { error: 'No <<<FILE …>>>…<<<END>>> blocks found' };
  }

  // VTID-02652 — Check 1: detect truncated output. Count every FILE header
  // (regardless of whether it has a closing <<<END>>>) and compare to the
  // count of complete blocks we consumed above. If the model started a
  // FILE block and then ran out of MESSAGES_MAX_TOKENS before emitting
  // <<<END>>>, the regex above silently skipped it and the worker would
  // open a PR claiming changes that aren't in the diff. PR #1102 was the
  // first observed example: PR_BODY listed 5 files, output truncated
  // mid-second-file, parser returned 1 block, PR opened with placeholder
  // code + a body that lied about wiring it up everywhere.
  const headerRe = /<<<FILE\s+(?:create|modify|delete)\s+\S+\s*>>>/g;
  const headerCount = (text.match(headerRe) || []).length;
  if (headerCount !== files.length) {
    return {
      error:
        `Truncated output: ${headerCount} <<<FILE …>>> headers found but only ${files.length} ` +
        `closed blocks. The model likely hit its token budget mid-file. Reject this attempt — ` +
        `the worker's PR-opener would otherwise file a PR whose body promises work the diff doesn't deliver.`,
    };
  }

  // VTID-02652 — Check 2: PR_BODY-vs-FILE-blocks consistency. The body
  // sometimes lists files in a bullet structure; if the model truncated
  // FILE-block emission OR hallucinated wire-ups, the body promises more
  // than was emitted. Heuristic: extract path-like tokens (containing '/'
  // and ending in a known code/data extension) from the body, compare
  // against the set of paths emitted in FILE blocks. If the body claims
  // a path that no FILE block touches and we have at least 2 such orphan
  // claims, reject — the autopilot has lied. We allow up to 1 orphan to
  // tolerate prose like "similar to the pattern in services/foo.ts".
  const bodyPathRe = /\b([\w./-]+\.(?:ts|tsx|js|jsx|sql|md|json|yml|yaml))\b/g;
  const claimedPaths = new Set<string>();
  let pm: RegExpExecArray | null;
  while ((pm = bodyPathRe.exec(pr_body)) !== null) {
    const candidate = pm[1];
    // Skip pure filenames without a directory — too generic to attribute.
    if (!candidate.includes('/')) continue;
    claimedPaths.add(candidate);
  }
  const emittedPaths = new Set(files.map((f) => f.path));
  const orphanClaims: string[] = [];
  for (const claim of claimedPaths) {
    // Match if any emitted path equals the claim OR ends with it (lets
    // body shorthand like "approvals.ts" match "src/routes/approvals.ts"
    // — except we filtered shorthand above by requiring '/').
    let matched = false;
    for (const emitted of emittedPaths) {
      if (emitted === claim || emitted.endsWith(`/${claim}`) || claim.endsWith(`/${emitted}`)) {
        matched = true;
        break;
      }
    }
    if (!matched) orphanClaims.push(claim);
  }
  if (orphanClaims.length >= 2) {
    return {
      error:
        `PR_BODY claims work on ${orphanClaims.length} files that no FILE block emits: ` +
        `${orphanClaims.slice(0, 5).join(', ')}. Either the model truncated mid-emission or ` +
        `hallucinated the wire-up. Reject this attempt rather than opening a PR with a lying body.`,
    };
  }

  return { files, pr_title, pr_body };
}

// Back-compat export name for existing tests / callers. Now points to the
// new delimiter parser.
const parseExecutionJson = parseExecutionOutput;

interface FileCtx { path: string; exists: boolean; content?: string; sha?: string }

interface ExecutionLesson {
  pattern_type: string;
  pattern_key: string;
  example_message: string;
  mitigation_note: string | null;
}

function buildExecutionPrompt(
  findingId: string,
  planVersion: number,
  planMarkdown: string,
  fileCtx: FileCtx[],
  branch: string,
  lessons?: ExecutionLesson[],
): string {
  const lines: string[] = [];
  // VTID-02692: LOCKED file list at the very top. The executor LLM (Gemini
  // 3.1 Pro Preview, Sonnet 4 fallback) was hallucinating Python paths
  // like services/agents/voice/*.py despite the plan listing the correct
  // TypeScript files. The validator caught it ("LLM emitted files outside
  // the plan's files_referenced") but only AFTER the LLM had spent a full
  // call producing garbage. Hard-anchoring the file list here, BEFORE the
  // plan, eliminates the ambiguity. Validator still acts as a safety net.
  const lockedFiles = fileCtx.map(f => f.path);
  lines.push(
    `# Developer Autopilot — Execute plan ${findingId} (plan v${planVersion})`,
    ``,
    `## Codebase conventions + imports surface`,
    ``,
    `READ THIS FIRST. Apply these rules to every file you emit. Common`,
    `hallucinations the autopilot has made before are listed at the bottom`,
    `of the conventions block.`,
    ``,
    loadAutopilotContext(),
    ``,
    `---`,
    ``,
    `## LOCKED FILE LIST — DO NOT DEVIATE`,
    ``,
    `You MUST emit a \`<<<FILE …>>>\` block for ONLY these exact paths`,
    `(verbatim — copy them character-for-character):`,
    ``,
    ...lockedFiles.map(p => `- \`${p}\``),
    ``,
    `Hard rules:`,
    `- Do NOT emit any file outside this list — the post-LLM validator`,
    `  rejects the entire diff if it sees a path not in this list, and the`,
    `  ticket falls into self-heal.`,
    `- Do NOT translate paths (e.g. .ts ↔ .py). The codebase is TypeScript`,
    `  + Node only; Python paths are always hallucinations.`,
    `- If the plan implies an additional file you'd want to touch, do NOT`,
    `  add it. Instead, narrow the change to fit the locked list, or write`,
    `  the missing-file note in the PR_BODY for the operator to follow up.`,
    ``,
    `You are producing the exact file contents for a new branch \`${branch}\` that`,
    `will be opened as a pull request. Follow the plan **exactly**. Do not expand`,
    `scope — only touch the files in the LOCKED list above.`,
    ``,
    `## Plan`,
    ``,
    planMarkdown.slice(0, 60_000),
    ``,
  );
  // Inject recent validation-failure patterns scoped to the same scanner so
  // Claude's output avoids repeating known traps (wrong import paths,
  // jest shape mistakes, parse errors). Best-effort — missing lessons are
  // a no-op, the base prompt is unchanged.
  if (lessons && lessons.length > 0) {
    lines.push(
      `## Lessons from prior attempts`,
      ``,
      `These validation failures occurred on similar recent plans. Do NOT`,
      `repeat them:`,
      ``,
    );
    for (const l of lessons) {
      const header = l.mitigation_note && l.mitigation_note.trim().length > 0
        ? l.mitigation_note.trim()
        : `${l.pattern_type}: ${l.pattern_key}`;
      lines.push(`- **${header}**`);
      const example = (l.example_message || '').trim().split('\n')[0].slice(0, 240);
      if (example) lines.push(`  Example: ${example}`);
    }
    lines.push(``);
  }
  if (fileCtx.length > 0) {
    lines.push(
      `## Current state of each file the plan touches`,
      ``,
      `Each block below is the file as it currently exists on \`${GITHUB_BASE_BRANCH}\``,
      `(or a notice that it doesn't exist yet). Produce the **full new content** for`,
      `each file — not a diff.`,
      ``,
    );
    for (const f of fileCtx) {
      lines.push(`### \`${f.path}\``);
      if (f.exists) {
        lines.push(
          `State: exists on ${GITHUB_BASE_BRANCH}. Current content (${(f.content || '').length} chars):`,
          '```',
          (f.content || '').slice(0, MAX_FILE_BYTES),
          '```',
          ``,
        );
      } else {
        lines.push(`State: does NOT exist on ${GITHUB_BASE_BRANCH} — create it.`, ``);
      }
    }
  }
  lines.push(
    `## Output format — delimiter blocks, NOT JSON`,
    ``,
    `Emit output in this exact shape (and nothing else, no surrounding prose or`,
    `fences). File contents go VERBATIM between the markers — no escaping, no`,
    `quoting, newlines are literal:`,
    ``,
    `<<<PR_TITLE>>>`,
    `DEV-AUTOPILOT: short descriptive title (<=70 chars)`,
    `<<<END>>>`,
    ``,
    `<<<PR_BODY>>>`,
    `Markdown body that describes what this PR does and why. Can span many lines.`,
    `Reference the finding; summarise the plan; list the files touched.`,
    `<<<END>>>`,
    ``,
    `<<<FILE create services/gateway/src/routes/example.test.ts>>>`,
    `// full file contents go here, verbatim`,
    `import { foo } from 'bar';`,
    ``,
    `describe('example', () => {`,
    `  it('works', () => {`,
    `    expect(1).toBe(1);`,
    `  });`,
    `});`,
    `<<<END>>>`,
    ``,
    `Rules:`,
    `- Allowed actions in the FILE header: "create", "modify", "delete". For`,
    `  "delete" emit the header + immediately <<<END>>> with no content in`,
    `  between.`,
    `- Emit one <<<FILE …>>>…<<<END>>> block per file in the plan's`,
    `  Files-to-modify list. Do not emit files outside that list.`,
    `- File content is written verbatim — do NOT wrap it in Markdown code`,
    `  fences, do NOT escape quotes, do NOT use \\n; just write the actual`,
    `  characters.`,
    `- Never emit the literal string "<<<END>>>" inside a file's content;`,
    `  it terminates the block. In the extremely rare case you need to, split`,
    `  the string across lines or concatenation.`,
    `- Produce all PR_TITLE, PR_BODY, and FILE blocks in a single response.`,
    ``,
    `Start now.`,
  );
  return lines.join('\n');
}

/**
 * BOOTSTRAP-LLM-ROUTER (Phase E): execute direct-API call now goes through
 * the provider router. The router reads llm_routing_policy.policy.worker
 * and dispatches to the configured fallback provider (default Vertex /
 * gemini-2.5-pro with Anthropic / claude-opus-4-7 secondary fallback).
 *
 * This path only fires when the worker queue is unavailable (worker daemon
 * dead, binary missing) — the worker queue path at runExecutionSession()
 * remains the primary, free Claude-subscription route. Code generation
 * quality matters most here, which is why the worker (Claude subscription)
 * stays primary; Gemini 3.1 Pro is the fallback floor.
 */
async function callMessagesApi(
  prompt: string,
  vtid?: string | null,
): Promise<{ ok: boolean; text?: string; usage?: { input_tokens?: number; output_tokens?: number }; error?: string }> {
  const { callViaRouter } = await import('./llm-router');
  const r = await callViaRouter('worker', prompt, {
    vtid: vtid ?? null,
    service: 'dev-autopilot-execute',
    allowFallback: true,
    maxTokens: MESSAGES_MAX_TOKENS,
  });
  if (!r.ok) {
    return { ok: false, error: r.error || 'router returned ok=false' };
  }
  return {
    ok: true,
    text: r.text,
    usage: r.usage
      ? { input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens }
      : undefined,
  };
}

// VTID-02703: exported so the Cloud Run Job (services/gateway/src/job-entry.ts)
// can invoke the same logic out-of-process. The Job runtime survives
// container churn that kills long-running fire-and-forget LLM calls inside
// the gateway service.
export async function runExecutionSession(
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

  // VTID-AUTOPILOT-PR-FLOOD: final defense — refuse to start an execution
  // session if the same finding already has an OPEN GitHub PR from a prior
  // (non-terminal) execution. The earlier guard in approveAutoExecute /
  // autoApproveTick covers the auto-approve path, but the bridge's
  // spawnChildExecution() inserts directly into dev_autopilot_executions
  // for self-heal retries — bypassing both. Combined with the bridge's
  // DRY_RUN default of 'true' (revertExecutionPR is a no-op stub when
  // DEV_AUTOPILOT_DRY_RUN is unset), the parent's PR stays open while
  // the child execution opens a fresh one. The 2026-05-07 live test
  // reproduced this in 9 minutes (PRs #1964 + #1968 both open against
  // finding 709356c3). This check catches all paths regardless of how
  // the execution row got inserted, and it runs before any LLM/GitHub
  // cost is spent.
  const priorOpenR = await supa<Array<{ id: string; pr_url: string | null; pr_number: number | null; status: string }>>(
    s,
    `/rest/v1/dev_autopilot_executions?finding_id=eq.${exec.finding_id}`
    + `&id=neq.${executionId}`
    + `&pr_url=not.is.null`
    + `&status=not.in.(completed,self_healed,auto_archived)`
    + `&select=id,pr_url,pr_number,status&order=approved_at.desc&limit=1`,
  );
  if (priorOpenR.ok && priorOpenR.data && priorOpenR.data.length > 0) {
    const prior = priorOpenR.data[0];
    const reason = `finding ${exec.finding_id.slice(0, 8)} already has an unmerged PR `
      + `${prior.pr_url || `#${prior.pr_number}`} from execution ${prior.id.slice(0, 8)} `
      + `(status=${prior.status}); refusing to open a duplicate. `
      + `Close or merge the prior PR before retrying.`;
    return {
      ok: false,
      error: reason,
      session_id: `pr-flood-block-${executionId.slice(0, 8)}`,
    };
  }

  const planR = await supa<Array<{ plan_markdown: string; files_referenced: string[] }>>(
    s,
    `/rest/v1/dev_autopilot_plan_versions?finding_id=eq.${exec.finding_id}&version=eq.${exec.plan_version}&limit=1`,
  );
  if (!planR.ok || !planR.data || planR.data.length === 0) {
    return { ok: false, error: 'plan version not found' };
  }
  const plan = planR.data[0];

  const branch = `dev-autopilot/${executionId.slice(0, 8)}`;
  const sessionId = `msg_${randomUUID().slice(0, 12)}`;

  // VTID-02686: only DRY_RUN should short-circuit. The executor now routes
  // through callViaRouter('worker', ...) which can use any provider in the
  // active llm_routing_policy (Vertex/Gemini, DeepSeek, Anthropic). The
  // previous `!ANTHROPIC_API_KEY` short-circuit forced DRY_RUN even when
  // Vertex was the configured provider — silently producing stub PRs.
  if (DRY_RUN) {
    console.log(`${LOG_PREFIX} DRY RUN — skipping real session for ${executionId} (files: ${plan.files_referenced.length})`);
    const stubPr = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/pull/DRY-RUN-${executionId.slice(0, 8)}`;
    return {
      ok: true,
      pr_url: stubPr,
      pr_number: 0,
      branch,
      session_id: `dry_${executionId.slice(0, 8)}`,
    };
  }

  // Re-extract files_referenced from plan_markdown (see note in
  // approveAutoExecute). Falls back to the stored column for pathological
  // plans that lack a well-formed Files-to-modify section. VTID-02687:
  // for feedback-bridged findings, also fall back to the bridge-validated
  // spec_snapshot.proposed_files — that list is authoritative even when
  // the planner LLM produced markdown without parseable file paths AND
  // the stored files_referenced column is empty (stale plan_versions from
  // before VTID-02680).
  const freshFiles = extractFilePaths(plan.plan_markdown);
  let planFiles = freshFiles.length > 0 ? freshFiles : (plan.files_referenced || []);
  if (planFiles.length === 0) {
    const findR = await supa<Array<{ source_ref: string | null; spec_snapshot: Record<string, unknown> | null }>>(
      s,
      `/rest/v1/autopilot_recommendations?id=eq.${exec.finding_id}&select=source_ref,spec_snapshot&limit=1`,
    );
    const snap = findR.ok && findR.data && findR.data[0]?.spec_snapshot;
    const proposed = snap && Array.isArray((snap as { proposed_files?: unknown }).proposed_files)
      ? ((snap as { proposed_files?: unknown }).proposed_files as unknown[]).filter(
          (p): p is string => typeof p === 'string' && p.includes('/'),
        )
      : [];
    if (proposed.length > 0) {
      console.log(`${LOG_PREFIX} [${executionId.slice(0, 8)}] plan.files_referenced empty — falling back to spec_snapshot.proposed_files (${proposed.length} files)`);
      planFiles = proposed;
    }
  }
  if (planFiles.length === 0) {
    return { ok: false, error: 'plan has no files_referenced — cannot execute', session_id: sessionId };
  }
  if (planFiles.length > MAX_FILES_PER_EXECUTION) {
    return {
      ok: false,
      error: `plan references ${planFiles.length} files — exceeds MAX_FILES_PER_EXECUTION (${MAX_FILES_PER_EXECUTION})`,
      session_id: sessionId,
    };
  }

  // 1. Gather current file contents from the base branch
  console.log(`${LOG_PREFIX} [${executionId.slice(0, 8)}] fetching ${planFiles.length} files from ${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BASE_BRANCH}`);
  const fileCtx: FileCtx[] = [];
  for (const p of planFiles) {
    const got = await fetchFileContent(p, GITHUB_BASE_BRANCH);
    fileCtx.push({ path: p, exists: got.exists, content: got.content, sha: got.sha });
  }

  // Pull prior-attempt lessons for the finding's scanner so Claude avoids
  // repeating known traps. Best-effort — no rows / failed query just skips
  // the optional prompt section.
  const findingMetaR = await supa<Array<{ spec_snapshot: { scanner?: string } | null }>>(
    s,
    `/rest/v1/autopilot_recommendations?id=eq.${exec.finding_id}&select=spec_snapshot&limit=1`,
  );
  const findingScanner: string | null = findingMetaR.ok && findingMetaR.data && findingMetaR.data[0]?.spec_snapshot?.scanner
    ? String(findingMetaR.data[0].spec_snapshot.scanner)
    : null;
  const lessons = findingScanner ? await loadExecutionLessons(s, findingScanner) : [];

  // 2. Ask Claude to produce the new file contents. Routes through the
  // worker queue when DEV_AUTOPILOT_USE_WORKER=true (Claude subscription);
  // otherwise hits the Messages API directly (pay-per-token).
  //
  // When AUTOPILOT_WORKER_OWNS_PR=true, ALSO delegate the post-LLM work
  // (parse output, create branch, write files, open PR) to the worker.
  // The worker's local clone + GitHub token mean it can do the whole
  // sequence in a single long-lived process, sidestepping the Cloud Run
  // recycle-mid-flight problem that kept stranding executions.
  const ownsPr = isWorkerQueueEnabled() && isWorkerOwnsPrEnabled();
  const prompt = buildExecutionPrompt(exec.finding_id, exec.plan_version, plan.plan_markdown, fileCtx, branch, lessons);
  const startedAt = Date.now();
  // Widen the inline type so both call shapes satisfy the union we destructure
  // below (worker-queue path may carry pr_url/pr_number/branch from the
  // worker-owned-PR mode; direct Messages API never does).
  const llm: { ok: boolean; text?: string; usage?: { input_tokens?: number; output_tokens?: number }; error?: string; pr_url?: string; pr_number?: number; branch?: string; attempt_failures?: WorkerAttemptFailure[] } =
    isWorkerQueueEnabled()
      ? await runWorkerTask(
          {
            kind: 'execute',
            finding_id: exec.finding_id,
            execution_id: executionId,
            prompt,
            model: EXECUTION_MODEL,
            max_tokens: MESSAGES_MAX_TOKENS,
            notes: `execute ${executionId.slice(0, 8)}`,
            worker_owns_pr: ownsPr,
            branch_name: branch,
            base_branch: GITHUB_BASE_BRANCH,
            vtid_like: `VTID-DA-${executionId.slice(0, 8)}`,
          },
          { timeoutMs: MESSAGES_TIMEOUT_MS },
        )
      : await callMessagesApi(prompt, `VTID-DA-${executionId.slice(0, 8)}`);
  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  // Prompt-gap feedback loop: the worker reports per-attempt validation
  // failures via output_payload.attempt_failures. Upsert each into
  // dev_autopilot_prompt_learnings so future plan/execute prompts can
  // reference them. Best-effort — a learnings-persist failure must not
  // block the execution outcome. Runs even on LLM failure so we capture
  // exhausted-validation cases too.
  if (llm.attempt_failures && llm.attempt_failures.length > 0) {
    await persistAttemptFailures(s, llm.attempt_failures, {
      finding_id: exec.finding_id,
      execution_id: executionId,
    }).catch(err => console.error(`${LOG_PREFIX} persist learnings error:`, err));
  }

  if (!llm.ok || !llm.text) {
    return { ok: false, error: `LLM call failed after ${elapsed}s: ${llm.error || 'unknown'}`, session_id: sessionId, branch };
  }
  console.log(`${LOG_PREFIX} [${executionId.slice(0, 8)}] LLM returned in ${elapsed}s via ${isWorkerQueueEnabled() ? 'worker-queue' : 'messages-api'} (${llm.usage?.input_tokens || '?'} in / ${llm.usage?.output_tokens || '?'} out)`);

  // Worker-owned-PR path: the worker already created the branch + wrote
  // files + opened the PR. We just record what it did and hand control to
  // the watcher.
  if (ownsPr && llm.pr_url) {
    console.log(`${LOG_PREFIX} [${executionId.slice(0, 8)}] worker published PR ${llm.pr_url} (${llm.branch || branch})`);
    return {
      ok: true,
      pr_url: llm.pr_url,
      pr_number: llm.pr_number,
      branch: llm.branch || branch,
      session_id: sessionId,
    };
  }

  const parsed = parseExecutionJson(llm.text);
  if ('error' in parsed) {
    return { ok: false, error: `LLM output parse: ${parsed.error}`, session_id: sessionId, branch };
  }

  // 3a. Validate: every emitted file path was in the plan's files_referenced
  const allowedSet = new Set(planFiles);
  const outOfScope: string[] = [];
  for (const f of parsed.files) {
    if (!allowedSet.has(f.path)) outOfScope.push(f.path);
  }
  if (outOfScope.length > 0) {
    return {
      ok: false,
      error: `LLM emitted files outside the plan's files_referenced: ${outOfScope.join(', ')}`,
      session_id: sessionId,
      branch,
    };
  }
  if (parsed.files.length === 0) {
    return { ok: false, error: 'LLM emitted zero files', session_id: sessionId, branch };
  }

  // 3b. VTID-02641: validate the executor's diff covers ENOUGH of the plan.
  // The existing 3a check only catches files in the diff that are NOT in
  // the plan. It's silent when the diff covers a SUBSET of the plan — e.g.
  // closed PR #1102 had a 4-file plan (approvals.ts, autopilot.ts,
  // admin/index.ts, safety-gap.ts) but the diff only created the empty
  // safety-gap.ts placeholder. The PR opened anyway as dead code.
  // This check fails the execution when coverage falls below
  // PLAN_DIFF_COVERAGE_THRESHOLD so the LLM-shipped-half-the-plan failure
  // mode surfaces to self-healing instead of becoming a noisy PR.
  const coverage = validatePlanDiffCoverage(planFiles, parsed.files.map(f => f.path));
  if (!coverage.ok) {
    return {
      ok: false,
      error:
        `executor diff covers only ${Math.round(coverage.coverage * 100)}% of the plan's files `
        + `(${coverage.coveredCount}/${coverage.planCount}). `
        + `Missing: ${coverage.missing.slice(0, 5).join(', ')}`
        + (coverage.missing.length > 5 ? `, +${coverage.missing.length - 5} more` : ''),
      session_id: sessionId,
      branch,
    };
  }
  for (const f of parsed.files) {
    if (f.action !== 'delete' && (!f.content || f.content.length === 0)) {
      return { ok: false, error: `LLM emitted empty content for ${f.path}`, session_id: sessionId, branch };
    }
    if (f.content && Buffer.byteLength(f.content, 'utf-8') > MAX_FILE_BYTES) {
      return {
        ok: false,
        error: `content for ${f.path} exceeds MAX_FILE_BYTES (${MAX_FILE_BYTES})`,
        session_id: sessionId,
        branch,
      };
    }
  }

  // 4. Create branch
  console.log(`${LOG_PREFIX} [${executionId.slice(0, 8)}] creating branch ${branch} off ${GITHUB_BASE_BRANCH}`);
  const br = await createBranch(branch, GITHUB_BASE_BRANCH);
  if (!br.ok) return { ok: false, error: br.error, session_id: sessionId, branch };

  // 5. Write each file
  const vtidLike = `VTID-DA-${executionId.slice(0, 8)}`;
  for (const f of parsed.files) {
    const existing = fileCtx.find(x => x.path === f.path);
    if (f.action === 'delete') {
      if (!existing?.sha) {
        console.warn(`${LOG_PREFIX} [${executionId.slice(0, 8)}] delete skipped — ${f.path} doesn't exist`);
        continue;
      }
      const encoded = f.path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
      const delR = await githubRequest(
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encoded}`,
        {
          method: 'DELETE',
          body: { message: `${vtidLike}: delete ${f.path}`, sha: existing.sha, branch },
        },
      );
      if (!delR.ok) return { ok: false, error: `delete ${f.path}: ${delR.error}`, session_id: sessionId, branch };
      continue;
    }
    const shaArg = f.action === 'modify' ? existing?.sha : undefined;
    const msg = `${vtidLike}: ${f.action} ${f.path}`;
    const wr = await putFileToBranch(branch, f.path, f.content!, msg, shaArg);
    if (!wr.ok) return { ok: false, error: `write ${f.path}: ${wr.error}`, session_id: sessionId, branch };
  }

  // 5b. VTID-AUTOPILOT-NOEMPTY — refuse to open a PR with a 0-file diff.
  // See compareBranchFiles() for the failure mode this prevents.
  const cmp = await compareBranchFiles(branch, GITHUB_BASE_BRANCH);
  if (!cmp.ok) {
    return { ok: false, error: `compare ${branch}..${GITHUB_BASE_BRANCH}: ${cmp.error}`, session_id: sessionId, branch };
  }
  if ((cmp.changedFiles ?? 0) === 0) {
    return {
      ok: false,
      error: 'LLM output produced no actual diff — every emitted file matched main byte-for-byte. '
        + 'Either the model judged no change was needed (surface the gap in the plan instead of '
        + 'echoing existing content) or the diff was lost in serialization. Refusing to open an '
        + 'empty PR.',
      session_id: sessionId,
      branch,
    };
  }

  // 6. Open PR
  const prTitle = parsed.pr_title || `DEV-AUTOPILOT: execute plan ${executionId.slice(0, 8)}`;
  const prBody = parsed.pr_body || `Automated PR from Dev Autopilot execution \`${executionId}\`.\n\n---\n\n${plan.plan_markdown.slice(0, 40_000)}`;
  console.log(`${LOG_PREFIX} [${executionId.slice(0, 8)}] opening PR "${prTitle}"`);
  const pr = await openPullRequest(branch, GITHUB_BASE_BRANCH, prTitle, prBody);
  if (!pr.ok) return { ok: false, error: `open PR: ${pr.error}`, session_id: sessionId, branch };

  return {
    ok: true,
    pr_url: pr.url,
    pr_number: pr.number,
    branch,
    session_id: sessionId,
  };
}

// Exported for unit tests.
export { parseExecutionJson, buildExecutionPrompt };

// =============================================================================
// State reconciler — guarantees end-to-end execution
// =============================================================================
// The original watchdog only covered status='running' (20 min timeout). After
// a few real-world stuck executions (PRs #854 #798 sat in 'deploying' /
// 'merging' for 2+ days because the gateway missed an OASIS event), this
// reconciler covers every non-terminal stage:
//
//   ci         → query GitHub PR check status
//   merging    → query GitHub PR.merged
//   deploying  → query oasis_events for deploy.gateway.success on this branch
//   verifying  → curl /alive on the live gateway + check verification event
//
// For each stuck execution past its per-state timeout, the reconciler asks
// "what's actually true?" (GitHub + OASIS + HTTP probe). If reality says the
// stage is done, transition the row forward. If reality says the stage
// failed, mark failed + bridge to self-heal. If reality is genuinely still
// in flight (e.g. CI is slow), leave it alone.
//
// Cadence: runs every BACKGROUND_TICK_MS alongside the existing executor.
// Bounded: ≤10 rows reconciled per tick per state to cap GitHub API spend.

interface StuckExecRow {
  id: string;
  finding_id: string;
  status: string;
  pr_url: string | null;
  pr_number: number | null;
  branch: string | null;
  updated_at: string;
  metadata: Record<string, unknown> | null;
}

/** Per-state timeout. Beyond this, the state is considered "stuck" and
 *  the reconciler asks reality.
 *
 * VTID-02698: bumped `verifying` from 15m → 60m. The watcher's
 * `verificationWatcherTick` owns the verifying state with a 30m
 * window of error-event analysis; the executor's `reconcileVerifying`
 * was firing FIRST (at 15m) with a brittle single `/alive` probe and
 * marking healthy execs failed when the probe hit a 429 from a deploy-
 * churn rate-limit. Bumping past the watcher's window lets the proper
 * owner advance the state; the executor only steps in if the watcher
 * is genuinely broken. */
const RECONCILE_TIMEOUT_MS: Record<string, number> = {
  ci:        30 * 60 * 1000,  // 30 min
  merging:   15 * 60 * 1000,  // 15 min
  deploying: 30 * 60 * 1000,  // 30 min
  verifying: 60 * 60 * 1000,  // 60 min — must exceed watcher's 30m window
};

const RECONCILE_BATCH_SIZE = 10;

/**
 * VTID-AUTOPILOT-DUPMERGE: shared side-effect handler for any terminal
 * execution-status transition (regardless of which subsystem owns the
 * transition). Records outcome bookkeeping for both success/failure, AND on
 * SUCCESS flips the source recommendation `new → completed` so the next
 * autoApproveTick() doesn't re-pick the same finding.
 *
 * Bug history: this block originally lived inline in `patchExecution` only,
 * which meant it fired for the reconciler-owned terminal transitions but
 * NOT for the watcher-owned `verifying → completed` transition (the
 * normal happy path). Result: 2026-05-04 drain produced 4 separate merged
 * PRs for finding 4bc912a4 (#1629/#1648/#1653/#1667 all touching
 * services/gateway/src/routes/telemetry.ts) — the watcher merged each one
 * cleanly, but never flipped the recommendation, so autoApproveTick re-
 * approved the same finding on the next 30s tick. Centralizing here lets
 * `dev-autopilot-watcher.ts:transitionStatus` call the same path.
 *
 * Exported (not just internal) so the watcher can import it without a
 * circular dependency (watcher → execute is the only direction in use).
 *
 * Fire-and-forget by design: outcome bookkeeping must never fail the
 * primary status patch. Errors are logged, not thrown.
 */
export function applyExecTerminalSideEffects(
  s: SupaConfig,
  executionId: string,
  status: string,
): void {
  if (status !== 'completed' && status !== 'failed') return;
  void (async () => {
    try {
      const lookupR = await supa<Array<{ finding_id: string; pr_url: string | null; pr_number: number | null }>>(
        s,
        `/rest/v1/dev_autopilot_executions?id=eq.${executionId}&select=finding_id,pr_url,pr_number&limit=1`,
      );
      if (!lookupR.ok) return;
      const exec = lookupR.data?.[0];
      if (!exec || !exec.finding_id) return;
      const finding_id = exec.finding_id;

      await recordExecOutcome(
        finding_id,
        status === 'completed' ? 'success' : 'failure',
      );

      if (status !== 'completed') return;

      // Only flip findings that are still 'new' — preserves any human
      // override (rejected/snoozed/activated) the operator may have set.
      const findingPatchR = await supa(
        s,
        `/rest/v1/autopilot_recommendations?id=eq.${finding_id}&status=eq.new`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'completed',
            merged_pr_url: exec.pr_url ?? null,
            merged_pr_number: exec.pr_number ?? null,
            completed_at: new Date().toISOString(),
          }),
        },
      );
      if (findingPatchR.ok) {
        await emitOasisEvent({
          vtid: EXEC_VTID,
          type: 'dev_autopilot.finding.completed',
          source: 'dev-autopilot',
          status: 'success',
          message: `Finding ${finding_id.slice(0, 8)} completed via execution ${executionId.slice(0, 8)}`
            + (exec.pr_number ? ` (PR #${exec.pr_number})` : ''),
          payload: {
            finding_id,
            execution_id: executionId,
            pr_url: exec.pr_url ?? null,
            pr_number: exec.pr_number ?? null,
          },
        });
      } else {
        // Don't propagate — outcome bookkeeping is best-effort.
        console.warn(
          `${LOG_PREFIX} finding completion patch failed for ${finding_id.slice(0, 8)}: ${findingPatchR.error}`,
        );
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} outcome / finding-completion backfill error for ${executionId.slice(0, 8)}:`, err);
    }
  })();
}

async function patchExecution(
  s: SupaConfig,
  id: string,
  fields: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const r = await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  });
  if (r.ok && typeof fields.status === 'string') {
    applyExecTerminalSideEffects(s, id, fields.status);
  }

  // VTID-02001: surface successful auto-fixes to the Self-Healing screen.
  // self_healing_log was a failure-only log; without this the screen shows
  // 100% escalation and the user can't tell autonomy is actually closing
  // findings. We record `fixed` for `completed` and `rolled_back` for
  // `reverted`. `failed_escalated` is already covered by the bridge writer
  // and `failed`/`cancelled` aren't healing outcomes worth surfacing as
  // distinct rows.
  if (
    r.ok &&
    (fields.status === 'completed' || fields.status === 'reverted')
  ) {
    void (async () => {
      try {
        const lookupR = await supa<
          Array<{
            finding_id: string;
            plan_version: number | null;
            pr_url: string | null;
            completed_at: string | null;
            created_at: string | null;
          }>
        >(
          s,
          `/rest/v1/dev_autopilot_executions?id=eq.${id}` +
            `&select=finding_id,plan_version,pr_url,completed_at,created_at&limit=1`,
        );
        const exec = lookupR.ok ? lookupR.data?.[0] : null;
        if (!exec) return;

        let endpoint = `autopilot.execute`;
        if (exec.finding_id) {
          const fR = await supa<Array<{ spec_snapshot: { file_path?: string } | null }>>(
            s,
            `/rest/v1/autopilot_recommendations?id=eq.${exec.finding_id}&select=spec_snapshot&limit=1`,
          );
          const fp = fR.ok && fR.data?.[0]?.spec_snapshot?.file_path;
          if (fp) endpoint = String(fp);
        }

        const outcome: 'fixed' | 'rolled_back' =
          fields.status === 'completed' ? 'fixed' : 'rolled_back';

        await writeAutopilotSuccess(s, {
          vtid: `VTID-DA-${id.slice(0, 8)}`,
          endpoint,
          outcome,
          diagnosis: {
            summary:
              outcome === 'fixed'
                ? `Auto-fix applied via ${exec.pr_url || 'PR'} (plan v${exec.plan_version ?? '?'})`
                : `Auto-fix reverted via ${exec.pr_url || 'PR'} (plan v${exec.plan_version ?? '?'}) — verifier or watchdog rolled back`,
            execution_id: id,
            finding_id: exec.finding_id,
            plan_version: exec.plan_version ?? null,
            pr_url: exec.pr_url ?? null,
            completed_at: exec.completed_at ?? null,
          },
          createdAtIso: exec.created_at || undefined,
          resolvedAtIso: exec.completed_at || undefined,
        });
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} self_healing_log success-write error for ${id.slice(0, 8)}:`,
          err,
        );
      }
    })();
  }
  return { ok: r.ok, error: r.error };
}

async function bridgeFailure(executionId: string, stage: string, error: string): Promise<void> {
  try {
    const { bridgeFailureToSelfHealing } = require('./dev-autopilot-bridge');
    await bridgeFailureToSelfHealing({ execution_id: executionId, failure_stage: stage, error });
  } catch (err) {
    console.error(`${LOG_PREFIX} bridge load error for ${executionId}:`, err);
  }
}

/** Reconcile status='ci'. Source of truth: GitHub PR check runs. */
async function reconcileCi(s: SupaConfig, exec: StuckExecRow): Promise<void> {
  if (!exec.pr_number) {
    console.warn(`${LOG_PREFIX} reconcile/ci: ${exec.id.slice(0, 8)} has no pr_number — leaving alone`);
    return;
  }
  // GET /repos/{owner}/{repo}/commits/{ref}/check-runs gives the PR head sha's
  // checks. Simpler: GET /pulls/{n} gives mergeable_state which summarizes.
  const prR = await githubRequest<{
    state: 'open' | 'closed';
    merged: boolean;
    mergeable_state: 'clean' | 'unstable' | 'dirty' | 'blocked' | 'behind' | 'has_hooks' | 'unknown';
    head: { sha: string };
  }>(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls/${exec.pr_number}`);
  if (!prR.ok || !prR.data) {
    console.warn(`${LOG_PREFIX} reconcile/ci: PR lookup failed for ${exec.id.slice(0, 8)}: ${prR.error}`);
    return;
  }

  if (prR.data.merged) {
    // Already merged (CI green and watcher merged) — advance to deploying.
    await patchExecution(s, exec.id, { status: 'deploying' });
    await emitOasisEvent({
      vtid: EXEC_VTID,
      type: 'dev_autopilot.execution.pr_merged',
      source: 'dev-autopilot',
      status: 'success',
      message: `Reconciler: ${exec.id.slice(0, 8)} PR #${exec.pr_number} already merged — advancing to deploying`,
      payload: { execution_id: exec.id, pr_number: exec.pr_number, reconciled_from: 'ci' },
    });
    return;
  }

  if (prR.data.state === 'closed' && !prR.data.merged) {
    // PR closed without merge — terminal "PR was handled" state. Mark
    // status='auto_archived' (NOT 'failed') so the runExecutionSession +
    // approveAutoExecute PR-flood guards stop treating this finding as
    // stranded. Without auto_archived, the operator's manual close keeps
    // the finding blocked forever — the original bug that forced the
    // 2026-05-07 cleanup. Skip bridgeFailure too: spawning a self-heal
    // child here would burn an LLM call to re-fix a finding whose
    // proposed PR was just closed (operator/CI rejected it). If the
    // finding is still actionable, autoApproveTick will pick it up on
    // its next sweep — bounded by the per-finding retry cap.
    await patchExecution(s, exec.id, {
      status: 'auto_archived',
      completed_at: new Date().toISOString(),
      metadata: { ...(exec.metadata || {}), error: 'reconciler: PR closed without merge (auto_archived)' },
    });
    await emitOasisEvent({
      vtid: EXEC_VTID,
      type: 'dev_autopilot.execution.auto_archived',
      source: 'dev-autopilot',
      status: 'info',
      message: `Reconciler: ${exec.id.slice(0, 8)} PR #${exec.pr_number} closed without merge — auto_archived`,
      payload: { execution_id: exec.id, pr_number: exec.pr_number, reason: 'pr_closed_unmerged' },
    });
    return;
  }

  // CI may be still running (mergeable_state='unstable') or blocked.
  // 'dirty' or 'blocked' for >timeout means CI failed or the PR has unresolved
  // conflicts — failure. 'unstable' typically means a check is still running;
  // leave alone.
  if (prR.data.mergeable_state === 'dirty' || prR.data.mergeable_state === 'blocked') {
    await patchExecution(s, exec.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      metadata: { ...(exec.metadata || {}), error: `reconciler: PR mergeable_state=${prR.data.mergeable_state} after ${RECONCILE_TIMEOUT_MS.ci / 60_000}m` },
    });
    await emitOasisEvent({
      vtid: EXEC_VTID,
      type: 'dev_autopilot.execution.ci_failed',
      source: 'dev-autopilot',
      status: 'error',
      message: `Reconciler: ${exec.id.slice(0, 8)} PR #${exec.pr_number} mergeable_state=${prR.data.mergeable_state}`,
      payload: { execution_id: exec.id, pr_number: exec.pr_number, mergeable_state: prR.data.mergeable_state },
    });
    bridgeFailure(exec.id, 'ci', `PR mergeable_state=${prR.data.mergeable_state}`).catch(() => {});
  }
  // else: CI still in flight, leave alone.
}

/** Reconcile status='merging'. Source of truth: GitHub PR.merged. */
async function reconcileMerging(s: SupaConfig, exec: StuckExecRow): Promise<void> {
  if (!exec.pr_number) return;
  const prR = await githubRequest<{ state: string; merged: boolean }>(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls/${exec.pr_number}`,
  );
  if (!prR.ok || !prR.data) return;
  if (prR.data.merged) {
    await patchExecution(s, exec.id, { status: 'deploying' });
    await emitOasisEvent({
      vtid: EXEC_VTID,
      type: 'dev_autopilot.execution.pr_merged',
      source: 'dev-autopilot',
      status: 'success',
      message: `Reconciler: ${exec.id.slice(0, 8)} PR #${exec.pr_number} merged — advancing to deploying`,
      payload: { execution_id: exec.id, pr_number: exec.pr_number, reconciled_from: 'merging' },
    });
  } else if (prR.data.state === 'closed') {
    await patchExecution(s, exec.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      metadata: { ...(exec.metadata || {}), error: 'reconciler: PR closed without merge while in merging' },
    });
    bridgeFailure(exec.id, 'merging', 'PR closed without merge').catch(() => {});
  }
  // else: stuck on auto-merge — leave to watcher one more cycle.
}

/** Reconcile status='deploying'. Source of truth: oasis_events for
 *  deploy.gateway.success or any event tagged with the merge SHA / branch. */
async function reconcileDeploying(s: SupaConfig, exec: StuckExecRow): Promise<void> {
  // VTID-02697: Two bugs in the previous version:
  //   1. Filtered on `type=in.(...)` but the column is `topic` — the request
  //      400'd, returned empty, and we always concluded "no deploy event"
  //      regardless of reality.
  //   2. Even when the column was right, it took ANY recent deploy event
  //      across the platform as proof that THIS exec deployed. False
  //      positive risk during concurrent autopilot runs.
  //
  // Fixed query uses `topic` and selects `metadata` so we can match by
  // merge SHA (set on the exec when the watcher merges its PR).
  const since = new Date(Date.now() - RECONCILE_TIMEOUT_MS.deploying * 2).toISOString();
  const deployR = await supa<Array<{ id: string; topic: string; created_at: string; metadata?: Record<string, unknown> }>>(s,
    `/rest/v1/oasis_events?topic=in.(deploy.gateway.success,deploy.success,vtid.lifecycle.deployed)`
    + `&created_at=gte.${since}&order=created_at.desc&limit=20&select=id,topic,created_at,metadata`);
  if (deployR.ok && deployR.data && deployR.data.length > 0) {
    const mergeSha = (exec.metadata as { merge_sha?: string } | null | undefined)?.merge_sha;
    // Prefer events whose git_commit matches the exec's merge SHA. If the
    // exec has no merge_sha (older row from before VTID-02697), fall back
    // to the original "any recent deploy success" behavior.
    const matched = mergeSha
      ? deployR.data.find((e) => {
          const m = (e.metadata as { git_commit?: string } | null | undefined);
          return typeof m?.git_commit === 'string' && m.git_commit === mergeSha;
        })
      : deployR.data[0];
    if (matched) {
      await patchExecution(s, exec.id, { status: 'verifying' });
      await emitOasisEvent({
        vtid: EXEC_VTID,
        type: 'dev_autopilot.execution.deployed',
        source: 'dev-autopilot',
        status: 'success',
        message: `Reconciler: ${exec.id.slice(0, 8)} deploy success event observed — advancing to verifying`,
        payload: { execution_id: exec.id, deploy_event_id: matched.id, reconciled_from: 'deploying', matched_by: mergeSha ? 'merge_sha' : 'recency' },
      });
      return;
    }
  }

  // No deploy event seen within the look-back window — fail.
  await patchExecution(s, exec.id, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    metadata: { ...(exec.metadata || {}), error: `reconciler: no deploy success event observed after ${RECONCILE_TIMEOUT_MS.deploying / 60_000}m in deploying` },
  });
  await emitOasisEvent({
    vtid: EXEC_VTID,
    type: 'dev_autopilot.execution.deploy_failed',
    source: 'dev-autopilot',
    status: 'error',
    message: `Reconciler: ${exec.id.slice(0, 8)} stuck in deploying with no observed deploy event`,
    payload: { execution_id: exec.id, reason: 'no_deploy_event_observed' },
  });
  bridgeFailure(exec.id, 'deploying', 'No deploy event observed').catch(() => {});
}

/** Reconcile status='verifying'. Source of truth: HTTP /alive probe + any
 *  recent verification-passed event. */
async function reconcileVerifying(s: SupaConfig, exec: StuckExecRow): Promise<void> {
  // Look for a verification event tagged for this execution.
  // VTID-02697: same fix as reconcileDeploying — column is `topic`, not
  // `type`. The previous query 400'd silently.
  const since = new Date(Date.now() - RECONCILE_TIMEOUT_MS.verifying * 2).toISOString();
  const verifyR = await supa<Array<{ id: string; topic: string }>>(s,
    `/rest/v1/oasis_events?topic=in.(dev_autopilot.execution.verification_passed,vtid.lifecycle.completed)`
    + `&created_at=gte.${since}&order=created_at.desc&limit=10&select=id,topic`);
  if (verifyR.ok && verifyR.data && verifyR.data.length > 0) {
    await patchExecution(s, exec.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });
    await emitOasisEvent({
      vtid: EXEC_VTID,
      type: 'dev_autopilot.execution.completed',
      source: 'dev-autopilot',
      status: 'success',
      message: `Reconciler: ${exec.id.slice(0, 8)} verification observed — completing`,
      payload: { execution_id: exec.id, reconciled_from: 'verifying' },
    });
    return;
  }

  // No verification event — best-effort: probe /alive ourselves. If 200,
  // call it good.
  //
  // VTID-02698: probe up to 3 times with 5s spacing. A single transient
  // 429 (rate-limited during deploy churn) or 503 (Cloud Run cold start)
  // shouldn't fail an execution that's otherwise healthy. Only treat
  // 4xx-non-429 / 5xx-non-503 / network errors as definitive failure.
  const gatewayUrl = process.env.GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';
  let alive = false;
  let lastStatus: number | null = null;
  for (let attempt = 0; attempt < 3 && !alive; attempt++) {
    if (attempt > 0) await new Promise((res) => setTimeout(res, 5000));
    try {
      const r = await fetch(`${gatewayUrl}/alive`);
      lastStatus = r.status;
      if (r.ok) { alive = true; break; }
      // 429/503 = transient, retry. Anything else = definitive non-alive.
      if (r.status !== 429 && r.status !== 503) break;
    } catch { /* network error — retry */ }
  }

  if (alive) {
    await patchExecution(s, exec.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });
    await emitOasisEvent({
      vtid: EXEC_VTID,
      type: 'dev_autopilot.execution.completed',
      source: 'dev-autopilot',
      status: 'success',
      message: `Reconciler: ${exec.id.slice(0, 8)} /alive ok — completing`,
      payload: { execution_id: exec.id, reconciled_from: 'verifying', via: 'alive_probe' },
    });
    return;
  }

  // VTID-02698: spread existing metadata so we don't blow away merge_sha
  // (set by the watcher at merge) or other fields the reconciler may
  // need on subsequent passes / for postmortem.
  await patchExecution(s, exec.id, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    metadata: {
      ...(exec.metadata || {}),
      error: `reconciler: /alive failed after ${RECONCILE_TIMEOUT_MS.verifying / 60_000}m in verifying (last_status=${lastStatus})`,
    },
  });
  bridgeFailure(exec.id, 'verifying', '/alive probe failed').catch(() => {});
}

/** Top-level reconciler. Iterates each non-terminal status with a per-state
 *  timeout and queries reality to transition or fail. Bounded per tick. */
export async function reconcileStuckExecutions(s: SupaConfig): Promise<void> {
  for (const status of Object.keys(RECONCILE_TIMEOUT_MS)) {
    const cutoff = new Date(Date.now() - RECONCILE_TIMEOUT_MS[status]).toISOString();
    const stuckR = await supa<StuckExecRow[]>(s,
      `/rest/v1/dev_autopilot_executions?status=eq.${status}&updated_at=lt.${cutoff}`
      + `&select=id,finding_id,status,pr_url,pr_number,branch,updated_at,metadata`
      + `&order=updated_at.asc&limit=${RECONCILE_BATCH_SIZE}`);
    if (!stuckR.ok || !stuckR.data || stuckR.data.length === 0) continue;
    console.log(`${LOG_PREFIX} reconciler: ${stuckR.data.length} execution(s) stuck in '${status}'`);
    for (const exec of stuckR.data) {
      try {
        if (status === 'ci')         await reconcileCi(s, exec);
        else if (status === 'merging')   await reconcileMerging(s, exec);
        else if (status === 'deploying') await reconcileDeploying(s, exec);
        else if (status === 'verifying') await reconcileVerifying(s, exec);
      } catch (err) {
        console.error(`${LOG_PREFIX} reconciler error on ${exec.id} [${status}]:`, err);
      }
    }
  }
}

/** Main tick — called every BACKGROUND_TICK_MS. Idempotent. */
export async function backgroundExecutorTick(): Promise<void> {
  const s = getSupabase();
  if (!s) return;

  // 0. Reclaim worker-queue rows stuck in 'running' or 'pending' past their
  // watchdog windows. Pending rows accumulate when no worker daemon is alive
  // to claim them — the running-watchdog can't see those. Each pending
  // reclaim writes a self_healing_log row directly so the Self-Healing
  // screen surfaces queue jams even when no caller is left waiting.
  if (isWorkerQueueEnabled()) {
    const reclaimRunning = await reclaimStuckWorkerTasks();
    const reclaimPending = await reclaimStuckPendingWorkerTasks();
    if (reclaimRunning.reclaimed > 0 || reclaimPending.reclaimed > 0) {
      console.log(
        `${LOG_PREFIX} watchdog reclaimed ${reclaimRunning.reclaimed} running + ${reclaimPending.reclaimed} pending worker task(s)`,
      );
    }
  }

  // 0b. Reclaim execution rows stuck in 'running'. Cloud Run recycles
  // containers every few minutes, killing in-flight fire-and-forget
  // runExecutionSession promises. The row never gets updated and sits in
  // 'running' forever. Anything that's been running > STUCK_EXECUTION_MS
  // and has no branch/pr_url yet is almost certainly abandoned — mark it
  // failed and bridge it into self-heal.
  const STUCK_EXECUTION_MS = 20 * 60 * 1000; // 20 min — plenty of slack for a normal execute (5-10 min)
  try {
    const cutoff = new Date(Date.now() - STUCK_EXECUTION_MS).toISOString();
    const stuckR = await supa<Array<{ id: string; finding_id: string; updated_at: string }>>(
      s,
      `/rest/v1/dev_autopilot_executions?status=eq.running&updated_at=lt.${cutoff}&select=id,finding_id,updated_at&limit=10`,
    );
    if (stuckR.ok && stuckR.data && stuckR.data.length > 0) {
      for (const stuck of stuckR.data) {
        const reclaim = await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${stuck.id}&status=eq.running`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'failed',
            completed_at: new Date().toISOString(),
            metadata: { error: `watchdog: stuck in 'running' > ${STUCK_EXECUTION_MS / 60_000}m (container recycled mid-execution)` },
          }),
        });
        if (reclaim.ok) {
          console.log(`${LOG_PREFIX} watchdog reclaimed stuck execution ${stuck.id.slice(0, 8)}`);
          await emitOasisEvent({
            vtid: EXEC_VTID,
            type: 'dev_autopilot.execution.failed',
            source: 'dev-autopilot',
            status: 'error',
            message: `Execution ${stuck.id.slice(0, 8)} reclaimed by watchdog (stuck in running)`,
            payload: { execution_id: stuck.id, finding_id: stuck.finding_id, reason: 'stuck_in_running' },
          });
          try {
            const { bridgeFailureToSelfHealing } = require('./dev-autopilot-bridge');
            bridgeFailureToSelfHealing({ execution_id: stuck.id, failure_stage: 'ci', error: 'watchdog reclaim: stuck in running' })
              .catch((err: unknown) => console.error(`${LOG_PREFIX} bridge error for reclaimed ${stuck.id}:`, err));
          } catch (err) {
            console.error(`${LOG_PREFIX} bridge load error for reclaimed ${stuck.id}:`, err);
          }
        }
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} execution watchdog error:`, err);
  }

  // 0c. State reconciler — for executions stuck in ci / merging / deploying /
  // verifying past their per-state timeout, query reality (GitHub + OASIS +
  // /alive probe) and either advance them or mark them failed + bridge to
  // self-heal. Bounded per tick so GitHub API spend is capped.
  try {
    await reconcileStuckExecutions(s);
  } catch (err) {
    console.error(`${LOG_PREFIX} reconciler error:`, err);
  }

  // 0c-bis. VTID-02669: feedback ticket completion reconciler. Closes
  // feedback_tickets whose linked dev_autopilot_executions reached a
  // terminal state (completed → resolved + playwright_verified stamp;
  // failed → needs_more_info with note). Without this, a completed run
  // leaves the ticket in_progress forever and the supervisor never gets
  // a "shipped" signal.
  try {
    const { reconcileCompletedFeedbackTickets } = await import('./feedback-completion-reconciler');
    const r = await reconcileCompletedFeedbackTickets(s);
    if (r.closed > 0 || r.failed > 0) {
      console.log(`${LOG_PREFIX} feedback-completion: closed=${r.closed} failed=${r.failed}`);
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} feedback-completion reconciler error:`, err);
  }

  // 0d. Auto-archive watchdog: any execution in a terminal-failure state
  // (failed / failed_escalated / reverted / cancelled) whose updated_at is
  // older than AUTO_ARCHIVE_DAYS gets moved to status='auto_archived' so
  // the queue + Self-Healing UI don't accumulate stale entries forever.
  // The escalation event already wrote to self_healing_log; archiving here
  // doesn't lose context.
  const AUTO_ARCHIVE_DAYS = Number.parseInt(process.env.AUTOPILOT_AUTO_ARCHIVE_DAYS || '7', 10);
  try {
    const cutoff = new Date(Date.now() - AUTO_ARCHIVE_DAYS * 86_400_000).toISOString();
    const archR = await supa(s,
      `/rest/v1/dev_autopilot_executions?status=in.(failed,failed_escalated,reverted,cancelled)`
      + `&updated_at=lt.${cutoff}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'auto_archived',
          updated_at: new Date().toISOString(),
        }),
      });
    if (archR.ok) {
      // PATCH return=minimal doesn't give us a count; log when the query
      // actually matched anything by re-querying — cheap and only fires on
      // archival activity.
      const sampleR = await supa<Array<{ id: string }>>(s,
        `/rest/v1/dev_autopilot_executions?status=eq.auto_archived&updated_at=gte.${new Date(Date.now() - 60_000).toISOString()}&select=id&limit=20`);
      if (sampleR.ok && sampleR.data && sampleR.data.length > 0) {
        console.log(`${LOG_PREFIX} auto-archive: ${sampleR.data.length} terminal-failure execution(s) archived (>${AUTO_ARCHIVE_DAYS}d old)`);
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} auto-archive error:`, err);
  }

  // 1. Honor kill switch — VTID-02676: feedback-lane executions bypass it.
  //    The kill switch was armed against an unrelated planner-hallucination
  //    incident that doesn't apply to feedback findings (Devon prompt +
  //    bridge pre-flight + planner LOCKED file list are dedicated guards).
  //    When kill_switch=true, we still run the tick but post-filter cooling
  //    rows to feedback-lane only.
  const cfg = await loadConfig(s);
  if (!cfg) return;

  // 2. Concurrency cap
  const running = await countRunningExecutions(s);
  const slots = Math.max(0, cfg.concurrency_cap - running);
  if (slots === 0) return;

  // 3. Pick cooling executions past execute_after, oldest first.
  //    Embed the recommendation so we can filter to feedback-lane when
  //    kill_switch is armed. Over-fetch (slots * 4) to ensure enough
  //    feedback rows survive the JS filter.
  const now = new Date().toISOString();
  const fetchLimit = cfg.kill_switch ? slots * 4 : slots;
  const readyR = await supa<Array<ExecutionRow & {
    recommendation?: { source_type?: string; source_ref?: string } | null;
  }>>(
    s,
    `/rest/v1/dev_autopilot_executions?status=eq.cooling&execute_after=lte.${encodeURIComponent(now)}&order=execute_after.asc&limit=${fetchLimit}`
    + `&select=id,finding_id,plan_version,auto_fix_depth,recommendation:autopilot_recommendations!finding_id(source_type,source_ref)`,
  );
  if (!readyR.ok || !readyR.data || readyR.data.length === 0) return;

  const isFeedbackLane = (rec: { source_type?: string; source_ref?: string } | null | undefined) =>
    rec?.source_type === 'dev_autopilot'
    && typeof rec?.source_ref === 'string'
    && rec.source_ref.startsWith('feedback_ticket:');
  const filteredRows = cfg.kill_switch
    ? (readyR.data || []).filter(r => isFeedbackLane(r.recommendation ?? null)).slice(0, slots)
    : (readyR.data || []).slice(0, slots);
  if (filteredRows.length === 0) return;
  if (cfg.kill_switch) {
    console.log(`${LOG_PREFIX} kill_switch armed — claiming ${filteredRows.length} feedback-lane cooling execution(s)`);
  }

  for (const exec of filteredRows) {
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

    // VTID-02703: dispatch path — Cloud Run Job (durable) or in-process (fast).
    // The Job runtime survives container churn that kills long-running
    // fire-and-forget Promises. Used for orb-live.ts and any execution
    // expected to take >3 min. Falls back to in-process when the Job
    // dispatch isn't configured or fails to enqueue.
    if (USE_JOB_RUNTIME) {
      try {
        const dispatched = await dispatchExecutorJob(exec.id);
        if (dispatched.ok) {
          // The Job calls runExecutionSession + applyExecutionResult on its
          // own. The gateway's job is done for this exec — return so we
          // don't double-fire.
          continue;
        }
        console.warn(`${LOG_PREFIX} Job dispatch failed for ${exec.id}: ${dispatched.error}; falling back to in-process`);
      } catch (err) {
        console.error(`${LOG_PREFIX} Job dispatch threw for ${exec.id}:`, err);
      }
    }

    // In-process fallback (existing behaviour). Fire-and-forget so one
    // long-running session doesn't block sibling claims.
    runExecutionSession(s, exec.id).then(async (result) => {
      await applyExecutionResult(s, exec.id, result);
    }).catch((err) => {
      console.error(`${LOG_PREFIX} unhandled executor error for ${exec.id}:`, err);
    });
  }
}

/**
 * VTID-02703: dispatch a Cloud Run Job execution for the given exec_id.
 *
 * Uses the Cloud Run Admin REST API:
 *   POST /v2/projects/{project}/locations/{region}/jobs/{job}:run
 *   body: { overrides: { containerOverrides: [{ env: [{name:'EXEC_ID', value:execId}] }] } }
 *
 * Authentication: relies on the gateway's GCP service account (auto-mounted
 * via google-github-actions/auth in CI; in production the Cloud Run service
 * uses the workload identity bound to its runtime SA, which has
 * roles/run.invoker on the Job).
 *
 * Returns immediately after triggering — the Job runs asynchronously and
 * writes back to the DB itself via job-entry.ts → applyExecutionResult.
 */
async function dispatchExecutorJob(execId: string): Promise<{ ok: boolean; error?: string; operation?: string }> {
  try {
    // Get an OAuth token from the metadata server (works on Cloud Run / GKE).
    // Falls back to gcloud-printed creds in dev (GOOGLE_APPLICATION_CREDENTIALS).
    const token = await getGcpAccessToken();
    if (!token) {
      return { ok: false, error: 'no GCP access token (metadata server unreachable)' };
    }
    const url = `https://run.googleapis.com/v2/projects/${JOB_PROJECT}/locations/${JOB_REGION}/jobs/${JOB_NAME}:run`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        overrides: {
          containerOverrides: [{
            env: [{ name: 'EXEC_ID', value: execId }],
          }],
        },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '?');
      return { ok: false, error: `${res.status}: ${detail.slice(0, 300)}` };
    }
    const body = await res.json().catch(() => ({})) as { name?: string };
    console.log(`${LOG_PREFIX} dispatched Job ${JOB_NAME} for exec=${execId.slice(0, 8)} op=${body.name || '?'}`);
    return { ok: true, operation: body.name };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * VTID-02703: get an access token for the Cloud Run Admin API.
 * On Cloud Run / GKE: read from the metadata server (default SA).
 * On dev / local: rely on GOOGLE_APPLICATION_CREDENTIALS being set.
 */
async function getGcpAccessToken(): Promise<string | null> {
  try {
    // Cloud Run mounts the metadata server at this fixed address.
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } as any },
    );
    if (!res.ok) return null;
    const body = await res.json() as { access_token?: string };
    return body.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * VTID-02703: writes the outcome of a runExecutionSession invocation back
 * to the DB and emits the appropriate OASIS event. Shared between the
 * gateway's in-process executor tick and the Cloud Run Job entry point so
 * both runtimes converge on identical post-execution state.
 */
export async function applyExecutionResult(
  s: SupaConfig,
  execId: string,
  result: { ok: boolean; pr_url?: string; branch?: string; pr_number?: number; session_id?: string; error?: string },
): Promise<void> {
  if (result.ok && result.pr_url) {
    await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${execId}`, {
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
      message: `Execution ${execId.slice(0, 8)} opened ${result.pr_url}`,
      payload: { execution_id: execId, pr_url: result.pr_url, branch: result.branch },
    });
    return;
  }

  await supa(s, `/rest/v1/dev_autopilot_executions?id=eq.${execId}`, {
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
    message: `Execution ${execId.slice(0, 8)} failed: ${result.error || 'unknown'}`,
    payload: { execution_id: execId, error: result.error },
  });
  try {
    const { bridgeFailureToSelfHealing } = require('./dev-autopilot-bridge');
    bridgeFailureToSelfHealing({
      execution_id: execId,
      failure_stage: 'ci',
      error: result.error,
    }).catch((err: unknown) => {
      console.error(`${LOG_PREFIX} bridge error for ${execId}:`, err);
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} bridge load error for ${execId}:`, err);
  }
}

/**
 * Auto-approve tick — picks eligible `status='new'` findings and calls
 * approveAutoExecute on their behalf. Runs alongside backgroundExecutorTick.
 *
 * Eligibility is gated by dev_autopilot_config:
 *   - auto_approve_enabled must be true (default false, opt-in per env).
 *   - kill_switch must be false (same gate as manual approval).
 *   - finding's risk_class must be in auto_approve_risk_classes.
 *   - finding's effort_score must be <= auto_approve_max_effort.
 *   - finding's scanner must be in auto_approve_scanners.
 *   - A plan version must already exist (approveAutoExecute enforces this
 *     too; we filter here to avoid calling approveAutoExecute on findings
 *     that would just error).
 *
 * Budget / concurrency caps are respected up-front so we don't burn through
 * the daily budget in a single burst. The per-tick cap (5) is deliberate:
 * it prevents a backlog flush if auto-approve is freshly enabled.
 *
 * The safety gate (evaluateSafetyGate inside approveAutoExecute) still runs
 * on every finding — this function only automates the "click Approve" step.
 */
export async function autoApproveTick(): Promise<void> {
  const s = getSupabase();
  if (!s) return;

  const cfg = await loadConfig(s);
  if (!cfg) return;
  if (cfg.kill_switch) return;
  if (!cfg.auto_approve_enabled) return;

  const riskClasses = (cfg.auto_approve_risk_classes && cfg.auto_approve_risk_classes.length > 0)
    ? cfg.auto_approve_risk_classes
    : ['low', 'medium'];
  const scanners = (cfg.auto_approve_scanners && cfg.auto_approve_scanners.length > 0)
    ? cfg.auto_approve_scanners
    : [];
  if (scanners.length === 0) return; // no scanner opted-in — nothing to pick
  const maxEffort = cfg.auto_approve_max_effort ?? 5;

  const approvedToday = await countApprovedToday(s);
  const running = await countRunningExecutions(s);
  const budgetSlots = Math.max(0, cfg.daily_budget - approvedToday);
  const concurrencySlots = Math.max(0, cfg.concurrency_cap - running);
  // Cap per-tick to avoid bursts when auto-approve is flipped on after a
  // backlog has accumulated.
  const PER_TICK_CAP = 5;
  const slots = Math.min(budgetSlots, concurrencySlots, PER_TICK_CAP);
  if (slots === 0) return;

  // PostgREST in.(...) expects comma-separated values; quote strings for
  // safety. scanners/riskClasses come from the config row (operator-controlled),
  // but still encode to avoid breaking on stray punctuation.
  const riskList = riskClasses.map(r => `"${encodeURIComponent(r)}"`).join(',');
  const scannerList = scanners.map(r => `"${encodeURIComponent(r)}"`).join(',');
  const findingsR = await supa<Array<{
    id: string;
    risk_class: 'low' | 'medium' | 'high' | null;
    effort_score: number | null;
    impact_score: number | null;
    spec_snapshot: { scanner?: string } | null;
  }>>(
    s,
    // VTID-02984 (PR-M1.x): widen the source_type filter from
    // `eq.dev_autopilot` to the shared executor allowlist so PR-L2 /
    // PR-L3 / M1 test-contract scanners flow through. Unknown
    // source_types stay rejected via the executor's per-row guards.
    `/rest/v1/autopilot_recommendations?source_type=in.(${executableSourceTypesPostgrestIn()})&status=eq.new`
      + `&risk_class=in.(${riskList})`
      + `&effort_score=lte.${maxEffort}`
      + `&spec_snapshot->>scanner=in.(${scannerList})`
      + `&order=impact_score.desc.nullslast,created_at.asc&limit=${slots * 2}`
      + `&select=id,risk_class,effort_score,impact_score,spec_snapshot`,
  );
  if (!findingsR.ok || !findingsR.data || findingsR.data.length === 0) return;

  let approved = 0;
  for (const f of findingsR.data) {
    if (approved >= slots) break;

    // Only approve findings that already have a plan. approveAutoExecute
    // will error otherwise; short-circuit with a cheap HEAD-style lookup.
    const planR = await supa<Array<{ version: number }>>(
      s,
      `/rest/v1/dev_autopilot_plan_versions?finding_id=eq.${f.id}&select=version&order=version.desc&limit=1`,
    );
    if (!planR.ok || !planR.data || planR.data.length === 0) continue;

    // Dedup: skip findings that already have a non-terminal execution.
    // Without this, every tick approves a NEW execution row even though
    // the prior one is still cooling/running — N concurrent executions
    // for the same finding all racing the same plan. Discovered while
    // running v1 autonomy: a single eligible finding produced 5 cooling
    // executions in 3 minutes after auto-approve flipped on.
    const inflightR = await supa<Array<{ id: string }>>(
      s,
      `/rest/v1/dev_autopilot_executions?finding_id=eq.${f.id}`
      + `&status=in.(cooling,running,ci,merging,deploying,verifying)`
      + `&select=id&limit=1`,
    );
    if (inflightR.ok && inflightR.data && inflightR.data.length > 0) continue;

    // VTID-AUTOPILOT-PR-FLOOD: also skip findings whose prior execution
    // opened a PR that was never merged. The status-based inflight check
    // above misses failed/reverted executions whose GitHub PR is still
    // open — the executor never closes a PR on failure. See the matching
    // guard in approveAutoExecute() for the full root-cause writeup.
    const strandedPrR = await supa<Array<{ id: string }>>(
      s,
      `/rest/v1/dev_autopilot_executions?finding_id=eq.${f.id}`
      + `&pr_url=not.is.null`
      + `&status=not.in.(completed,self_healed,auto_archived)`
      + `&select=id&limit=1`,
    );
    if (strandedPrR.ok && strandedPrR.data && strandedPrR.data.length > 0) continue;

    // VTID-AUTOPILOT-RETRY-CAP: per-finding aggregate retry circuit breaker.
    // The bridge has per-chain max_auto_fix_depth=2, but autoApproveTick
    // creates fresh chains every 30s for any finding still status='new'.
    // Findings the model genuinely cannot solve (open `proposed_files=[]`
    // scope, npm-audit, multi-file impact rules > 32k output) burn execs
    // indefinitely. 2026-05-04 19:30 → 06:30 drain: 452 execs across 6
    // findings, 2 merges; the rest were retry-loop noise on 4 unfixable
    // findings. Mitigation at the time was manual snooze. This is the
    // proper fix: count terminal-failure execs in the last 24 hours; if
    // >= AUTO_RETRY_CAP, auto-snooze the recommendation 7 days. Operator
    // can manually unsnooze if the spec/scope/plan changes.
    const failureWindow = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const failuresR = await supa<Array<{ id: string }>>(
      s,
      `/rest/v1/dev_autopilot_executions?finding_id=eq.${f.id}`
      + `&status=in.(failed,reverted,failed_escalated)`
      + `&updated_at=gte.${encodeURIComponent(failureWindow)}`
      + `&select=id&limit=10`,
    );
    const AUTO_RETRY_CAP = 5;
    if (failuresR.ok && failuresR.data && failuresR.data.length >= AUTO_RETRY_CAP) {
      const snoozedUntil = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      await supa(
        s,
        `/rest/v1/autopilot_recommendations?id=eq.${f.id}&status=eq.new`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'snoozed',
            snoozed_until: snoozedUntil,
            updated_at: new Date().toISOString(),
          }),
        },
      );
      console.log(
        `${LOG_PREFIX} auto-approve skipped ${f.id.slice(0, 8)}: ${failuresR.data.length} terminal failures in 24h ≥ cap (${AUTO_RETRY_CAP}) — snoozed 7d`,
      );
      continue;
    }

    // Pass undefined so the INSERT writes approved_by=NULL.
    // Earlier code passed the string literal 'auto', but approved_by is a
    // UUID column — Postgres rejected every autonomous approval with
    // "invalid input syntax for type uuid". Net: auto-approve has been
    // silently no-op since the feature shipped. NULL is a valid sentinel
    // for "approved by the system" — the OASIS event below is the audit
    // trail for non-human approvals.
    const result = await approveAutoExecute({ finding_id: f.id });
    if (!result.ok || !result.execution) {
      // A safety-gate rejection here is EXPECTED for findings that cite
      // files outside allow_scope — just log and move on. The operator
      // will still see those findings in the queue with status='new'.
      console.log(`${LOG_PREFIX} auto-approve skipped ${f.id.slice(0, 8)}: ${result.error || 'safety gate'}`);
      continue;
    }

    approved++;
    await emitOasisEvent({
      vtid: EXEC_VTID,
      type: 'dev_autopilot.execution.auto_approved',
      source: 'dev-autopilot',
      status: 'info',
      message: `Auto-approved execution ${result.execution.id.slice(0, 8)} for finding ${f.id.slice(0, 8)}`,
      payload: {
        finding_id: f.id,
        execution_id: result.execution.id,
        trigger: {
          risk_class: f.risk_class,
          effort_score: f.effort_score,
          impact_score: f.impact_score,
          scanner: f.spec_snapshot?.scanner ?? null,
        },
      },
    });
  }

  // =============================================================
  // Second pass: IMPACT findings.
  // Independent gate — auto_approve_impact_enabled + explicit allowlist of
  // rule ids. Unlike baseline, we don't filter by risk_class/effort — if
  // the operator named the rule in auto_approve_impact_rules, that IS the
  // approval signal. Shares the same daily_budget + concurrency_cap as
  // baseline (one bucket), and the same PER_TICK_CAP.
  // =============================================================
  if (cfg.auto_approve_impact_enabled) {
    const impactRules = cfg.auto_approve_impact_rules || [];
    const remainingSlots = slots - approved;
    if (remainingSlots > 0 && impactRules.length > 0) {
      const ruleList = impactRules.map(r => `"${encodeURIComponent(r)}"`).join(',');
      const impactR = await supa<Array<{
        id: string;
        risk_class: 'low' | 'medium' | 'high' | null;
        effort_score: number | null;
        impact_score: number | null;
        spec_snapshot: { rule?: string; severity?: string; category?: string } | null;
      }>>(
        s,
        `/rest/v1/autopilot_recommendations?source_type=eq.dev_autopilot_impact&status=eq.new`
          + `&spec_snapshot->>rule=in.(${ruleList})`
          + `&order=impact_score.desc.nullslast,created_at.asc&limit=${remainingSlots * 2}`
          + `&select=id,risk_class,effort_score,impact_score,spec_snapshot`,
      );
      if (impactR.ok && impactR.data && impactR.data.length > 0) {
        for (const f of impactR.data) {
          if (approved >= slots) break;

          // Plan must exist — approveAutoExecute requires it. Impact
          // findings don't get eager plans by default, so we generate one
          // on the fly if none exists. Keep this best-effort: a plan-gen
          // failure just means this finding waits for the next tick.
          const planR = await supa<Array<{ version: number }>>(
            s,
            `/rest/v1/dev_autopilot_plan_versions?finding_id=eq.${f.id}&select=version&order=version.desc&limit=1`,
          );
          if (!planR.ok || !planR.data || planR.data.length === 0) {
            console.log(`${LOG_PREFIX} auto-approve (impact) skipping ${f.id.slice(0, 8)}: no plan yet — will retry after eager-plan runs`);
            continue;
          }

          // Pass undefined so the INSERT writes approved_by=NULL.
    // Earlier code passed the string literal 'auto', but approved_by is a
    // UUID column — Postgres rejected every autonomous approval with
    // "invalid input syntax for type uuid". Net: auto-approve has been
    // silently no-op since the feature shipped. NULL is a valid sentinel
    // for "approved by the system" — the OASIS event below is the audit
    // trail for non-human approvals.
    const result = await approveAutoExecute({ finding_id: f.id });
          if (!result.ok || !result.execution) {
            console.log(`${LOG_PREFIX} auto-approve (impact) skipped ${f.id.slice(0, 8)}: ${result.error || 'safety gate'}`);
            continue;
          }

          approved++;
          await emitOasisEvent({
            vtid: EXEC_VTID,
            type: 'dev_autopilot.execution.auto_approved',
            source: 'dev-autopilot',
            status: 'info',
            message: `Auto-approved impact execution ${result.execution.id.slice(0, 8)} for finding ${f.id.slice(0, 8)} (rule: ${f.spec_snapshot?.rule})`,
            payload: {
              finding_id: f.id,
              execution_id: result.execution.id,
              trigger: {
                source: 'impact',
                rule: f.spec_snapshot?.rule ?? null,
                severity: f.spec_snapshot?.severity ?? null,
                category: f.spec_snapshot?.category ?? null,
                risk_class: f.risk_class,
              },
            },
          });
        }
      }
    }
  }

  if (approved > 0) {
    console.log(`${LOG_PREFIX} auto-approved ${approved} finding(s) this tick`);
  }
}

/**
 * Lazy plan generator — fills in plans for backlog findings that the
 * eager top-K planner missed.
 *
 * Why this exists: eagerlyPlanTopK() only fires from synthesis ingest
 * with brand-new signals. Once the scanner reaches steady state
 * (0 new findings per run, all duplicates), no planning ever happens
 * for the backlog. autoApproveTick() then silently does nothing because
 * it only approves findings WITH plans. Net effect: an empty queue
 * sitting on top of dozens of plannable findings.
 *
 * This tick picks up to 3 plannable findings per cycle (status=new,
 * risk_class IN ('low','medium'), no plan_versions row) and calls
 * generatePlanVersion. Bounded so a hung worker never wedges the loop.
 */
const LAZY_PLAN_BATCH_SIZE = 3;
const LAZY_PLAN_RISK_CLASSES = ['low', 'medium'];

export async function lazyPlanTick(): Promise<void> {
  const s = getSupabase();
  if (!s) return;

  // Honor the kill switch so this can't run away when ops disables autonomy.
  const cfg = await loadConfig(s);
  if (!cfg) return;
  if (cfg.kill_switch) return;

  // Global queue-pressure guard: if the worker queue already has any plan
  // tasks pending OR running, skip this tick entirely. Without this, every
  // 30s tick (and every Cloud Run instance running its own copy) keeps
  // enqueueing more tasks faster than the worker can drain them — leading
  // to dozens of duplicate plans per finding and starving execute tasks.
  const pendingR = await supa<Array<{ id: string }>>(
    s,
    `/rest/v1/dev_autopilot_worker_queue?kind=eq.plan&status=in.(pending,running)&select=id&limit=1`,
  );
  if (pendingR.ok && pendingR.data && pendingR.data.length > 0) return;

  // Find planless findings ordered by impact_score desc.
  const riskFilter = `(${LAZY_PLAN_RISK_CLASSES.map(r => `"${r}"`).join(',')})`;
  const findingsR = await supa<Array<{ id: string }>>(
    s,
    `/rest/v1/autopilot_recommendations?source_type=in.(dev_autopilot,dev_autopilot_impact)`
    + `&status=eq.new&risk_class=in.${riskFilter}`
    + `&order=impact_score.desc&limit=${LAZY_PLAN_BATCH_SIZE * 4}&select=id`,
  );
  if (!findingsR.ok || !findingsR.data) return;

  let generated = 0;
  for (const f of findingsR.data) {
    if (generated >= LAZY_PLAN_BATCH_SIZE) break;
    // Skip if a plan already exists for this finding.
    const planR = await supa<Array<{ version: number }>>(
      s,
      `/rest/v1/dev_autopilot_plan_versions?finding_id=eq.${f.id}&select=version&limit=1`,
    );
    if (planR.ok && planR.data && planR.data.length > 0) continue;
    // Skip if a plan task for this finding is already pending/running
    // (defense in depth — the global guard above usually covers this,
    // but a tick mid-claim could still race).
    const inflightR = await supa<Array<{ id: string }>>(
      s,
      `/rest/v1/dev_autopilot_worker_queue?finding_id=eq.${f.id}&kind=eq.plan&status=in.(pending,running)&select=id&limit=1`,
    );
    if (inflightR.ok && inflightR.data && inflightR.data.length > 0) continue;
    try {
      const result = await generatePlanVersion(f.id);
      if (result.ok) {
        generated++;
        console.log(`${LOG_PREFIX} lazy-plan generated for ${f.id.slice(0, 8)}`);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} lazy-plan error for ${f.id.slice(0, 8)}:`, err);
    }
  }
  if (generated > 0) {
    console.log(`${LOG_PREFIX} lazy-plan tick: generated ${generated} plan(s)`);
  }
}

// =============================================================================
// Activation reaper — recover dev_autopilot* recs activated but never executed
// =============================================================================
//
// Operator clicks Activate → vtid_ledger row goes to IN_PROGRESS, the bridge
// fires fire-and-forget, the user moves on. If the bridge call crashed (Cloud
// Run container recycle, Supabase blip, Anthropic 5xx during plan
// generation), the recommendation is left "activated" but no execution row
// exists. The vtid_ledger card sits in IN PROGRESS forever — exactly what
// the user reported (cards stuck for 2+ weeks).
//
// This tick scans for activated dev_autopilot* recs where:
//   - autopilot_recommendations.status = 'activated'
//   - source_type IN (dev_autopilot, dev_autopilot_impact)
//   - activated_at < now - GRACE
//   - no dev_autopilot_executions row exists for this finding (any status)
// and re-runs the bridge for them. GRACE keeps the reaper from racing the
// initial fire-and-forget bridge call from the activate route.
const REAPER_GRACE_MS = 5 * 60 * 1000; // 5 min — well past plan-gen latency

async function activationReaperTick(): Promise<void> {
  const s = getSupabase();
  if (!s) return;

  const cfg = await loadConfig(s);
  if (!cfg || cfg.kill_switch) return;

  const cutoff = new Date(Date.now() - REAPER_GRACE_MS).toISOString();
  // Pull a small batch — we want to recover steadily, not flood the LLM
  // budget with weeks of accumulated activations on the first tick.
  const orphanedR = await supa<Array<{ id: string; activated_vtid: string | null; activated_at: string }>>(
    s,
    `/rest/v1/autopilot_recommendations?source_type=in.(dev_autopilot,dev_autopilot_impact)` +
    `&status=eq.activated&activated_at=lt.${cutoff}` +
    `&select=id,activated_vtid,activated_at&order=activated_at.asc&limit=5`,
  );
  if (!orphanedR.ok || !orphanedR.data || orphanedR.data.length === 0) return;

  for (const orphan of orphanedR.data) {
    // Confirm no execution row exists (any status — a completed exec means
    // the work was done and we shouldn't redo it; a failed/archived exec
    // means self-heal has already had its turn).
    const execR = await supa<Array<{ id: string }>>(
      s,
      `/rest/v1/dev_autopilot_executions?finding_id=eq.${orphan.id}&select=id&limit=1`,
    );
    if (execR.ok && execR.data && execR.data.length > 0) continue;

    console.log(`${LOG_PREFIX} reaper: recovering activated ${orphan.id.slice(0, 8)} (vtid=${orphan.activated_vtid}, age=${Math.round((Date.now() - new Date(orphan.activated_at).getTime()) / 60000)}m)`);
    try {
      const result = await bridgeActivationToExecution(orphan.id, null);
      if (result.ok) {
        await emitOasisEvent({
          vtid: orphan.activated_vtid || EXEC_VTID,
          type: 'dev_autopilot.execution.reaped',
          source: 'dev-autopilot',
          status: 'info',
          message: `Reaper bridged orphaned activation ${orphan.id.slice(0, 8)} → execution ${result.execution_id?.slice(0, 8) || '?'}`,
          payload: { finding_id: orphan.id, execution_id: result.execution_id, vtid: orphan.activated_vtid },
        });
      } else {
        console.warn(`${LOG_PREFIX} reaper: bridge failed for ${orphan.id.slice(0, 8)}: ${result.error}`);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} reaper: error on ${orphan.id.slice(0, 8)}:`, err);
    }
  }
}

// =============================================================================
// Allocated-orphan reaper — tombstone stale "Allocated - Pending Title" shells
// =============================================================================
//
// VTID-0542 allocator creates a placeholder row (status='allocated',
// title='Allocated - Pending Title') as the first leg of a 2-step
// allocate→update sequence. Normally the second leg lands within 1 second.
// When it doesn't (caller crash, supabase write race, broken self-heal
// triage path), the shell sits forever and pollutes the operator's Tasks
// board. The board adapter hides these from view, but rows still accumulate
// in the database. This tick promotes stale shells to status='deleted' so
// they fall out of the ledger entirely.
const ALLOCATED_REAPER_GRACE_MS = 10 * 60 * 1000; // 10 min — well past the
// happy-path allocate→update latency, even on a slow Supabase day.

async function allocatedOrphanReaperTick(): Promise<void> {
  const s = getSupabase();
  if (!s) return;

  const cutoff = new Date(Date.now() - ALLOCATED_REAPER_GRACE_MS).toISOString();
  const orphansR = await supa<Array<{ vtid: string; created_at: string; title: string | null }>>(
    s,
    `/rest/v1/vtid_ledger?status=eq.allocated&created_at=lt.${cutoff}` +
    `&or=(title.is.null,title.eq.Allocated%20-%20Pending%20Title,title.eq.Pending%20Title)` +
    `&select=vtid,created_at,title&limit=50`,
  );
  if (!orphansR.ok || !orphansR.data || orphansR.data.length === 0) return;

  for (const orphan of orphansR.data) {
    const ageMin = Math.round((Date.now() - new Date(orphan.created_at).getTime()) / 60_000);
    console.log(`${LOG_PREFIX} reaper: tombstoning orphan ${orphan.vtid} (age=${ageMin}min, title='${orphan.title}')`);
    await supa(s, `/rest/v1/vtid_ledger?vtid=eq.${orphan.vtid}&status=eq.allocated`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'deleted',
        delete_reason: `allocated-orphan-reaper: shell never received title (age=${ageMin}min)`,
        updated_at: new Date().toISOString(),
      }),
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
    autoApproveTick().catch((err) => {
      console.error(`${LOG_PREFIX} auto-approve tick error:`, err);
    });
    lazyPlanTick().catch((err) => {
      console.error(`${LOG_PREFIX} lazy-plan tick error:`, err);
    });
    activationReaperTick().catch((err) => {
      console.error(`${LOG_PREFIX} activation-reaper tick error:`, err);
    });
    allocatedOrphanReaperTick().catch((err) => {
      console.error(`${LOG_PREFIX} allocated-orphan-reaper tick error:`, err);
    });
  }, BACKGROUND_TICK_MS);
}

export { LOG_PREFIX, DRY_RUN, BACKGROUND_TICK_MS };
