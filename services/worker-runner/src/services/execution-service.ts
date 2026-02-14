/**
 * VTID-01200: Worker Runner - Execution Service
 * VTID-01229: Added execution timeout to prevent hanging tasks
 * VTID-01230: Reads model config from crew.yaml (no more hardcoded model strings)
 * VTID-01231: Contract validation on LLM outputs before action execution
 *
 * Executes actual work via LLM (Gemini/Claude).
 * Uses Vertex AI for Gemini execution on Cloud Run.
 */

import { VertexAI, GenerativeModel, Content, Part } from '@google-cloud/vertexai';
import { randomUUID } from 'crypto';
import { RunnerConfig, TaskDomain, ExecutionResult, PendingTask, RoutingResult } from '../types';
import { resolveModelForRole } from './crew-config';
import { validateLLMResponse, formatViolationsForReprompt } from './contract-validator';

const VTID = 'VTID-01200';

// VTID-01229: Execution timeout configuration (30 minutes default)
const EXECUTION_TIMEOUT_MS = parseInt(process.env.WORKER_EXECUTION_TIMEOUT_MS || '1800000', 10);

// VTID-01231: Max contract validation retries
const MAX_CONTRACT_RETRIES = parseInt(process.env.WORKER_CONTRACT_RETRIES || '2', 10);

/**
 * VTID-01229: Promise timeout wrapper
 * Wraps a promise with a timeout, rejecting if the promise takes too long
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms (${Math.round(timeoutMs / 60000)} minutes)`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

// Vertex AI client (initialized lazily)
let vertexAI: VertexAI | null = null;
let generativeModel: GenerativeModel | null = null;
let resolvedModelId: string | null = null;

/**
 * VTID-01230: Initialize Vertex AI client using crew.yaml config
 */
function initVertexAI(config: RunnerConfig): boolean {
  const workerModel = resolveModelForRole('worker');

  // Env overrides still work, but default comes from crew.yaml
  const project = config.vertexProject || process.env.GOOGLE_CLOUD_PROJECT || 'lovable-vitana-vers1';
  const location = config.vertexLocation || process.env.VERTEX_LOCATION || 'us-central1';
  const model = config.vertexModel || process.env.VERTEX_MODEL || workerModel.modelId;

  // Skip re-init if already initialized with same model
  if (vertexAI && generativeModel && resolvedModelId === model) {
    return true;
  }

  try {
    vertexAI = new VertexAI({
      project,
      location,
    });

    generativeModel = vertexAI.getGenerativeModel({
      model,
      generationConfig: {
        temperature: 0.2, // Lower temperature for code generation
        maxOutputTokens: 8192,
        topP: 0.95,
        topK: 40,
      },
    });

    resolvedModelId = model;
    console.log(`[${VTID}] Vertex AI initialized: project=${project}, location=${location}, model=${model} (crew.yaml worker.primary=${workerModel.modelId})`);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${VTID}] Failed to initialize Vertex AI: ${errorMessage}`);
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

You are the frontend worker. You handle UI, CSS, SPA, and frontend component changes.

ALLOWED PATHS:
- services/gateway/src/frontend/**
- services/gateway/dist/frontend/**
- *.html, *.css, *.tsx, *.jsx files in frontend directories

FORBIDDEN:
- Backend routes or services
- Database migrations
- API endpoints

PATTERNS TO FOLLOW:
- React/TypeScript patterns
- Tailwind CSS for styling
- CSP compliance (no inline scripts)
- Accessibility standards`,

    backend: `
## BACKEND DOMAIN RULES

You are the backend worker. You handle API endpoints, services, and backend logic.

ALLOWED PATHS:
- services/gateway/src/** (excluding frontend)
- services/**/src/**
- config/**

FORBIDDEN:
- Frontend files (html, css in frontend directories)
- Database migrations (use memory worker)

PATTERNS TO FOLLOW:
- Express Router for route modules
- Zod for request validation
- OASIS events for observability
- Service layer pattern
- Keep routes thin`,

    memory: `
## MEMORY DOMAIN RULES

You are the memory worker. You handle database, migrations, and data layer changes.

ALLOWED PATHS:
- supabase/migrations/**
- services/agents/memory-indexer/**
- *.sql files

FORBIDDEN:
- Frontend files
- API routes (use backend worker)

PATTERNS TO FOLLOW:
- Supabase migrations
- RLS policies
- Tenant context awareness
- Safe migration practices`,

    mixed: `
## MIXED DOMAIN RULES

This task spans multiple domains. Analyze carefully and describe changes for each domain:
- Frontend (UI, CSS, components)
- Backend (API, services, routes)
- Memory (database, migrations)

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
 * VTID-01231: Call LLM and validate response against contract.
 * Retries with violation feedback if contract check fails.
 */
async function callAndValidate(
  model: GenerativeModel,
  systemPrompt: string,
  taskPrompt: string,
  vtid: string,
  maxRetries: number = MAX_CONTRACT_RETRIES
): Promise<{ responseText: string; attempt: number }> {
  let currentPrompt = taskPrompt;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [{ text: currentPrompt }] as Part[],
      },
    ];

    console.log(`[${VTID}] LLM call for ${vtid} (attempt ${attempt}/${maxRetries + 1}, timeout: ${EXECUTION_TIMEOUT_MS}ms)`);

    const response = await withTimeout(
      model.generateContent({
        contents,
        systemInstruction: {
          role: 'system',
          parts: [{ text: systemPrompt }] as Part[],
        },
      }),
      EXECUTION_TIMEOUT_MS,
      `LLM generation for ${vtid}`
    );

    const candidate = response.response?.candidates?.[0];
    const content = candidate?.content;

    if (!content || !content.parts) {
      if (attempt <= maxRetries) {
        currentPrompt = taskPrompt + '\n\n## RETRY\nPrevious attempt returned no content. Please try again.';
        continue;
      }
      return { responseText: '', attempt };
    }

    const textPart = content.parts.find((part: Part) => 'text' in part);
    const responseText = textPart ? (textPart as { text: string }).text : '';

    // VTID-01231: Validate against contract
    const validation = validateLLMResponse(responseText);

    if (validation.valid) {
      if (attempt > 1) {
        console.log(`[${VTID}] Contract validation passed on retry attempt ${attempt} for ${vtid}`);
      }
      return { responseText, attempt };
    }

    // If we have retries left, re-prompt with violation feedback
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
 * VTID-01231: Now uses contract validator for structured parsing
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

  // Contract validation failed even after retries — return as failure
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
 * Execute task using Vertex AI (Gemini)
 */
export async function executeTask(
  config: RunnerConfig,
  task: PendingTask,
  routing: RoutingResult,
  domain: TaskDomain
): Promise<ExecutionResult> {
  const runId = routing.run_id || `run_${randomUUID().slice(0, 8)}`;
  const startTime = Date.now();
  // VTID-01230: Model comes from crew.yaml via resolveModelForRole
  const workerModel = resolveModelForRole('worker');
  const modelName = config.vertexModel || process.env.VERTEX_MODEL || workerModel.modelId;
  const provider = 'vertex-ai';

  console.log(`[${VTID}] Executing task ${task.vtid} (domain=${domain}, run_id=${runId}, model=${modelName})`);

  // Initialize Vertex AI if not already done
  if (!initVertexAI(config)) {
    return {
      ok: false,
      error: 'Failed to initialize Vertex AI',
      duration_ms: Date.now() - startTime,
      model: modelName,
      provider,
    };
  }

  if (!generativeModel) {
    return {
      ok: false,
      error: 'Generative model not initialized',
      duration_ms: Date.now() - startTime,
      model: modelName,
      provider,
    };
  }

  try {
    const systemPrompt = buildSystemPrompt(domain);
    const taskPrompt = buildTaskPrompt(task, routing, domain);

    // VTID-01231: Call with contract validation and retry
    const { responseText, attempt } = await callAndValidate(
      generativeModel,
      systemPrompt,
      taskPrompt,
      task.vtid
    );

    console.log(`[${VTID}] Received response for ${task.vtid} (${responseText.length} chars, attempt ${attempt})`);

    // Parse and return result (uses contract validator internally)
    return parseExecutionResult(responseText, Date.now() - startTime, modelName, provider, attempt);
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
 * Get model info for metrics
 * VTID-01230: Now reads from crew.yaml
 */
export function getModelInfo(config: RunnerConfig): { model: string; provider: string } {
  const workerModel = resolveModelForRole('worker');
  return {
    model: config.vertexModel || process.env.VERTEX_MODEL || workerModel.modelId,
    provider: 'vertex-ai',
  };
}
