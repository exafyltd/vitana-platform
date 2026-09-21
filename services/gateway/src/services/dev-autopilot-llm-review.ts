/**
 * Dev Autopilot — LLM merge review (VTID-03853)
 *
 * autopilot-validator.ts's runCodeReview()/runSecurityScan() are documented
 * placeholders (filename-pattern/regex matching only, explicitly commented
 * "In production, this would call an AI-based code review agent" /
 * "we do pattern matching on file names only"). Investigating where they
 * actually sit in the pipeline for this VTID found something more important
 * than the stub itself: `validateForMerge()` (the function that calls them)
 * is NOT in the call path dev_autopilot_executions rows actually merge
 * through. That real path is dev-autopilot-watcher.ts's `ciWatcherTick()`:
 * GitHub CI green + `shouldAutoMerge(riskClass)` (a risk-class allowlist
 * check) → straight to `githubService.mergePullRequest()`. No code review,
 * no security scan, no LLM review of any kind ever touches this path —
 * whether the diff was authored by the self-healing plane or by the
 * Operator Console's DeepSeek on-ramp (VTID-03820).
 *
 * This module adds one more gate, wired directly into that real path (see
 * dev-autopilot-watcher.ts): fetch the PR's diff and ask a Bedrock Claude
 * model (via callViaRouter('validator', ...) — the DB-backed
 * llm_routing_policy 'validator' stage) to flag genuine security/
 * correctness red flags before merge.
 *
 * Fail-open, deliberately: a diff-fetch failure, an LLM call failure, or an
 * unparseable response never blocks a merge — a flaky review mechanism must
 * never become a denial-of-service on the whole autonomous pipeline. Each
 * fail-open path logs loudly so a stuck 100%-skip rate is visible instead of
 * silently degrading to "no review ever ran." Only an actual parsed "block"
 * verdict blocks.
 *
 * Kill-switched off by default (DEV_AUTOPILOT_LLM_REVIEW_ENABLED), matching
 * this platform's standing practice for new autonomy-adjacent gates
 * (VTID-03706, VTID-03820) — pinned to staging only in this PR, never prod,
 * until observed against real traffic.
 */

import githubService from './github-service';
import { runStageToolLoop } from './llm-stage-tool-loop';
import { createValidatorToolExecutor, validatorRouterTools } from './dev-autopilot-llm-review-tools';

const LOG_PREFIX = '[dev-autopilot-llm-review]';
// Keep the review prompt well inside the router's per-call token budget —
// this is a safety net, not a full-repo audit, so a large PR gets a
// best-effort review of its first files rather than no review at all.
const MAX_DIFF_CHARS = 24_000;
const MAX_FILES_IN_REVIEW = 20;

export function isLlmMergeReviewEnabled(): boolean {
  return (process.env.DEV_AUTOPILOT_LLM_REVIEW_ENABLED || '').toLowerCase() === 'true';
}

/**
 * VTID-04231: the reviewer's tool loop (read_file at the PR head, ci_evidence,
 * dev_get_risk — dev-autopilot-llm-review-tools.ts). Default ON under the
 * parent switch above; the exact string 'false' restores the single-shot
 * diff-only review. Bounds: `REVIEW_MAX_TURNS` model turns, `REVIEW_MAX_TOOL_CALLS`
 * tool calls, `REVIEW_DEADLINE_MS` wall clock — then one tool-less call for the
 * verdict. A tool or loop failure stays fail-open exactly like a single-shot
 * failure (below).
 */
export function isLlmMergeReviewToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.DEV_AUTOPILOT_LLM_REVIEW_TOOLS_ENABLED || '').toLowerCase() !== 'false';
}
export const REVIEW_MAX_TURNS = 6;
export const REVIEW_MAX_TOOL_CALLS = 8;
export const REVIEW_DEADLINE_MS = 90_000;
export const REVIEW_SYSTEM_PROMPT = 'You are a pre-merge safety reviewer for an autonomous code-change pipeline. You answer with exactly one JSON verdict object and nothing else.';

export interface LlmMergeReviewResult {
  /** false only on an infrastructure failure (diff fetch, LLM call, parse) — see `passed`, which still reads true in that case (fail-open). */
  ok: boolean;
  /** false ONLY on a real, parsed "block" verdict from the model. */
  passed: boolean;
  summary: string;
  error?: string;
  /** VTID-04231: which provider/model served the verdict and how many tool calls the reviewer made. */
  provider?: string;
  model?: string;
  tool_calls?: number;
  tools_used?: string[];
}

interface PrFileForReview {
  filename: string;
  status: string;
  patch?: string;
}

export function buildDiffBundle(files: PrFileForReview[]): string {
  const parts: string[] = [];
  let used = 0;
  const capped = files.slice(0, MAX_FILES_IN_REVIEW);
  for (const f of capped) {
    if (!f.patch) {
      parts.push(`### ${f.filename} (${f.status}, no textual diff — binary or too large to diff)`);
      continue;
    }
    const chunk = `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\`\n`;
    if (used + chunk.length > MAX_DIFF_CHARS) {
      parts.push(`### ... review budget exhausted, ${files.length - capped.indexOf(f)} file(s) not shown`);
      break;
    }
    parts.push(chunk);
    used += chunk.length;
  }
  if (files.length > MAX_FILES_IN_REVIEW) {
    parts.push(`### ... ${files.length - MAX_FILES_IN_REVIEW} additional file(s) not shown (review budget)`);
  }
  return parts.join('\n');
}

export function buildReviewPrompt(vtid: string, diffBundle: string, toolsAvailable: boolean = false): string {
  return [
    `You are a pre-merge safety reviewer for an autonomous code-change pipeline.`,
    `A PR for ${vtid} is about to be auto-merged with no human review. Look ONLY`,
    `for genuine, concrete problems in the diff below: hardcoded secrets or`,
    `credentials, SQL injection or command injection, disabled auth/RLS checks,`,
    `destructive operations without guards (DROP TABLE, force-push, rm -rf), or`,
    `code that is obviously broken (a syntax error, an unclosed block, a clearly`,
    `inverted condition).`,
    ``,
    `Do NOT flag style, naming, missing tests, or anything you are not genuinely`,
    `confident is a real problem — a false positive here blocks real work in a`,
    `production pipeline, which is worse than missing a minor issue.`,
    ``,
    ...(toolsAvailable ? [
      `You have three read-only tools, all pinned to the PR head commit:`,
      `read_file(path, start_line?, end_line?) to see the rest of a changed file when`,
      `a hunk alone is ambiguous; ci_evidence() for the head commit's check-runs and any`,
      `failing job's log; dev_get_risk(path) for a file's churn/bug-fix/ownership/fan-in`,
      `facts. Use them only when the diff alone cannot settle a real concern — most`,
      `reviews need none. Then answer.`,
      ``,
    ] : []),
    `Respond with ONLY a single JSON object and nothing else, no markdown fence:`,
    `{"verdict":"pass"} or {"verdict":"block","reasons":["<short reason>", ...]}`,
    ``,
    `## Diff`,
    diffBundle,
  ].join('\n');
}

export function parseReviewVerdict(text: string): { verdict: 'pass' | 'block'; reasons: string[] } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.verdict === 'pass') return { verdict: 'pass', reasons: [] };
  if (obj.verdict === 'block') {
    const reasons = Array.isArray(obj.reasons)
      ? obj.reasons.filter((r): r is string => typeof r === 'string')
      : [];
    return { verdict: 'block', reasons };
  }
  return null;
}

export async function runLlmMergeReview(params: {
  repo: string;
  prNumber: number;
  vtid: string;
}): Promise<LlmMergeReviewResult> {
  let files: PrFileForReview[];
  try {
    files = await githubService.getPrFiles(params.repo, params.prNumber);
  } catch (err) {
    console.warn(`${LOG_PREFIX} diff fetch failed for PR #${params.prNumber} — skipping review (fail-open):`, err);
    return { ok: false, passed: true, summary: 'diff fetch failed — review skipped, not blocking', error: String(err) };
  }
  if (!files || files.length === 0) {
    return { ok: true, passed: true, summary: 'no files changed — nothing to review' };
  }

  const diffBundle = buildDiffBundle(files);

  // VTID-04231: resolve the PR head so every tool reads exactly what would
  // merge. A failure here is not a review failure — it just means the
  // single-shot, diff-only review runs (no tools), as before this VTID.
  let headSha: string | null = null;
  if (isLlmMergeReviewToolsEnabled()) {
    try {
      const pr = await githubService.getPullRequest(params.repo, params.prNumber);
      headSha = (pr as { head?: { sha?: string } })?.head?.sha || null;
      if (!headSha) console.warn(`${LOG_PREFIX} PR #${params.prNumber} has no head sha — reviewing without tools`);
    } catch (err) {
      console.warn(`${LOG_PREFIX} PR head lookup failed for #${params.prNumber} — reviewing without tools:`, err);
    }
  }
  const toolsOn = Boolean(headSha);
  const prompt = buildReviewPrompt(params.vtid, diffBundle, toolsOn);

  const loop = await runStageToolLoop({
    stage: 'validator',
    service: 'dev-autopilot-llm-review',
    vtid: params.vtid,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    prompt,
    tools: toolsOn ? validatorRouterTools() : [],
    execute: toolsOn
      ? createValidatorToolExecutor({ repo: params.repo, headSha: headSha as string })
      : async (name) => ({ result: `no tools are available in this review (${name})`, isError: true }),
    maxTurns: toolsOn ? REVIEW_MAX_TURNS : 1,
    maxToolCalls: toolsOn ? REVIEW_MAX_TOOL_CALLS : 0,
    deadlineMs: REVIEW_DEADLINE_MS,
    maxTokens: 1000,
    allowFallback: true,
  });
  const r = { ok: loop.ok, text: loop.text, error: loop.error };
  const meta = { provider: loop.provider, model: loop.model, tool_calls: loop.toolCalls, tools_used: loop.toolNames };
  if (!r.ok || !r.text) {
    console.warn(`${LOG_PREFIX} review call failed for PR #${params.prNumber} — skipping review (fail-open): ${r.error}`);
    return { ok: false, passed: true, summary: 'review call failed — skipped, not blocking', error: r.error, ...meta };
  }

  const verdict = parseReviewVerdict(r.text);
  if (!verdict) {
    console.warn(`${LOG_PREFIX} unparseable review response for PR #${params.prNumber} — skipping review (fail-open): ${r.text.slice(0, 200)}`);
    return { ok: false, passed: true, summary: 'unparseable review response — skipped, not blocking', error: 'unparseable_verdict', ...meta };
  }

  if (verdict.verdict === 'pass') {
    return { ok: true, passed: true, summary: `LLM review found no blocking issues${loop.toolCalls ? ` (${loop.toolCalls} tool call(s): ${loop.toolNames.join(', ')})` : ''}`, ...meta };
  }
  return {
    ok: true,
    passed: false,
    summary: `LLM review blocked merge: ${verdict.reasons.join('; ') || 'unspecified'}`,
    ...meta,
  };
}
