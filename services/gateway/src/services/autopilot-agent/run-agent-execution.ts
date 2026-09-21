/**
 * VTID-04006: the agent executor session — `runExecutionSession`'s sibling
 * for `metadata.executor='agent'` / `DEV_AUTOPILOT_EXECUTOR=agent`.
 *
 *   clone(base) → tool loop on DeepSeek Flash (Bedrock fallback via the
 *   router) → git status → post-hoc scope check → tsc + jest re-run (≤3 fix
 *   rounds fed back into the same transcript) → PR contract + evidence pack
 *   (VTID-04002) → commit → push → open PR.
 *
 * Same input row, same result shape and the same `applyExecutionResult`
 * afterwards as the single-shot path, so the watcher/reconciler/self-heal
 * bridge see no difference — only the PR is better.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { emitOasisEvent } from '../oasis-event-service';
import type { CicdEventType } from '../../types/cicd';
import { supa, extractLlmOnRampOverride, type SupaConfig, type ExecutionRow } from '../dev-autopilot-execute';
import { parseFixMode } from '../dev-autopilot-bridge';
import { recordAgentRunUsage, type AgentRunUsage } from '../dev-autopilot-outcomes';
import { estimateCost } from '../../constants/llm-defaults';
import { applyPrContract } from '../dev-autopilot-pr-contract';
import { isTestFile } from '../dev-autopilot-safety';
import { loadAutopilotContext } from '../dev-autopilot/context-loader';
import type { LLMProvider, LLMRouterMessage } from '../llm-router';
import { AGENT_TOOLS, executeAgentTool } from './agent-tools';
import { runAgentLoop, type AgentStep } from './agent-loop';
import { buildAgentSystemPrompt, buildAgentTaskPrompt, buildFixModeTaskPrompt, buildScopeFixPrompt, buildValidationFixPrompt } from './agent-prompt';
import { checkChangedFilesScope, hasTestCoverage } from './agent-scope';
import { makeCheckRunner, runJest, runTsc, selectJestTargets } from './agent-validate';
import { cleanupWorkspace, commitAndPush, findFilesWithConflictMarkers, gitDiffAgainstBase, linkNodeModules, listChangedFiles, listChangedFilesSince, mergeBaseIntoBranch, prepareWorkspace, scrubSecret, type MergeBaseResult, type Workspace } from './agent-workspace';
import { approvalRequired } from '../dev-autopilot-approval';
import { startExecutionHeartbeat } from './agent-heartbeat';
import { RepeatedCheckGuard } from './agent-check-guard';

const LOG_PREFIX = '[autopilot-agent]';
const EXEC_VTID = 'VTID-DEV-AUTOPILOT';

const GITHUB_OWNER = process.env.DEV_AUTOPILOT_REPO_OWNER || 'exafyltd';
const GITHUB_REPO = process.env.DEV_AUTOPILOT_REPO_NAME || 'vitana-platform';
const GITHUB_BASE_BRANCH = process.env.DEV_AUTOPILOT_REPO_REF || 'main';
const DRY_RUN = (process.env.DEV_AUTOPILOT_DRY_RUN || 'false').toLowerCase() === 'true';

/** STANDING model policy (docs/OPERATOR-AGENT-BUILD-PLAN.md): DeepSeek Flash
 *  4.1 primary; the `worker` stage's policy fallback (Bedrock Claude) applies
 *  through the router unchanged. Env-overridable for a controlled experiment,
 *  never to Google. */
const AGENT_PRIMARY_PROVIDER = (process.env.AGENT_PRIMARY_PROVIDER || 'deepseek') as LLMProvider;
const AGENT_PRIMARY_MODEL = process.env.AGENT_PRIMARY_MODEL || 'deepseek-flash';
const AGENT_MAX_TURNS = Number.parseInt(process.env.AGENT_MAX_TURNS || '60', 10);
const AGENT_DEADLINE_MS = Number.parseInt(process.env.AGENT_DEADLINE_MS || String(22 * 60_000), 10);
const AGENT_MAX_FIX_ROUNDS = Number.parseInt(process.env.AGENT_MAX_FIX_ROUNDS || '3', 10);
/** VTID-04112: chars of history resent per turn before older tool results
 *  are trimmed — see agent-loop.ts's HISTORY_CHAR_BUDGET for why. */
const AGENT_HISTORY_CHAR_BUDGET = Number.parseInt(process.env.AGENT_HISTORY_CHAR_BUDGET || '120000', 10);
const AGENT_MAX_TOKENS = Number.parseInt(process.env.AGENT_MAX_TOKENS || '8000', 10);
const AGENT_NODE_MODULES_SOURCE = process.env.AGENT_NODE_MODULES_SOURCE || '/app/node_modules';
const AGENT_SKIP_TSC = (process.env.AGENT_SKIP_TSC || 'false').toLowerCase() === 'true';
const CLAUDE_MD_EXCERPT_CHARS = 14_000;

export type AgentExecutionResult = {
  /** VTID-04032: the operator cancelled the execution while it ran; never bridged to self-heal. */
  cancelled?: boolean;
  ok: boolean; pr_url?: string; branch?: string; pr_number?: number; session_id?: string; error?: string;
  // VTID-04029: the branch is pushed, the PR is NOT opened — a human decides
  // on the diff first (dev-autopilot-approval.ts).
  awaiting_approval?: boolean; base_sha?: string; head_sha?: string; pr_title?: string; pr_body?: string;
  diff?: { stat: string; patch: string; files: string[] };
};

interface ConfigRow { allow_scope: string[]; deny_scope: string[] }

async function loadScope(s: SupaConfig): Promise<ConfigRow> {
  const r = await supa<ConfigRow[]>(s, '/rest/v1/dev_autopilot_config?select=allow_scope,deny_scope&limit=1');
  if (!r.ok || !r.data || r.data.length === 0) throw new Error('dev_autopilot_config missing');
  return { allow_scope: r.data[0].allow_scope || [], deny_scope: r.data[0].deny_scope || [] };
}

async function readClaudeMdExcerpt(repoDir: string): Promise<string> {
  try {
    const text = await fs.readFile(path.join(repoDir, 'CLAUDE.md'), 'utf8');
    // Part 1 (rules) only — the change log is history, not instruction.
    const cut = text.indexOf('# PART 2');
    const part1 = cut > 0 ? text.slice(0, cut) : text;
    return part1.length > CLAUDE_MD_EXCERPT_CHARS ? `${part1.slice(0, CLAUDE_MD_EXCERPT_CHARS)}\n…[abridged]` : part1;
  } catch {
    return '(CLAUDE.md not found in the clone)';
  }
}

async function openPullRequest(token: string, branch: string, title: string, body: string): Promise<{ ok: boolean; url?: string; number?: number; error?: string }> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ title, body, head: branch, base: GITHUB_BASE_BRANCH, draft: false }),
    });
    if (!res.ok) return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 300)}` };
    const data = (await res.json()) as { html_url: string; number: number };
    return { ok: true, url: data.html_url, number: data.number };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function stepEmitter(executionId: string, vtid: string): (step: AgentStep) => void {
  return (step) => {
    // Fire-and-forget; steps are read back by GET /executions/:id/steps
    // (oasis_events filtered on metadata.execution_id + topic dev_autopilot.*).
    emitOasisEvent({
      vtid,
      type: `dev_autopilot.agent.${step.kind}` as CicdEventType,
      source: 'autopilot-agent',
      status: step.isError ? 'warning' : 'info',
      message: `[${executionId.slice(0, 8)}] turn ${step.turn} ${step.kind}${step.name ? ` ${step.name}` : ''}: ${step.detail.slice(0, 200)}`,
      payload: { execution_id: executionId, turn: step.turn, kind: step.kind, tool: step.name, ms: step.ms, is_error: !!step.isError },
    }).catch(() => undefined);
    console.log(`${LOG_PREFIX} [${executionId.slice(0, 8)}] t${step.turn} ${step.kind}${step.name ? ` ${step.name}` : ''} ${step.ms != null ? `${step.ms}ms ` : ''}${step.detail.slice(0, 160)}`);
  };
}

export async function runAgentExecutionSession(
  s: SupaConfig,
  exec: ExecutionRow & { finding_id: string; plan_version: number },
): Promise<AgentExecutionResult> {
  const executionId = exec.id;
  // VTID-04017: fix mode — continue on the parent execution's PR branch.
  const fixMode = parseFixMode(exec.metadata);
  const branch = fixMode ? fixMode.branch : `dev-autopilot/${executionId.slice(0, 8)}`;
  const sessionId = `agent_${randomUUID().slice(0, 12)}`;
  const short = executionId.slice(0, 8);
  const startedAt = Date.now();

  const planR = await supa<Array<{ plan_markdown: string; files_referenced: string[] | null }>>(
    s, `/rest/v1/dev_autopilot_plan_versions?finding_id=eq.${exec.finding_id}&version=eq.${exec.plan_version}&limit=1`,
  );
  if (!planR.ok || !planR.data || planR.data.length === 0) return { ok: false, error: 'plan version not found', session_id: sessionId };
  const plan = planR.data[0];

  const findR = await supa<Array<{ activated_vtid: string | null; spec_snapshot: Record<string, unknown> | null }>>(
    s, `/rest/v1/autopilot_recommendations?id=eq.${exec.finding_id}&select=activated_vtid,spec_snapshot&limit=1`,
  );
  const activatedVtid = findR.ok && findR.data && findR.data[0]?.activated_vtid ? String(findR.data[0].activated_vtid) : null;
  // VTID-04007: open-ended intake — no pre-selected files; the task prompt
  // switches to discovery mode.
  const openEnded = (findR.ok && findR.data && findR.data[0]?.spec_snapshot?.intake) === 'open_ended'
    || exec.metadata?.intake === 'open_ended';
  const telemetryVtid = activatedVtid || `VTID-DA-${short}`;
  const priorFailure = typeof exec.metadata?.parent_failure === 'string' ? (exec.metadata.parent_failure as string)
    : typeof exec.metadata?.failure_reason === 'string' ? (exec.metadata.failure_reason as string) : null;

  if (DRY_RUN) {
    return { ok: true, pr_url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/pull/DRY-RUN-${short}`, pr_number: 0, branch, session_id: `dry_${short}` };
  }
  const token = process.env.GITHUB_SAFE_MERGE_TOKEN;
  if (!token) return { ok: false, error: 'GITHUB_SAFE_MERGE_TOKEN not set — the agent executor cannot clone or push', session_id: sessionId, branch };

  const onStep = stepEmitter(executionId, telemetryVtid);
  // VTID-04017: per-run usage/cost, appended to the finding's outcome row
  // in `finally` whatever happens (best-effort, never throws).
  const run: AgentRunUsage = {
    execution_id: executionId, vtid: activatedVtid, provider: null, model: null, input_tokens: 0, output_tokens: 0, cost_usd: 0,
    turns: 0, fix_rounds: 0, checks_refused: 0, fallback_used: false, fix_mode: !!fixMode, outcome: 'failed', error: null, elapsed_ms: 0, recorded_at: '',
  };
  const finish = (r: AgentExecutionResult): AgentExecutionResult => {
    run.outcome = !r.ok ? (r.cancelled ? 'cancelled' : 'failed') : r.awaiting_approval ? 'awaiting_approval' : fixMode ? 'fix_pushed' : 'pr_opened';
    run.error = r.ok ? null : (r.error || 'unknown').slice(0, 500);
    return r;
  };
  // VTID-04011: keep the row's updated_at fresh while this task is alive so
  // the running-watchdog cannot reclaim a live agent execution.
  // VTID-04032: the heartbeat also reads the row back — an operator cancel
  // (row moved off `running`, or metadata.cancel_requested) raises this flag
  // and the loop stops at its next turn/tool boundary; nothing is pushed.
  let cancelRequested = false;
  const heartbeat = startExecutionHeartbeat(s, executionId, {
    onCancelRequested: () => {
      cancelRequested = true;
      onStep({ turn: 0, kind: 'error', detail: 'cancel requested by operator — stopping at the next turn boundary' });
    },
  });
  const cancelledResult = () => finish({ ok: false, cancelled: true, error: 'cancelled by operator', session_id: sessionId, branch });
  const override = extractLlmOnRampOverride(exec.metadata) || { provider: AGENT_PRIMARY_PROVIDER, model: AGENT_PRIMARY_MODEL };
  const { callViaRouter } = await import('../llm-router');

  let ws: Workspace | null = null;
  try {
    const scope = await loadScope(s);
    onStep({ turn: 0, kind: 'llm', detail: fixMode
      ? `fix mode: continuing PR #${fixMode.pr_number} on ${GITHUB_OWNER}/${GITHUB_REPO}@${branch} (parent ${fixMode.parent_execution_id.slice(0, 8)})`
      : `preparing workspace ${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BASE_BRANCH} → ${branch}` });
    ws = await prepareWorkspace({ owner: GITHUB_OWNER, repo: GITHUB_REPO, baseBranch: GITHUB_BASE_BRANCH, branch, token, existingBranch: !!fixMode });
    // In fix mode the diff that matters is the whole PR (parent's committed
    // work + this run's edits) versus the base branch.
    // VTID-04217: fix mode first merges the latest base branch into the PR
    // branch. A clean merge is the whole fix for a `merge conflict (dirty)`
    // failure; a conflicted one leaves markers the agent is told to resolve,
    // and the runner refuses to push while any remain (below).
    let mergeBase: MergeBaseResult | null = null;
    if (fixMode) {
      mergeBase = await mergeBaseIntoBranch(ws.repoDir, GITHUB_BASE_BRANCH);
      onStep({
        turn: 0, kind: 'tool', name: 'runner:merge_base', isError: mergeBase.status === 'conflict',
        detail: `merge origin/${GITHUB_BASE_BRANCH}@${mergeBase.baseSha.slice(0, 8)} → ${mergeBase.status}${mergeBase.conflicts.length ? `: ${mergeBase.conflicts.join(', ')}` : ''}`,
      });
    }
    const baseSha = mergeBase ? mergeBase.baseSha : ws.baseSha;
    const linked = await linkNodeModules(ws.repoDir, 'services/gateway', AGENT_NODE_MODULES_SOURCE);
    console.log(`${LOG_PREFIX} [${short}] workspace ${ws.repoDir} base=${baseSha.slice(0, 8)} node_modules=${linked}${fixMode ? ' fix_mode' : ''}`);

    const systemPrompt = buildAgentSystemPrompt({
      repo: `${GITHUB_OWNER}/${GITHUB_REPO}`, baseBranch: GITHUB_BASE_BRANCH, branch, vtid: telemetryVtid,
      allowScope: scope.allow_scope, denyScope: scope.deny_scope,
      conventions: loadAutopilotContext(), claudeMdExcerpt: await readClaudeMdExcerpt(ws.repoDir),
    });
    const repoDir = ws.repoDir;
    // VTID-04016: refuse re-running a check that already failed since the
    // last edit (Run #4b spent ~18 of 22 minutes on nine identical tsc runs).
    const checkGuard = new RepeatedCheckGuard();
    const toolCtx = { root: repoDir, runCheck: makeCheckRunner(repoDir), checkGuard, log: (l: string) => console.log(`${LOG_PREFIX} [${short}] ${l}`) };
    const callLlm = (prompt: string, history: LLMRouterMessage[], sys: string) =>
      callViaRouter('worker', prompt, {
        vtid: telemetryVtid, service: 'autopilot-agent', allowFallback: true, maxTokens: AGENT_MAX_TOKENS,
        systemPrompt: sys, history, tools: AGENT_TOOLS,
        providerOverride: override.provider, modelOverride: override.model,
      });

    const repoDirChanged = async () => (fixMode ? listChangedFilesSince(repoDir, baseSha) : listChangedFiles(repoDir));
    let changed = await repoDirChanged();
    let prompt = fixMode
      ? buildFixModeTaskPrompt({
        vtid: telemetryVtid, planMarkdown: plan.plan_markdown, prUrl: fixMode.pr_url, branch, prFiles: changed.map((c) => c.path),
        ciEvidence: priorFailure || '', attempt: (exec.auto_fix_depth || 0) + 1, maxAttempts: (exec.auto_fix_depth || 0) + 1 + AGENT_MAX_FIX_ROUNDS,
        mergeBase: mergeBase ? { status: mergeBase.status, conflicts: mergeBase.conflicts, baseBranch: GITHUB_BASE_BRANCH } : undefined,
      })
      : buildAgentTaskPrompt({ vtid: telemetryVtid, planMarkdown: plan.plan_markdown, filesReferenced: plan.files_referenced || [], priorFailure, openEnded });
    let history: LLMRouterMessage[] = [];
    let finished: { summary: string; pr_title: string; pr_body: string } | null = null;
    let provider: string | undefined; let model: string | undefined; let fallbackUsed = false;
    const usage = { inputTokens: 0, outputTokens: 0 };
    let totalTurns = 0;
    let fixRounds = 0;
    const started = Date.now();

    for (let round = 0; round <= AGENT_MAX_FIX_ROUNDS; round++) {
      fixRounds = round;
      const loop = await runAgentLoop({
        systemPrompt, prompt, tools: AGENT_TOOLS, history,
        execute: (name, args) => executeAgentTool(name, args, toolCtx),
        callLlm, maxTurns: AGENT_MAX_TURNS - totalTurns, deadlineMs: Math.max(60_000, AGENT_DEADLINE_MS - (Date.now() - started)), onStep,
        isCancelled: () => cancelRequested, historyCharBudget: AGENT_HISTORY_CHAR_BUDGET,
      });
      history = loop.history; totalTurns += loop.turns;
      usage.inputTokens += loop.usage.inputTokens; usage.outputTokens += loop.usage.outputTokens;
      provider = loop.provider || provider; model = loop.model || model; fallbackUsed = fallbackUsed || loop.fallbackUsed;
      run.turns = totalTurns; run.fix_rounds = round; run.input_tokens = usage.inputTokens; run.output_tokens = usage.outputTokens;
      run.provider = provider || null; run.model = model || null; run.fallback_used = fallbackUsed;
      if (loop.cancelled || cancelRequested) return cancelledResult();
      if (!loop.ok || !loop.finished) return finish({ ok: false, error: loop.error || 'agent did not finish', session_id: sessionId, branch });
      finished = loop.finished;

      // --- runner-side verification, independent of what the model claims ---
      changed = await repoDirChanged();
      if (changed.length === 0) return finish({ ok: false, error: 'agent finished with an empty diff — refusing to open an empty PR', session_id: sessionId, branch });
      if (fixMode && mergeBase?.status !== 'merged' && (await listChangedFiles(repoDir)).length === 0) {
        // The PR diff is non-empty (the parent's work) but this run edited
        // nothing — pushing would re-run the same red CI. (VTID-04217: a
        // clean base merge IS the change when the failure was the conflict,
        // so that case is exempt — the merge commit is already on HEAD.)
        return finish({ ok: false, error: 'fix mode: agent finished without changing anything on the PR branch', session_id: sessionId, branch });
      }
      if (mergeBase) {
        // VTID-04217: never push a conflict marker. Scan the files git
        // reported as conflicted plus everything changed vs the base.
        const candidates = Array.from(new Set([...mergeBase.conflicts, ...changed.map((c) => c.path)]));
        const marked = await findFilesWithConflictMarkers(repoDir, candidates);
        if (marked.length > 0) {
          onStep({ turn: totalTurns, kind: 'tool', name: 'runner:conflict_markers', detail: marked.join(', '), isError: true });
          if (round === AGENT_MAX_FIX_ROUNDS) return finish({ ok: false, error: `merge conflict markers still present after ${round} fix round(s): ${marked.join(', ')}`, session_id: sessionId, branch });
          prompt = buildValidationFixPrompt('merge conflict resolution', `These files still contain conflict markers (<<<<<<< / ======= / >>>>>>>): ${marked.join(', ')}. Resolve every marker, keeping both this PR's change and ${GITHUB_BASE_BRANCH}'s, then re-run the checks.`, round + 1, AGENT_MAX_FIX_ROUNDS); continue;
        }
      }
      const scopeCheck = checkChangedFilesScope(changed, scope.allow_scope, scope.deny_scope, [`docs/validation/${telemetryVtid}/**`]);
      if (!scopeCheck.ok) {
        if (round === AGENT_MAX_FIX_ROUNDS) return finish({ ok: false, error: `scope violation after ${round} fix round(s): ${scopeCheck.reason}`, session_id: sessionId, branch });
        prompt = buildScopeFixPrompt(scopeCheck.reason); continue;
      }
      if (!hasTestCoverage(changed, isTestFile)) {
        if (round === AGENT_MAX_FIX_ROUNDS) return finish({ ok: false, error: 'tests_missing: no test file in the diff after fix rounds', session_id: sessionId, branch });
        prompt = buildValidationFixPrompt('test-coverage rule', 'The diff contains no test file. Every non-deletion change needs a jest test in the same diff.', round + 1, AGENT_MAX_FIX_ROUNDS); continue;
      }
      const changedPaths = changed.map((c) => c.path);
      const touchesGateway = changedPaths.some((p) => p.startsWith('services/gateway/'));
      if (cancelRequested) return cancelledResult();
      if (touchesGateway && !AGENT_SKIP_TSC) {
        const tsc = await runTsc(repoDir, 'services/gateway');
        onStep({ turn: totalTurns, kind: 'tool', name: 'runner:tsc', detail: tsc.ok ? 'clean' : tsc.output.slice(0, 300), isError: !tsc.ok });
        if (!tsc.ok) {
          if (round === AGENT_MAX_FIX_ROUNDS) return finish({ ok: false, error: `tsc failed after ${round} fix round(s): ${tsc.output.slice(0, 1500)}`, session_id: sessionId, branch });
          prompt = buildValidationFixPrompt('tsc --noEmit (services/gateway)', tsc.output, round + 1, AGENT_MAX_FIX_ROUNDS); continue;
        }
      }
      let jestFailed = '';
      for (const target of selectJestTargets(changedPaths)) {
        if (cancelRequested) return cancelledResult();
        const r = await runJest(repoDir, target.project, target.patterns);
        onStep({ turn: totalTurns, kind: 'tool', name: 'runner:jest', detail: `${target.project} ${target.patterns.join(' ')} → ${r.ok ? 'pass' : 'FAIL'}`, isError: !r.ok });
        if (!r.ok) { jestFailed = `${target.project}: ${target.patterns.join(' ')}\n${r.output}`; break; }
      }
      if (jestFailed) {
        if (round === AGENT_MAX_FIX_ROUNDS) return finish({ ok: false, error: `jest failed after ${round} fix round(s): ${jestFailed.slice(0, 1500)}`, session_id: sessionId, branch });
        prompt = buildValidationFixPrompt('jest', jestFailed, round + 1, AGENT_MAX_FIX_ROUNDS); continue;
      }
      break; // verified
    }
    if (!finished) return finish({ ok: false, error: 'agent did not finish', session_id: sessionId, branch });

    // --- PR contract + evidence pack (VTID-04002), written into the tree ---
    const contract = applyPrContract({
      vtid: activatedVtid, title: finished.pr_title,
      body: `${finished.pr_body}\n\n---\n_Agent executor (VTID-04006): ${totalTurns} turn(s), provider ${provider || override.provider}, model ${model || override.model}${fallbackUsed ? ', fallback used' : ''}; ${usage.inputTokens} in / ${usage.outputTokens} out tokens. Runner re-verified tsc + jest before this PR was opened._`,
      files: changed.map((c) => ({ path: c.path, action: c.action })),
      executionId, findingId: exec.finding_id, planVersion: exec.plan_version, branch, baseBranch: GITHUB_BASE_BRANCH,
      provider: provider || override.provider, model: model || override.model,
      // VTID-04016: the evidence pack's commands.log describes the agent
      // path, not the single-shot flow it was written for.
      executor: 'agent',
      agentStats: { turns: totalTurns, fixRounds, checksRefused: checkGuard.refusedCount(), navRepeatsRefused: checkGuard.navRefusedCount(), fallbackUsed, tscRun: !AGENT_SKIP_TSC },
    });
    run.checks_refused = checkGuard.refusedCount();
    if (contract.skipped_reason) console.warn(`${LOG_PREFIX} [${short}] PR contract NOT applied: ${contract.skipped_reason}`);
    for (const ef of contract.evidenceFiles) {
      const abs = path.join(repoDir, ef.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, ef.content, 'utf8');
    }
    const vtidLike = activatedVtid || `VTID-DA-${short}`;
    const commitMessage = fixMode
      ? `fix(ci): ${finished.pr_title.slice(0, 120)} (${vtidLike})\n\n${finished.summary}\n\nFix-mode execution ${executionId} for PR #${fixMode.pr_number} (parent ${fixMode.parent_execution_id})`
      : `${contract.title}\n\n${finished.summary}\n\nExecution ${executionId} (${vtidLike})`;
    // VTID-04032: a cancel that lands during the checks must not be pushed.
    if (cancelRequested) return cancelledResult();
    const { sha } = await commitAndPush(repoDir, { message: commitMessage, branch, token, force: !fixMode });
    onStep({ turn: totalTurns, kind: 'finish', detail: `pushed ${sha.slice(0, 8)} on ${branch} (${changed.length} file(s))${fixMode ? ` → PR #${fixMode.pr_number}` : ''}` });
    if (fixMode) {
      // Same PR, new head — the watcher tracks this row on the parent's PR number.
      return finish({ ok: true, pr_url: fixMode.pr_url, pr_number: fixMode.pr_number, branch, session_id: sessionId });
    }
    // VTID-04029: hold for a human Approve/Reject on the diff before any PR
    // exists. The branch is already pushed (the scratch dir dies with this
    // task); the preview is what the reviewer sees in the Command Hub.
    if (approvalRequired(exec.metadata, { fixMode: false })) {
      const diff = await gitDiffAgainstBase(repoDir, baseSha);
      onStep({ turn: totalTurns, kind: 'finish', detail: `awaiting approval: ${diff.files.length} file(s), diff ${diff.patch.length} chars — no PR opened` });
      return finish({
        ok: true, awaiting_approval: true, branch, base_sha: baseSha, head_sha: sha, session_id: sessionId,
        pr_title: contract.title, pr_body: contract.body, diff,
      });
    }
    const pr = await openPullRequest(token, branch, contract.title, contract.body);
    if (!pr.ok) return finish({ ok: false, error: `open PR: ${scrubSecret(pr.error || '?', token)}`, session_id: sessionId, branch });
    return finish({ ok: true, pr_url: pr.url, pr_number: pr.number, branch, session_id: sessionId });
  } catch (err) {
    const msg = scrubSecret(err instanceof Error ? err.message : String(err), token);
    run.outcome = 'failed'; run.error = msg.slice(0, 500);
    console.error(`${LOG_PREFIX} [${short}] failed: ${msg}`);
    await emitOasisEvent({
      vtid: EXEC_VTID, type: 'dev_autopilot.agent.error' as CicdEventType, source: 'autopilot-agent', status: 'error',
      message: `Agent execution ${short} failed: ${msg.slice(0, 200)}`, payload: { execution_id: executionId, error: msg.slice(0, 2000) },
    }).catch(() => undefined);
    return { ok: false, error: msg, session_id: sessionId, branch };
  } finally {
    heartbeat.stop();
    await cleanupWorkspace(ws);
    run.elapsed_ms = Date.now() - startedAt;
    run.recorded_at = new Date().toISOString();
    run.cost_usd = estimateCost(run.model || '', run.input_tokens, run.output_tokens);
    await recordAgentRunUsage(exec.finding_id, run).catch(() => undefined);
  }
}
