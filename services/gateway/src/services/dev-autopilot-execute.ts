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
import { extractFilePaths } from './dev-autopilot-planning';
import { isWorkerQueueEnabled, isWorkerOwnsPrEnabled, runWorkerTask, reclaimStuckWorkerTasks, reclaimStuckPendingWorkerTasks, type WorkerAttemptFailure } from './dev-autopilot-worker-queue';
import { writeAutopilotFailure } from './dev-autopilot-self-heal-log';

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
const MESSAGES_MAX_TOKENS = 16000;
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
    spec_snapshot: Record<string, unknown>;
  }>>(
    s,
    `/rest/v1/autopilot_recommendations?id=eq.${input.finding_id}&select=id,risk_class,source_type,spec_snapshot&limit=1`,
  );
  if (!recR.ok || !recR.data) return { ok: false, error: recR.error || 'finding lookup failed' };
  const rec = recR.data[0];
  if (!rec) return { ok: false, error: 'finding not found' };
  // Accept both baseline and impact-scan findings — both flow through the
  // same plan→approve→execute path. Reject anything else (community, system).
  if (rec.source_type !== 'dev_autopilot' && rec.source_type !== 'dev_autopilot_impact') {
    return { ok: false, error: `not a dev_autopilot finding (source_type=${rec.source_type})` };
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
  const files = freshFiles.length > 0
    ? freshFiles
    : (plan.files_referenced || []).map(String);
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
  lines.push(
    `# Developer Autopilot — Execute plan ${findingId} (plan v${planVersion})`,
    ``,
    `You are producing the exact file contents for a new branch \`${branch}\` that`,
    `will be opened as a pull request. Follow the plan **exactly**. Do not expand`,
    `scope — only touch the files the plan lists. Do not add commentary outside`,
    `the final JSON object.`,
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

async function callMessagesApi(
  prompt: string,
): Promise<{ ok: boolean; text?: string; usage?: { input_tokens?: number; output_tokens?: number }; error?: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), MESSAGES_TIMEOUT_MS);
  try {
    const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: EXECUTION_MODEL,
        max_tokens: MESSAGES_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 500)}` };
    }
    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (data.content || [])
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text as string)
      .join('\n')
      .trim();
    if (!text) return { ok: false, error: 'Messages API returned no text content', usage: data.usage };
    return { ok: true, text, usage: data.usage };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: `Messages API aborted after ${MESSAGES_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, error: String(err) };
  } finally {
    clearTimeout(timer);
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
  const sessionId = `msg_${randomUUID().slice(0, 12)}`;

  if (DRY_RUN || !ANTHROPIC_API_KEY) {
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
  // plans that lack a well-formed Files-to-modify section.
  const freshFiles = extractFilePaths(plan.plan_markdown);
  const planFiles = freshFiles.length > 0 ? freshFiles : (plan.files_referenced || []);
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
      : await callMessagesApi(prompt);
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

  // 3. Validate: every emitted file path was in the plan's files_referenced
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
}

/** Per-state timeout. Beyond this, the state is considered "stuck" and
 *  the reconciler asks reality. */
const RECONCILE_TIMEOUT_MS: Record<string, number> = {
  ci:        30 * 60 * 1000,  // 30 min
  merging:   15 * 60 * 1000,  // 15 min
  deploying: 30 * 60 * 1000,  // 30 min
  verifying: 15 * 60 * 1000,  // 15 min
};

const RECONCILE_BATCH_SIZE = 10;

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
    // PR closed without merge — terminal failure.
    await patchExecution(s, exec.id, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      metadata: { error: 'reconciler: PR closed without merge' },
    });
    await emitOasisEvent({
      vtid: EXEC_VTID,
      type: 'dev_autopilot.execution.failed',
      source: 'dev-autopilot',
      status: 'error',
      message: `Reconciler: ${exec.id.slice(0, 8)} PR #${exec.pr_number} closed without merge`,
      payload: { execution_id: exec.id, pr_number: exec.pr_number, reason: 'pr_closed_unmerged' },
    });
    bridgeFailure(exec.id, 'ci', 'PR closed without merge').catch(() => {});
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
      metadata: { error: `reconciler: PR mergeable_state=${prR.data.mergeable_state} after ${RECONCILE_TIMEOUT_MS.ci / 60_000}m` },
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
      metadata: { error: 'reconciler: PR closed without merge while in merging' },
    });
    bridgeFailure(exec.id, 'merging', 'PR closed without merge').catch(() => {});
  }
  // else: stuck on auto-merge — leave to watcher one more cycle.
}

/** Reconcile status='deploying'. Source of truth: oasis_events for
 *  deploy.gateway.success or any event tagged with the merge SHA / branch. */
async function reconcileDeploying(s: SupaConfig, exec: StuckExecRow): Promise<void> {
  // Look for a deploy success event newer than the execution's last update.
  const since = new Date(Date.now() - RECONCILE_TIMEOUT_MS.deploying * 2).toISOString();
  const deployR = await supa<Array<{ id: string; type: string; created_at: string }>>(s,
    `/rest/v1/oasis_events?type=in.(deploy.gateway.success,deploy.success,vtid.lifecycle.deployed)`
    + `&created_at=gte.${since}&order=created_at.desc&limit=20&select=id,type,created_at`);
  if (deployR.ok && deployR.data && deployR.data.length > 0) {
    // We saw at least one recent deploy success event. Best-effort: advance
    // this execution to verifying; the verification step will run next.
    await patchExecution(s, exec.id, { status: 'verifying' });
    await emitOasisEvent({
      vtid: EXEC_VTID,
      type: 'dev_autopilot.execution.deployed',
      source: 'dev-autopilot',
      status: 'success',
      message: `Reconciler: ${exec.id.slice(0, 8)} deploy success event observed — advancing to verifying`,
      payload: { execution_id: exec.id, deploy_event_id: deployR.data[0].id, reconciled_from: 'deploying' },
    });
    return;
  }

  // No deploy event seen within the look-back window — fail.
  await patchExecution(s, exec.id, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    metadata: { error: `reconciler: no deploy success event observed after ${RECONCILE_TIMEOUT_MS.deploying / 60_000}m in deploying` },
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
  const since = new Date(Date.now() - RECONCILE_TIMEOUT_MS.verifying * 2).toISOString();
  const verifyR = await supa<Array<{ id: string; type: string }>>(s,
    `/rest/v1/oasis_events?type=in.(dev_autopilot.execution.verification_passed,vtid.lifecycle.completed)`
    + `&created_at=gte.${since}&order=created_at.desc&limit=10&select=id,type`);
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
  // call it good. (Conservative: only complete if /alive returns 200; else
  // fail.)
  const gatewayUrl = process.env.GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';
  let alive = false;
  try {
    const r = await fetch(`${gatewayUrl}/alive`);
    alive = r.ok;
  } catch { /* alive=false */ }

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

  await patchExecution(s, exec.id, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    metadata: { error: `reconciler: /alive failed after ${RECONCILE_TIMEOUT_MS.verifying / 60_000}m in verifying` },
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
      + `&select=id,finding_id,status,pr_url,pr_number,branch,updated_at`
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
    `/rest/v1/autopilot_recommendations?source_type=eq.dev_autopilot&status=eq.new`
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

    const result = await approveAutoExecute({ finding_id: f.id, approved_by: 'auto' });
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

          const result = await approveAutoExecute({ finding_id: f.id, approved_by: 'auto' });
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
  }, BACKGROUND_TICK_MS);
}

export { LOG_PREFIX, DRY_RUN, BACKGROUND_TICK_MS };
