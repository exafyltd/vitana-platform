/**
 * VTID-01200: Worker Runner - Execution Service
 * VTID-01229: Added execution timeout to prevent hanging tasks
 * VTID-01231: Contract validation on LLM outputs before action execution
 * BOOTSTRAP-WORKER-DS: env-configurable model + DeepSeek-reasoner fallback
 *
 * Executes work via Anthropic Claude (default: claude-opus-4-6). Operators
 * can swap the primary model via WORKER_LLM_MODEL env without code change.
 * If Claude API fails (5xx, rate-limit, network), execution falls back to
 * DeepSeek-reasoner via the OpenAI-compatible endpoint at api.deepseek.com.
 * Fallback is logged loudly and reported in the ExecutionResult.
 */

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import { RunnerConfig, TaskDomain, ExecutionResult, PendingTask, RoutingResult } from '../types';
import { validateLLMResponse, formatViolationsForReprompt } from './contract-validator';
import { awaitAutopilotExecution } from './gateway-client';

const VTID = 'VTID-01200';

// VTID-01229: Execution timeout configuration (10 minutes — Claude is faster than Gemini)
const EXECUTION_TIMEOUT_MS = parseInt(process.env.WORKER_EXECUTION_TIMEOUT_MS || '600000', 10);

// VTID-01231: Max contract validation retries
const MAX_CONTRACT_RETRIES = parseInt(process.env.WORKER_CONTRACT_RETRIES || '2', 10);

// BOOTSTRAP-WORKER-DS: model is now env-configurable, defaults preserved
const CLAUDE_MODEL = process.env.WORKER_LLM_MODEL || 'claude-opus-4-6';
const DEEPSEEK_FALLBACK_MODEL = process.env.WORKER_FALLBACK_MODEL || 'deepseek-reasoner';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_FALLBACK_ENABLED = process.env.WORKER_DEEPSEEK_FALLBACK !== 'false';

// Anthropic client (initialized lazily)
let anthropic: Anthropic | null = null;

function initClaude(): boolean {
  if (anthropic) return true;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(`[${VTID}] ANTHROPIC_API_KEY not set`);
    return false;
  }

  try {
    anthropic = new Anthropic({ apiKey });
    console.log(`[${VTID}] Anthropic client initialized (model: ${CLAUDE_MODEL})`);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${VTID}] Failed to initialize Anthropic client: ${msg}`);
    return false;
  }
}

/**
 * Build system prompt for the worker based on domain
 */
function buildSystemPrompt(domain: TaskDomain): string {
  const basePrompt = `You are a specialized worker agent in the Vitana platform. Your role is to execute development tasks within strict boundaries.

## CRITICAL RULES

1. ALWAYS respond with a structured JSON output containing:
   - ok: boolean (true if task succeeded)
   - files_changed: string[] (list of modified files)
   - files_created: string[] (list of new files)
   - summary: string (human-readable summary of what was done)
   - error: string (if task failed, describe why)

2. DO NOT actually modify files - describe what changes would be made.

3. Follow domain-specific guardrails strictly.

4. If the task is unclear or impossible, set ok=false and explain in error.

5. Be concise and precise in your responses.`;

  const domainPrompts: Record<TaskDomain, string> = {
    frontend: `
## FRONTEND DOMAIN RULES
You handle UI, CSS, SPA, and frontend component changes.
ALLOWED PATHS: services/gateway/src/frontend/**, *.html, *.css, *.tsx, *.jsx
FORBIDDEN: Backend routes, database migrations, API endpoints`,

    backend: `
## BACKEND DOMAIN RULES
You handle API endpoints, services, and backend logic.
ALLOWED PATHS: services/gateway/src/** (excluding frontend), services/**/src/**
FORBIDDEN: Frontend files, database migrations`,

    memory: `
## MEMORY DOMAIN RULES
You handle database, migrations, and data layer changes.
ALLOWED PATHS: supabase/migrations/**, services/agents/memory-indexer/**, *.sql
FORBIDDEN: Frontend files, API routes`,

    infra: `
## INFRASTRUCTURE DOMAIN RULES
You handle CI/CD, deployment, configuration, and DevOps changes.
ALLOWED PATHS: .github/workflows/**, Dockerfile, *.yaml, *.yml, config/**
FORBIDDEN: Application logic, database migrations`,

    ai: `
## AI DOMAIN RULES
You handle LLM integrations, agents, intelligence engines, and AI processing.
ALLOWED PATHS: services/agents/**, services/gateway/src/services/*agent*, services/gateway/src/routes/orb*
FORBIDDEN: Frontend files, database migrations`,

    mixed: `
## MIXED DOMAIN RULES
This task spans multiple domains. Analyze carefully and describe changes for each domain.
Be explicit about which changes belong to which domain.`,
  };

  return basePrompt + domainPrompts[domain];
}

/**
 * Build the task prompt for the LLM
 */
function buildTaskPrompt(
  task: PendingTask,
  routing: RoutingResult,
  domain: TaskDomain
): string {
  const identity = routing.identity;

  return `## TASK DETAILS

VTID: ${task.vtid}
Title: ${task.title}
Domain: ${domain}
Dispatched To: ${routing.dispatched_to || 'worker-' + domain}
Run ID: ${routing.run_id || 'unknown'}

## CONTEXT

Repository: ${identity.repo}
Project: ${identity.project}
Environment: ${identity.environment}
Tenant: ${identity.tenant}

## SPEC CONTENT

${task.spec_content || 'No specification provided. Infer requirements from the title.'}

## GOVERNANCE EVALUATION

${
  routing.governance
    ? `Passed: ${routing.governance.summary?.passed ?? 0}/${routing.governance.summary?.total ?? 0}
Proceed: ${routing.governance.proceed}
Evaluations:
${(routing.governance.evaluations || []).map((e) => `- ${e.skill}: ${e.passed ? '✓' : '✗'} ${e.message}`).join('\n') || 'None'}`
    : 'No governance evaluation performed.'
}

## YOUR TASK

Analyze this task and describe what changes would be needed to complete it.
Remember to respond with a valid JSON object containing: ok, files_changed, files_created, summary, error.

IMPORTANT: Only describe changes within your domain boundaries. If changes are needed outside your domain, note them but do not include them in files_changed/files_created.`;
}

/**
 * BOOTSTRAP-WORKER-DS: Direct DeepSeek fallback call.
 * Uses DeepSeek's OpenAI-compatible /chat/completions endpoint via raw fetch.
 * Only invoked when the primary Claude path fails — never silently.
 */
async function callDeepSeekFallback(
  systemPrompt: string,
  taskPrompt: string,
  vtid: string
): Promise<{ responseText: string; model: string }> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY not set — cannot fall back');
  }

  console.warn(`[${VTID}] DeepSeek fallback engaged for ${vtid} (model: ${DEEPSEEK_FALLBACK_MODEL})`);

  const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEEPSEEK_FALLBACK_MODEL,
      max_tokens: 8192,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: taskPrompt },
      ],
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '<no body>');
    throw new Error(`DeepSeek fallback HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
  }

  const body = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const responseText = body.choices?.[0]?.message?.content || '';

  return { responseText, model: DEEPSEEK_FALLBACK_MODEL };
}

/**
 * VTID-01231: Call Claude and validate response against contract.
 * Retries with violation feedback if contract check fails.
 */
async function callAndValidate(
  systemPrompt: string,
  taskPrompt: string,
  vtid: string,
  maxRetries: number = MAX_CONTRACT_RETRIES
): Promise<{ responseText: string; attempt: number }> {
  if (!anthropic) throw new Error('Anthropic client not initialized');

  let currentPrompt = taskPrompt;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    console.log(`[${VTID}] Claude call for ${vtid} (attempt ${attempt}/${maxRetries + 1}, model: ${CLAUDE_MODEL})`);

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: currentPrompt }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    const responseText = textBlock ? textBlock.text : '';

    if (!responseText) {
      if (attempt <= maxRetries) {
        currentPrompt = taskPrompt + '\n\n## RETRY\nPrevious attempt returned no content. Please try again.';
        continue;
      }
      return { responseText: '', attempt };
    }

    // VTID-01231: Validate against contract
    const validation = validateLLMResponse(responseText);

    if (validation.valid) {
      if (attempt > 1) {
        console.log(`[${VTID}] Contract validation passed on retry attempt ${attempt} for ${vtid}`);
      }
      return { responseText, attempt };
    }

    if (attempt <= maxRetries) {
      const repromptContext = formatViolationsForReprompt(validation.violations);
      console.warn(
        `[${VTID}] Contract validation failed for ${vtid} (attempt ${attempt}): ${validation.violations.length} violations. Retrying...`
      );
      currentPrompt = taskPrompt + repromptContext;
    } else {
      console.error(
        `[${VTID}] Contract validation failed for ${vtid} after ${attempt} attempts: ${JSON.stringify(validation.violations)}`
      );
      return { responseText, attempt };
    }
  }

  return { responseText: '', attempt: maxRetries + 1 };
}

/**
 * Parse the LLM response into an ExecutionResult
 */
function parseExecutionResult(
  response: string,
  durationMs: number,
  modelName: string,
  provider: string,
  attempt: number
): ExecutionResult {
  const validation = validateLLMResponse(response);

  if (validation.valid && validation.sanitized) {
    return {
      ...validation.sanitized,
      duration_ms: durationMs,
      model: modelName,
      provider,
    };
  }

  const violationSummary = validation.violations
    .map((v) => `${v.field}: ${v.message}`)
    .join('; ');

  return {
    ok: false,
    error: `Contract validation failed after ${attempt} attempt(s): ${violationSummary}`,
    summary: response.substring(0, 500),
    duration_ms: durationMs,
    model: modelName,
    provider,
    violations: validation.violations.map((v) => `${v.field}: ${v.rule}`),
  };
}

/**
 * Execute task using Claude Opus 4.6
 */
export async function executeTask(
  config: RunnerConfig,
  task: PendingTask,
  routing: RoutingResult,
  domain: TaskDomain
): Promise<ExecutionResult> {
  const runId = routing.run_id || `run_${randomUUID().slice(0, 8)}`;
  const startTime = Date.now();
  const modelName = CLAUDE_MODEL;
  const provider = 'anthropic';

  console.log(`[${VTID}] Executing task ${task.vtid} (domain=${domain}, run_id=${runId}, model=${modelName})`);

  // PR-A (VTID-02922): self-healing tasks bridged into the Dev Autopilot
  // pipeline delegate execution to the autopilot Cloud Run Job, which
  // actually edits files, opens a real PR, runs CI, and verifies deploy.
  // The worker-runner's own describe-only LLM call is bypassed for these.
  const isSelfHealing = task.metadata?.source === 'self-healing';
  const autopilotExecutionId =
    typeof task.metadata?.autopilot_execution_id === 'string'
      ? (task.metadata.autopilot_execution_id as string)
      : undefined;
  if (isSelfHealing && autopilotExecutionId) {
    console.log(
      `[${VTID}] Self-healing task ${task.vtid} delegating to autopilot execution ${autopilotExecutionId.slice(0, 8)} — skipping local LLM call`,
    );
    return await delegateToAutopilot(config, task, autopilotExecutionId, modelName, provider, startTime);
  }

  if (!initClaude()) {
    return {
      ok: false,
      error: 'Failed to initialize Anthropic client — ANTHROPIC_API_KEY may be missing',
      duration_ms: Date.now() - startTime,
      model: modelName,
      provider,
    };
  }

  try {
    const systemPrompt = buildSystemPrompt(domain);
    const taskPrompt = buildTaskPrompt(task, routing, domain);

    try {
      const { responseText, attempt } = await callAndValidate(
        systemPrompt,
        taskPrompt,
        task.vtid
      );

      console.log(`[${VTID}] Received response for ${task.vtid} (${responseText.length} chars, attempt ${attempt})`);

      return parseExecutionResult(responseText, Date.now() - startTime, modelName, provider, attempt);
    } catch (primaryError) {
      // BOOTSTRAP-WORKER-DS: Engage DeepSeek fallback on primary failure.
      // Never silent — always logged and reported in the result.
      const primaryMsg = primaryError instanceof Error ? primaryError.message : 'Unknown error';

      if (!DEEPSEEK_FALLBACK_ENABLED) {
        throw primaryError;
      }

      console.error(`[${VTID}] Primary (${modelName}) failed for ${task.vtid}: ${primaryMsg}. Attempting DeepSeek fallback.`);

      try {
        const { responseText: fbText, model: fbModel } = await callDeepSeekFallback(
          systemPrompt,
          taskPrompt,
          task.vtid
        );
        console.log(`[${VTID}] DeepSeek fallback succeeded for ${task.vtid} (${fbText.length} chars)`);

        const result = parseExecutionResult(fbText, Date.now() - startTime, fbModel, 'deepseek', 1);
        result.fallback_used = true;
        result.fallback_from = `${provider}/${modelName}`;
        result.fallback_reason = primaryMsg;
        return result;
      } catch (fallbackError) {
        const fbMsg = fallbackError instanceof Error ? fallbackError.message : 'Unknown error';
        console.error(`[${VTID}] DeepSeek fallback also failed for ${task.vtid}: ${fbMsg}`);
        return {
          ok: false,
          error: `Primary failed: ${primaryMsg}; fallback failed: ${fbMsg}`,
          duration_ms: Date.now() - startTime,
          model: modelName,
          provider,
        };
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${VTID}] Execution error for ${task.vtid}: ${errorMessage}`);

    return {
      ok: false,
      error: `Execution error: ${errorMessage}`,
      duration_ms: Date.now() - startTime,
      model: modelName,
      provider,
    };
  }
}

/**
 * PR-A (VTID-02922): poll the gateway's /await-autopilot-execution endpoint
 * and translate the four-state contract into an ExecutionResult.
 *
 *   'pr_ready'  → ok=true, files_changed populated, healing_state=
 *                 'patched_pending_deploy'. Worker reports completion so the
 *                 repair-evidence gate clears, but the reconciler — NOT the
 *                 worker — owns final terminal_outcome='success' after CI +
 *                 deploy + live probe pass.
 *   'completed' → ok=true, files_changed populated, healing_state=
 *                 'verified_healed'. Reconciler will set terminal_outcome=
 *                 'success' on the next cycle.
 *   'failed'    → ok=false, terminal_outcome will be 'failed'.
 *   'deferred'  → ok=true (so the runner doesn't fall into the failure
 *                 path), defer=true so the caller releases the claim
 *                 WITHOUT calling /complete or /terminalize. The
 *                 self-healing reconciler finishes the lifecycle.
 */
async function delegateToAutopilot(
  config: RunnerConfig,
  task: PendingTask,
  autopilotExecutionId: string,
  modelName: string,
  provider: string,
  startTime: number,
): Promise<ExecutionResult> {
  const awaited = await awaitAutopilotExecution(config, task.vtid, autopilotExecutionId);
  const duration_ms = Date.now() - startTime;

  if (!awaited.ok || !awaited.result) {
    return {
      ok: false,
      error: awaited.error || 'await-autopilot-execution failed with no body',
      duration_ms,
      model: modelName,
      provider,
      autopilot_execution_id: autopilotExecutionId,
    };
  }

  const r = awaited.result;
  switch (r.state) {
    case 'pr_ready':
      return {
        ok: true,
        files_changed: r.files_changed || [],
        files_created: r.files_created || [],
        summary: `Autopilot opened PR ${r.pr_url} (status=${r.execution_status}); CI + deploy + live probe pending — reconciler owns final healed state.`,
        duration_ms,
        model: 'autopilot-executor',
        provider: 'dev-autopilot',
        healing_state: 'patched_pending_deploy',
        pr_url: r.pr_url,
        pr_number: r.pr_number,
        branch: r.branch || undefined,
        autopilot_execution_id: autopilotExecutionId,
      };
    case 'completed':
      return {
        ok: true,
        files_changed: r.files_changed || [],
        files_created: r.files_created || [],
        summary: `Autopilot execution completed: PR ${r.pr_url} merged, deployed, and live probe verified.`,
        duration_ms,
        model: 'autopilot-executor',
        provider: 'dev-autopilot',
        healing_state: 'verified_healed',
        pr_url: r.pr_url,
        pr_number: r.pr_number,
        branch: r.branch || undefined,
        autopilot_execution_id: autopilotExecutionId,
      };
    case 'failed':
      return {
        ok: false,
        error: r.error || `autopilot execution failed (status=${r.execution_status})`,
        duration_ms,
        model: 'autopilot-executor',
        provider: 'dev-autopilot',
        healing_state: 'execution_failed',
        autopilot_execution_id: autopilotExecutionId,
      };
    case 'deferred':
      return {
        ok: true,
        defer: true,
        summary: `Autopilot execution still in '${r.execution_status}' after worker-runner await window; reconciler will finish.`,
        duration_ms,
        model: 'autopilot-executor',
        provider: 'dev-autopilot',
        autopilot_execution_id: autopilotExecutionId,
      };
    default:
      return {
        ok: false,
        error: `unknown await-autopilot-execution state: ${(r as any).state}`,
        duration_ms,
        model: 'autopilot-executor',
        provider: 'dev-autopilot',
        autopilot_execution_id: autopilotExecutionId,
      };
  }
}

/**
 * Get model info for metrics
 */
export function getModelInfo(_config: RunnerConfig): { model: string; provider: string } {
  return {
    model: CLAUDE_MODEL,
    provider: 'anthropic',
  };
}
