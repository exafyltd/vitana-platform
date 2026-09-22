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
import { isValidatorMemoryRecallEnabled, buildFileScopedMemoryBlock } from './dev-agent-memory-file-recall';

const LOG_PREFIX = '[dev-autopilot-llm-review]';
// Keep the review prompt well inside the router's per-call token budget —
// this is a safety net, not a full-repo audit, so a large PR gets a
// best-effort review of its first files rather than no review at all.
const MAX_DIFF_CHARS = 24_000;
const MAX_FILES_IN_REVIEW = 20;

export function isLlmMergeReviewEnabled(): boolean {
  return (process.env.DEV_AUTOPILOT_LLM_REVIEW_ENABLED || '').toLowerCase() === 'true';
}

export interface LlmMergeReviewResult {
  /** false only on an infrastructure failure (diff fetch, LLM call, parse) — see `passed`, which still reads true in that case (fail-open). */
  ok: boolean;
  /** false ONLY on a real, parsed "block" verdict from the model. */
  passed: boolean;
  summary: string;
  error?: string;
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

export function buildReviewPrompt(vtid: string, diffBundle: string, devMemoryBlock?: string): string {
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
    `Respond with ONLY a single JSON object and nothing else, no markdown fence:`,
    `{"verdict":"pass"} or {"verdict":"block","reasons":["<short reason>", ...]}`,
    ``,
    `## Diff`,
    diffBundle,
    devMemoryBlock ? `\n${devMemoryBlock}\n` : '',
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
  // VTID-04224 Phase 3: flag-gated file-scoped dev_agent_memory recall,
  // fail-open — a recall failure must never block or degrade the review.
  let devMemoryBlock = '';
  if (isValidatorMemoryRecallEnabled()) {
    try {
      devMemoryBlock = await buildFileScopedMemoryBlock(files.map((f) => f.filename), 'vitana-platform');
    } catch {
      devMemoryBlock = '';
    }
  }
  const prompt = buildReviewPrompt(params.vtid, diffBundle, devMemoryBlock);

  const { callViaRouter } = await import('./llm-router');
  const r = await callViaRouter('validator', prompt, {
    vtid: params.vtid,
    service: 'dev-autopilot-llm-review',
    allowFallback: true,
    maxTokens: 1000,
  });
  if (!r.ok || !r.text) {
    console.warn(`${LOG_PREFIX} review call failed for PR #${params.prNumber} — skipping review (fail-open): ${r.error}`);
    return { ok: false, passed: true, summary: 'review call failed — skipped, not blocking', error: r.error };
  }

  const verdict = parseReviewVerdict(r.text);
  if (!verdict) {
    console.warn(`${LOG_PREFIX} unparseable review response for PR #${params.prNumber} — skipping review (fail-open): ${r.text.slice(0, 200)}`);
    return { ok: false, passed: true, summary: 'unparseable review response — skipped, not blocking', error: 'unparseable_verdict' };
  }

  if (verdict.verdict === 'pass') {
    return { ok: true, passed: true, summary: 'LLM review found no blocking issues' };
  }
  return {
    ok: true,
    passed: false,
    summary: `LLM review blocked merge: ${verdict.reasons.join('; ') || 'unspecified'}`,
  };
}
