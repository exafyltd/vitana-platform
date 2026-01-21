/**
 * VTID-01200: Worker Runner - Execution Service
 *
 * Executes actual work via LLM (Gemini/Claude).
 * Uses Vertex AI for Gemini execution on Cloud Run.
 */

import { VertexAI, GenerativeModel, Content, Part } from '@google-cloud/vertexai';
import { randomUUID } from 'crypto';
import { RunnerConfig, TaskDomain, ExecutionResult, PendingTask, RoutingResult } from '../types';

const VTID = 'VTID-01200';

// Vertex AI client (initialized lazily)
let vertexAI: VertexAI | null = null;
let generativeModel: GenerativeModel | null = null;

/**
 * Initialize Vertex AI client
 */
function initVertexAI(config: RunnerConfig): boolean {
  if (vertexAI && generativeModel) {
    return true;
  }

  const project = config.vertexProject || process.env.GOOGLE_CLOUD_PROJECT || 'lovable-vitana-vers1';
  const location = config.vertexLocation || process.env.VERTEX_LOCATION || 'us-central1';
  const model = config.vertexModel || process.env.VERTEX_MODEL || 'gemini-2.5-pro';

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

    console.log(`[${VTID}] Vertex AI initialized: project=${project}, location=${location}, model=${model}`);
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
    ? `Passed: ${routing.governance.summary.passed}/${routing.governance.summary.total}
Proceed: ${routing.governance.proceed}
Evaluations:
${routing.governance.evaluations.map((e) => `- ${e.skill}: ${e.passed ? '✓' : '✗'} ${e.message}`).join('\n')}`
    : 'No governance evaluation performed.'
}

## YOUR TASK

Analyze this task and describe what changes would be needed to complete it.
Remember to respond with a valid JSON object containing: ok, files_changed, files_created, summary, error.

IMPORTANT: Only describe changes within your domain boundaries. If changes are needed outside your domain, note them but do not include them in files_changed/files_created.`;
}

/**
 * Parse the LLM response into an ExecutionResult
 */
function parseExecutionResult(
  response: string,
  durationMs: number,
  model: string,
  provider: string
): ExecutionResult {
  try {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        ok: false,
        error: 'No JSON found in LLM response',
        summary: response.substring(0, 500),
        duration_ms: durationMs,
        model,
        provider,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      ok: parsed.ok === true,
      files_changed: Array.isArray(parsed.files_changed) ? parsed.files_changed : [],
      files_created: Array.isArray(parsed.files_created) ? parsed.files_created : [],
      summary: parsed.summary || 'No summary provided',
      error: parsed.error,
      violations: Array.isArray(parsed.violations) ? parsed.violations : [],
      duration_ms: durationMs,
      model,
      provider,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to parse LLM response: ${error instanceof Error ? error.message : 'Unknown error'}`,
      summary: response.substring(0, 500),
      duration_ms: durationMs,
      model,
      provider,
    };
  }
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
  const model = config.vertexModel || process.env.VERTEX_MODEL || 'gemini-2.5-pro';
  const provider = 'vertex-ai';

  console.log(`[${VTID}] Executing task ${task.vtid} (domain=${domain}, run_id=${runId})`);

  // Initialize Vertex AI if not already done
  if (!initVertexAI(config)) {
    return {
      ok: false,
      error: 'Failed to initialize Vertex AI',
      duration_ms: Date.now() - startTime,
      model,
      provider,
    };
  }

  if (!generativeModel) {
    return {
      ok: false,
      error: 'Generative model not initialized',
      duration_ms: Date.now() - startTime,
      model,
      provider,
    };
  }

  try {
    const systemPrompt = buildSystemPrompt(domain);
    const taskPrompt = buildTaskPrompt(task, routing, domain);

    // Build the request
    const contents: Content[] = [
      {
        role: 'user',
        parts: [{ text: taskPrompt }] as Part[],
      },
    ];

    // Generate content
    console.log(`[${VTID}] Calling Vertex AI for ${task.vtid}...`);
    const response = await generativeModel.generateContent({
      contents,
      systemInstruction: {
        role: 'system',
        parts: [{ text: systemPrompt }] as Part[],
      },
    });

    const candidate = response.response?.candidates?.[0];
    const content = candidate?.content;

    if (!content || !content.parts) {
      return {
        ok: false,
        error: 'No content in LLM response',
        duration_ms: Date.now() - startTime,
        model,
        provider,
      };
    }

    // Extract text response
    const textPart = content.parts.find((part: Part) => 'text' in part);
    const responseText = textPart ? (textPart as { text: string }).text : '';

    console.log(`[${VTID}] Received response for ${task.vtid} (${responseText.length} chars)`);

    // Parse and return result
    return parseExecutionResult(responseText, Date.now() - startTime, model, provider);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${VTID}] Execution error for ${task.vtid}: ${errorMessage}`);

    return {
      ok: false,
      error: `Execution error: ${errorMessage}`,
      duration_ms: Date.now() - startTime,
      model,
      provider,
    };
  }
}

/**
 * Get model info for metrics
 */
export function getModelInfo(config: RunnerConfig): { model: string; provider: string } {
  return {
    model: config.vertexModel || process.env.VERTEX_MODEL || 'gemini-2.5-pro',
    provider: 'vertex-ai',
  };
}
