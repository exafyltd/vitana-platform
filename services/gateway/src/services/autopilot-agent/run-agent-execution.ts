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
import { applyPrContract } from '../dev-autopilot-pr-contract';
import { isTestFile } from '../dev-autopilot-safety';
import { loadAutopilotContext } from '../dev-autopilot/context-loader';
import type { LLMProvider, LLMRouterMessage } from '../llm-router';
import { AGENT_TOOLS, executeAgentTool } from './agent-tools';
import { runAgentLoop, type AgentStep } from './agent-loop';
import { buildAgentSystemPrompt, buildAgentTaskPrompt, buildScopeFixPrompt, buildValidationFixPrompt } from './agent-prompt';
import { checkChangedFilesScope, hasTestCoverage } from './agent-scope';
import { makeCheckRunner, runJest, runTsc, selectJestTargets } from './agent-validate';
import { cleanupWorkspace, commitAndPush, linkNodeModules, listChangedFiles, prepareWorkspace, scrubSecret, type Workspace } from './agent-workspace';

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
const AGENT_MAX_TOKENS = Number.parseInt(process.env.AGENT_MAX_TOKENS || '8000', 10);
const AGENT_NODE_MODULES_SOURCE = process.env.AGENT_NODE_MODULES_SOURCE || '/app/node_modules';
const AGENT_SKIP_TSC = (process.env.AGENT_SKIP_TSC || 'false').toLowerCase() === 'true';
const CLAUDE_MD_EXCERPT_CHARS = 14_000;

export type AgentExecutionResult = { ok: boolean; pr_url?: string; branch?: string; pr_number?: number; session_id?: string; error?: string };

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
  const branch = `dev-autopilot/${executionId.slice(0, 8)}`;
  const sessionId = `agent_${randomUUID().slice(0, 12)}`;
  const short = executionId.slice(0, 8);

  const planR = await supa<Array<{ plan_markdown: string; files_referenced: string[] | null }>>(
    s, `/rest/v1/dev_autopilot_plan_versions?finding_id=eq.${exec.finding_id}&version=eq.${exec.plan_version}&limit=1`,
  );
  if (!planR.ok || !planR.data || planR.data.length === 0) return { ok: false, error: 'plan version not found', session_id: sessionId };
  const plan = planR.data[0];

  const findR = await supa<Array<{ activated_vtid: string | null; spec_snapshot: Record<string, unknown> | null }>>(
    s, `/rest/v1/autopilot_recommendations?id=eq.${exec.finding_id}&select=activated_vtid,spec_snapshot&limit=1`,
  );
  const activatedVtid = findR.ok && findR.data && findR.data[0]?.activated_vtid ? String(findR.data[0].activated_vtid) : null;
  const telemetryVtid = activatedVtid || `VTID-DA-${short}`;
  const priorFailure = typeof exec.metadata?.parent_failure === 'string' ? (exec.metadata.parent_failure as string)
    : typeof exec.metadata?.failure_reason === 'string' ? (exec.metadata.failure_reason as string) : null;

  if (DRY_RUN) {
    return { ok: true, pr_url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/pull/DRY-RUN-${short}`, pr_number: 0, branch, session_id: `dry_${short}` };
  }
  const token = process.env.GITHUB_SAFE_MERGE_TOKEN;
  if (!token) return { ok: false, error: 'GITHUB_SAFE_MERGE_TOKEN not set — the agent executor cannot clone or push', session_id: sessionId, branch };

  const onStep = stepEmitter(executionId, telemetryVtid);
  const override = extractLlmOnRampOverride(exec.metadata) || { provider: AGENT_PRIMARY_PROVIDER, model: AGENT_PRIMARY_MODEL };
  const { callViaRouter } = await import('../llm-router');

  let ws: Workspace | null = null;
  try {
    const scope = await loadScope(s);
    onStep({ turn: 0, kind: 'llm', detail: `preparing workspace ${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BASE_BRANCH} → ${branch}` });
    ws = await prepareWorkspace({ owner: GITHUB_OWNER, repo: GITHUB_REPO, baseBranch: GITHUB_BASE_BRANCH, branch, token });
    const linked = await linkNodeModules(ws.repoDir, 'services/gateway', AGENT_NODE_MODULES_SOURCE);
    console.log(`${LOG_PREFIX} [${short}] workspace ${ws.repoDir} base=${ws.baseSha.slice(0, 8)} node_modules=${linked}`);

    const systemPrompt = buildAgentSystemPrompt({
      repo: `${GITHUB_OWNER}/${GITHUB_REPO}`, baseBranch: GITHUB_BASE_BRANCH, branch, vtid: telemetryVtid,
      allowScope: scope.allow_scope, denyScope: scope.deny_scope,
      conventions: loadAutopilotContext(), claudeMdExcerpt: await readClaudeMdExcerpt(ws.repoDir),
    });
    const repoDir = ws.repoDir;
    const toolCtx = { root: repoDir, runCheck: makeCheckRunner(repoDir), log: (l: string) => console.log(`${LOG_PREFIX} [${short}] ${l}`) };
    const callLlm = (prompt: string, history: LLMRouterMessage[], sys: string) =>
      callViaRouter('worker', prompt, {
        vtid: telemetryVtid, service: 'autopilot-agent', allowFallback: true, maxTokens: AGENT_MAX_TOKENS,
        systemPrompt: sys, history, tools: AGENT_TOOLS,
        providerOverride: override.provider, modelOverride: override.model,
      });

    let prompt = buildAgentTaskPrompt({ vtid: telemetryVtid, planMarkdown: plan.plan_markdown, filesReferenced: plan.files_referenced || [], priorFailure });
    let history: LLMRouterMessage[] = [];
    let finished: { summary: string; pr_title: string; pr_body: string } | null = null;
    let changed = await listChangedFiles(repoDir);
    let provider: string | undefined; let model: string | undefined; let fallbackUsed = false;
    const usage = { inputTokens: 0, outputTokens: 0 };
    let totalTurns = 0;
    const started = Date.now();

    for (let round = 0; round <= AGENT_MAX_FIX_ROUNDS; round++) {
      const loop = await runAgentLoop({
        systemPrompt, prompt, tools: AGENT_TOOLS, history,
        execute: (name, args) => executeAgentTool(name, args, toolCtx),
        callLlm, maxTurns: AGENT_MAX_TURNS - totalTurns, deadlineMs: Math.max(60_000, AGENT_DEADLINE_MS - (Date.now() - started)), onStep,
      });
      history = loop.history; totalTurns += loop.turns;
      usage.inputTokens += loop.usage.inputTokens; usage.outputTokens += loop.usage.outputTokens;
      provider = loop.provider || provider; model = loop.model || model; fallbackUsed = fallbackUsed || loop.fallbackUsed;
      if (!loop.ok || !loop.finished) return { ok: false, error: loop.error || 'agent did not finish', session_id: sessionId, branch };
      finished = loop.finished;

      // --- runner-side verification, independent of what the model claims ---
      changed = await listChangedFiles(repoDir);
      if (changed.length === 0) return { ok: false, error: 'agent finished with an empty diff — refusing to open an empty PR', session_id: sessionId, branch };
      const scopeCheck = checkChangedFilesScope(changed, scope.allow_scope, scope.deny_scope, [`docs/validation/${telemetryVtid}/**`]);
      if (!scopeCheck.ok) {
        if (round === AGENT_MAX_FIX_ROUNDS) return { ok: false, error: `scope violation after ${round} fix round(s): ${scopeCheck.reason}`, session_id: sessionId, branch };
        prompt = buildScopeFixPrompt(scopeCheck.reason); continue;
      }
      if (!hasTestCoverage(changed, isTestFile)) {
        if (round === AGENT_MAX_FIX_ROUNDS) return { ok: false, error: 'tests_missing: no test file in the diff after fix rounds', session_id: sessionId, branch };
        prompt = buildValidationFixPrompt('test-coverage rule', 'The diff contains no test file. Every non-deletion change needs a jest test in the same diff.', round + 1, AGENT_MAX_FIX_ROUNDS); continue;
      }
      const changedPaths = changed.map((c) => c.path);
      const touchesGateway = changedPaths.some((p) => p.startsWith('services/gateway/'));
      if (touchesGateway && !AGENT_SKIP_TSC) {
        const tsc = await runTsc(repoDir, 'services/gateway');
        onStep({ turn: totalTurns, kind: 'tool', name: 'runner:tsc', detail: tsc.ok ? 'clean' : tsc.output.slice(0, 300), isError: !tsc.ok });
        if (!tsc.ok) {
          if (round === AGENT_MAX_FIX_ROUNDS) return { ok: false, error: `tsc failed after ${round} fix round(s): ${tsc.output.slice(0, 1500)}`, session_id: sessionId, branch };
          prompt = buildValidationFixPrompt('tsc --noEmit (services/gateway)', tsc.output, round + 1, AGENT_MAX_FIX_ROUNDS); continue;
        }
      }
      let jestFailed = '';
      for (const target of selectJestTargets(changedPaths)) {
        const r = await runJest(repoDir, target.project, target.patterns);
        onStep({ turn: totalTurns, kind: 'tool', name: 'runner:jest', detail: `${target.project} ${target.patterns.join(' ')} → ${r.ok ? 'pass' : 'FAIL'}`, isError: !r.ok });
        if (!r.ok) { jestFailed = `${target.project}: ${target.patterns.join(' ')}\n${r.output}`; break; }
      }
      if (jestFailed) {
        if (round === AGENT_MAX_FIX_ROUNDS) return { ok: false, error: `jest failed after ${round} fix round(s): ${jestFailed.slice(0, 1500)}`, session_id: sessionId, branch };
        prompt = buildValidationFixPrompt('jest', jestFailed, round + 1, AGENT_MAX_FIX_ROUNDS); continue;
      }
      break; // verified
    }
    if (!finished) return { ok: false, error: 'agent did not finish', session_id: sessionId, branch };

    // --- PR contract + evidence pack (VTID-04002), written into the tree ---
    const contract = applyPrContract({
      vtid: activatedVtid, title: finished.pr_title,
      body: `${finished.pr_body}\n\n---\n_Agent executor (VTID-04006): ${totalTurns} turn(s), provider ${provider || override.provider}, model ${model || override.model}${fallbackUsed ? ', fallback used' : ''}; ${usage.inputTokens} in / ${usage.outputTokens} out tokens. Runner re-verified tsc + jest before this PR was opened._`,
      files: changed.map((c) => ({ path: c.path, action: c.action })),
      executionId, findingId: exec.finding_id, planVersion: exec.plan_version, branch, baseBranch: GITHUB_BASE_BRANCH,
      provider: provider || override.provider, model: model || override.model,
    });
    if (contract.skipped_reason) console.warn(`${LOG_PREFIX} [${short}] PR contract NOT applied: ${contract.skipped_reason}`);
    for (const ef of contract.evidenceFiles) {
      const abs = path.join(repoDir, ef.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, ef.content, 'utf8');
    }
    const vtidLike = activatedVtid || `VTID-DA-${short}`;
    const { sha } = await commitAndPush(repoDir, { message: `${contract.title}\n\n${finished.summary}\n\nExecution ${executionId} (${vtidLike})`, branch, token });
    onStep({ turn: totalTurns, kind: 'finish', detail: `pushed ${sha.slice(0, 8)} on ${branch} (${changed.length} file(s))` });
    const pr = await openPullRequest(token, branch, contract.title, contract.body);
    if (!pr.ok) return { ok: false, error: `open PR: ${scrubSecret(pr.error || '?', token)}`, session_id: sessionId, branch };
    return { ok: true, pr_url: pr.url, pr_number: pr.number, branch, session_id: sessionId };
  } catch (err) {
    const msg = scrubSecret(err instanceof Error ? err.message : String(err), token);
    console.error(`${LOG_PREFIX} [${short}] failed: ${msg}`);
    await emitOasisEvent({
      vtid: EXEC_VTID, type: 'dev_autopilot.agent.error' as CicdEventType, source: 'autopilot-agent', status: 'error',
      message: `Agent execution ${short} failed: ${msg.slice(0, 200)}`, payload: { execution_id: executionId, error: msg.slice(0, 2000) },
    }).catch(() => undefined);
    return { ok: false, error: msg, session_id: sessionId, branch };
  } finally {
    await cleanupWorkspace(ws);
  }
}
