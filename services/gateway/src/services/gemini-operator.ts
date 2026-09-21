/**
 * VTID-0536: Gemini Operator Tools Bridge v1
 * VTID-01023: Wire /api/v1/operator/chat to Vertex Gemini
 * VTID-01159: Enforce OASIS-Only Task Discovery via discover_oasis_tasks tool
 *
 * Provides Gemini function-calling tools for the Operator Chat.
 * Tools can trigger Autopilot and OASIS actions, governed by the 0400 Governance Engine.
 *
 * VTID-01023: Added Vertex AI support using ADC (Application Default Credentials).
 * When running on Cloud Run, uses the service account for authentication.
 * Priority: Vertex AI > Gemini API Key > Local Router
 *
 * VTID-01159: OASIS-Only Task Discovery
 * - discover_oasis_tasks: Query pending tasks from OASIS (read-only)
 * - OASIS is the ONLY source of truth - NO repo/spec scanning permitted
 * - If OASIS fails, return reliability error (no invented lists)
 * - Output format: Scheduled/Allocated, In Progress, Ignored (legacy)
 *
 * Tools:
 * - autopilot.create_task: Create a new Autopilot task (with governance)
 * - autopilot.get_status: Get status of an existing task
 * - autopilot.list_recent_tasks: List recent Autopilot tasks
 * - discover_oasis_tasks: OASIS-only pending task discovery (VTID-01159)
 */

import fetch from 'node-fetch';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
// VTID-03579: operator LLM calls go through the router (Bedrock primary,
// DeepSeek fallback) — never a provider named in this file.
import { callViaRouter, type LLMRouterTool, type LLMUsage } from './llm-router';
// VTID-04031: token usage + estimated cost per model call, folded into the reply meta.
import { turnUsageFields, summarizeTurnCost, type ModelTurnCost } from './operator-turn-cost';
// VTID-03892: the Operator's own engineering memory (VTID-03889) — separate
// from Memory Garden, which is community end-user personalization data.
import { recallDevMemory, type DevMemoryHit } from './dev-agent-memory';
import {
  createOperatorTask,
  getAutopilotTaskStatus,
  getPendingPlanTasks,
  ingestOperatorEvent,
  CreatedTask,
  TaskStatusResponse
} from './operator-service';
import { emitOasisEvent, recommendationSyncEvents } from './oasis-event-service';
// VTID-03820: DeepSeek-powered execution on-ramp
import { triggerOperatorExecution } from './operator-execution-onramp';
import { dataExportConsentTag } from './data-export-consent';
// VTID-01221: Sync Brief formatter for recommendation presentation
import { formatSyncBrief, isWhatNextIntent, shouldFetchRecommendations, SyncBriefContext, Recommendation } from './sync-brief-formatter';
// VTID-0538: Knowledge Hub integration
import { executeKnowledgeSearch, KNOWLEDGE_SEARCH_TOOL_DEFINITION } from './knowledge-hub';
// VTID-03835: Operator Console codebase read access (search + file read)
import { searchCode, getFileContents } from './github-service';
import { getOperatorBootstrapPack } from './operator-bootstrap-pack';
import { filterVitanaLogs, LOGS_DEFAULT_MINUTES, LOGS_MAX_MINUTES, LOGS_DEFAULT_LIMIT, LOGS_MAX_LIMIT } from './aws-cloudwatch-logs-readonly';
import { buildRecallQuery } from './operator-threads';
import { RECALL_CANDIDATES, diversifyRecallHits, renderDevMemoryBlock } from './dev-memory-ranking';
import { runReadonlySql, isSqlReadonlyEnabled, SQL_DEFAULT_ROWS, SQL_MAX_ROWS, SQL_DEFAULT_TIMEOUT_MS, SQL_MAX_TIMEOUT_MS } from './operator-sql-readonly';
// VTID-03836: Operator Console AWS ECS read-only status
import { describeEcsServices, ALLOWED_ECS_SERVICES, listEcsTasks, ALLOWED_ECS_TASK_FAMILIES, TASKS_DEFAULT_LIMIT, TASKS_MAX_LIMIT } from './aws-ecs-readonly';
import { runRepowise, isRepowiseCommand, runGraphify, isGraphifyCommand, resolveCodeintelRepoDir, ALLOWED_CODEINTEL_REPOS } from './codeintel-readonly';
import { CODE_INDEX_TOOL_NAMES, CODE_INDEX_TOOL_SCHEMAS, describeBundle, loadCodeIndex, resolveCodeIndexRepo, runCodeIndexTool, type CodeIndexToolName } from './codeintel-index';
// VTID-01208: LLM Telemetry
import {
  startLLMCall,
  completeLLMCall,
  failLLMCall,
  LLMCallContext,
  hashPrompt
} from './llm-telemetry-service';
import { getPersonalityConfigSync } from './ai-personality-service';
import { scoreAndRankEvents, formatForText, EventRecord, EventSearchFilters, ScoredEventResults } from './event-relevance-scoring';
// VTID-01270: Matchmaking tool handler
import { executeGetUserMatches as executeGetUserMatchesTool } from './match-tool-handler';
// VTID-DEV-ASSIST: Developer Assistant imports
import githubService from './github-service';
import cicdLockManager from './cicd-lock-manager';
import { runFullQualityCheck } from './spec-quality-agent';
// BOOTSTRAP-VOICE-DEMO: real heartbeats so the agents dashboard shows
// gemini-operator as healthy whenever it's actually called.
import { recordAgentHeartbeat } from '../routes/agents-registry';
import * as repo from './gemini-operator-repository';
// VTID-03851: verified-caller marker for the execution on-ramp. Written by
// routes/operator.ts on EVERY /chat request (set or clear), read by
// executeExecuteTask() before anything else. See operator-execute-authz.ts.
import { getThreadAuth, isExecuteTaskAuthorized, describeExecuteTaskRefusal } from './operator-execute-authz';
import { executeReviewExecution, executeApproveExecution, executeRejectExecution } from './operator-approval-tools';
import { executeActivateRecommendation } from './operator-recommendation-tools';
import { executeCancelExecution } from './operator-cancel-tool';

// Environment config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// VTID-01270A: Thread-to-identity map for community/events tools
// Populated by ORB chat handlers before calling processWithGemini
const threadIdentityMap = new Map<string, { tenant_id: string; user_id: string; role?: string; user_timezone?: string; vitana_id?: string | null }>();

/** VTID-01270A: Set identity context for a thread (call before processWithGemini) */
export function setThreadIdentity(threadId: string, identity: { tenant_id: string; user_id: string; role?: string; user_timezone?: string; vitana_id?: string | null }): void {
  threadIdentityMap.set(threadId, identity);
  // Auto-cleanup after 30 minutes
  setTimeout(() => threadIdentityMap.delete(threadId), 30 * 60 * 1000);
}
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

// VTID-01023: Vertex AI configuration - uses ADC (Application Default Credentials)
// On Cloud Run, this automatically uses the service account
const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'lovable-vitana-vers1';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const VERTEX_MODEL = process.env.VERTEX_MODEL || 'gemini-2.5-pro';

// VTID-03579: the has*Config trio described which GOOGLE backend was wired up.
// With the operator routed there is no per-provider config to check here at all
// — the router owns availability, and a stale "do we have an AI backend?" flag
// computed from Google env vars could only ever answer the wrong question.

// VTID-03579: the Vertex client is gone. The operator names no provider now —
// `llm_routing_policy`'s `operator` stage does (Bedrock primary, DeepSeek
// fallback).

// ==================== Types ====================

/**
 * Tool call request from Gemini
 */
export interface GeminiToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Tool call result to return to Gemini
 */
export interface GeminiToolResult {
  name: string;
  response: Record<string, unknown>;
}

/**
 * Governance evaluation result
 */
export interface GovernanceResult {
  ok: boolean;
  allowed: boolean;
  level: 'L1' | 'L2' | 'L3' | 'L4';
  violations: Array<{
    rule_id: string;
    level: string;
    message: string;
  }>;
}

/**
 * Tool execution result
 */
export interface ToolExecutionResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  governanceBlocked?: boolean;
  governanceResult?: GovernanceResult;
}

/**
 * Gemini operator response
 */
export interface GeminiOperatorResponse {
  reply: string;
  toolResults?: GeminiToolResult[];
  meta?: Record<string, unknown>;
}

// ==================== Turn events (VTID-04028) ====================

/**
 * VTID-04028 (gap analysis §4.6): live events for one operator turn, so the
 * Command Hub can show the tool-call transcript while the turn runs instead
 * of a spinner followed by the whole reply. Emitted through the optional
 * `onEvent` sink on processWithGemini(); without a sink nothing changes.
 * The sink is fire-and-forget by contract — a throwing sink is caught and
 * ignored, it can never fail or delay the turn.
 */
export type OperatorTurnEvent =
  | ({ type: 'model.turn'; stage: 'plan' | 'final'; provider: string; model: string; tool_calls: number; duration_ms: number } & ModelTurnCost)
  | { type: 'tool.call'; index: number; name: string; args: Record<string, unknown> }
  | { type: 'tool.result'; index: number; name: string; ok: boolean; duration_ms: number; error?: string; governance_blocked?: boolean; excerpt: string };

export type OperatorTurnEventSink = (event: OperatorTurnEvent) => void;

/** Bound on the tool-result excerpt carried in a `tool.result` event. */
export const TURN_EVENT_EXCERPT_MAX_CHARS = 600;
/** Bound on the serialized args carried in a `tool.call` event. */
export const TURN_EVENT_ARGS_MAX_CHARS = 1200;

/** Serialize a value for a turn event, clipped so an SSE frame stays small. */
export function clipForTurnEvent(value: unknown, maxChars: number): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  } catch {
    s = String(value);
  }
  if (typeof s !== 'string') s = String(s);
  return s.length > maxChars ? `${s.slice(0, maxChars)}…(+${s.length - maxChars} chars)` : s;
}

/** Args for a `tool.call` event: the original object when small, else a clipped-string placeholder. */
export function boundTurnEventArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const safe = args && typeof args === 'object' ? args : {};
  let raw = '';
  try { raw = JSON.stringify(safe); } catch { raw = ''; }
  if (raw.length <= TURN_EVENT_ARGS_MAX_CHARS) return safe;
  return { _clipped: clipForTurnEvent(raw, TURN_EVENT_ARGS_MAX_CHARS) };
}

/** Emit through the sink, swallowing anything it throws. */
export function emitTurnEvent(sink: OperatorTurnEventSink | undefined, event: OperatorTurnEvent): void {
  if (!sink) return;
  try {
    sink(event);
  } catch (err) {
    console.warn(`[VTID-04028] turn event sink threw on ${event.type}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ==================== Tool Definitions ====================

/**
 * Tool definitions for Gemini function calling
 * These are registered with Gemini for function calling capability
 */
export const GEMINI_TOOL_DEFINITIONS = {
  functionDeclarations: [
    {
      name: 'autopilot_create_task',
      description: 'Create a new Autopilot task in the Vitana system. This will create a VTID, register the task, and trigger planning. Only call this tool when you have a clear description of what the task should accomplish. If the user\'s request is vague (e.g., just "create a task" without details), ask them for a title and description FIRST before calling this tool.',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'A detailed description of the task to be created. Should include what needs to be done and any relevant context.'
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical'],
            description: 'Priority level for the task. Defaults to medium if not specified.'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags to categorize the task (e.g., ["bug", "gateway", "urgent"]).'
          }
        },
        required: ['description']
      }
    },
    {
      name: 'autopilot_execute_task',
      description: 'VTID-03820: Execute an already-approved VTID via the DeepSeek-powered execution on-ramp — writes code and opens a real pull request. The target VTID MUST already have spec_status=approved; this tool does not approve specs itself. Disabled unless the platform owner has explicitly enabled OPERATOR_EXECUTION_ONRAMP_ENABLED. Only call this when the user has clearly asked to execute/implement/ship a SPECIFIC, already-approved VTID — never to create new work (use autopilot_create_task for that) and never speculatively.',
      parameters: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The already-approved VTID to execute (e.g. VTID-04102).'
          },
          plan_markdown: {
            type: 'string',
            description: 'What to change and why — the execution plan for this VTID.'
          },
          files_referenced: {
            type: 'array',
            items: { type: 'string' },
            description: 'File paths the plan will create or change — nothing else. Every path MUST be repo-root-relative exactly as it appears in the repository (e.g. services/gateway/src/services/foo.ts, services/gateway/test/foo.test.ts) — never a bare filename, never relative to a subdirectory: the safety gate glob-matches each entry against its allow scope and a bare filename never matches. A test-only plan lists only the test file; a source change lists the source file AND its paired test file (the safety gate rejects a plan missing test coverage, and rejects any listed file outside its allow scope).'
          }
        },
        required: ['vtid', 'plan_markdown', 'files_referenced']
      }
    },
    {
      name: 'autopilot_run_task',
      description: 'VTID-04007: Turn a free-text development request into a governed agent-mode execution — allocates and registers the VTID itself, then the agent executor reads the code, makes the change, runs tsc + jest and opens a real pull request. Use ONLY when the user clearly asks for a code change to be made and names NO VTID. Never for questions about code, never to log a task for later (autopilot_create_task), never when the user names a VTID (autopilot_execute_task). Disabled unless the platform owner has enabled OPERATOR_EXECUTION_ONRAMP_ENABLED and OPERATOR_VTID_SELF_ALLOCATE_ENABLED.',
      parameters: {
        type: 'object',
        properties: {
          request: {
            type: 'string',
            description: "The development request in the user's own words — what should change and why. Quote the user; do not add requirements they did not state. No VTID, no file list."
          },
          title: {
            type: 'string',
            description: 'Optional short ledger title (≤ 140 chars); derived from the request when omitted.'
          }
        },
        required: ['request']
      }
    },
    {
      name: 'autopilot_review_execution',
      description: 'VTID-04030: Review a Dev Autopilot execution held for approval (status awaiting_approval — the agent pushed its branch but did NOT open the PR yet): returns the branch, the PR title/body it would open, the changed files, the --stat and a bounded unified diff so the user can decide. Call it with no execution_id to list every execution currently waiting for a decision. Read-only. Use it when the user asks what is waiting for approval, to see/show/review a held execution or its diff, or before approving/rejecting when they have not seen the change.',
      parameters: {
        type: 'object',
        properties: {
          execution_id: {
            type: 'string',
            description: 'The execution id — the full UUID, or the 8+ character prefix shown in the Command Hub / in an earlier tool result. Omit to list every execution waiting for approval.'
          }
        },
        required: []
      }
    },
    {
      name: 'autopilot_approve_execution',
      description: 'VTID-04030: Approve a held Dev Autopilot execution — opens the REAL pull request on the branch the agent already pushed (stored title/body) and hands the execution to the normal CI path. Only call it when the user explicitly asks to approve a SPECIFIC held execution they name (id or prefix); never speculatively, never on a guess about which one they mean, and never to approve something they only asked to look at.',
      parameters: {
        type: 'object',
        properties: {
          execution_id: {
            type: 'string',
            description: 'The execution id to approve (full UUID or the 8+ character prefix). It must be in status awaiting_approval.'
          }
        },
        required: ['execution_id']
      }
    },
    {
      name: 'autopilot_reject_execution',
      description: 'VTID-04030: Reject a held Dev Autopilot execution — deletes the pushed branch (best effort) and cancels the execution with the recorded reason; no PR is opened. Only call it when the user explicitly asks to reject/discard a SPECIFIC held execution they name (id or prefix); never speculatively.',
      parameters: {
        type: 'object',
        properties: {
          execution_id: {
            type: 'string',
            description: 'The execution id to reject (full UUID or the 8+ character prefix). It must be in status awaiting_approval.'
          },
          reason: {
            type: 'string',
            description: 'Why it is rejected, in the user\'s own words (recorded on the execution, up to 500 chars). Omit if they gave none.'
          }
        },
        required: ['execution_id']
      }
    },
    {
      name: 'autopilot_activate_recommendation',
      description: 'VTID-04111: Activate a specific Dev Autopilot recommendation by id — allocates its VTID (idempotent: a second call just returns the existing VTID) and, for a manually-bridgeable source_type, starts a real execution with the cooldown skipped. Only call it when the user explicitly asks to activate a SPECIFIC recommendation they name by id; never speculatively, never on a guess about which one they mean.',
      parameters: {
        type: 'object',
        properties: {
          recommendation_id: {
            type: 'string',
            description: "The recommendation's UUID (full UUID only)."
          }
        },
        required: ['recommendation_id']
      }
    },
    {
      name: 'autopilot_cancel_execution',
      description: 'VTID-04034: Cancel a queued (cooling) or running Dev Autopilot execution — a running agent is stopped (its ECS task stopped best effort, the agent halts at its next turn boundary), nothing is pushed or opened. With no execution_id it only LISTS what can be cancelled (read-only). Only call it with an id when the user explicitly asks to cancel/stop a SPECIFIC execution they name (id or prefix); never speculatively.',
      parameters: {
        type: 'object',
        properties: {
          execution_id: {
            type: 'string',
            description: 'The execution id to cancel (full UUID or the 8+ character prefix). It must be cooling or running. Omit to list what can be cancelled.'
          },
          reason: {
            type: 'string',
            description: 'Why it is cancelled, in the user\'s own words (recorded on the execution, up to 500 chars). Omit if they gave none.'
          }
        },
        required: []
      }
    },
    {
      name: 'autopilot_get_status',
      description: 'Get the current status of an existing Autopilot task by its VTID. Returns information about planner, worker, and validator states.',
      parameters: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID (Vitana Task ID) of the task to check. Format: VTID-XXXX or similar.'
          }
        },
        required: ['vtid']
      }
    },
    {
      name: 'autopilot_list_recent_tasks',
      description: 'List recent Autopilot tasks with optional filtering. Returns a summary of recent tasks and their statuses.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: 'Maximum number of tasks to return. Defaults to 10, max 50.'
          },
          status: {
            type: 'string',
            enum: ['pending', 'scheduled', 'planned', 'in-progress', 'completed', 'validated', 'failed', 'cancelled'],
            description: 'Filter tasks by status. If not specified, returns tasks of all statuses.'
          }
        },
        required: []
      }
    },
    // VTID-0538: Knowledge Hub search tool
    // VTID-01025: Clarified - only for Vitana-specific questions, not general knowledge
    {
      name: 'knowledge_search',
      description: `Search the Vitana documentation and knowledge base. Use ONLY for Vitana-specific questions.

Use this tool ONLY when the user asks about Vitana concepts:
- "What is the Vitana Index?"
- "Explain the Command Hub architecture"
- "What is OASIS?"
- "How does the Autopilot system work?"
- "What are the three tenants (Maxina, AlKalma, Earthlings)?"

Do NOT use this tool for:
- General knowledge questions (math, geography, science, etc.)
- Task management commands (use autopilot tools instead)
- Programming questions unrelated to Vitana`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query or question about Vitana documentation'
          }
        },
        required: ['query']
      }
    },
    // VTID-01159: OASIS-only task discovery (TASK_STATE_QUERY)
    // Enforces OASIS as single source of truth - NO repo/spec scanning
    {
      name: 'discover_oasis_tasks',
      description: `Discover pending tasks from OASIS (the single source of truth). Use this tool when the operator asks about:
- "What tasks are scheduled?"
- "List pending tasks"
- "Show scheduled work"
- "What's in the queue?"
- "What tasks are in progress?"
- "Show me allocated tasks"

This tool returns ONLY tasks from OASIS with status: scheduled, allocated, or in_progress.
Legacy DEV-* items are listed as ignored. NO repo scanning permitted.`,
      parameters: {
        type: 'object',
        properties: {
          statuses: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['scheduled', 'allocated', 'in_progress']
            },
            description: 'Filter by status. Defaults to all pending statuses: scheduled, allocated, in_progress.'
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of tasks to return. Defaults to 50, max 200.'
          }
        },
        required: []
      }
    },
    // VTID-01192: Code execution tool for calculations and data processing
    {
      name: 'run_code',
      description: `Execute JavaScript code to perform calculations, date math, data processing, or any computation.
Use this tool when the user asks for:
- Math calculations ("what is 15% of 230?")
- Date calculations ("how many days between two dates?", "what day of week is my birthday?")
- Age calculations ("how old am I?", "age difference between two people")
- Unit conversions ("convert 100 miles to kilometers")
- Data transformations
- Any computation that requires code execution

The code runs in a sandboxed JavaScript environment with access to Date, Math, JSON, and standard JS functions.
Return results as a string or JSON that can be displayed to the user.`,
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'JavaScript code to execute. Must return a value or call console.log() to produce output.'
          },
          description: {
            type: 'string',
            description: 'Brief description of what this code does (for logging/debugging).'
          }
        },
        required: ['code']
      }
    },
    // VTID-01221: Autopilot Recommendation Sync - Primary tool
    {
      name: 'autopilot_get_recommendations',
      description: `Fetch recommended next actions from Autopilot for the current context.

ALWAYS call this tool BEFORE giving "next steps" advice when:
- User asks "what next", "what should I do", "what do we do now", "recommend"
- A VTID is selected or being discussed
- A pipeline/deploy is in progress or just completed

Returns prioritized recommendations with rationale, commands, and verification steps.
Autopilot is the SINGLE SOURCE OF TRUTH for "what to do next".
Do NOT invent recommendations if this tool returns results.`,
      parameters: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            enum: ['developer', 'infra', 'admin'],
            description: 'User role context for filtering recommendations.'
          },
          ui_context: {
            type: 'object',
            properties: {
              surface: { type: 'string' },
              screen: { type: 'string' },
              selection: { type: 'string' }
            },
            description: 'Current UI context.'
          },
          vtid: {
            type: 'string',
            description: 'Optional VTID to get recommendations for a specific task.'
          },
          time_window_minutes: {
            type: 'integer',
            description: 'Look-back window for recent activity context. Default: 120.'
          }
        },
        required: []
      }
    },
    // VTID-01221: Fallback tool - VTID analysis
    {
      name: 'oasis_analyze_vtid',
      description: `Analyze a VTID by querying OASIS events to build an evidence report.
Use this ONLY as a FALLBACK when autopilot_get_recommendations fails or is unavailable.
Returns timeline of events, current status, and deterministic analysis based on OASIS data.`,
      parameters: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID to analyze (e.g., VTID-01216).'
          },
          include_events: {
            type: 'boolean',
            description: 'Include raw event timeline. Default: true.'
          },
          limit: {
            type: 'integer',
            description: 'Max events to include. Default: 50.'
          }
        },
        required: ['vtid']
      }
    },
    // VTID-01221: Fallback tool - Deploy verification
    {
      name: 'dev_verify_deploy_checklist',
      description: `Run post-deploy verification checklist for a VTID.
Use this ONLY as a FALLBACK when autopilot_get_recommendations fails or is unavailable.
Returns checklist items with pass/fail status based on OASIS evidence.`,
      parameters: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID to verify deployment for.'
          },
          service: {
            type: 'string',
            description: 'Optional service name to filter checks.'
          }
        },
        required: ['vtid']
      }
    },
    // VTID-03835: Operator Console codebase read access — read-only, GitHub-backed
    // (there is no live checkout on the gateway container to read from).
    {
      name: 'dev_search_codebase',
      description: `Search a Vitana codebase (via the GitHub Search Code API, default branch "main") for a keyword, symbol name, or string literal. Read-only. Returns matching file paths, not full file content — call dev_read_file on a result to see the code. Developer/admin role only.

Two repos, pass "repo" to pick — defaults to exafyltd/vitana-platform (backend/gateway + the internal Command Hub admin console) if omitted:
- exafyltd/vitana-platform: gateway, backend services, the Command Hub frontend (services/gateway/src/frontend/command-hub/).
- exafyltd/vitana-v1: the actual consumer-facing Vitana app frontend (React/TypeScript screens, components, hooks) — most frontend/UI work lives HERE, not in vitana-platform.

KNOWN BLIND SPOT: GitHub's code search index excludes any file over 384KB. services/gateway/src/frontend/command-hub/app.js (vitana-platform) is ~2.5MB — this tool will ALWAYS return zero results for anything inside it, no matter the query. For that one file, skip straight to dev_read_file with an explicit path instead of concluding the content doesn't exist.`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search terms — e.g. a function/variable name, a string literal, or a concept keyword.'
          },
          path_glob: {
            type: 'string',
            description: 'Optional path prefix/substring to narrow results (e.g. "services/gateway/src/routes"). GitHub code search has no true glob support — this is a substring match, not a wildcard pattern.'
          },
          repo: {
            type: 'string',
            description: 'Which repo to search: "exafyltd/vitana-platform" (default) or "exafyltd/vitana-v1" (the consumer-facing frontend app). Any other value is rejected.'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'dev_read_file',
      description: `Read a file's content, or list a directory, from a Vitana GitHub repo. Defaults to the "main" branch and to exafyltd/vitana-platform. Read-only. Developer/admin role only. Pass "repo": "exafyltd/vitana-v1" for the consumer-facing frontend app repo (most frontend/UI code lives there, not in vitana-platform).`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Repo-relative file or directory path, e.g. "services/gateway/src/services/gemini-operator.ts" or "src/pages" for vitana-v1.'
          },
          ref: {
            type: 'string',
            description: 'Branch, tag, or commit SHA to read from. Defaults to "main".'
          },
          repo: {
            type: 'string',
            description: 'Which repo to read from: "exafyltd/vitana-platform" (default) or "exafyltd/vitana-v1" (the consumer-facing frontend app). Any other value is rejected.'
          }
        },
        required: ['path']
      }
    },
    // VTID-03836: Operator Console AWS ECS read-only status. Disabled until a
    // dedicated read-only IAM role is provisioned — see aws-ecs-readonly.ts.
    {
      name: 'dev_aws_ecs_status',
      description: `Get the live ECS deployment status (desired/running/pending task counts, current task definition, rollout state) for one documented Vitana service. Read-only — never deploys, scales, or restarts anything, and only the services listed in CLAUDE.md §1b are queryable. Developer/admin role only.`,
      parameters: {
        type: 'object',
        properties: {
          service_name: {
            type: 'string',
            description: `The ECS service name, e.g. "vitana-gateway-awsdr" (prod) or "vitana-gateway" (staging). Allowed values: ${ALLOWED_ECS_SERVICES.join(', ')}.`
          }
        },
        required: ['service_name']
      }
    },
    // VTID-04020: Operator Console read-only CloudWatch Logs — the third
    // item of the gap analysis' §4.4 access list. FilterLogEvents only.
    {
      name: 'dev_cloudwatch_logs',
      description: `Read recent CloudWatch log events from one documented Vitana ECS service's log group (/ecs/vitana-<service>, e.g. /ecs/vitana-gateway for staging, /ecs/vitana-gateway-awsdr for prod, /ecs/vitana-autopilot-executor for the executor task). Read-only — FilterLogEvents only, never writes, never touches any other group. Bounded: window default ${LOGS_DEFAULT_MINUTES} min (max ${LOGS_MAX_MINUTES}), events default ${LOGS_DEFAULT_LIMIT} (max ${LOGS_MAX_LIMIT}), messages clipped. Use filter_pattern (CloudWatch filter syntax, e.g. "ERROR", "[VTID-04007]", "execution 4f5d7ea4") to narrow. Developer/admin role only.`,
      parameters: {
        type: 'object',
        properties: {
          log_group: {
            type: 'string',
            description: 'The log group, exactly /ecs/vitana-<service-name>. The ECS service names are the ones dev_aws_ecs_status accepts.'
          },
          filter_pattern: {
            type: 'string',
            description: 'Optional CloudWatch Logs filter pattern (plain terms, quoted phrases, or [bracketed] tokens). Omit for everything in the window.'
          },
          minutes: {
            type: 'number',
            description: `How far back to look, in minutes (default ${LOGS_DEFAULT_MINUTES}, max ${LOGS_MAX_MINUTES}).`
          },
          limit: {
            type: 'number',
            description: `Maximum events to return (default ${LOGS_DEFAULT_LIMIT}, max ${LOGS_MAX_LIMIT}).`
          }
        },
        required: ['log_group']
      }
    },
    // VTID-04035: Operator Console read-only ECS task-level view — the
    // fourth item of the gap analysis' §4.4 access list. ListTasks +
    // DescribeTasks only.
    {
      name: 'dev_ecs_tasks',
      description: `List the ECS tasks (containers) of one documented Vitana service or of the one-shot autopilot-executor task family: task id, status, started/stopped times, stop reason and code, container exit codes, task-definition revision, image. Use it to see whether an executor task is actually alive, when it started, or why a task stopped. Read-only — ListTasks + DescribeTasks only, never stops or starts anything. Bounded: default ${TASKS_DEFAULT_LIMIT} tasks (max ${TASKS_MAX_LIMIT}); desired_status RUNNING (default) or STOPPED (ECS keeps stopped tasks for about an hour). Developer/admin role only.`,
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: `An ECS service name (${ALLOWED_ECS_SERVICES.join(', ')}) or a task family (${ALLOWED_ECS_TASK_FAMILIES.join(', ')}).`
          },
          desired_status: {
            type: 'string',
            description: '"RUNNING" (default) or "STOPPED" — stopped tasks show stop reason and container exit codes.'
          },
          limit: {
            type: 'number',
            description: `Maximum tasks to return (default ${TASKS_DEFAULT_LIMIT}, max ${TASKS_MAX_LIMIT}).`
          }
        },
        required: ['target']
      }
    },
    // VTID-04116: Operator Console codebase intelligence — RepoWise. Closes
    // the gap the VTID-04002 gap analysis flagged: CLAUDE.md's mandatory
    // codebase-intelligence workflow had nothing installed anywhere to
    // satisfy it. Read-only, bounded, inert until the CLI + a built index
    // ship in the gateway image (see codeintel-readonly.ts's header).
    {
      name: 'dev_repowise',
      description: `Query RepoWise's precomputed codebase index (architecture, call graph, code health, git-history hotspots, test coverage, decisions — the tool CLAUDE.md's "Mandatory Codebase Intelligence Workflow" names first). command "ask"/"search"/"why" take a free-text question or search term; "context"/"risk" take a file or symbol path; "health"/"status" take none. Read-only; never edits anything. Developer/admin role only.`,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'One of: ask, search, context, risk, health, why, status.'
          },
          argument: {
            type: 'string',
            description: 'The question, search term, or file/symbol path — required for ask/search/context/risk/why, omitted for health/status.'
          },
          repo: {
            type: 'string',
            description: `Which repo's index to query: ${Object.keys(ALLOWED_CODEINTEL_REPOS).join(' or ')}. Defaults to exafyltd/vitana-platform.`
          }
        },
        required: ['command']
      }
    },
    // VTID-04116: Operator Console codebase intelligence — Graphify.
    {
      name: 'dev_graphify',
      description: `Query Graphify's precomputed knowledge graph of the codebase (call/import/inheritance edges, community structure, god nodes, rationale comments — CLAUDE.md's other named codebase-intelligence tool). command "query"/"explain" take a free-text question or component name; "path" takes two node names separated by a space (e.g. "UserService DatabasePool") for the shortest dependency path between them. Read-only; never edits anything. Developer/admin role only.`,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'One of: query, path, explain.'
          },
          argument: {
            type: 'string',
            description: 'The question/component name for query/explain, or "<source node> <target node>" for path.'
          },
          repo: {
            type: 'string',
            description: `Which repo's graph to query: ${Object.keys(ALLOWED_CODEINTEL_REPOS).join(' or ')}. Defaults to exafyltd/vitana-platform.`
          }
        },
        required: ['command']
      }
    },
    // VTID-04229: Operator Console codebase index — the S3-published bundle
    // (Graphify graph + RepoWise facts, rebuilt on every merge to main by
    // CODEINTEL-INDEX.yml). Unlike dev_repowise/dev_graphify above these need
    // no CLI in the image, so they work on the live gateway; the same three
    // declarations are the executor's (agent-tools.ts). Read-only.
    ...CODE_INDEX_TOOL_NAMES.map((name) => ({
      name,
      description: `${CODE_INDEX_TOOL_SCHEMAS[name].description} Developer/admin role only.`,
      parameters: {
        type: 'object',
        properties: CODE_INDEX_TOOL_SCHEMAS[name].properties,
        required: CODE_INDEX_TOOL_SCHEMAS[name].required,
      },
    })),
    // VTID-04023: Operator Console read-only SQL — one bounded SELECT over a
    // dedicated read-only connection (operator-sql-readonly.ts), for the
    // questions the 4-table allowlist below cannot answer (joins, aggregates,
    // any other table). Developer/admin only; inert until configured.
    {
      name: 'dev_run_sql_readonly',
      description: `Run ONE read-only SQL statement (SELECT, WITH … SELECT, or plain EXPLAIN) against the platform database over a dedicated read-only connection, inside a READ ONLY transaction with a statement timeout. Use for joins, aggregates and tables dev_db_query does not cover (e.g. "how many dev_autopilot_executions failed per stage this week"). No writes, no DDL, no locking, no EXPLAIN ANALYZE; rows and payload are bounded. Developer/admin role only.`,
      parameters: {
        type: 'object',
        properties: {
          sql: {
            type: 'string',
            description: 'A single SELECT / WITH … SELECT / EXPLAIN statement (max 4000 chars). Add ORDER BY … LIMIT yourself for large tables.'
          },
          max_rows: {
            type: 'integer',
            description: `Maximum rows to return (default ${SQL_DEFAULT_ROWS}, max ${SQL_MAX_ROWS}).`
          },
          timeout_ms: {
            type: 'integer',
            description: `Statement timeout in milliseconds (default ${SQL_DEFAULT_TIMEOUT_MS}, max ${SQL_MAX_TIMEOUT_MS}).`
          }
        },
        required: ['sql']
      }
    },
    // VTID-03837: Operator Console read-only DB access — explicit table
    // allowlist via Supabase PostgREST, never arbitrary SQL.
    {
      name: 'dev_db_query',
      description: `Read rows from an explicitly allowlisted table (vtid_ledger, oasis_events, dev_autopilot_executions, dev_autopilot_plan_versions) via Supabase. Read-only — no arbitrary SQL, no writes, no other tables. Developer/admin role only.`,
      parameters: {
        type: 'object',
        properties: {
          table: {
            type: 'string',
            enum: ['vtid_ledger', 'oasis_events', 'dev_autopilot_executions', 'dev_autopilot_plan_versions'],
            description: 'Table to read from.'
          },
          vtid: {
            type: 'string',
            description: 'Optional VTID to filter rows by.'
          },
          limit: {
            type: 'integer',
            description: 'Max rows to return. Defaults to 20, max 100.'
          }
        },
        required: ['table']
      }
    },
    // VTID-01270A: Community & Events tools for ORB text chat
    {
      name: 'search_events',
      description: 'Search upcoming community events, meetups, and live rooms. Supports filtering by activity/keyword, location, organizer, date range, and price. Call with no parameters to list all upcoming events. For follow-up questions about events already listed, answer from conversation context — do NOT call this tool again.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Activity or keyword to search (e.g., "yoga", "dance", "boat trip", "fitness", "wellness", "coffee"). Searches title, description, and category.'
          },
          location: {
            type: 'string',
            description: 'City, venue, or country to filter by (e.g., "Berlin", "Mallorca", "Germany", "Dubai").'
          },
          organizer: {
            type: 'string',
            description: 'Name of the event organizer or host to filter by.'
          },
          date_from: {
            type: 'string',
            description: 'Start of date range in YYYY-MM-DD format (e.g., "2026-04-01"). Defaults to today.'
          },
          date_to: {
            type: 'string',
            description: 'End of date range in YYYY-MM-DD format (e.g., "2026-04-30").'
          },
          max_price: {
            type: 'number',
            description: 'Maximum price in EUR. Use 0 for free events only.'
          },
          type_filter: {
            type: 'string',
            enum: ['meetup', 'live_room', 'all'],
            description: 'Filter by event type. Defaults to all.'
          }
        },
        required: []
      }
    },
    {
      name: 'search_community',
      description: 'Search community groups and their activities. Use when the user asks about groups, communities, who to connect with, or community activities.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query for community groups (e.g., "meditation", "runners", "nutrition")'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'get_recommendations',
      description: 'Get personalized recommendations for the user including suggested groups, events to attend, and daily matches. Use when the user asks "what should I do?", "any suggestions?", "who should I meet?", or "what events are for me?"',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['community', 'match', 'all'],
            description: 'Type of recommendations. Defaults to all.'
          }
        },
        required: []
      }
    },
    // VTID-CHAT-SEND: Direct-message tools so Vitana can send a chat message to
    // another community member on the user's behalf (text-chat parity with the
    // ORB voice surface). Backed by the same shared handlers used by voice.
    {
      name: 'resolve_recipient',
      description: `Resolve the person the user wants to message to one or more candidate community members. Call this when the user names someone to message but you are not sure exactly who they mean (e.g. ambiguous first name). Returns scored candidates; if exactly one high-confidence match is returned you can proceed, otherwise ask the user to clarify. You usually do NOT need this when the user gave a full, unambiguous name — in that case call send_chat_message directly with recipient_label set to that name.`,
      parameters: {
        type: 'object',
        properties: {
          spoken_name: {
            type: 'string',
            description: 'The name of the person to message, exactly as the user said it (e.g. "Maria", "Mariia Maksina", or a Vitana ID).'
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of candidates to return. Defaults to 5.'
          }
        },
        required: ['spoken_name']
      }
    },
    {
      name: 'send_chat_message',
      description: `Send a direct chat message to another community member on the user's behalf. Use this when the user asks to send/write a message to a person (e.g. "send Maria a message saying ...", "schick Mariia eine Nachricht: ...").

CONFIRMATION CONTRACT (mandatory — the server enforces this — a call without confirmed=true never delivers the message):
1. Call send_chat_message(recipient_label, body) WITHOUT confirmed=true. It returns a preview ("Ready to send to X: ...") — nothing is sent yet.
2. Read the recipient AND message body back to the user verbatim ("Soll ich die Nachricht an <name> senden: '<body>'?").
3. Wait for explicit confirmation (e.g. "yes, send it" / "ja, versende es").
4. Call send_chat_message again with the SAME arguments PLUS confirmed: true to actually deliver it.

NEVER call this tool with confirmed=true before the user has confirmed the read-back. NEVER describe these steps to the user in prose — just follow them silently and call the tool.
NEVER claim a message was sent unless a call with confirmed=true returned ok. If it returns an error, tell the user honestly and offer to try again — do NOT silently switch to a different action.`,
      parameters: {
        type: 'object',
        properties: {
          recipient_user_id: {
            type: 'string',
            description: 'The recipient\'s user UUID, if you already have it from a previous resolve_recipient call. Optional — if you only have the name, leave this out and set recipient_label.'
          },
          recipient_label: {
            type: 'string',
            description: 'The recipient\'s name exactly as the user referred to them (full name preferred, e.g. "Mariia Maksina"). Used to look up and verify the recipient.'
          },
          body: {
            type: 'string',
            description: 'The message text to send, exactly as the user dictated it.'
          },
          confirmed: {
            type: 'boolean',
            description: 'Pass true ONLY after the user explicitly confirmed the read-back of both recipient and message. Omit or false for the preview call.'
          }
        },
        required: ['recipient_label', 'body']
      }
    },
    // ===== VTID-DEV-ASSIST: Developer Assistant Tools =====
    {
      name: 'dev_list_tasks',
      description: 'List all tasks from the VTID ledger with status, column, and terminal state derived from OASIS events.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Max tasks to return. Defaults to 50.' },
          status: { type: 'string', description: 'Filter by status.' },
          layer: { type: 'string', description: 'Filter by layer.' }
        },
        required: []
      }
    },
    {
      name: 'dev_get_task_detail',
      description: 'Get full detail for a specific VTID including ledger data and recent OASIS events.',
      parameters: {
        type: 'object',
        properties: {
          vtid: { type: 'string', description: 'The VTID to look up.' }
        },
        required: ['vtid']
      }
    },
    {
      name: 'dev_generate_spec',
      description: 'Generate an implementation spec from seed notes for a VTID.',
      parameters: {
        type: 'object',
        properties: {
          vtid: { type: 'string', description: 'The VTID to generate a spec for.' },
          seed_notes: { type: 'string', description: 'Additional context or notes.' }
        },
        required: ['vtid']
      }
    },
    {
      name: 'dev_get_spec',
      description: 'Get the current spec content and status for a VTID.',
      parameters: {
        type: 'object',
        properties: {
          vtid: { type: 'string', description: 'The VTID to get the spec for.' }
        },
        required: ['vtid']
      }
    },
    {
      name: 'dev_validate_spec',
      description: 'Run validation checks on a spec for a VTID.',
      parameters: {
        type: 'object',
        properties: {
          vtid: { type: 'string', description: 'The VTID whose spec to validate.' }
        },
        required: ['vtid']
      }
    },
    {
      name: 'dev_quality_check',
      description: 'Run a quality check on a spec for a VTID using the spec quality agent.',
      parameters: {
        type: 'object',
        properties: {
          vtid: { type: 'string', description: 'The VTID whose spec to quality-check.' }
        },
        required: ['vtid']
      }
    },
    {
      name: 'dev_approve_spec',
      description: 'Approve a validated spec for a VTID.',
      parameters: {
        type: 'object',
        properties: {
          vtid: { type: 'string', description: 'The VTID whose spec to approve.' }
        },
        required: ['vtid']
      }
    },
    {
      name: 'dev_list_approvals',
      description: 'List pending approval items (PRs awaiting review).',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Max approvals to return. Defaults to 50.' }
        },
        required: []
      }
    },
    {
      name: 'dev_approval_count',
      description: 'Get the count of pending approvals.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'dev_approve_item',
      description: 'Approve a pending approval item by approval_id. Triggers safe merge.',
      parameters: {
        type: 'object',
        properties: {
          approval_id: { type: 'string', description: 'The approval_id to approve.' }
        },
        required: ['approval_id']
      }
    },
    {
      name: 'dev_reject_item',
      description: 'Reject a pending approval item by approval_id.',
      parameters: {
        type: 'object',
        properties: {
          approval_id: { type: 'string', description: 'The approval_id to reject.' },
          reason: { type: 'string', description: 'Reason for rejection.' }
        },
        required: ['approval_id']
      }
    },
    {
      name: 'dev_query_oasis_events',
      description: 'Query OASIS events with optional filtering by VTID, topic, or status.',
      parameters: {
        type: 'object',
        properties: {
          vtid: { type: 'string', description: 'Filter by VTID.' },
          topic: { type: 'string', description: 'Filter by topic pattern.' },
          status: { type: 'string', description: 'Filter by status.' },
          limit: { type: 'integer', description: 'Max events. Defaults to 50.' }
        },
        required: []
      }
    },
    {
      name: 'dev_create_pr',
      description: 'Create a GitHub pull request for a VTID branch.',
      parameters: {
        type: 'object',
        properties: {
          vtid: { type: 'string', description: 'The VTID this PR is for.' },
          head_branch: { type: 'string', description: 'Branch to merge from.' },
          base_branch: { type: 'string', description: 'Branch to merge into. Defaults to main.' },
          title: { type: 'string', description: 'PR title.' },
          body: { type: 'string', description: 'PR body.' }
        },
        required: ['vtid', 'head_branch']
      }
    },
    {
      name: 'dev_merge_pr',
      description: 'Safe merge a PR with CI gate. Only merges if checks pass.',
      parameters: {
        type: 'object',
        properties: {
          vtid: { type: 'string', description: 'The VTID for this merge.' },
          pr_number: { type: 'integer', description: 'PR number to merge.' },
          merge_method: { type: 'string', enum: ['squash', 'merge', 'rebase'], description: 'Merge method. Defaults to squash.' }
        },
        required: ['vtid', 'pr_number']
      }
    },
    {
      name: 'dev_deploy_service',
      description: 'Deploy a service via CI/CD pipeline.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Service to deploy (e.g., gateway).' },
          vtid: { type: 'string', description: 'VTID triggering this deploy.' },
          environment: { type: 'string', enum: ['production', 'staging'], description: 'Target environment.' }
        },
        required: ['service']
      }
    },
    {
      name: 'dev_deployment_status',
      description: 'Check deployment history and status.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Filter by service.' },
          limit: { type: 'integer', description: 'Max deployments. Defaults to 10.' }
        },
        required: []
      }
    },
    {
      name: 'dev_cicd_health',
      description: 'Check CI/CD pipeline health.',
      parameters: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'dev_lock_status',
      description: 'Check deploy concurrency lock status.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  ]
};

// ==================== Governance Evaluation ====================

/**
 * Evaluate governance rules for an operator action
 * Calls POST /api/v1/governance/evaluate internally
 */
async function evaluateGovernance(actionId: string, payload: Record<string, unknown>): Promise<GovernanceResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0536] Supabase not configured - allowing action by default');
    return {
      ok: true,
      allowed: true,
      level: 'L4',
      violations: []
    };
  }

  try {
    // For operator actions, evaluate with action context
    const evaluationPayload = {
      action: actionId,
      service: 'operator-chat',
      environment: 'dev',
      vtid: payload.vtid || 'VTID-0536',
      ...payload
    };

    // Call the internal governance evaluation
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/evaluate_governance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
      },
      body: JSON.stringify(evaluationPayload)
    });

    // If RPC doesn't exist, use direct governance rules query
    if (!resp.ok) {
      // Fallback: fetch governance rules and evaluate locally
      return await evaluateGovernanceLocal(actionId, payload);
    }

    const result = await resp.json() as GovernanceResult;
    return result;
  } catch (error: any) {
    console.warn(`[VTID-0536] Governance evaluation error: ${error.message}`);
    // Fail-open: allow action if governance evaluation fails
    return {
      ok: true,
      allowed: true,
      level: 'L4',
      violations: []
    };
  }
}

/**
 * Local governance evaluation fallback
 * Evaluates rules directly when RPC is not available
 */
async function evaluateGovernanceLocal(actionId: string, payload: Record<string, unknown>): Promise<GovernanceResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: true, allowed: true, level: 'L4', violations: [] };
  }

  try {
    // Fetch active governance rules
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/governance_rules?is_active=eq.true&select=*`,
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
        }
      }
    );

    if (!resp.ok) {
      console.warn(`[VTID-0536] Governance rules fetch failed: ${resp.status}`);
      return { ok: true, allowed: true, level: 'L4', violations: [] };
    }

    const rules = await resp.json() as any[];
    const violations: GovernanceResult['violations'] = [];
    let highestLevel: GovernanceResult['level'] = 'L4';

    // Evaluate each rule
    for (const rule of rules) {
      const logic = rule.logic || {};
      const appliesTo = logic.applies_to || [];

      // Check if rule applies to operator actions
      const appliesToOperator =
        appliesTo.includes('operator') ||
        appliesTo.includes('operator.autopilot') ||
        appliesTo.includes(actionId) ||
        appliesTo.includes('*');

      if (!appliesToOperator) continue;

      // Evaluate risk level condition
      if (logic.risk_level && payload.risk_level) {
        const riskLevelMap: Record<string, number> = { 'A1': 1, 'A2': 2, 'A3': 3, 'A4': 4 };
        const requiredLevel = riskLevelMap[logic.risk_level] || 4;
        const providedLevel = riskLevelMap[payload.risk_level as string] || 4;

        if (providedLevel > requiredLevel) {
          const ruleLevel = rule.level || 'L2';
          violations.push({
            rule_id: rule.rule_id || rule.id,
            level: ruleLevel,
            message: `Risk level ${payload.risk_level} exceeds allowed level ${logic.risk_level}`
          });

          // Track highest severity
          const levelOrder: Record<string, number> = { 'L1': 1, 'L2': 2, 'L3': 3, 'L4': 4 };
          if (levelOrder[ruleLevel] < levelOrder[highestLevel]) {
            highestLevel = ruleLevel as GovernanceResult['level'];
          }
        }
      }
    }

    // Determine if action is allowed
    const hasBlockingViolation = violations.some(v => v.level === 'L1' || v.level === 'L2');

    return {
      ok: true,
      allowed: !hasBlockingViolation,
      level: violations.length > 0 ? highestLevel : 'L4',
      violations
    };
  } catch (error: any) {
    console.warn(`[VTID-0536] Local governance evaluation error: ${error.message}`);
    return { ok: true, allowed: true, level: 'L4', violations: [] };
  }
}

// ==================== OASIS Event Logging ====================

/**
 * Log an assistant turn event to OASIS
 */
async function logAssistantTurn(params: {
  vtid: string;
  threadId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  result: ToolExecutionResult;
}): Promise<void> {
  await emitOasisEvent({
    vtid: params.vtid,
    type: 'assistant.turn',
    source: 'operator-console',
    status: params.result.ok ? 'success' : 'error',
    message: `Tool call: ${params.toolName}`,
    payload: {
      threadId: params.threadId,
      tool: params.toolName,
      args: params.toolArgs,
      result: params.result.ok ? 'success' : 'error',
      error: params.result.error
    }
  }).catch(err => console.warn('[VTID-0536] Failed to log assistant turn:', err.message));
}

/**
 * Log autopilot intent events to OASIS
 */
async function logAutopilotIntent(params: {
  vtid: string;
  threadId: string;
  action: 'created' | 'approved' | 'rejected' | 'executed';
  details: Record<string, unknown>;
}): Promise<void> {
  // Phase 1 W2 (BOOTSTRAP-PHASE1-W2-CONSENT-METADATA): tag with data_export_ok
  // only where the thread's tenant has established export consent, so the
  // intent-kind dataset extractor can ingest these events. Default off.
  const identity = threadIdentityMap.get(params.threadId);
  const consentTag = await dataExportConsentTag({
    tenantId: identity?.tenant_id,
    userId: identity?.user_id,
  });
  await emitOasisEvent({
    vtid: params.vtid,
    type: `autopilot.intent.${params.action}`,
    source: 'operator-console',
    status: params.action === 'rejected' ? 'warning' : 'success',
    message: `Autopilot intent ${params.action}`,
    payload: {
      threadId: params.threadId,
      ...params.details,
      ...consentTag
    }
  }).catch(err => console.warn('[VTID-0536] Failed to log autopilot intent:', err.message));
}

// ==================== Tool Implementations ====================

/**
 * Execute autopilot.create_task tool
 * - Evaluates governance first
 * - Creates VTID via Gateway
 * - Inserts task into OASIS
 * - Calls plan endpoint
 * - Emits OASIS events
 */
async function executeCreateTask(
  args: { description: string; priority?: string; tags?: string[] },
  threadId: string
): Promise<ToolExecutionResult> {
  const requestId = randomUUID();
  console.log(`[VTID-0536] create_task called: ${args.description.substring(0, 50)}...`);

  // Step 1: Evaluate governance
  const governanceResult = await evaluateGovernance('operator.autopilot.create_task', {
    role: 'operator',
    risk_level: 'A4', // Task creation is low-risk
    description: args.description,
    priority: args.priority || 'medium',
    tags: args.tags || []
  });

  // Log governance evaluation
  await emitOasisEvent({
    vtid: 'VTID-0536',
    type: 'governance.evaluate',
    source: 'operator-console',
    status: governanceResult.allowed ? 'success' : 'warning',
    message: `Governance evaluated for operator.autopilot.create_task: ${governanceResult.allowed ? 'allowed' : 'blocked'}`,
    payload: {
      action_id: 'operator.autopilot.create_task',
      allowed: governanceResult.allowed,
      level: governanceResult.level,
      violations_count: governanceResult.violations.length
    }
  }).catch(err => console.warn('[VTID-0536] Failed to log governance event:', err.message));

  // Step 2: Check if blocked by governance
  if (!governanceResult.allowed) {
    await logAutopilotIntent({
      vtid: 'VTID-0536',
      threadId,
      action: 'rejected',
      details: {
        reason: 'governance_blocked',
        violations: governanceResult.violations
      }
    });

    return {
      ok: false,
      governanceBlocked: true,
      governanceResult,
      error: `Governance blocked: ${governanceResult.violations.map(v => v.message).join('; ')}`
    };
  }

  // Step 3: Log intent created
  await logAutopilotIntent({
    vtid: 'VTID-0536',
    threadId,
    action: 'created',
    details: {
      description: args.description,
      priority: args.priority,
      tags: args.tags
    }
  });

  // Step 4: Create the task (VTID + ledger entry + spec event)
  const createdTask = await createOperatorTask({
    rawDescription: args.description,
    sourceThreadId: threadId,
    sourceMessageId: requestId
  });

  if (!createdTask) {
    return {
      ok: false,
      error: 'Failed to create task: VTID generation or task entry failed'
    };
  }

  // VTID-03819: a similar task already exists — nothing new was allocated,
  // so skip the vtid.created/executed intent logging below (those describe
  // a task that was actually created) and tell the caller which existing
  // VTID to use instead.
  if (createdTask.duplicate) {
    console.log(`[VTID-03819] Skipping creation — similar task already exists: ${createdTask.vtid}`);
    return {
      ok: true,
      data: {
        vtid: createdTask.vtid,
        title: createdTask.title,
        mode: createdTask.mode,
        status: 'existing',
        duplicate: true,
        message: `A similar task already exists: ${createdTask.vtid} — "${createdTask.title}". No new task was created.`
      }
    };
  }

  // Step 5: Log VTID created
  await emitOasisEvent({
    vtid: createdTask.vtid,
    type: 'vtid.created',
    source: 'operator-console',
    status: 'success',
    message: `VTID created: ${createdTask.vtid}`,
    payload: {
      vtid: createdTask.vtid,
      title: createdTask.title,
      threadId,
      sourceMessageId: requestId,
      priority: args.priority || 'medium',
      tags: args.tags || []
    }
  }).catch(err => console.warn('[VTID-0536] Failed to log VTID created:', err.message));

  // Step 6: Trigger planning (call plan endpoint)
  // Note: In V1, we just create the task spec - planner agents will pick it up
  // For now, emit autopilot.plan.created event is handled by the planner

  // Step 7: Log intent executed
  await logAutopilotIntent({
    vtid: createdTask.vtid,
    threadId,
    action: 'executed',
    details: {
      vtid: createdTask.vtid,
      title: createdTask.title
    }
  });

  console.log(`[VTID-0536] Task created: ${createdTask.vtid}`);

  return {
    ok: true,
    data: {
      vtid: createdTask.vtid,
      title: createdTask.title,
      mode: createdTask.mode,
      status: 'pending',
      message: `Task created successfully with VTID ${createdTask.vtid}. It has been queued for planning.`
    }
  };
}

/**
 * VTID-03820: Execute autopilot_execute_task — the DeepSeek-powered
 * execution on-ramp. Higher-risk than task creation (this writes code and
 * opens a real PR), so it gets its own governance action id and a higher
 * risk_level. The actual approval/safety-gate/kill-switch logic all lives
 * in triggerOperatorExecution()/the reused Dev Autopilot machinery — this
 * function is a thin governance-logged wrapper, matching executeCreateTask's
 * own shape.
 */
/**
 * VTID-04002: render an on-ramp rejection with its safety-gate violations so
 * the reason (rule code + offending path) is visible in the chat reply.
 */
export function describeOnRampRejection(error: string, violations?: unknown[]): string {
  if (!Array.isArray(violations) || violations.length === 0) return error;
  const parts = violations.slice(0, 8).map((v) => {
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const code = typeof o.code === 'string' ? o.code : 'violation';
      const detail = (o.detail && typeof o.detail === 'object') ? (o.detail as Record<string, unknown>) : {};
      const rawPath = o.path ?? o.file ?? detail.path ?? detail.file
        ?? (Array.isArray(detail.files) ? (detail.files as unknown[]).map(String).join(', ') : undefined);
      const path = typeof rawPath === 'string' && rawPath.length > 0 ? rawPath : undefined;
      const msg = typeof o.message === 'string' ? o.message : '';
      return [code, path ? `(${path})` : '', msg ? `— ${msg}` : ''].filter(Boolean).join(' ');
    }
    return String(v);
  });
  return `${error}: ${parts.join('; ')}`;
}

async function executeExecuteTask(
  args: { vtid: string; plan_markdown: string; files_referenced: string[] },
  threadId: string
): Promise<ToolExecutionResult> {
  const requestId = randomUUID();
  console.log(`[VTID-03820] execute_task called for ${args.vtid}`);

  // VTID-03851: refuse before governance, before any DB read, before any
  // OASIS event that could be mistaken for a legitimate attempt. The
  // marker is whatever THIS request's route handler wrote (set on a
  // verified JWT, cleared otherwise) — an anonymous request can never
  // inherit a previous admin's thread.
  const authz = isExecuteTaskAuthorized(getThreadAuth(threadId));
  if (!authz.ok) {
    console.warn(`[VTID-03851] execute_task REFUSED for ${args.vtid} thread=${threadId}: ${authz.reason}`);
    await logAutopilotIntent({
      vtid: args.vtid,
      threadId,
      action: 'rejected',
      details: { reason: `auth_${authz.reason}` },
    });
    return { ok: false, error: describeExecuteTaskRefusal(authz.reason) };
  }

  const governanceResult = await evaluateGovernance('operator.autopilot.execute_task', {
    role: 'operator',
    risk_level: 'A2', // writes code + opens a PR — higher risk than task creation (A4)
    vtid: args.vtid,
  });

  await emitOasisEvent({
    vtid: args.vtid,
    type: 'governance.evaluate',
    source: 'operator-console',
    status: governanceResult.allowed ? 'success' : 'warning',
    message: `Governance evaluated for operator.autopilot.execute_task: ${governanceResult.allowed ? 'allowed' : 'blocked'}`,
    payload: {
      action_id: 'operator.autopilot.execute_task',
      allowed: governanceResult.allowed,
      level: governanceResult.level,
      violations_count: governanceResult.violations.length,
    },
  }).catch(err => console.warn('[VTID-03820] Failed to log governance event:', err.message));

  if (!governanceResult.allowed) {
    await logAutopilotIntent({
      vtid: args.vtid,
      threadId,
      action: 'rejected',
      details: { reason: 'governance_blocked', violations: governanceResult.violations },
    });
    return {
      ok: false,
      governanceBlocked: true,
      governanceResult,
      error: `Governance blocked: ${governanceResult.violations.map(v => v.message).join('; ')}`,
    };
  }

  const result = await triggerOperatorExecution({
    vtid: args.vtid,
    planMarkdown: args.plan_markdown,
    filesReferenced: args.files_referenced,
    requestedBy: `operator-chat:${threadId}`,
  });

  if (!result.ok) {
    await logAutopilotIntent({
      vtid: args.vtid,
      threadId,
      action: 'rejected',
      details: { reason: result.error, violations: result.violations },
    });
    // VTID-04002: surface the safety-gate violations to the operator. Before
    // this, only the bare string 'safety gate blocked approval' reached the
    // chat and the model had no way to tell the user WHICH rule or path was
    // rejected (Test Run #1: a bare `memory-relevance-scoring.ts` failed the
    // allow-scope glob and the operator saw no path at all).
    return { ok: false, error: describeOnRampRejection(result.error, result.violations) };
  }

  await logAutopilotIntent({
    vtid: args.vtid,
    threadId,
    action: 'executed',
    details: { execution_id: result.execution_id, finding_id: result.finding_id, requestId },
  });

  return {
    ok: true,
    data: {
      vtid: args.vtid,
      execution_id: result.execution_id,
      provider: 'deepseek',
      status: 'queued',
      message: `Execution queued for ${args.vtid} via the DeepSeek on-ramp (${result.execution_id.slice(0, 8)}). It will run on the next executor tick.`,
    },
  };
}

/**
 * VTID-04007 (W2): autopilot_run_task — open-ended intake. The user's
 * request, verbatim, becomes the plan; the on-ramp allocates the VTID
 * (server-side self-allocation, VTID-04005) and pins the AGENT executor on
 * the row, and the safety gate's globs are applied to the agent's real diff
 * afterwards. Same authz (VTID-03851) and governance shape as
 * executeExecuteTask; the only new capability is that no VTID and no file
 * list have to be named up front.
 */
const INTAKE_TELEMETRY_VTID = 'VTID-DEV-AUTOPILOT';

async function executeRunTask(
  args: { request: string; title?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  const requestId = randomUUID();
  const request = typeof args.request === 'string' ? args.request.trim() : '';
  console.log(`[VTID-04007] run_task called (${request.length} chars)`);

  const authz = isExecuteTaskAuthorized(getThreadAuth(threadId));
  if (!authz.ok) {
    console.warn(`[VTID-04007] run_task REFUSED thread=${threadId}: ${authz.reason}`);
    await logAutopilotIntent({
      vtid: INTAKE_TELEMETRY_VTID,
      threadId,
      action: 'rejected',
      details: { reason: `auth_${authz.reason}`, tool: 'autopilot_run_task' },
    });
    return { ok: false, error: describeExecuteTaskRefusal(authz.reason).replace('autopilot_execute_task', 'autopilot_run_task') };
  }
  if (request.length < 12) {
    return { ok: false, error: 'autopilot_run_task needs the request in the user\'s own words (at least a sentence) — nothing was queued.' };
  }

  const governanceResult = await evaluateGovernance('operator.autopilot.run_task', {
    role: 'operator',
    risk_level: 'A2', // writes code + opens a PR, and allocates the VTID itself
    vtid: INTAKE_TELEMETRY_VTID,
  });

  await emitOasisEvent({
    vtid: INTAKE_TELEMETRY_VTID,
    type: 'governance.evaluate',
    source: 'operator-console',
    status: governanceResult.allowed ? 'success' : 'warning',
    message: `Governance evaluated for operator.autopilot.run_task: ${governanceResult.allowed ? 'allowed' : 'blocked'}`,
    payload: {
      action_id: 'operator.autopilot.run_task',
      allowed: governanceResult.allowed,
      level: governanceResult.level,
      violations_count: governanceResult.violations.length,
      intake: 'open_ended',
    },
  }).catch(err => console.warn('[VTID-04007] Failed to log governance event:', err.message));

  if (!governanceResult.allowed) {
    await logAutopilotIntent({
      vtid: INTAKE_TELEMETRY_VTID,
      threadId,
      action: 'rejected',
      details: { reason: 'governance_blocked', violations: governanceResult.violations, tool: 'autopilot_run_task' },
    });
    return {
      ok: false,
      governanceBlocked: true,
      governanceResult,
      error: `Governance blocked: ${governanceResult.violations.map(v => v.message).join('; ')}`,
    };
  }

  const result = await triggerOperatorExecution({
    planMarkdown: request,
    title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined,
    filesReferenced: [],
    openEnded: true,
    requestedBy: `operator-chat:${threadId}`,
  });

  if (!result.ok) {
    await logAutopilotIntent({
      vtid: INTAKE_TELEMETRY_VTID,
      threadId,
      action: 'rejected',
      details: { reason: result.error, violations: result.violations, tool: 'autopilot_run_task' },
    });
    return { ok: false, error: describeOnRampRejection(result.error, result.violations) };
  }

  await logAutopilotIntent({
    vtid: result.vtid,
    threadId,
    action: 'executed',
    details: { execution_id: result.execution_id, finding_id: result.finding_id, requestId, intake: 'open_ended', vtid_allocated: result.vtid_allocated },
  });

  return {
    ok: true,
    data: {
      vtid: result.vtid,
      vtid_allocated: result.vtid_allocated,
      execution_id: result.execution_id,
      executor: 'agent',
      provider: 'deepseek',
      status: 'queued',
      message: `Allocated ${result.vtid} and queued an agent-mode execution (${result.execution_id.slice(0, 8)}) for it. The agent will locate the code, make the change, run tsc + jest and open a pull request on the next executor tick.`,
    },
  };
}

/**
 * Execute autopilot.get_status tool
 * - Fetches task status from OASIS
 * - Includes planner/worker/validator state
 * - Emits OASIS event
 */
async function executeGetStatus(
  args: { vtid: string },
  threadId: string
): Promise<ToolExecutionResult> {
  console.log(`[VTID-0536] get_status called for: ${args.vtid}`);

  // Step 1: Validate VTID format
  // VTID-01007: Accept 4-5 digit VTIDs (canonical format is VTID-##### from VTID-01000+)
  const vtidRegex = /^(VTID-\d{4,5}(-[A-Za-z0-9]+)?|[A-Z]+-[A-Z0-9]+-\d{4}-\d{4})$/;
  if (!vtidRegex.test(args.vtid)) {
    return {
      ok: false,
      error: `Invalid VTID format: ${args.vtid}. Expected format like VTID-0533, VTID-01006 or DEV-COMHU-2024-0001`
    };
  }

  // Step 2: Get task status
  const taskStatus = await getAutopilotTaskStatus(args.vtid);

  if (!taskStatus) {
    return {
      ok: false,
      error: `Task ${args.vtid} not found in the system`
    };
  }

  // Step 3: Emit OASIS event
  await emitOasisEvent({
    vtid: args.vtid,
    type: 'autopilot.status.requested',
    source: 'operator-console',
    status: 'info',
    message: `Status requested for ${args.vtid}`,
    payload: {
      threadId,
      status: taskStatus.status
    }
  }).catch(err => console.warn('[VTID-0536] Failed to log status request:', err.message));

  console.log(`[VTID-0536] Status retrieved for ${args.vtid}: ${taskStatus.status}`);

  return {
    ok: true,
    data: {
      vtid: taskStatus.vtid,
      status: taskStatus.status,
      title: taskStatus.title,
      planSteps: taskStatus.planSteps,
      validationStatus: taskStatus.validationStatus,
      createdAt: taskStatus.createdAt,
      updatedAt: taskStatus.updatedAt,
      message: formatStatusMessage(taskStatus)
    }
  };
}

/**
 * Format a human-readable status message
 */
function formatStatusMessage(status: TaskStatusResponse): string {
  let msg = `Task ${status.vtid} is currently **${status.status}**`;

  if (status.title) {
    msg += `\n**Title:** ${status.title}`;
  }

  if (status.planSteps !== undefined && status.planSteps > 0) {
    msg += `\n**Plan:** ${status.planSteps} steps`;
  }

  if (status.validationStatus) {
    msg += `\n**Validation:** ${status.validationStatus}`;
  }

  return msg;
}

/**
 * Execute autopilot.list_recent_tasks tool
 * - Queries OASIS for recent tasks
 * - Returns summarized list
 * - Emits OASIS event
 */
async function executeListRecentTasks(
  args: { limit?: number; status?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  const limit = Math.min(Math.max(args.limit || 10, 1), 50);
  console.log(`[VTID-0536] list_recent_tasks called: limit=${limit}, status=${args.status || 'all'}`);

  try {
    // Step 1: Query recent tasks from VtidLedger
    const tasks = await queryRecentTasks(limit, args.status);

    // Step 2: Emit OASIS event
    await emitOasisEvent({
      vtid: 'VTID-0536',
      type: 'autopilot.list.requested',
      source: 'operator-console',
      status: 'info',
      message: `Recent tasks list requested: ${tasks.length} tasks returned`,
      payload: {
        threadId,
        limit,
        statusFilter: args.status || null,
        count: tasks.length
      }
    }).catch(err => console.warn('[VTID-0536] Failed to log list request:', err.message));

    console.log(`[VTID-0536] Retrieved ${tasks.length} recent tasks`);

    return {
      ok: true,
      data: {
        count: tasks.length,
        tasks,
        message: formatTaskListMessage(tasks)
      }
    };
  } catch (error: any) {
    return {
      ok: false,
      error: `Failed to retrieve tasks: ${error.message}`
    };
  }
}

/**
 * Query recent tasks from VtidLedger
 */
async function queryRecentTasks(limit: number, statusFilter?: string): Promise<Array<{
  vtid: string;
  title: string;
  status: string;
  createdAt: string;
}>> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-0536] Supabase not configured');
    return [];
  }

  try {
    let queryUrl = `${SUPABASE_URL}/rest/v1/vtid_ledger?select=vtid,title,status,created_at&order=created_at.desc&limit=${limit}`;

    if (statusFilter) {
      queryUrl += `&status=eq.${encodeURIComponent(statusFilter)}`;
    }

    const resp = await fetch(queryUrl, {
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
      }
    });

    if (!resp.ok) {
      console.warn(`[VTID-0536] Tasks query failed: ${resp.status}`);
      return [];
    }

    const tasks = await resp.json() as Array<{
      vtid: string;
      title: string;
      status: string;
      created_at: string;
    }>;

    return tasks.map(t => ({
      vtid: t.vtid,
      title: t.title || 'Untitled',
      status: t.status || 'unknown',
      createdAt: t.created_at
    }));
  } catch (error: any) {
    console.warn(`[VTID-0536] Tasks query error: ${error.message}`);
    return [];
  }
}

/**
 * Format task list as human-readable message
 */
function formatTaskListMessage(tasks: Array<{ vtid: string; title: string; status: string; createdAt: string }>): string {
  if (tasks.length === 0) {
    return 'No tasks found matching the criteria.';
  }

  let msg = `Found **${tasks.length}** recent task(s):\n\n`;

  for (const task of tasks) {
    const createdDate = new Date(task.createdAt).toLocaleDateString();
    msg += `- **${task.vtid}** [${task.status}]: ${task.title.substring(0, 60)}${task.title.length > 60 ? '...' : ''} _(${createdDate})_\n`;
  }

  return msg;
}

// ==================== VTID-01159: OASIS-Only Task Discovery ====================

/**
 * VTID-01159: Canonical pending status set
 */
const PENDING_STATUSES: string[] = ['scheduled', 'allocated', 'in_progress'];

/**
 * VTID-01159: Valid VTID format pattern
 */
const VTID_PATTERN = /^VTID-\d{4,5}$/;

/**
 * VTID-01159: Legacy patterns to ignore
 */
const LEGACY_PATTERNS = [
  /^DEV-/,
  /^ADM-/,
  /^AICOR-/,
  /^OASIS-TASK-/,
];

/**
 * VTID-01159: Check if an ID matches a legacy pattern
 */
function isLegacyId(id: string): { isLegacy: boolean; pattern?: string } {
  for (const pattern of LEGACY_PATTERNS) {
    if (pattern.test(id)) {
      return { isLegacy: true, pattern: pattern.source };
    }
  }
  return { isLegacy: false };
}

/**
 * VTID-01159: Pending task structure
 */
interface PendingTask {
  vtid: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * VTID-01159: Ignored item structure
 */
interface IgnoredItem {
  id: string;
  reason: 'ignored_by_contract';
  details: string;
}

/**
 * VTID-01159: Execute discover_oasis_tasks tool
 * HARD GOVERNANCE:
 * 1. OASIS is the ONLY source of truth for tasks
 * 2. MCP MUST NOT infer pending work from repository files
 * 3. MCP MUST NOT create/update tasks - READ-ONLY
 * 4. Tasks must be traceable to OASIS records
 * 5. Legacy DEV-* items must be listed as ignored
 * 6. If OASIS fails, return error - NO fallback to repo scanning
 */
async function executeDiscoverOasisTasks(
  args: { statuses?: string[]; limit?: number },
  threadId: string
): Promise<ToolExecutionResult> {
  const limit = Math.min(Math.max(args.limit || 50, 1), 200);
  const requestedStatuses = args.statuses || ['scheduled', 'allocated', 'in_progress'];

  // Validate statuses are in canonical set
  const validStatuses = requestedStatuses.filter(s => PENDING_STATUSES.indexOf(s) !== -1);

  console.log(`[VTID-01159] discover_oasis_tasks called: statuses=${validStatuses.join(',')}, limit=${limit}`);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error('[VTID-01159] OASIS/Supabase not configured - cannot discover tasks');
    // HARD GOVERNANCE: Return error, do NOT fallback to repo scanning
    return {
      ok: false,
      error: 'OASIS_RELIABILITY_ERROR: Database not configured. Cannot discover tasks without OASIS connection. NO fallback to repo scanning permitted.'
    };
  }

  try {
    // Step A: Query OASIS ONLY (Section 4 - Step A from VTID-01161)
    // VTID-01052: Exclude deleted tasks by default
    const queryUrl = `${SUPABASE_URL}/rest/v1/vtid_ledger?status=neq.deleted&order=updated_at.desc&limit=${limit}`;

    const resp = await fetch(queryUrl, {
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`
      }
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(`[VTID-01159] OASIS query failed: ${resp.status} - ${errorText}`);
      // HARD GOVERNANCE: Return error, do NOT fallback
      return {
        ok: false,
        error: `OASIS_RELIABILITY_ERROR: Database query failed (${resp.status}). Cannot discover tasks. NO fallback to repo scanning permitted.`
      };
    }

    const oasisTasks = await resp.json() as Array<{
      vtid: string;
      title: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>;

    // Step B: Filter + Validate (Section 4 - Step B from VTID-01161)
    const pending: PendingTask[] = [];
    const ignored: IgnoredItem[] = [];

    for (const task of oasisTasks) {
      const vtid = task.vtid;

      // Check for legacy ID patterns first
      const { isLegacy, pattern } = isLegacyId(vtid);
      if (isLegacy) {
        ignored.push({
          id: vtid,
          reason: 'ignored_by_contract',
          details: `Non-numeric VTID format (matches ${pattern}); repo artifacts are not task truth.`
        });
        continue;
      }

      // Validate VTID format
      const vtidFormatValid = VTID_PATTERN.test(vtid);
      if (!vtidFormatValid) {
        ignored.push({
          id: vtid,
          reason: 'ignored_by_contract',
          details: `VTID format invalid. Expected VTID-\\d{4,5}, got: ${vtid}`
        });
        continue;
      }

      // Validate status is in requested statuses
      const statusIsPending = validStatuses.indexOf(task.status) !== -1;
      if (!statusIsPending) {
        // Skip tasks not in requested statuses
        continue;
      }

      // Task passes all validation - add to pending
      pending.push({
        vtid: task.vtid,
        title: task.title || 'Pending Title',
        status: task.status,
        created_at: task.created_at,
        updated_at: task.updated_at
      });
    }

    // Emit OASIS event for discovery (fire and forget)
    emitOasisEvent({
      vtid: 'VTID-01159',
      type: 'vtid.stage.task_discovery.success' as any,
      source: 'operator-console',
      status: 'success',
      message: `Discovered ${pending.length} pending tasks`,
      payload: {
        threadId,
        requested_statuses: validStatuses,
        pending_count: pending.length,
        ignored_count: ignored.length,
        source_of_truth: 'OASIS'
      }
    }).catch(err => console.warn('[VTID-01159] Failed to emit discovery event:', err.message));

    console.log(`[VTID-01159] Discovery complete: ${pending.length} pending, ${ignored.length} ignored`);

    // Format output per VTID-01159 spec (Section 2)
    const formattedMessage = formatDiscoverTasksMessage(pending, ignored);

    return {
      ok: true,
      data: {
        source_of_truth: 'OASIS',
        pending_count: pending.length,
        ignored_count: ignored.length,
        pending,
        ignored,
        message: formattedMessage
      }
    };
  } catch (error: any) {
    console.error(`[VTID-01159] Discovery failed:`, error);

    // Emit failure event
    emitOasisEvent({
      vtid: 'VTID-01159',
      type: 'vtid.stage.task_discovery.failed' as any,
      source: 'operator-console',
      status: 'error',
      message: `Task discovery failed: ${error.message}`,
      payload: {
        threadId,
        requested_statuses: validStatuses,
        error: error.message
      }
    }).catch(() => {});

    // HARD GOVERNANCE: Return error, do NOT fallback to repo scanning
    return {
      ok: false,
      error: `OASIS_RELIABILITY_ERROR: ${error.message}. Cannot discover tasks. NO fallback to repo scanning permitted.`
    };
  }
}

/**
 * VTID-01159: Format discover tasks output per spec Section 2
 *
 * Required Output Format:
 * - "Scheduled/Allocated"
 * - "In Progress"
 * - "Ignored (legacy)"
 * - Each task line: VTID-##### — Title (status)
 * - Footer: Source: OASIS, pending_count
 */
function formatDiscoverTasksMessage(
  pending: PendingTask[],
  ignored: IgnoredItem[]
): string {
  const lines: string[] = [];

  // Group tasks by status category
  const scheduledAllocated = pending.filter(t => t.status === 'scheduled' || t.status === 'allocated');
  const inProgress = pending.filter(t => t.status === 'in_progress');

  // Section 1: Scheduled/Allocated
  lines.push('**Scheduled/Allocated**');
  if (scheduledAllocated.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const task of scheduledAllocated) {
      lines.push(`- ${task.vtid} — ${task.title} (${task.status})`);
    }
  }
  lines.push('');

  // Section 2: In Progress
  lines.push('**In Progress**');
  if (inProgress.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const task of inProgress) {
      lines.push(`- ${task.vtid} — ${task.title} (${task.status})`);
    }
  }
  lines.push('');

  // Section 3: Ignored (legacy)
  if (ignored.length > 0) {
    lines.push('**Ignored (legacy)**');
    for (const item of ignored) {
      lines.push(`- ${item.id} — ${item.details}`);
    }
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push(`**Source:** OASIS`);
  lines.push(`**pending_count:** ${pending.length}`);

  return lines.join('\n');
}

// ==================== VTID-01192: Code Execution Tool ====================

/**
 * VTID-01192: Execute JavaScript code in a sandboxed environment
 * Provides calculation capabilities similar to ChatGPT Code Interpreter
 */
async function executeRunCode(
  args: { code: string; description?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  const { code, description } = args;
  console.log(`[VTID-01192] run_code called: ${description || code.substring(0, 50)}...`);

  try {
    // Create a sandboxed context with safe globals
    const vm = require('vm');

    // Capture console.log output
    const logs: string[] = [];
    const mockConsole = {
      log: (...args: any[]) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
      error: (...args: any[]) => logs.push('ERROR: ' + args.map(a => String(a)).join(' ')),
      warn: (...args: any[]) => logs.push('WARN: ' + args.map(a => String(a)).join(' ')),
    };

    // Safe sandbox context
    const sandbox = {
      console: mockConsole,
      Math,
      Date,
      JSON,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      Number,
      String,
      Boolean,
      Array,
      Object,
      RegExp,
      Error,
      // Utility functions for common calculations
      daysBetween: (date1: Date, date2: Date) => Math.abs(Math.floor((date2.getTime() - date1.getTime()) / (1000 * 60 * 60 * 24))),
      yearsBetween: (date1: Date, date2: Date) => Math.abs(date2.getFullYear() - date1.getFullYear()),
      formatDate: (date: Date) => date.toISOString().split('T')[0],
    };

    // Wrap code to capture return value
    const wrappedCode = `
      (function() {
        ${code}
      })()
    `;

    // Execute with timeout (5 seconds max)
    const script = new vm.Script(wrappedCode);
    const context = vm.createContext(sandbox);
    const result = script.runInContext(context, { timeout: 5000 });

    // Build output from return value and console logs
    let output = '';
    if (logs.length > 0) {
      output += logs.join('\n');
    }
    if (result !== undefined && result !== null) {
      if (output) output += '\n';
      output += typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
    }

    if (!output) {
      output = 'Code executed successfully (no output)';
    }

    console.log(`[VTID-01192] run_code result: ${output.substring(0, 100)}...`);

    return {
      ok: true,
      data: {
        output,
        message: output
      }
    };
  } catch (error: any) {
    console.error(`[VTID-01192] run_code error:`, error.message);
    return {
      ok: false,
      error: `Code execution failed: ${error.message}`
    };
  }
}

// ==================== VTID-01221: Autopilot Recommendation Sync Tools ====================

/**
 * VTID-01221: Execute autopilot_get_recommendations tool
 * Fetches recommendations from Autopilot API and formats via Sync Brief
 */
async function executeGetRecommendations(
  args: {
    role?: string;
    ui_context?: { surface?: string; screen?: string; selection?: string };
    vtid?: string;
    time_window_minutes?: number;
  },
  threadId: string
): Promise<ToolExecutionResult> {
  const LOG = '[VTID-01221]';
  const startTime = Date.now();
  const { role, ui_context, vtid, time_window_minutes = 120 } = args;

  console.log(`${LOG} autopilot_get_recommendations called: vtid=${vtid || 'none'}, role=${role || 'developer'}`);

  // Rate limiting check
  if (!shouldFetchRecommendations(threadId)) {
    console.log(`${LOG} Request debounced for thread ${threadId}`);
    return {
      ok: true,
      data: {
        debounced: true,
        message: 'Recommendations request rate-limited. Please wait a moment before asking again.',
      },
    };
  }

  // Emit request event
  await recommendationSyncEvents.recommendationsRequested(vtid || null, {
    source: 'operator',
    role,
    surface: ui_context?.surface,
    screen: ui_context?.screen,
    thread_id: threadId,
  }).catch(() => {});

  try {
    // Call the existing recommendations API
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase not configured');
    }

    // Build query params for the recommendations API
    const queryParams = new URLSearchParams({
      status: 'new,active',
      limit: '10',
    });

    const response = await fetch(
      `${supabaseUrl}/rest/v1/rpc/get_autopilot_recommendations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({
          p_status: ['new', 'active'],
          p_limit: 10,
          p_offset: 0,
          p_user_id: null,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Recommendations API error: ${response.status} - ${errorText}`);
    }

    const rawRecommendations = await response.json() as any[];
    const durationMs = Date.now() - startTime;

    // Transform to Recommendation format
    const recommendations: Recommendation[] = rawRecommendations.map(r => ({
      id: r.id,
      title: r.title,
      priority: r.priority || 'medium',
      rationale: r.rationale || r.description || '',
      suggested_commands: r.suggested_commands || [],
      verification: r.verification_steps || [],
      related_vtids: r.related_vtids || (r.vtid ? [r.vtid] : []),
      requires_approval: r.requires_approval || false,
      source: r.source_type,
    }));

    // Filter by VTID if specified
    let filteredRecs = recommendations;
    if (vtid) {
      filteredRecs = recommendations.filter(r =>
        r.related_vtids?.includes(vtid) || r.rationale?.includes(vtid)
      );
      // If no VTID-specific recs, return all but note the filter
      if (filteredRecs.length === 0) {
        filteredRecs = recommendations;
      }
    }

    // Emit received event
    await recommendationSyncEvents.recommendationsReceived(
      vtid || null,
      filteredRecs.length,
      filteredRecs.map(r => r.id),
      'operator',
      durationMs
    ).catch(() => {});

    // Format as Sync Brief
    const syncBriefContext: SyncBriefContext = {
      vtid,
      uiContext: ui_context,
      recommendations: filteredRecs,
      isFallback: false,
    };

    const syncBrief = formatSyncBrief(syncBriefContext);

    console.log(`${LOG} Returning ${filteredRecs.length} recommendations in ${durationMs}ms`);

    return {
      ok: true,
      data: {
        recommendations: filteredRecs,
        count: filteredRecs.length,
        formatted: syncBrief.formatted,
        message: syncBrief.formatted,
        vtid: 'VTID-01221',
      },
    };
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    console.error(`${LOG} Failed to fetch recommendations:`, error.message);

    // Emit failure event
    await recommendationSyncEvents.recommendationsFailed(
      vtid || null,
      error.message,
      'operator',
      true
    ).catch(() => {});

    // Return with fallback suggestion
    return {
      ok: false,
      error: `Failed to fetch Autopilot recommendations: ${error.message}`,
      data: {
        fallback_available: true,
        fallback_tools: ['oasis_analyze_vtid', 'dev_verify_deploy_checklist'],
        message: `Autopilot unavailable. Use fallback tools (oasis_analyze_vtid, dev_verify_deploy_checklist) for deterministic analysis.`,
      },
    };
  }
}

/**
 * VTID-01221: Execute oasis_analyze_vtid fallback tool
 * Builds deterministic evidence report from OASIS events
 */
async function executeAnalyzeVTID(
  args: { vtid: string; include_events?: boolean; limit?: number },
  threadId: string
): Promise<ToolExecutionResult> {
  const LOG = '[VTID-01221]';
  const { vtid, include_events = true, limit = 50 } = args;

  console.log(`${LOG} oasis_analyze_vtid called: vtid=${vtid}`);

  // Emit fallback tool usage
  await recommendationSyncEvents.fallbackToolUsed(
    vtid,
    'oasis_analyze_vtid',
    'Autopilot recommendations unavailable',
    'operator'
  ).catch(() => {});

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return {
      ok: false,
      error: 'OASIS not configured - cannot analyze VTID',
    };
  }

  try {
    // Query OASIS events for this VTID
    const eventLimit = Math.min(Math.max(limit, 1), 100);
    const queryUrl = `${supabaseUrl}/rest/v1/oasis_events?vtid=eq.${encodeURIComponent(vtid)}&order=created_at.desc&limit=${eventLimit}`;

    const response = await fetch(queryUrl, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OASIS query failed: ${response.status} - ${errorText}`);
    }

    const events = await response.json() as Array<{
      id: string;
      created_at: string;
      topic: string;
      status: string;
      message: string;
      metadata?: Record<string, unknown>;
    }>;

    // Build analysis report
    const analysis = buildVTIDAnalysis(vtid, events);

    // Format output
    const lines: string[] = [];
    lines.push(`## VTID Analysis: ${vtid}`);
    lines.push('');
    lines.push(`**Status:** ${analysis.currentStatus}`);
    lines.push(`**Events:** ${events.length} recorded`);
    lines.push(`**First Activity:** ${analysis.firstActivity || 'N/A'}`);
    lines.push(`**Last Activity:** ${analysis.lastActivity || 'N/A'}`);
    lines.push('');

    if (analysis.summary.length > 0) {
      lines.push('### Summary');
      analysis.summary.forEach(s => lines.push(`- ${s}`));
      lines.push('');
    }

    if (include_events && events.length > 0) {
      lines.push('### Event Timeline (Recent)');
      events.slice(0, 10).forEach(e => {
        const time = new Date(e.created_at).toLocaleString();
        lines.push(`- **${e.topic}** [${e.status}] - ${e.message} _(${time})_`);
      });
      if (events.length > 10) {
        lines.push(`_...and ${events.length - 10} more events_`);
      }
    }

    lines.push('');
    lines.push('---');
    lines.push('_This is a fallback analysis from OASIS. For AI-generated recommendations, Autopilot must be available._');

    const message = lines.join('\n');

    return {
      ok: true,
      data: {
        vtid,
        current_status: analysis.currentStatus,
        event_count: events.length,
        first_activity: analysis.firstActivity,
        last_activity: analysis.lastActivity,
        summary: analysis.summary,
        events: include_events ? events.slice(0, limit) : [],
        message,
        is_fallback: true,
      },
    };
  } catch (error: any) {
    console.error(`${LOG} VTID analysis failed:`, error.message);
    return {
      ok: false,
      error: `VTID analysis failed: ${error.message}`,
    };
  }
}

/**
 * Build summary analysis from OASIS events
 */
function buildVTIDAnalysis(vtid: string, events: any[]): {
  currentStatus: string;
  firstActivity: string | null;
  lastActivity: string | null;
  summary: string[];
} {
  if (events.length === 0) {
    return {
      currentStatus: 'unknown',
      firstActivity: null,
      lastActivity: null,
      summary: ['No events found for this VTID'],
    };
  }

  // Sort by time (oldest first for summary)
  const sortedByTime = [...events].sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  const firstActivity = sortedByTime[0]?.created_at || null;
  const lastActivity = sortedByTime[sortedByTime.length - 1]?.created_at || null;

  // Determine current status from most recent events
  const recent = events.slice(0, 5);
  let currentStatus = 'in_progress';

  for (const e of recent) {
    const topic = e.topic || '';
    const status = e.status || '';

    if (topic.includes('completed') || topic.includes('success')) {
      currentStatus = 'completed';
      break;
    } else if (topic.includes('failed') || status === 'error') {
      currentStatus = 'failed';
      break;
    } else if (topic.includes('blocked')) {
      currentStatus = 'blocked';
      break;
    } else if (topic.includes('deploy')) {
      currentStatus = 'deploying';
    } else if (topic.includes('merge')) {
      currentStatus = 'merged';
    } else if (topic.includes('pr_created')) {
      currentStatus = 'pr_created';
    }
  }

  // Build summary
  const summary: string[] = [];
  const topics = new Set(events.map(e => e.topic));

  if (topics.has('cicd.github.create_pr.succeeded')) {
    summary.push('PR was created');
  }
  if (topics.has('cicd.github.safe_merge.executed')) {
    summary.push('PR was merged');
  }
  if (topics.has('deploy.gateway.success')) {
    summary.push('Deployment succeeded');
  }
  if (topics.has('deploy.gateway.failed')) {
    summary.push('Deployment failed');
  }
  if (topics.has('governance.deploy.blocked')) {
    summary.push('Deployment was blocked by governance');
  }

  const errorEvents = events.filter(e => e.status === 'error');
  if (errorEvents.length > 0) {
    summary.push(`${errorEvents.length} error event(s) recorded`);
  }

  return { currentStatus, firstActivity, lastActivity, summary };
}

/**
 * VTID-01221: Execute dev_verify_deploy_checklist fallback tool
 * Builds verification checklist from OASIS evidence
 */
async function executeVerifyDeployChecklist(
  args: { vtid: string; service?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  const LOG = '[VTID-01221]';
  const { vtid, service } = args;

  console.log(`${LOG} dev_verify_deploy_checklist called: vtid=${vtid}, service=${service || 'all'}`);

  // Emit fallback tool usage
  await recommendationSyncEvents.fallbackToolUsed(
    vtid,
    'dev_verify_deploy_checklist',
    'Autopilot recommendations unavailable',
    'operator'
  ).catch(() => {});

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return {
      ok: false,
      error: 'OASIS not configured - cannot verify deployment',
    };
  }

  try {
    // Query deployment-related events for this VTID
    const queryUrl = `${supabaseUrl}/rest/v1/oasis_events?vtid=eq.${encodeURIComponent(vtid)}&order=created_at.desc&limit=100`;

    const response = await fetch(queryUrl, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OASIS query failed: ${response.status} - ${errorText}`);
    }

    const events = await response.json() as Array<{
      topic: string;
      status: string;
      message: string;
      metadata?: Record<string, unknown>;
    }>;

    // Build checklist from events
    const checklist = buildDeployChecklist(events, service);

    // Format output
    const lines: string[] = [];
    lines.push(`## Deploy Verification: ${vtid}`);
    if (service) {
      lines.push(`Service: ${service}`);
    }
    lines.push('');

    const passedCount = checklist.filter(c => c.passed).length;
    const totalCount = checklist.length;
    const allPassed = passedCount === totalCount;

    lines.push(`**Result:** ${allPassed ? 'PASSED' : 'INCOMPLETE'} (${passedCount}/${totalCount})`);
    lines.push('');

    lines.push('### Checklist');
    checklist.forEach(item => {
      const icon = item.passed ? '[x]' : '[ ]';
      const evidence = item.evidence ? ` _(${item.evidence})_` : '';
      lines.push(`- ${icon} ${item.check}${evidence}`);
    });

    lines.push('');
    lines.push('---');
    lines.push('_This is a fallback verification from OASIS evidence. For AI-generated recommendations, Autopilot must be available._');

    const message = lines.join('\n');

    return {
      ok: true,
      data: {
        vtid,
        service,
        all_passed: allPassed,
        passed_count: passedCount,
        total_count: totalCount,
        checklist,
        message,
        is_fallback: true,
      },
    };
  } catch (error: any) {
    console.error(`${LOG} Deploy verification failed:`, error.message);
    return {
      ok: false,
      error: `Deploy verification failed: ${error.message}`,
    };
  }
}

const OPERATOR_DEFAULT_REPO = 'exafyltd/vitana-platform';

/**
 * VTID-03946: dev_search_codebase/dev_read_file used to be hardcoded to
 * OPERATOR_DEFAULT_REPO with no way to reach exafyltd/vitana-v1 at all —
 * the repo holding most of the actual Vitana frontend (this repo's own
 * frontend is just the internal Command Hub admin console). A live
 * Operator conversation asked to scope frontend work reported "I don't
 * yet see where the actual console UI lives" and asked the user 8
 * clarifying questions for something the codebase already answers,
 * because the tool could never have found it regardless of query wording.
 * Each entry maps to the GitHub token that actually has read access to it
 * — vitana-v1 reuses FRONTEND_DEPLOY_TOKEN (already provisioned for the
 * PUBLISH-button frontend promotion, CLAUDE.md §8), not a new credential.
 * Never accept an arbitrary repo string from the model — this allowlist is
 * the security boundary.
 */
// Resolved lazily (a function, not a value) so a task-def env change to
// FRONTEND_DEPLOY_TOKEN takes effect without a restart — same convention
// as BEDROCK_ROLE_ARN (CLAUDE.md §2b) — rather than being frozen at
// module-load time.
const OPERATOR_ALLOWED_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1'] as const;
function operatorRepoToken(repo: string): string | undefined {
  return repo === OPERATOR_DEFAULT_REPO ? undefined : process.env.FRONTEND_DEPLOY_TOKEN;
}

function resolveOperatorRepo(requested: string | undefined): { repo: string; token?: string } | { error: string } {
  const repo = requested && requested.trim() ? requested.trim() : OPERATOR_DEFAULT_REPO;
  if (!(OPERATOR_ALLOWED_REPOS as readonly string[]).includes(repo)) {
    return { error: `unknown_repo: "${repo}" is not allowlisted. Allowed: ${OPERATOR_ALLOWED_REPOS.join(', ')}` };
  }
  const token = operatorRepoToken(repo);
  if (repo !== OPERATOR_DEFAULT_REPO && !token) {
    return { error: `repo_token_not_configured: FRONTEND_DEPLOY_TOKEN is not set — cannot read "${repo}" from this environment.` };
  }
  return { repo, token };
}

/**
 * VTID-03835: dev_search_codebase — read-only GitHub code search.
 */
async function executeDevSearchCodebase(
  args: { query: string; path_glob?: string; repo?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  if (process.env.OPERATOR_CODEBASE_READ_ENABLED !== 'true') {
    return { ok: false, error: 'operator_codebase_read_disabled: OPERATOR_CODEBASE_READ_ENABLED is not "true"' };
  }
  if (!args.query || !args.query.trim()) {
    return { ok: false, error: 'query is required' };
  }
  const resolved = resolveOperatorRepo(args.repo);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  try {
    // Only pass a 4th arg when there's a real token override — keeps the
    // default-repo call shape identical to before this VTID (VTID-03835's
    // own tests assert an exact 3-arg call for that path).
    const results = resolved.token
      ? await searchCode(resolved.repo, args.query, args.path_glob, resolved.token)
      : await searchCode(resolved.repo, args.query, args.path_glob);
    console.log(`[VTID-03835] dev_search_codebase thread=${threadId} repo=${resolved.repo} query="${args.query}" results=${results.length}`);
    return { ok: true, data: { repo: resolved.repo, query: args.query, results } };
  } catch (err: any) {
    return { ok: false, error: `Codebase search failed: ${err.message}` };
  }
}

/**
 * VTID-03835: dev_read_file — read-only GitHub file/directory read.
 */
async function executeDevReadFile(
  args: { path: string; ref?: string; repo?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  if (process.env.OPERATOR_CODEBASE_READ_ENABLED !== 'true') {
    return { ok: false, error: 'operator_codebase_read_disabled: OPERATOR_CODEBASE_READ_ENABLED is not "true"' };
  }
  if (!args.path || !args.path.trim()) {
    return { ok: false, error: 'path is required' };
  }
  const resolved = resolveOperatorRepo(args.repo);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  try {
    const result = resolved.token
      ? await getFileContents(resolved.repo, args.path, args.ref || 'main', resolved.token)
      : await getFileContents(resolved.repo, args.path, args.ref || 'main');
    console.log(`[VTID-03835] dev_read_file thread=${threadId} repo=${resolved.repo} path="${args.path}" ref="${args.ref || 'main'}" type=${result.type}`);
    return { ok: true, data: { repo: resolved.repo, ref: args.ref || 'main', ...result } };
  } catch (err: any) {
    return { ok: false, error: `File read failed: ${err.message}` };
  }
}

/**
 * VTID-03836: dev_aws_ecs_status — read-only ECS DescribeServices.
 * Kill-switched off by default and NOT pinned on any deploy workflow yet —
 * see aws-ecs-readonly.ts's header comment for why (no dedicated read-only
 * IAM role provisioned; the client currently runs under the same broad
 * gateway task role as the deploy-capable aws-ecs-admin.ts).
 */
async function executeDevAwsEcsStatus(
  args: { service_name: string },
  threadId: string
): Promise<ToolExecutionResult> {
  if (process.env.OPERATOR_AWS_READONLY_ENABLED !== 'true') {
    return { ok: false, error: 'operator_aws_readonly_disabled: OPERATOR_AWS_READONLY_ENABLED is not "true"' };
  }
  if (!args.service_name || !args.service_name.trim()) {
    return { ok: false, error: 'service_name is required' };
  }
  try {
    const results = await describeEcsServices([args.service_name]);
    console.log(`[VTID-03836] dev_aws_ecs_status thread=${threadId} service=${args.service_name}`);
    if (results.length === 0) {
      return { ok: false, error: `Service not found: ${args.service_name}` };
    }
    return { ok: true, data: results[0] as any };
  } catch (err: any) {
    return { ok: false, error: `ECS status check failed: ${err.message}` };
  }
}

/**
 * VTID-04020: dev_cloudwatch_logs — read-only CloudWatch FilterLogEvents
 * over one /ecs/vitana-<service> log group. Same kill switch as the ECS
 * status tool; the log-group shape is enforced before any AWS call
 * (aws-cloudwatch-logs-readonly.ts); an IAM denial comes back verbatim.
 */
async function executeDevCloudwatchLogs(
  args: { log_group: string; filter_pattern?: string; minutes?: number; limit?: number },
  threadId: string
): Promise<ToolExecutionResult> {
  if (process.env.OPERATOR_AWS_READONLY_ENABLED !== 'true') {
    return { ok: false, error: 'operator_aws_readonly_disabled: OPERATOR_AWS_READONLY_ENABLED is not "true"' };
  }
  if (!args.log_group || !String(args.log_group).trim()) {
    return { ok: false, error: 'log_group is required (e.g. /ecs/vitana-gateway)' };
  }
  try {
    const result = await filterVitanaLogs({
      logGroup: String(args.log_group),
      filterPattern: typeof args.filter_pattern === 'string' ? args.filter_pattern : undefined,
      minutes: typeof args.minutes === 'number' ? args.minutes : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    });
    console.log(`[VTID-04020] dev_cloudwatch_logs thread=${threadId} group=${result.log_group} window=${result.window_minutes}m events=${result.events.length}${result.truncated ? ' (truncated)' : ''}`);
    return { ok: true, data: result as any };
  } catch (err: any) {
    return { ok: false, error: `CloudWatch logs read failed: ${err.message}` };
  }
}

/**
 * VTID-04035: dev_ecs_tasks — read-only ECS ListTasks + DescribeTasks over
 * one documented service or the autopilot-executor task family. Same kill
 * switch as the ECS status tool; the target is checked against the §1b
 * allowlists before any AWS call (aws-ecs-readonly.ts); an IAM denial comes
 * back verbatim.
 */
async function executeDevEcsTasks(
  args: { target: string; desired_status?: string; limit?: number },
  threadId: string
): Promise<ToolExecutionResult> {
  if (process.env.OPERATOR_AWS_READONLY_ENABLED !== 'true') {
    return { ok: false, error: 'operator_aws_readonly_disabled: OPERATOR_AWS_READONLY_ENABLED is not "true"' };
  }
  if (!args.target || !String(args.target).trim()) {
    return { ok: false, error: `target is required (a §1b service name or the ${ALLOWED_ECS_TASK_FAMILIES.join('/')} task family)` };
  }
  try {
    const result = await listEcsTasks({
      target: String(args.target),
      desiredStatus: typeof args.desired_status === 'string' ? args.desired_status : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    });
    console.log(`[VTID-04035] dev_ecs_tasks thread=${threadId} target=${result.target} (${result.kind}) status=${result.desired_status} tasks=${result.tasks.length}${result.truncated ? ' (truncated)' : ''}`);
    return { ok: true, data: result as any };
  } catch (err: any) {
    return { ok: false, error: `ECS tasks read failed: ${err.message}` };
  }
}

/**
 * VTID-04116: dev_repowise — read-only RepoWise CLI bridge. Same kill-switch
 * shape as the AWS readonly tools (OPERATOR_CODEINTEL_ENABLED); a missing
 * binary/index reports not_configured rather than failing silently.
 */
async function executeDevRepowise(
  args: { command: string; argument?: string; repo?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  if (process.env.OPERATOR_CODEINTEL_ENABLED !== 'true') {
    return { ok: false, error: 'operator_codeintel_disabled: OPERATOR_CODEINTEL_ENABLED is not "true"' };
  }
  const command = String(args.command || '').trim();
  if (!isRepowiseCommand(command)) {
    return { ok: false, error: 'command must be one of: ask, search, context, risk, health, why, status' };
  }
  const repoDir = resolveCodeintelRepoDir(args.repo);
  if (!repoDir) {
    return { ok: false, error: `repo must be one of: ${Object.keys(ALLOWED_CODEINTEL_REPOS).join(', ')}` };
  }
  try {
    const result = await runRepowise(command, args.argument, repoDir);
    console.log(`[VTID-04116] dev_repowise thread=${threadId} command=${command} repo=${args.repo || 'exafyltd/vitana-platform'} ok=${result.ok}${result.truncated ? ' (truncated)' : ''}`);
    if (!result.ok && (result.error || '').startsWith('not_configured')) {
      const fb = await codeIndexFallbackFor('repowise', command, args.argument, args.repo, threadId);
      if (fb) return fb;
    }
    if (!result.ok) return { ok: false, error: result.error || 'repowise call failed' };
    return { ok: true, data: result as any };
  } catch (err: any) {
    return { ok: false, error: `repowise call failed: ${err.message}` };
  }
}

/**
 * VTID-04116: dev_graphify — read-only Graphify CLI bridge. Same posture.
 */
async function executeDevGraphify(
  args: { command: string; argument?: string; repo?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  if (process.env.OPERATOR_CODEINTEL_ENABLED !== 'true') {
    return { ok: false, error: 'operator_codeintel_disabled: OPERATOR_CODEINTEL_ENABLED is not "true"' };
  }
  const command = String(args.command || '').trim();
  if (!isGraphifyCommand(command)) {
    return { ok: false, error: 'command must be one of: query, path, explain' };
  }
  const repoDir = resolveCodeintelRepoDir(args.repo);
  if (!repoDir) {
    return { ok: false, error: `repo must be one of: ${Object.keys(ALLOWED_CODEINTEL_REPOS).join(', ')}` };
  }
  try {
    const result = await runGraphify(command, args.argument, repoDir);
    console.log(`[VTID-04116] dev_graphify thread=${threadId} command=${command} repo=${args.repo || 'exafyltd/vitana-platform'} ok=${result.ok}${result.truncated ? ' (truncated)' : ''}`);
    if (!result.ok && (result.error || '').startsWith('not_configured')) {
      const fb = await codeIndexFallbackFor('graphify', command, args.argument, args.repo, threadId);
      if (fb) return fb;
    }
    if (!result.ok) return { ok: false, error: result.error || 'graphify call failed' };
    return { ok: true, data: result as any };
  } catch (err: any) {
    return { ok: false, error: `graphify call failed: ${err.message}` };
  }
}

/**
 * VTID-04229: dev_index_query / dev_graph_path / dev_get_risk — pure queries
 * over the S3-published codebase index. Same kill switch as the CLI bridge
 * (OPERATOR_CODEINTEL_ENABLED); a missing bundle is reported as the loader's
 * own reason (bucket, key, credential) — never a silent empty answer.
 */
async function executeDevCodeIndexTool(
  name: CodeIndexToolName,
  args: Record<string, unknown>,
  threadId: string
): Promise<ToolExecutionResult> {
  if (process.env.OPERATOR_CODEINTEL_ENABLED !== 'true') {
    return { ok: false, error: 'operator_codeintel_disabled: OPERATOR_CODEINTEL_ENABLED is not "true"' };
  }
  const repo = resolveCodeIndexRepo(args.repo);
  if (!repo) return { ok: false, error: `repo must be one of: ${Object.keys(ALLOWED_CODEINTEL_REPOS).join(', ')}` };
  try {
    const loaded = await loadCodeIndex(repo);
    const out = runCodeIndexTool(name, args, loaded.bundle);
    console.log(`[VTID-04229] ${name} thread=${threadId} repo=${repo} sha=${loaded.bundle.sha.slice(0, 8)} cache=${loaded.fromCache} ok=${out.ok}`);
    if (!out.ok) return { ok: false, error: out.text };
    return { ok: true, data: { text: out.text, index: describeBundle(loaded.bundle), ...(out.data || {}) } };
  } catch (err: any) {
    return { ok: false, error: `code index unavailable: ${err?.message || String(err)}` };
  }
}

/**
 * VTID-04229: when the CLI bridge reports not_configured (the binary is not
 * in this image — true of every deployment so far, VTID-04222 §3), answer
 * the same question from the S3 index instead of returning the stub error.
 */
async function codeIndexFallbackFor(
  tool: 'repowise' | 'graphify',
  command: string,
  argument: string | undefined,
  repo: string | undefined,
  threadId: string
): Promise<ToolExecutionResult | null> {
  const arg = (argument || '').trim();
  let name: CodeIndexToolName;
  let args: Record<string, unknown>;
  if (tool === 'graphify' && command === 'path') {
    const parts = arg.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return null;
    name = 'dev_graph_path'; args = { source: parts[0], target: parts.slice(1).join(' '), repo };
  } else if (tool === 'repowise' && (command === 'risk' || command === 'context')) {
    if (!arg) return null;
    name = 'dev_get_risk'; args = { path: arg, repo };
  } else if (tool === 'repowise' && (command === 'health' || command === 'status')) {
    name = 'dev_index_query'; args = { query: 'services gateway index status', repo, budget_chars: 1200 };
  } else {
    if (!arg) return null;
    name = 'dev_index_query'; args = { query: arg, repo };
  }
  const res = await executeDevCodeIndexTool(name, args, threadId);
  if (!res.ok) return res;
  return { ok: true, data: { ...(res.data || {}), served_by: `${name} (S3 code index; the ${tool} CLI is not installed in this runtime)` } };
}

// VTID-03837: explicit table allowlist for dev_db_query — never arbitrary SQL.
const DEV_DB_QUERY_ALLOWED_TABLES = [
  'vtid_ledger',
  'oasis_events',
  'dev_autopilot_executions',
  'dev_autopilot_plan_versions',
] as const;

/**
 * VTID-04023: dev_run_sql_readonly — one bounded read-only statement over the
 * dedicated OPERATOR_SQL_READONLY_DATABASE_URL connection. Every safety layer
 * lives in operator-sql-readonly.ts; this is the tool boundary: kill switch,
 * argument shape, and an honest error (not an empty result) on refusal.
 */
async function executeDevRunSqlReadonly(
  args: { sql?: string; max_rows?: number; timeout_ms?: number },
  threadId: string
): Promise<ToolExecutionResult> {
  if (!isSqlReadonlyEnabled()) {
    return { ok: false, error: 'operator_sql_readonly_disabled: OPERATOR_SQL_READONLY_ENABLED is not "true"' };
  }
  if (typeof args.sql !== 'string' || !args.sql.trim()) {
    return { ok: false, error: 'sql is required' };
  }
  try {
    const result = await runReadonlySql({ sql: args.sql, max_rows: args.max_rows, timeout_ms: args.timeout_ms }, { threadId });
    return { ok: true, data: result as any };
  } catch (err: any) {
    return { ok: false, error: `Read-only SQL failed: ${err?.message || String(err)}` };
  }
}

/**
 * VTID-03837: dev_db_query — read-only Supabase PostgREST read, restricted
 * to an explicit table allowlist. Reuses the same SUPABASE_SERVICE_ROLE
 * read pattern already used by executeDevDeploymentStatus/executeAnalyzeVTID
 * elsewhere in this file — not a new or widened credential.
 */
async function executeDevDbQuery(
  args: { table: string; vtid?: string; limit?: number },
  threadId: string
): Promise<ToolExecutionResult> {
  if (process.env.OPERATOR_DB_READONLY_ENABLED !== 'true') {
    return { ok: false, error: 'operator_db_readonly_disabled: OPERATOR_DB_READONLY_ENABLED is not "true"' };
  }
  if (!(DEV_DB_QUERY_ALLOWED_TABLES as readonly string[]).includes(args.table)) {
    return { ok: false, error: `Table not allowed: ${args.table}. Allowed: ${DEV_DB_QUERY_ALLOWED_TABLES.join(', ')}` };
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;
  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Supabase not configured' };
  }
  const limit = Math.min(Math.max(args.limit || 20, 1), 100);
  // Only vtid_ledger/oasis_events key on a plain `vtid` column — the two
  // dev_autopilot_* tables key on finding_id (a UUID FK) / self_healing_vtid
  // instead, so a vtid filter there would just 400 against PostgREST.
  const VTID_FILTERABLE_TABLES = new Set(['vtid_ledger', 'oasis_events']);
  try {
    let url = `${supabaseUrl}/rest/v1/${args.table}?order=created_at.desc&limit=${limit}`;
    if (args.vtid && VTID_FILTERABLE_TABLES.has(args.table)) {
      url += `&vtid=eq.${encodeURIComponent(args.vtid)}`;
    } else if (args.vtid) {
      return { ok: false, error: `Table ${args.table} does not support filtering by vtid (no vtid column) — omit the vtid argument.` };
    }
    const resp = await fetch(url, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      return { ok: false, error: `Query failed: ${resp.status} - ${errorText}` };
    }
    const rows = await resp.json();
    console.log(`[VTID-03837] dev_db_query thread=${threadId} table=${args.table} rows=${Array.isArray(rows) ? rows.length : 0}`);
    return { ok: true, data: { table: args.table, rows } as any };
  } catch (err: any) {
    return { ok: false, error: `DB query failed: ${err.message}` };
  }
}

/**
 * Build deploy verification checklist from OASIS events
 */
function buildDeployChecklist(
  events: Array<{ topic: string; status: string; message: string; metadata?: Record<string, unknown> }>,
  service?: string
): Array<{ check: string; passed: boolean; evidence?: string }> {
  const topics = new Set(events.map(e => e.topic));
  const statuses = new Map(events.map(e => [e.topic, e.status]));

  const checklist: Array<{ check: string; passed: boolean; evidence?: string }> = [];

  // PR Created
  const prCreated = topics.has('cicd.github.create_pr.succeeded');
  checklist.push({
    check: 'PR created',
    passed: prCreated,
    evidence: prCreated ? 'cicd.github.create_pr.succeeded' : undefined,
  });

  // Governance passed
  const govPassed = !topics.has('governance.deploy.blocked');
  checklist.push({
    check: 'Governance checks passed',
    passed: govPassed,
    evidence: topics.has('governance.deploy.allowed') ? 'governance.deploy.allowed' : undefined,
  });

  // PR merged
  const prMerged = topics.has('cicd.github.safe_merge.executed') || topics.has('cicd.merge.success');
  checklist.push({
    check: 'PR merged',
    passed: prMerged,
    evidence: prMerged ? 'cicd.github.safe_merge.executed' : undefined,
  });

  // Deploy requested
  const deployRequested = topics.has('cicd.deploy.service.requested');
  checklist.push({
    check: 'Deploy triggered',
    passed: deployRequested,
    evidence: deployRequested ? 'cicd.deploy.service.requested' : undefined,
  });

  // Deploy succeeded
  const deploySucceeded = topics.has('deploy.gateway.success') || topics.has('cicd.deploy.service.succeeded');
  checklist.push({
    check: 'Deploy completed successfully',
    passed: deploySucceeded,
    evidence: deploySucceeded ? 'deploy.gateway.success' : undefined,
  });

  // No errors
  const hasErrors = events.some(e => e.status === 'error');
  checklist.push({
    check: 'No error events',
    passed: !hasErrors,
    evidence: hasErrors ? 'Error events found' : undefined,
  });

  // VTID lifecycle completed
  const lifecycleCompleted = topics.has('vtid.lifecycle.completed');
  checklist.push({
    check: 'VTID lifecycle completed',
    passed: lifecycleCompleted,
    evidence: lifecycleCompleted ? 'vtid.lifecycle.completed' : undefined,
  });

  return checklist;
}

// ==================== VTID-01270A: Community & Events Tool Handlers ====================

/**
 * VTID-01270A: Search upcoming events and meetups
 */
async function executeCommunitySearchEvents(
  args: { query?: string; type_filter?: string; location?: string; organizer?: string; date_from?: string; date_to?: string; max_price?: number },
  threadId: string
): Promise<ToolExecutionResult> {
  const identity = threadIdentityMap.get(threadId);

  const EVENTS_SUPABASE_URL = process.env.SUPABASE_URL || '';
  const EVENTS_SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE || '';

  const query = args.query || '';
  const typeFilter = args.type_filter || 'all';
  const locationFilter = args.location || '';
  const organizerFilter = args.organizer || '';
  const dateFrom = args.date_from || '';
  const dateTo = args.date_to || '';
  const maxPrice = args.max_price !== undefined ? Number(args.max_price) : undefined;
  const now = new Date().toISOString();
  const liveRoomResults: string[] = [];

  // Scoring engine result (populated by events fetch)
  let scoredResult: ScoredEventResults | null = null;

  // Primary: Fetch events from platform Supabase (global_community_events)
  // VTID-01270A Scoring: Fetch broadly (no query ilike filter) so scoring engine
  // can rank ALL events — no event is pre-excluded at the DB level.
  if (EVENTS_SUPABASE_KEY && (typeFilter === 'meetup' || typeFilter === 'all')) {
    const eventsHeaders = {
      'Content-Type': 'application/json',
      apikey: EVENTS_SUPABASE_KEY,
      Authorization: `Bearer ${EVENTS_SUPABASE_KEY}`,
    };

    const startTimeGte = dateFrom ? `${dateFrom}T00:00:00Z` : now;
    let eventsUrl = `${EVENTS_SUPABASE_URL}/rest/v1/global_community_events?select=id,title,description,start_time,end_time,location,virtual_link,slug,metadata&start_time=gte.${startTimeGte}&order=start_time.asc&limit=50`;

    if (dateTo) {
      eventsUrl += `&start_time=lte.${dateTo}T23:59:59Z`;
    }

    // NOTE: No query ilike filter — scoring engine handles relevance ranking.
    // Date range is the only hard constraint (true temporal boundary).

    try {
      const filterSummary = [query && `query="${query}"`, locationFilter && `loc="${locationFilter}"`, organizerFilter && `org="${organizerFilter}"`, dateFrom && `from=${dateFrom}`, dateTo && `to=${dateTo}`, maxPrice !== undefined && `maxPrice=${maxPrice}`].filter(Boolean).join(', ') || 'no filters';
      console.log(`[VTID-01270A] search_events (text): ${filterSummary}`);
      const resp = await fetch(eventsUrl, { method: 'GET', headers: eventsHeaders });
      if (resp.ok) {
        const events = await resp.json() as EventRecord[];
        console.log(`[VTID-01270A] search_events (text): ${events.length} raw results`);

        // Fetch user's home_city for proximity boost
        let userHomeCity: string | undefined;
        if (identity && SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
          try {
            const locResp = await fetch(
              `${SUPABASE_URL}/rest/v1/location_preferences?user_id=eq.${identity.user_id}&select=home_city&limit=1`,
              { method: 'GET', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}` } }
            );
            if (locResp.ok) {
              const locRows = await locResp.json() as Array<{ home_city: string | null }>;
              if (locRows.length > 0 && locRows[0].home_city) {
                userHomeCity = locRows[0].home_city;
              }
            }
          } catch { /* location_preferences lookup failed — proceed without proximity */ }
        }

        const filters: EventSearchFilters = {
          query,
          location: locationFilter,
          organizer: organizerFilter,
          maxPrice,
          userHomeCity,
        };

        scoredResult = scoreAndRankEvents(events, filters, 10);
        console.log(`[VTID-01270A] search_events (text) scored: ${scoredResult.best.length} best, ${scoredResult.alternatives.length} alternatives, homeCity=${userHomeCity || 'none'}`);
      } else {
        const body = await resp.text();
        console.warn(`[VTID-01270A] events query failed: ${resp.status} — ${body.substring(0, 200)}`);
      }
    } catch (e: any) {
      console.warn(`[VTID-01270A] events query error: ${e.message}`);
    }
  }

  // Secondary: Fetch live rooms from Platform Supabase
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE && (typeFilter === 'live_room' || typeFilter === 'all')) {
    const platformHeaders = {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    };
    const tenantFilter = identity ? `&tenant_id=eq.${identity.tenant_id}` : '';
    let roomsUrl = `${SUPABASE_URL}/rest/v1/live_rooms?select=id,title,starts_at,status${tenantFilter}&status=in.(scheduled,live)&order=starts_at.asc&limit=6`;
    if (query) {
      roomsUrl += `&title=ilike.*${encodeURIComponent(query)}*`;
    }
    try {
      const resp = await fetch(roomsUrl, { method: 'GET', headers: platformHeaders });
      if (resp.ok) {
        const rooms = await resp.json() as Array<{
          id: string; title: string; starts_at: string; status: string;
        }>;
        for (const r of rooms) {
          const date = r.starts_at
            ? new Date(r.starts_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
            : 'TBD';
          const statusLabel = r.status === 'live' ? 'LIVE NOW' : date;
          liveRoomResults.push(`[Live Room] ${r.title} | ${statusLabel}`);
        }
      }
    } catch (e: any) {
      console.warn(`[VTID-01270A] live_rooms query failed: ${e.message}`);
    }
  }

  // Build final output: scored events + live rooms
  const hasEvents = scoredResult && (scoredResult.best.length > 0 || scoredResult.alternatives.length > 0);
  const hasRooms = liveRoomResults.length > 0;

  if (!hasEvents && !hasRooms) {
    const filterDesc = [query, locationFilter, organizerFilter, dateFrom, dateTo, maxPrice !== undefined ? `max €${maxPrice}` : ''].filter(Boolean).join(', ') || 'none';
    console.log(`[VTID-01270A] search_events (text): 0 hits (filters: ${filterDesc})`);
    return { ok: true, data: { result: 'No upcoming events found at this time. Check back soon — new events are added regularly!' } };
  }

  let formatted = '';
  if (hasEvents) {
    formatted = formatForText(scoredResult!);
  }
  if (hasRooms) {
    if (formatted) formatted += '\n\n';
    formatted += liveRoomResults.join('\n');
  }

  console.log(`[VTID-01270A] search_events (text): ${(scoredResult?.best.length || 0) + (scoredResult?.alternatives.length || 0)} scored + ${liveRoomResults.length} rooms`);
  return { ok: true, data: { result: formatted } };
}

/**
 * VTID-01270A: Search community groups
 */
async function executeCommunitySearchGroups(
  args: { query: string },
  threadId: string
): Promise<ToolExecutionResult> {
  const identity = threadIdentityMap.get(threadId);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: true, data: { result: 'Community search is temporarily unavailable.' } };
  }

  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
  };

  const query = args.query || '';
  const tenantFilter = identity ? `&tenant_id=eq.${identity.tenant_id}` : '';
  let groupsUrl = `${SUPABASE_URL}/rest/v1/community_groups?select=id,name,topic_key,description,is_public${tenantFilter}&is_public=eq.true&order=created_at.desc&limit=10`;
  if (query) {
    groupsUrl += `&or=(name.ilike.*${encodeURIComponent(query)}*,description.ilike.*${encodeURIComponent(query)}*,topic_key.ilike.*${encodeURIComponent(query)}*)`;
  }

  try {
    const resp = await fetch(groupsUrl, { method: 'GET', headers });
    if (!resp.ok) {
      console.warn(`[VTID-01270A] community_groups query failed: ${resp.status}`);
      return { ok: true, data: { result: 'Could not search community groups at this time.' } };
    }

    const groups = await resp.json() as Array<{
      id: string; name: string; topic_key: string; description: string; is_public: boolean;
    }>;

    if (groups.length === 0) {
      console.log(`[VTID-01270A] search_community (text): 0 hits for "${query}"`);
      return { ok: true, data: { result: 'No community groups found matching your query.' } };
    }

    const formatted = groups
      .map(g => `**${g.name}** — ${(g.description || '').substring(0, 200)} | Topic: ${g.topic_key}`)
      .join('\n');

    console.log(`[VTID-01270A] search_community (text): ${groups.length} hits for "${query}"`);
    return { ok: true, data: { result: `Found ${groups.length} community groups:\n${formatted}` } };
  } catch (e: any) {
    console.warn(`[VTID-01270A] search_community error: ${e.message}`);
    return { ok: true, data: { result: 'Community search encountered an error. Please try again.' } };
  }
}

/**
 * VTID-01270A: Get personalized recommendations
 */
async function executeCommunityGetRecommendations(
  args: { type?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  const identity = threadIdentityMap.get(threadId);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: true, data: { result: 'Recommendations are temporarily unavailable.' } };
  }

  if (!identity) {
    return { ok: true, data: { result: 'Personalized recommendations require an authenticated session. Please try using voice or signing in.' } };
  }

  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
  };

  const recType = args.type || 'all';
  const today = new Date().toISOString().split('T')[0];
  const results: string[] = [];

  // Community recommendations
  if (recType === 'community' || recType === 'all') {
    const recsUrl = `${SUPABASE_URL}/rest/v1/community_recommendations?select=id,rec_type,target_id,score,reasons&tenant_id=eq.${identity.tenant_id}&user_id=eq.${identity.user_id}&rec_date=eq.${today}&order=score.desc&limit=5`;
    try {
      const resp = await fetch(recsUrl, { method: 'GET', headers });
      if (resp.ok) {
        const recs = await resp.json() as Array<{
          id: string; rec_type: string; target_id: string;
          score: number; reasons: Record<string, unknown>;
        }>;
        for (const r of recs) {
          const reasonText = r.reasons && typeof r.reasons === 'object'
            ? Object.values(r.reasons).filter(v => typeof v === 'string').join(', ')
            : '';
          results.push(`[${r.rec_type}] Score: ${r.score}/100${reasonText ? ` — ${reasonText}` : ''}`);
        }
      }
    } catch (e: any) {
      console.warn(`[VTID-01270A] community_recommendations query failed: ${e.message}`);
    }
  }

  // Daily matches
  if (recType === 'match' || recType === 'all') {
    const matchesUrl = `${SUPABASE_URL}/rest/v1/matches_daily?select=id,score,state,reasons&tenant_id=eq.${identity.tenant_id}&user_id=eq.${identity.user_id}&match_date=eq.${today}&state=eq.suggested&order=score.desc&limit=5`;
    try {
      const resp = await fetch(matchesUrl, { method: 'GET', headers });
      if (resp.ok) {
        const matches = await resp.json() as Array<{
          id: string; score: number; state: string; reasons: Record<string, unknown>;
        }>;
        for (const m of matches) {
          const reasonText = m.reasons && typeof m.reasons === 'object'
            ? Object.values(m.reasons).filter(v => typeof v === 'string').join(', ')
            : '';
          results.push(`[Daily Match] Score: ${m.score}/100${reasonText ? ` — ${reasonText}` : ''}`);
        }
      }
    } catch (e: any) {
      console.warn(`[VTID-01270A] matches_daily query failed: ${e.message}`);
    }
  }

  if (results.length === 0) {
    console.log(`[VTID-01270A] get_recommendations (text): 0 results (type=${recType})`);
    // VTID-03110: never say "no personalized recommendations". Deflect
    // into a teaching offer using the next pedagogically-ordered
    // capability from the Teacher catalog. Same helper as the voice
    // path in orb-live.ts so behavior is consistent across modalities.
    let deflection = '';
    try {
      const { getSupabase } = await import('../lib/supabase');
      const sb = getSupabase();
      if (sb) {
        const { buildTeacherDeflectionForEmptyRecommendations } = await import(
          './assistant-continuation/providers/teacher/teacher-deflection'
        );
        // Text path doesn't carry a session lang; default to 'en'. A
        // future slice can lookup app_users.preferred_language if
        // needed — voice path (orb-live.ts) uses session.lang.
        deflection = await buildTeacherDeflectionForEmptyRecommendations({
          supabase: sb,
          tenantId: identity.tenant_id,
          userId: identity.user_id,
          lang: 'en',
          recType,
        });
      }
    } catch (err) {
      console.warn(`[VTID-03110] deflection helper failed (non-fatal): ${(err as Error).message}`);
    }
    if (!deflection) {
      deflection = 'Nothing specific is queued up at the moment, but Vitanaland has lots to learn. What would you like to dive into?';
    }
    return { ok: true, data: { result: deflection } };
  }

  const formatted = results.join('\n');
  console.log(`[VTID-01270A] get_recommendations (text): ${results.length} results (type=${recType})`);
  return { ok: true, data: { result: `Here are your personalized recommendations:\n${formatted}` } };
}

// ==================== BOOTSTRAP-VOICE-DEMO: Architecture Investigator ====================

/**
 * Execute the investigate_failure voice tool. Calls the Architecture
 * Investigator agent (DeepSeek-reasoner), which pulls recent OASIS events
 * into context, generates a structured root-cause hypothesis, persists it
 * to architecture_reports, and emits architecture.investigation.completed.
 *
 * Returns a compact natural-language summary so ORB can read it back to
 * the user. The full structured report is in the data payload.
 */
async function executeInvestigateFailure(
  args: { incident_topic: string; vtid?: string; notes?: string; event_limit?: number },
  threadId: string
): Promise<ToolExecutionResult> {
  console.log(`[BOOTSTRAP-ARCH-INV] investigate_failure: topic=${args.incident_topic} vtid=${args.vtid || '-'} thread=${threadId}`);

  try {
    // Lazy-load to avoid pulling DeepSeek deps unless the tool is invoked.
    const { investigateIncident } = await import('./architecture-investigator');

    const report = await investigateIncident({
      incident_topic: args.incident_topic,
      vtid: args.vtid,
      notes: args.notes,
      event_limit: args.event_limit,
      trigger_reason: 'manual',
    });

    const altCount = report.alternative_hypotheses?.length || 0;
    const summary = `Root cause (confidence ${(report.confidence * 100).toFixed(0)}%): ${report.root_cause} Suggested fix: ${report.suggested_fix} ${altCount > 0 ? `I considered ${altCount} alternative hypotheses; full report saved.` : 'Full report saved.'}`;

    return {
      ok: true,
      data: {
        result: summary,
        report_id: report.id,
        confidence: report.confidence,
        root_cause: report.root_cause,
        suggested_fix: report.suggested_fix,
        alternative_hypotheses: report.alternative_hypotheses,
        evidence_summary: report.evidence_summary,
        provider: report.llm_provider,
        model: report.llm_model,
        latency_ms: report.latency_ms,
      },
    };
  } catch (err: any) {
    const msg = err?.message || 'Unknown error';
    console.error(`[BOOTSTRAP-ARCH-INV] investigate_failure failed: ${msg}`);
    return {
      ok: false,
      error: `Investigation failed: ${msg}`,
    };
  }
}

// ==================== Main Tool Router ====================

/**
 * Execute a tool call from Gemini
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  threadId: string
): Promise<ToolExecutionResult> {
  console.log(`[VTID-0536] Executing tool: ${toolName}`);

  // VTID-DEV-ASSIST: Defense-in-depth role enforcement for dev_ tools.
  // Even if a tool call reaches the executor through an unexpected path,
  // dev_ prefixed tools are HARD BLOCKED for non-developer roles.
  if (toolName.startsWith('dev_') && toolName !== 'dev_verify_deploy_checklist') {
    const threadIdentity = threadIdentityMap.get(threadId);
    const threadRole = threadIdentity?.role;
    if (threadRole && !['developer', 'admin'].includes(threadRole)) {
      console.warn(`[VTID-DEV-ASSIST] TOOL BLOCKED: ${toolName} denied for role=${threadRole} thread=${threadId}`);
      return {
        ok: false,
        error: `Access denied: tool ${toolName} requires developer role (current: ${threadRole})`,
      };
    }
  }

  // Log assistant turn start
  const startTime = Date.now();

  let result: ToolExecutionResult;

  try {
    switch (toolName) {
      case 'autopilot_create_task':
        result = await executeCreateTask(
          args as { description: string; priority?: string; tags?: string[] },
          threadId
        );
        break;

      case 'autopilot_execute_task':
        result = await executeExecuteTask(
          args as { vtid: string; plan_markdown: string; files_referenced: string[] },
          threadId
        );
        break;

      case 'autopilot_run_task':
        result = await executeRunTask(
          args as { request: string; title?: string },
          threadId
        );
        break;

      case 'autopilot_review_execution':
        result = await executeReviewExecution(
          args as { execution_id?: string },
          threadId
        );
        break;

      case 'autopilot_approve_execution':
        result = await executeApproveExecution(
          args as { execution_id: string },
          threadId
        );
        break;

      case 'autopilot_reject_execution':
        result = await executeRejectExecution(
          args as { execution_id: string; reason?: string },
          threadId
        );
        break;

      case 'autopilot_activate_recommendation':
        result = await executeActivateRecommendation(
          args as { recommendation_id: string },
          threadId
        );
        break;

      case 'autopilot_cancel_execution':
        result = await executeCancelExecution(
          args as { execution_id?: string; reason?: string },
          threadId
        );
        break;

      case 'autopilot_get_status':
        result = await executeGetStatus(
          args as { vtid: string },
          threadId
        );
        break;

      case 'autopilot_list_recent_tasks':
        result = await executeListRecentTasks(
          args as { limit?: number; status?: string },
          threadId
        );
        break;

      // VTID-0538: Knowledge Hub search tool
      case 'knowledge_search':
        result = await executeKnowledgeSearch(
          args as { query: string },
          threadId
        );
        break;

      // VTID-01159: OASIS-only task discovery (TASK_STATE_QUERY)
      case 'discover_oasis_tasks':
        result = await executeDiscoverOasisTasks(
          args as { statuses?: string[]; limit?: number },
          threadId
        );
        break;

      // VTID-01192: Code execution for calculations
      case 'run_code':
        result = await executeRunCode(
          args as { code: string; description?: string },
          threadId
        );
        break;

      // VTID-01221: Autopilot Recommendation Sync - Primary tool
      case 'autopilot_get_recommendations':
        result = await executeGetRecommendations(
          args as {
            role?: string;
            ui_context?: { surface?: string; screen?: string; selection?: string };
            vtid?: string;
            time_window_minutes?: number;
          },
          threadId
        );
        break;

      // VTID-01221: Fallback tool - VTID analysis
      case 'oasis_analyze_vtid':
        result = await executeAnalyzeVTID(
          args as { vtid: string; include_events?: boolean; limit?: number },
          threadId
        );
        break;

      // VTID-01221: Fallback tool - Deploy verification
      case 'dev_verify_deploy_checklist':
        result = await executeVerifyDeployChecklist(
          args as { vtid: string; service?: string },
          threadId
        );
        break;

      // VTID-03835: Operator Console codebase read access
      case 'dev_search_codebase':
        result = await executeDevSearchCodebase(
          args as { query: string; path_glob?: string; repo?: string },
          threadId
        );
        break;

      case 'dev_read_file':
        result = await executeDevReadFile(
          args as { path: string; ref?: string; repo?: string },
          threadId
        );
        break;

      // VTID-03836: Operator Console AWS ECS read-only status
      case 'dev_aws_ecs_status':
        result = await executeDevAwsEcsStatus(
          args as { service_name: string },
          threadId
        );
        break;

      // VTID-04020: Operator Console read-only CloudWatch Logs
      case 'dev_cloudwatch_logs':
        result = await executeDevCloudwatchLogs(
          args as { log_group: string; filter_pattern?: string; minutes?: number; limit?: number },
          threadId
        );
        break;

      // VTID-04035: Operator Console read-only ECS task-level view
      case 'dev_ecs_tasks':
        result = await executeDevEcsTasks(
          args as { target: string; desired_status?: string; limit?: number },
          threadId
        );
        break;

      // VTID-04116: Operator Console codebase intelligence
      case 'dev_repowise':
        result = await executeDevRepowise(
          args as { command: string; argument?: string; repo?: string },
          threadId
        );
        break;

      case 'dev_graphify':
        result = await executeDevGraphify(
          args as { command: string; argument?: string; repo?: string },
          threadId
        );
        break;

      // VTID-04229: Operator Console codebase index (S3 bundle)
      case 'dev_index_query':
      case 'dev_graph_path':
      case 'dev_get_risk':
        result = await executeDevCodeIndexTool(toolName as CodeIndexToolName, args as Record<string, unknown>, threadId);
        break;

      // VTID-04023: Operator Console read-only SQL
      case 'dev_run_sql_readonly':
        result = await executeDevRunSqlReadonly(
          args as { sql?: string; max_rows?: number; timeout_ms?: number },
          threadId
        );
        break;

      // VTID-03837: Operator Console read-only DB access
      case 'dev_db_query':
        result = await executeDevDbQuery(
          args as { table: string; vtid?: string; limit?: number },
          threadId
        );
        break;

      // VTID-01270A: Community & Events tools
      case 'search_events':
        result = await executeCommunitySearchEvents(
          args as { query?: string; type_filter?: string; location?: string; organizer?: string; date_from?: string; date_to?: string; max_price?: number },
          threadId
        );
        break;

      case 'search_community':
        result = await executeCommunitySearchGroups(
          args as { query: string },
          threadId
        );
        break;

      case 'get_recommendations':
        result = await executeCommunityGetRecommendations(
          args as { type?: string },
          threadId
        );
        break;

      // VTID-01270: Matchmaking tool — fetch user's daily matches
      case 'get_user_matches': {
        const matchIdentity = threadIdentityMap.get(threadId);
        if (matchIdentity?.user_id && matchIdentity?.tenant_id) {
          const matchResult = await executeGetUserMatchesTool(
            matchIdentity.user_id,
            matchIdentity.tenant_id,
            args as { date?: string; match_type?: string; topic_filter?: string; min_score?: number; limit?: number }
          );
          // Build presentation hint so Gemini knows exactly how to format the response
          const matchHints = matchResult.matches.map((m: any) =>
            `${m.display_name} (${m.match_type}, score ${m.score}) → deep_link: ${m.deep_link}`
          ).join('\n');
          const presentationHint = matchResult.matches.length > 0
            ? `IMPORTANT: Present each match with its deep_link URL on its own line. Example:\n🎉 ${matchResult.matches[0].display_name}\n${matchResult.matches[0].deep_link}\nAll matches:\n${matchHints}\nDiscover all: ${matchResult.discover_all_link}`
            : 'No matches found. Suggest the user check ' + matchResult.discover_all_link;

          result = {
            ok: matchResult.ok,
            data: {
              matches: matchResult.matches,
              total_available: matchResult.total_available,
              date: matchResult.date,
              discover_all_link: matchResult.discover_all_link,
              _presentation_hint: presentationHint,
            },
          };
        } else {
          result = {
            ok: false,
            error: 'User context not available for matchmaking tool',
          };
        }
        break;
      }

      // VTID-CHAT-SEND: Direct-message tools (text-chat parity with ORB voice).
      // Both delegate to the shared, battle-tested handlers in
      // orb-tools-shared.ts so text and voice send messages identically
      // (recipient resolution, receiver verification, rate-limit, push notify).
      case 'resolve_recipient': {
        const sendIdentity = threadIdentityMap.get(threadId);
        if (!sendIdentity?.user_id) {
          result = { ok: false, error: 'User context not available for messaging' };
          break;
        }
        const { tool_resolve_recipient } = await import('./orb-tools-shared');
        const sb = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE!);
        const r = await tool_resolve_recipient(
          args as Record<string, unknown>,
          {
            user_id: sendIdentity.user_id,
            tenant_id: sendIdentity.tenant_id ?? null,
            role: sendIdentity.role ?? 'community',
            vitana_id: sendIdentity.vitana_id ?? null,
          },
          sb,
        );
        result = r.ok
          ? { ok: true, data: { ...((r as { result?: Record<string, unknown> }).result ?? {}), message: (r as { text?: string }).text } }
          : { ok: false, error: (r as { error: string }).error };
        break;
      }

      case 'send_chat_message': {
        const sendIdentity = threadIdentityMap.get(threadId);
        if (!sendIdentity?.user_id) {
          result = { ok: false, error: 'User context not available for messaging' };
          break;
        }
        const { tool_send_chat_message } = await import('./orb-tools-shared');
        const sb = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE!);
        const r = await tool_send_chat_message(
          args as Record<string, unknown>,
          {
            user_id: sendIdentity.user_id,
            tenant_id: sendIdentity.tenant_id ?? null,
            role: sendIdentity.role ?? 'community',
            vitana_id: sendIdentity.vitana_id ?? null,
            // Use the thread id as the rate-limit session key for text chat.
            session_id: threadId,
          },
          sb,
        );
        result = r.ok
          ? { ok: true, data: { ...((r as { result?: Record<string, unknown> }).result ?? {}), message: (r as { text?: string }).text } }
          : { ok: false, error: (r as { error: string }).error };
        break;
      }

      // ===== VTID-DEV-ASSIST: Developer Assistant Tool Cases =====
      case 'dev_list_tasks':
        result = await executeDevListTasks(args as { limit?: number; status?: string; layer?: string }, threadId);
        break;

      case 'dev_get_task_detail':
        result = await executeDevGetTaskDetail(args as { vtid: string }, threadId);
        break;

      case 'dev_generate_spec':
        result = await executeDevGenerateSpec(args as { vtid: string; seed_notes?: string }, threadId);
        break;

      case 'dev_get_spec':
        result = await executeDevGetSpec(args as { vtid: string }, threadId);
        break;

      case 'dev_validate_spec':
        result = await executeDevValidateSpec(args as { vtid: string }, threadId);
        break;

      case 'dev_quality_check':
        result = await executeDevQualityCheck(args as { vtid: string }, threadId);
        break;

      case 'dev_approve_spec':
        result = await executeDevApproveSpec(args as { vtid: string }, threadId);
        break;

      case 'dev_list_approvals':
        result = await executeDevListApprovals(args as { limit?: number }, threadId);
        break;

      case 'dev_approval_count':
        result = await executeDevApprovalCount(threadId);
        break;

      case 'dev_approve_item':
        result = await executeDevApproveItem(args as { approval_id: string }, threadId);
        break;

      case 'dev_reject_item':
        result = await executeDevRejectItem(args as { approval_id: string; reason?: string }, threadId);
        break;

      case 'dev_query_oasis_events':
        result = await executeDevQueryOasisEvents(args as { vtid?: string; topic?: string; status?: string; limit?: number }, threadId);
        break;

      case 'dev_create_pr':
        result = await executeDevCreatePr(args as { vtid: string; head_branch: string; base_branch?: string; title?: string; body?: string }, threadId);
        break;

      case 'dev_merge_pr':
        result = await executeDevMergePr(args as { vtid: string; pr_number: number; merge_method?: string }, threadId);
        break;

      case 'dev_deploy_service':
        result = await executeDevDeployService(args as { service: string; vtid?: string; environment?: string }, threadId);
        break;

      case 'dev_deployment_status':
        result = await executeDevDeploymentStatus(args as { service?: string; limit?: number }, threadId);
        break;

      case 'dev_cicd_health':
        result = await executeDevCicdHealth(threadId);
        break;

      case 'dev_lock_status':
        result = await executeDevLockStatus(threadId);
        break;

      // VTID-02000: Marketplace tools
      case 'search_marketplace_products':
        result = await executeSearchMarketplaceProducts(
          args as {
            q?: string;
            user_condition?: string;
            health_goals?: string[];
            ingredients_any?: string[];
            dietary_tags?: string[];
            form?: string;
            category?: string;
            price_max_cents?: number;
            limit?: number;
            scope?: string;
          },
          threadId
        );
        break;

      case 'open_discover_feed':
        result = await executeOpenDiscoverFeed(
          args as { category?: string; limit?: number },
          threadId
        );
        break;

      // VTID-02100: Wearable metrics
      case 'get_wearable_metrics':
        result = await executeGetWearableMetrics(args as { days?: number }, threadId);
        break;

      // VTID-01990: Time-anchored conversation recall.
      // Resolves a user's free-text time reference ("yesterday morning",
      // "earlier today", "letzten Montag") to a window and returns matching
      // session summaries + actual conversation_messages turns + facts.
      case 'recall_conversation_at_time': {
        const recallIdentity = threadIdentityMap.get(threadId);
        if (!recallIdentity?.user_id) {
          result = { ok: false, error: 'Tool requires authenticated user context' };
          break;
        }
        const { executeRecallConversationAtTime } = await import('./tool-recall-conversation');
        const recallResult = await executeRecallConversationAtTime(
          args as { time_hint: string; topic_hint?: string },
          {
            user_id: recallIdentity.user_id,
            user_timezone: recallIdentity.user_timezone,
          },
        );
        result = {
          ok: recallResult.ok,
          error: recallResult.error,
          data: recallResult as unknown as Record<string, unknown>,
        };
        break;
      }

      // BOOTSTRAP-VOICE-DEMO: Architecture Investigator voice tool
      case 'investigate_failure':
        result = await executeInvestigateFailure(
          args as {
            incident_topic: string;
            vtid?: string;
            notes?: string;
            event_limit?: number;
          },
          threadId
        );
        break;

      default:
        result = {
          ok: false,
          error: `Unknown tool: ${toolName}`
        };
    }
  } catch (error: any) {
    console.error(`[VTID-0536] Tool execution error:`, error);
    result = {
      ok: false,
      error: `Tool execution failed: ${error.message}`
    };
  }

  // Log assistant turn
  await logAssistantTurn({
    vtid: 'VTID-0536',
    threadId,
    toolName,
    toolArgs: args,
    result
  });

  const duration = Date.now() - startTime;
  console.log(`[VTID-0536] Tool ${toolName} completed in ${duration}ms: ${result.ok ? 'success' : 'error'}`);

  return result;
}

// ==================== Gemini Integration ====================

/**
 * VTID-03892: Render dev_agent_memory recall hits as a system-prompt block.
 * Fail-open elsewhere (a failed/empty recall means no block, never an error
 * surfaced to the user) — this only formats hits that already came back.
 */
function buildDevMemoryContextBlock(hits: DevMemoryHit[]): string {
  // VTID-04027: category-diverse top-10 selection over the wider candidate
  // set, rendered with a per-row clip and a total budget.
  return renderDevMemoryBlock(diversifyRecallHits(hits));
}

/**
 * VTID-03930: a compact, always-on codebase orientation block — the
 * "understand the codebase immediately, without reading hundreds of files"
 * ask. RepoWise/Graphify themselves are local CLI tools with session-scoped
 * indexes (graphify-out/graph.json, .repowise/) — they are not services the
 * deployed ECS gateway container can invoke at request time, so this is NOT
 * a live query against them. It is a small, hand-curated summary SOURCED
 * from a real run of both (graphify god-nodes, repowise health) plus this
 * repo's own CLAUDE.md §2 services table, refreshed by editing this
 * constant (re-run the commands in its own comment, not automatically).
 * Deliberately short — anything deeper goes through the tools that already
 * exist and are now reachable (VTID-03926): dev_search_codebase,
 * dev_read_file, dev_db_query, knowledge_search.
 *
 * Refresh commands (run from repo root): `graphify god-nodes --top 15`,
 * `repowise health`, `repowise status`. Last generated 2026-09-15.
 */
const CODEBASE_OVERVIEW_BLOCK = `**Codebase orientation (vitana-platform, refreshed 2026-09-16):**
- Deployable services: Gateway (services/gateway/ — this process), OASIS Operator, OASIS Projector, Verification Engine, Worker Runner. Full table + AWS ECS names: CLAUDE.md §1b/§2.
- TWO repos, not one. This is exafyltd/vitana-platform (backend/gateway + the internal Command Hub admin console at services/gateway/src/frontend/command-hub/app.js). The consumer-facing Vitana app — most frontend/UI screens, components, hooks — lives in a SEPARATE repo, exafyltd/vitana-v1, which dev_search_codebase/dev_read_file can also reach via their "repo" parameter. Never conclude frontend code "doesn't exist" or ask the user where the UI lives before trying repo:"exafyltd/vitana-v1".
- Architectural hubs (most-connected symbols, i.e. touching these has the widest blast radius): RunContext, function_tool(), summarize(), emitOasisEvent(), getSupabase(), _dispatch(), renderApp() (Command Hub frontend, services/gateway/src/frontend/command-hub/app.js), gatewayApiCall(), buildContextHeaders(), requireAuth(), developerGate().
- Known health hotspot: services/gateway/src/routes/orb-live.ts (lowest maintainability score in the repo — large, stateful, high change-risk file).
- dev_search_codebase blind spot: GitHub's code search index excludes files over 384KB. app.js above is ~2.5MB, so a search will ALWAYS return zero hits for anything inside it regardless of query — this is a tool limitation, not evidence the content is missing. Use dev_read_file with an explicit path for that file instead.
- Codebase index (VTID-04229): dev_index_query (symbols/files matching a question + what they import/call and what calls them), dev_graph_path (shortest dependency path A→B) and dev_get_risk (churn, bug fixes, ownership, import fan-in, dead code for one file) answer from the Graphify+RepoWise bundle rebuilt on every merge to main — use dev_index_query BEFORE dev_search_codebase to find the right files, and dev_get_risk before proposing an edit to a shared file. Both repos, via the "repo" parameter.
- For anything beyond this summary — a specific file, function, recent change, or "where is X implemented" — call dev_search_codebase / dev_read_file (real GitHub API, VTID-03835/VTID-03946) or dev_db_query (VTID-03837) rather than guessing from this block alone.`;

/**
 * VTID-01023: System prompt for Operator Chat Gemini/Vertex integration
 * VTID-01025: Open chat mode - general knowledge + task operations
 */
function getOperatorSystemPrompt(): string {
  const opConfig = getPersonalityConfigSync('operator_chat') as Record<string, any>;
  let prompt = opConfig.system_prompt || `You are a helpful AI assistant with access to the Vitana Autopilot system. You can answer any question and also help manage Vitana tasks.

**Available tools (use when appropriate):**
- autopilot_create_task: Create a new Autopilot task
- autopilot_get_status: Check the status of an existing task by VTID
- autopilot_list_recent_tasks: List recent tasks
- knowledge_search: Search Vitana documentation (use for Vitana-specific questions like "What is OASIS?", "Explain the Vitana Index", etc.)
- run_code: Execute JavaScript code for calculations, date math, conversions, data processing
- autopilot_execute_task: Execute an ALREADY-APPROVED VTID via the DeepSeek execution on-ramp (writes code and opens a real pull request). Takes vtid, plan_markdown and files_referenced (the files the plan will create or change).
- autopilot_run_task: Turn a free-text development request into a governed agent-mode execution — allocates and registers the VTID itself, then the agent executor reads the code, makes the change, runs tsc + jest and opens a real pull request. Takes request (the user's words) and an optional title. No VTID and no file list are needed.
- autopilot_review_execution: Show a Dev Autopilot execution that is held for approval (the agent pushed its branch but did not open the PR yet): branch, PR title/body, changed files, --stat and a bounded diff. With no execution_id it lists everything waiting for a decision. Read-only.
- autopilot_approve_execution: Approve a held execution — opens the real pull request on the pushed branch and hands it to CI. Takes execution_id.
- autopilot_reject_execution: Reject a held execution — deletes the pushed branch and cancels it with the recorded reason. Takes execution_id and an optional reason.
- autopilot_activate_recommendation: Activate a specific Dev Autopilot recommendation by id — allocates its VTID (idempotent) and, for a manually-bridgeable source_type, starts a real execution with the cooldown skipped. Takes recommendation_id.
- autopilot_cancel_execution: Cancel a queued (cooling) or RUNNING execution — the agent is stopped, nothing is pushed or opened. With no execution_id it only lists what can be cancelled. Takes an optional execution_id and an optional reason.

**When to use tools:**
- Task creation requests (e.g., "Create a task to deploy gateway") → MUST call autopilot_create_task tool
- Status checks (e.g., "Status of VTID-0540") → use autopilot_get_status
- Task listing (e.g., "Show recent tasks") → use autopilot_list_recent_tasks
- Execution requests naming a specific VTID (e.g., "Execute VTID-03829", "implement VTID-04102", "ship VTID-04102 via the on-ramp") → call autopilot_execute_task
- Open-ended development requests that name NO VTID (e.g., "fix the CI failure reason so it names the checks", "add a retry to the push dispatcher") → call autopilot_run_task with the request as the user stated it
- Questions about what is waiting for approval, or a request to see/review a held execution or its diff (e.g., "what is waiting for my approval?", "show me the diff of 4f7d5ea4") → call autopilot_review_execution
- An explicit decision on a held execution the user names (e.g., "approve 4f7d5ea4", "reject 4f7d5ea4, wrong approach") → call autopilot_approve_execution or autopilot_reject_execution
- An explicit request to activate a specific Dev Autopilot recommendation by id (e.g., "activate recommendation a1b2c3d4-...") → call autopilot_activate_recommendation
- A request to stop/cancel/abort a queued or running execution (e.g., "cancel 9a4d2c7e", "stop that run, wrong file", "what is running that I can cancel?") → call autopilot_cancel_execution (with no id to list, with the id they name to cancel)
- Vitana-specific questions → use knowledge_search
- Calculations, date math, age calculations, unit conversions → use run_code

**CRITICAL EXECUTION RULES (autopilot_execute_task):**
- Only call it when the user explicitly asks to execute/implement/ship a SPECIFIC VTID they name. Never invent a VTID, never execute a VTID the user did not name, and never use it to create new work (that is autopilot_create_task).
- A task's ledger status (in_progress, scheduled, etc.) is NOT a signal that an execution is already running — a person or a coding session sets in_progress when they start working a task. Do NOT refuse to execute because autopilot_get_status reports in_progress. The tool itself is the only authority on whether an execution can start: call it and report its result.
- Build plan_markdown from what the user said plus the task's title/spec; list in files_referenced the files the plan will create or change — nothing else. A test-only plan lists only the test file; a source change lists the source file AND its test file, because the safety gate rejects a plan without test coverage. Never add a file the plan does not touch (the safety gate also rejects any file outside its allow scope). Every files_referenced entry MUST be the full repo-root-relative path exactly as it appears in the repository (e.g. services/gateway/src/services/foo.ts and services/gateway/test/foo.test.ts) — never a bare filename like foo.ts and never a path relative to a subdirectory; the safety gate glob-matches each entry against its allow scope and a bare filename never matches, so the whole execution is rejected.
- autopilot_run_task is for a code change the user asks to be made NOW without naming a VTID: pass their request verbatim in request (plus only the context they gave — never invent requirements) and list no files; the agent discovers them and the safety gate checks its real diff afterwards. It allocates the VTID itself, so do not call autopilot_create_task first for the same request and never pair it with autopilot_execute_task. A question about code is not a request to change it; a request to log/track a task for later is autopilot_create_task, not autopilot_run_task.
- autopilot_cancel_execution stops an execution that is still cooling or running (not a held one — that is reject). Call it with no id whenever the user asks what is running or which execution they mean; call it WITH an id ONLY when the user explicitly asks to cancel/stop a specific execution they name (id or 8+ character prefix). Never cancel on your own judgement, never guess which execution they mean (list them and ask), and if the tool reports the execution is not cooling/running, or the id is ambiguous, report exactly that. A cancel is final for that execution — nothing is pushed or opened for it.
- autopilot_review_execution / autopilot_approve_execution / autopilot_reject_execution act on executions the agent has already run and HELD (status awaiting_approval) — they never start work. Review is read-only and safe to call whenever the user asks what is waiting or wants to see a change. Approve opens a real pull request and reject deletes the pushed branch: call either ONLY when the user explicitly asks for that decision on a specific execution they name (id or 8+ character prefix), after they have seen the change or said they do not need to. Never approve or reject on your own judgement of the diff, never guess which execution they mean (list them and ask), and if the tool reports the execution is not awaiting_approval, or the id is ambiguous, report exactly that.
- autopilot_activate_recommendation is different from all of the above: it acts on a RECOMMENDATION (not an execution), takes the full recommendation UUID (no prefix resolution), and allocates a VTID plus — for an eligible source_type — starts a real execution with the cooldown skipped. Call it ONLY when the user explicitly names the recommendation they want activated (by id, or after you have shown them exactly one recommendation and they confirm it); never guess which recommendation they mean and never activate more than one without being asked for each.
- If the tool returns a rejection (governance, safety gate, kill switch, on-ramp disabled), report the exact reason honestly. Never claim an execution was queued unless the tool returned status "queued".
- If you believe the tool is unavailable or disabled, call it anyway and report what it returns — do not tell the user it is unavailable based on an assumption.

**CRITICAL TASK CREATION RULES:**
- When the user asks to create a task, check if they provided a meaningful description of what the task should accomplish.
  - If YES (e.g., "Create a task to deploy the gateway to production"): call autopilot_create_task immediately.
  - If NO (e.g., "create a task", "make a new ticket", "log this"): ask the user for a title and description BEFORE calling the tool. Example: "Sure! What should this task be about? Please give me a title and a brief description."
- NEVER generate fake VTID numbers. VTIDs are only created by the autopilot_create_task tool.
- NEVER claim a task was created unless the tool returned a successful result.
- If a tool call fails, tell the user honestly.`;

  if (opConfig.calculation_directive) {
    prompt += `\n\n${opConfig.calculation_directive}`;
  }

  prompt += `\n\nBe helpful, accurate, and concise. If a task is blocked by governance, explain the reason clearly.`;
  return prompt;
}


/**
 * VTID-01023: Convert tool definitions to Vertex AI format
 * Uses explicit typing to match Vertex AI SDK requirements
 */
/**
 * VTID-03579: the same role-filtered tool set, in the router's provider-neutral
 * shape. Deliberately built from the SAME `GEMINI_TOOL_DEFINITIONS` source and
 * the SAME `dev_`-prefix whitelist as `getVertexToolDefinitions` above — the
 * role filter is a security boundary (dev tools are excluded whenever the role
 * is not explicitly developer/admin, including when it is unknown), and a
 * second hand-maintained copy of that list is exactly how such a boundary drifts
 * open without anyone noticing.
 */
function getRouterToolDefinitions(userRole?: string): LLMRouterTool[] {
  let toolDefs = GEMINI_TOOL_DEFINITIONS.functionDeclarations;
  const isDeveloper = userRole && ['developer', 'admin'].includes(userRole);
  if (!isDeveloper) {
    toolDefs = toolDefs.filter(fd => !fd.name.startsWith('dev_') || fd.name === 'dev_verify_deploy_checklist');
  }
  return toolDefs.map(fd => ({
    name: fd.name,
    description: fd.description,
    inputSchema: fd.parameters as unknown as Record<string, unknown>,
  }));
}

/**
 * VTID-01023: Call Vertex AI with tools using ADC
 * VTID-01106: Added optional custom system instruction for ORB memory context
 * Returns the model response with optional tool calls
 */
async function callVertexWithTools(
  text: string,
  threadId: string,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  customSystemInstruction?: string,
  vtid?: string | null,
  userRole?: string,
  // VTID-03892: dev_agent_memory recall, rendered by the caller (processWithGemini)
  // and appended here regardless of which base prompt applies above.
  memoryContextBlock?: string
): Promise<{
  reply: string;
  toolCalls?: GeminiToolCall[];
  telemetryContext?: LLMCallContext;
  // VTID-04031: the router's token usage for this call (undefined when the provider reported none).
  usage?: LLMUsage;
  // VTID-03579 (review follow-up): who ACTUALLY served this turn. Without it
  // the caller kept reporting provider:'vertex' for every Bedrock/DeepSeek
  // call, which is the same "the table says one thing, the wire did another"
  // blindness this whole VTID exists to remove — and it is exposed to clients
  // and stored in memory-indexer metadata, so it would have poisoned exactly
  // the diagnostics used to verify the migration.
  provider?: string;
  model?: string;
}> {
  // VTID-01106: Use custom system instruction if provided (for ORB memory context)
  // VTID-01192: ALWAYS include tool instructions - merge with custom instruction
  const toolInstructions = `
**Available tools (ALWAYS use for calculations):**
- run_code: Execute JavaScript code for calculations, date math, conversions

**CRITICAL: When you have data in your context and need to calculate:**
- Age difference, days between dates, percentages → CALL run_code
- Extract the dates/numbers from context, then call run_code with JS code
- NEVER say "I don't have access" when data IS in your context`;

  const basePrompt = customSystemInstruction
    ? `${customSystemInstruction}\n\n${toolInstructions}`
    : `${getOperatorSystemPrompt()}\n\nCurrent thread: ${threadId}`;
  // VTID-03892: memory is appended after either base — a custom instruction
  // (e.g. ORB memory context) and the default operator prompt both get it.
  const withMemory = memoryContextBlock ? `${basePrompt}\n\n${memoryContextBlock}` : basePrompt;
  // VTID-03930: the codebase orientation block is unconditional — every
  // Operator turn, authenticated or not, gets it, the same way
  // dev_agent_memory recall runs unconditionally above. It is background
  // context, not a tool result, so it does not depend on userRole.
  // VTID-04018: the session bootstrap pack (rules, service map, schema index,
  // recent change log, live build-info, open PRs, recent events, and the tool
  // catalog rendered from the declarations below). '' unless
  // OPERATOR_BOOTSTRAP_PACK_ENABLED=true; fail-open by construction.
  const routerTools = getRouterToolDefinitions(userRole);
  const bootstrapPack = await getOperatorBootstrapPack({ toolDefs: routerTools });
  const systemPrompt = `${withMemory}\n\n${CODEBASE_OVERVIEW_BLOCK}${bootstrapPack ? `\n\n${bootstrapPack}` : ''}`;

  // VTID-03579: was a direct Vertex `generateContent` with ADC. The operator is
  // the last big Google caller and the hardest, because it is an agentic loop
  // rather than a one-shot completion: multi-turn history in, possibly several
  // tool calls out. That is why `callViaRouter` grew `history` and `toolCalls`
  // in this same change — routing the operator by flattening its history into
  // one prompt string would have quietly destroyed conversational context and
  // looked like the assistant developing amnesia.
  //
  // Telemetry is the router's now: it emits llm.call.started/completed/failed
  // itself, so the manual startLLMCall/completeLLMCall/failLLMCall trio that
  // used to wrap this would double-count every operator turn.
  const r = await callViaRouter('operator', text, {
    vtid: vtid || null,
    service: 'gemini-operator',
    systemPrompt,
    // VTID-04102: was 4096 — half the deepseekAdapter's own default (8000).
    // This call carries the full bootstrap pack + codebase-overview block +
    // memory context + tool catalog as system prompt and is expected to plan
    // multi-step tool use, so 4096 was tight enough to truncate mid-turn on a
    // real task (measured live: output_tokens===4096, tool_calls:0, empty
    // text). Matches the router-wide default instead of a narrower one.
    maxTokens: 8000,
    tools: routerTools,
    history: conversationHistory.map((m) => ({ role: m.role, content: m.content })),
  });

  if (!r.ok) {
    // Preserved as a throw: the caller has a real fallback path keyed off this
    // (formatToolResultsAsResponse / the no-AI-backend reply), and swallowing
    // the failure here would hand the user a confident empty answer instead.
    throw new Error(r.error || 'Operator LLM call failed');
  }

  const toolCalls: GeminiToolCall[] | undefined =
    r.toolCalls && r.toolCalls.length > 0
      ? r.toolCalls.map((tc) => ({ name: tc.name, args: tc.arguments || {} }))
      : undefined;

  if (toolCalls) {
    console.log(`[VTID-01023] operator returned ${toolCalls.length} tool call(s) via ${r.provider}`);
    return { reply: r.text || '', toolCalls, provider: r.provider, model: r.model, usage: r.usage };
  }

  const reply = r.text || '';
  if (!reply) {
    // VTID-04102: `r.ok` only means the provider answered, not that the
    // answer was usable — a response truncated at max_tokens before
    // finishing a tool call or any prose (measured live: output_tokens
    // pinned at the maxTokens cap, tool_calls:0, text empty) satisfies
    // `ok:true` with nothing a user can read. Silently returning '' here
    // rendered as "No response received" in the Command Hub with zero
    // diagnostic and no recovery. Throw instead, exactly like the `!r.ok`
    // branch above — the caller's own catch falls through to
    // processLocalRouting(), the real fallback the comment on that branch
    // already relies on, instead of treating an unusable success as done.
    throw new Error(
      `Operator LLM call returned no text and no tool calls via ${r.provider}/${r.model} ` +
        `(output_tokens=${r.usage?.outputTokens ?? 'unknown'}, likely truncated at max_tokens)`,
    );
  }
  console.log(`[VTID-01023] operator returned text response (${reply.length} chars) via ${r.provider}`);
  return { reply, provider: r.provider, model: r.model, usage: r.usage };
}

/**
 * VTID-01023: Send tool results back to Vertex AI for final response
 */
async function sendToolResultsToVertex(
  originalText: string,
  toolResults: GeminiToolResult[],
  threadId: string
  // VTID-04031: who served the final call and what it cost, for the turn's meta.
): Promise<{ reply: string; usage?: LLMUsage; provider?: string; model?: string }> {
  const baseToolResultPrompt = `You are Vitana, a friendly community assistant. Present the tool results to the user in a warm, helpful way.
If there were errors or governance blocks, explain them clearly.
If successful, present the results naturally.

CRITICAL — Sharing links:
- Event search results contain "Link: https://vitanaland.com/e/..." for each event. You MUST include this URL in your response.
- Put the URL on its own line. NEVER say "I'll send the link" — paste the actual URL.
- Example:
  🎉 City by Bike Tour in Lyon
  https://vitanaland.com/e/city-by-bike`;
  // VTID-04018 (§4.1 "same prompt for tool-result turns"): the tool-result
  // turn carries the same bootstrap pack as the main turn — '' when disabled.
  const toolResultPack = await getOperatorBootstrapPack({ toolDefs: getRouterToolDefinitions(undefined) });
  const systemPrompt = toolResultPack ? `${baseToolResultPrompt}\n\n${toolResultPack}` : baseToolResultPrompt;

  // VTID-03579: results are presented as a TEXT turn, not as tool_result blocks,
  // and that is a deliberate protocol choice rather than a shortcut.
  //
  // Anthropic requires every `tool_result` to carry the `tool_use_id` of a
  // `tool_use` block in the immediately preceding assistant message. This
  // function only receives `GeminiToolResult` (a name and a response) — the
  // originating ids are not in scope here, and inventing them produces a hard
  // 400 rather than a degraded answer. Rendering the outcomes as text is valid
  // on every provider, and the model sees exactly the same information: what
  // was asked, and what came back.
  const renderedResults = toolResults
    .map((tr) => `Tool: ${tr.name}\nResult: ${JSON.stringify(tr.response)}`)
    .join('\n\n');

  try {
    const r = await callViaRouter('operator', renderedResults, {
      service: 'gemini-operator-tool-results',
      systemPrompt,
      // VTID-04102: matches the plan call's budget (see callVertexWithTools) —
      // same truncation risk, same fix. This call site already degrades
      // gracefully to formatToolResultsAsResponse() on an empty/failed
      // result, so the raised cap here is prevention, not a new safety net.
      maxTokens: 8000,
      history: [{ role: 'user', content: originalText }],
    });

    if (!r.ok || !r.text) {
      console.warn(
        `[VTID-01023] tool-results call failed via ${r.provider ?? 'router'}: ${r.error ?? 'empty'}`,
      );
      return formatToolResultsAsResponse(toolResults);
    }

    // Unchanged safety net (VTID-01270): the link guarantee does not depend on
    // the model remembering to paste it, and that matters more now that the
    // model behind this is a different one than the prompt was tuned against.
    return { reply: ensureLinksInReply(r.text, toolResults), usage: r.usage, provider: r.provider, model: r.model };
  } catch (err: any) {
    console.warn(`[VTID-01023] tool results call failed: ${err.message}`);
    return formatToolResultsAsResponse(toolResults);
  }
}

/**
 * VTID-01270: Extract vitanaland.com links from tool results.
 * If the LLM's reply doesn't include them, append them as a safety net.
 */
function ensureLinksInReply(reply: string, toolResults: GeminiToolResult[]): string {
  const links: string[] = [];
  for (const tr of toolResults) {
    const data = tr.response;
    // Event search results contain "Link: https://vitanaland.com/e/..."
    if (typeof data?.result === 'string') {
      const linkMatches = data.result.match(/https:\/\/vitanaland\.com\/e\/[^\s]+/g);
      if (linkMatches) links.push(...linkMatches);
    }
    // Match tool results contain deep_link in each match object
    if (Array.isArray(data?.matches)) {
      for (const m of data.matches) {
        if (m.deep_link && typeof m.deep_link === 'string') {
          links.push(m.deep_link);
        }
      }
    }
  }

  if (links.length === 0) return reply;

  // Check if reply already contains at least one of the links
  const hasAnyLink = links.some(link => reply.includes(link));
  if (hasAnyLink) return reply;

  // Append missing links
  const uniqueLinks = [...new Set(links)];
  const linkBlock = uniqueLinks.slice(0, 5).join('\n');
  console.log(`[VTID-01270] LLM omitted links, appending ${uniqueLinks.length} links to reply`);
  return `${reply}\n\n${linkBlock}`;
}

/**
 * VTID-01023: Format tool results as a human-readable response
 * VTID-01025: Handle NOT_VITANA_QUERY marker for non-Vitana queries
 */
function formatToolResultsAsResponse(toolResults: GeminiToolResult[]): { reply: string } {
  const successResults = toolResults.filter(r => r.response.ok);
  const failedResults = toolResults.filter(r => !r.response.ok);

  let reply = '';

  for (const result of successResults) {
    // VTID-0538: Handle knowledge_search answer format
    if (result.name === 'knowledge_search' && result.response.answer) {
      const answer = result.response.answer as string;
      // VTID-01025: Don't show NOT_VITANA_QUERY marker in fallback mode
      if (answer.startsWith('[NOT_VITANA_QUERY]')) {
        reply += 'I can help with that! However, I\'m currently in limited mode. Please try again.\n\n';
      } else {
        reply += answer + '\n\n';
        if (result.response.docs && (result.response.docs as any[]).length > 0) {
          reply += '_Sources: ' + (result.response.docs as any[]).map((d: any) => d.title).join(', ') + '_\n\n';
        }
      }
    } else if (result.response.message) {
      reply += result.response.message + '\n\n';
    }
  }

  for (const result of failedResults) {
    if (result.response.governanceBlocked) {
      reply += `**Governance Blocked:** ${result.response.error}\n\n`;
    } else {
      reply += `**Error:** ${result.response.error}\n\n`;
    }
  }

  return { reply: reply.trim() || 'Operation completed.' };
}

/**
 * Process a message with Gemini, including function calling
 * VTID-01023: Updated routing logic
 * - Priority 1: Vertex AI (uses ADC, no API key needed on Cloud Run)
 * - Priority 2: Gemini API if API key is configured
 * - Priority 3: Local routing fallback
 * - Always includes provider/model metadata for transparency
 *
 * VTID-01106: Added optional systemInstruction override for ORB memory context
 */
export async function processWithGemini(input: {
  text: string;
  threadId: string;
  attachments?: Array<{ oasis_ref: string; kind: string }>;
  context?: Record<string, unknown>;
  // VTID-01027: Conversation history for session memory
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  conversationId?: string;
  // VTID-01106: Optional system instruction override (for ORB memory context)
  systemInstruction?: string;
  // VTID-DEV-ASSIST: User role for tool filtering — only send tools the user is authorized to use
  userRole?: string;
  // VTID-04022: rolling server-side thread summary (operator-threads.ts). When
  // present, dev_agent_memory recall runs against summary + current message
  // instead of the raw message alone (gap analysis §4.3).
  threadSummary?: string | null;
  // VTID-04028: live turn events (model turns, tool calls/results) for the
  // streaming route. Optional; a missing sink means no emission at all.
  onEvent?: OperatorTurnEventSink;
}): Promise<GeminiOperatorResponse> {
  const { text, threadId, attachments = [], context = {}, conversationHistory = [], conversationId, systemInstruction, userRole, threadSummary, onEvent } = input;

  // BOOTSTRAP-MEMORY-ORCHESTRATOR-MANDATORY: soft bypass detection at the
  // shared executor. Emits memory.orchestrator.bypass_detected (never throws
  // here — internal utility callers legitimately carry no user memory) so
  // any assistant path that skipped the orchestrator shows up on the
  // Memory Alive/Dead admin card.
  try {
    const { detectMemoryBypass } = require('./memory-orchestrator');
    detectMemoryBypass(systemInstruction, { threadId, caller: 'processWithGemini' });
  } catch { /* detection must never break the LLM call */ }

  // BOOTSTRAP-VOICE-DEMO: emit a real heartbeat so the agents dashboard
  // reflects live usage. Fire-and-forget; never block the LLM call.
  recordAgentHeartbeat('gemini-operator').catch(() => {});

  console.log(`[VTID-01023] Processing message: "${text.substring(0, 50)}..."`);
  if (conversationHistory.length > 0) {
    console.log(`[VTID-01027] Including ${conversationHistory.length} context messages from conversation ${conversationId}`);
  }

  // VTID-03579: no longer gated on a Vertex client existing. That gate meant
  // "is Google configured?", so removing Vertex without removing the gate would
  // have skipped the operator entirely and dropped every request to the local
  // keyword-matching fallback — a silent, total capability loss that still
  // returns 200. Provider availability is the router's question now.
  {
    try {
      console.log('[VTID-03579] Operator call via llm-router');

      // VTID-03892: recall dev_agent_memory before the call. Fail-open by
      // design (per DevMemoryHit's own contract) — a recall failure or an
      // empty result never blocks or degrades the operator turn, it just
      // means no memory block gets appended.
      let memoryContextBlock: string | undefined;
      try {
        // VTID-04027: fetch a wider candidate set; buildDevMemoryContextBlock diversifies and bounds it.
        const memRes = await recallDevMemory(buildRecallQuery(threadSummary, text), 'vitana-platform', { limit: RECALL_CANDIDATES });
        if (memRes.ok && memRes.hits.length > 0) {
          memoryContextBlock = buildDevMemoryContextBlock(memRes.hits);
        } else if (!memRes.ok) {
          console.warn(`[VTID-03892] dev_agent_memory recall failed, continuing without it: ${memRes.error}`);
        }
      } catch (memErr: any) {
        console.warn(`[VTID-03892] dev_agent_memory recall threw, continuing without it: ${memErr?.message}`);
      }

      // VTID-01106: Pass custom system instruction if provided (for ORB memory context)
      // VTID-DEV-ASSIST: Pass userRole to filter tool definitions by authorization
      const planStartedAt = Date.now();
      const vertexResponse = await callVertexWithTools(text, threadId, conversationHistory, systemInstruction, undefined, userRole, memoryContextBlock);
      emitTurnEvent(onEvent, {
        type: 'model.turn',
        stage: 'plan',
        provider: vertexResponse.provider ?? 'router',
        model: vertexResponse.model ?? 'router',
        tool_calls: vertexResponse.toolCalls?.length ?? 0,
        duration_ms: Date.now() - planStartedAt,
        ...turnUsageFields(vertexResponse.model, vertexResponse.usage),
      });

      // Check if Vertex wants to call any tools
      if (vertexResponse.toolCalls && vertexResponse.toolCalls.length > 0) {
        const toolResults: GeminiToolResult[] = [];

        for (const [index, toolCall] of vertexResponse.toolCalls.entries()) {
          // VTID-04028: announce the call before it runs, report it after —
          // the transcript the Command Hub renders live.
          emitTurnEvent(onEvent, { type: 'tool.call', index, name: toolCall.name, args: boundTurnEventArgs(toolCall.args) });
          const toolStartedAt = Date.now();
          const result = await executeTool(toolCall.name, toolCall.args, threadId);
          emitTurnEvent(onEvent, {
            type: 'tool.result',
            index,
            name: toolCall.name,
            ok: result.ok,
            duration_ms: Date.now() - toolStartedAt,
            ...(result.error ? { error: clipForTurnEvent(result.error, TURN_EVENT_EXCERPT_MAX_CHARS) } : {}),
            ...(result.governanceBlocked ? { governance_blocked: true } : {}),
            excerpt: clipForTurnEvent(result.data ?? {}, TURN_EVENT_EXCERPT_MAX_CHARS),
          });
          toolResults.push({
            name: toolCall.name,
            response: {
              ok: result.ok,
              ...result.data,
              error: result.error,
              governanceBlocked: result.governanceBlocked
            }
          });
        }

        // Send tool results back to Vertex for final response
        const finalStartedAt = Date.now();
        const finalResponse = await sendToolResultsToVertex(text, toolResults, threadId);
        emitTurnEvent(onEvent, {
          type: 'model.turn',
          stage: 'final',
          provider: finalResponse.provider ?? vertexResponse.provider ?? 'router',
          model: finalResponse.model ?? vertexResponse.model ?? 'router',
          tool_calls: 0,
          duration_ms: Date.now() - finalStartedAt,
          ...turnUsageFields(finalResponse.model ?? vertexResponse.model, finalResponse.usage),
        });

        // VTID-04031: both model calls of the turn folded into one cost line.
        const turnCost = summarizeTurnCost([
          { model: vertexResponse.model, usage: vertexResponse.usage },
          { model: finalResponse.model ?? vertexResponse.model, usage: finalResponse.usage },
        ]);
        return {
          reply: finalResponse.reply,
          toolResults,
          meta: {
            provider: vertexResponse.provider ?? 'router',
            model: vertexResponse.model ?? 'router',
            mode: `operator_${vertexResponse.provider ?? 'router'}`,
            tool_calls: vertexResponse.toolCalls.length,
            vtid: 'VTID-01023',
            duration_ms: Date.now() - planStartedAt,
            ...turnCost,
          }
        };
      }

      // No tool calls, return Vertex's direct response
      return {
        reply: vertexResponse.reply,
        meta: {
          provider: vertexResponse.provider ?? 'router',
          model: vertexResponse.model ?? 'router',
          mode: `operator_${vertexResponse.provider ?? 'router'}`,
          tool_calls: 0,
          vtid: 'VTID-01023',
          duration_ms: Date.now() - planStartedAt,
          // VTID-04031
          ...summarizeTurnCost([{ model: vertexResponse.model, usage: vertexResponse.usage }]),
        }
      };
    } catch (error: any) {
      console.warn(`[VTID-01023] Vertex AI error, trying fallback: ${error.message}`);
      // Fall through to Gemini API or local routing
    }
  }

  // VTID-03579: the "fall back to the Gemini API key" branch that lived here is
  // DELETED, not disabled. Per CLAUDE.md ALWAYS 10c, a Claude stage's fallback
  // is another Bedrock model or an explicit failure — never Google. This branch
  // was the operator's own private fallback chain, invisible to
  // `llm_routing_policy`, so the routing table could read "off Google" while
  // every operator turn that hit a Vertex hiccup silently landed on Gemini.
  // The router's configured fallback (DeepSeek) now covers this, and it is
  // visible in the policy table and in llm.call.* telemetry.

  // VTID-01023: Final fallback to local routing
  console.log('[VTID-01023] Using local routing fallback');
  const fallbackResponse = await processLocalRouting(text, threadId);
  if (fallbackResponse.meta) {
    // VTID-03579: reaching here now means the router could not serve at all
    // (primary AND fallback failed), not "Google was unconfigured".
    fallbackResponse.meta.fallback_reason = 'llm_router_error';
  }
  return fallbackResponse;
}

/**
 * Call Gemini API with tool definitions
 * VTID-01027: Added conversation history support
 * VTID-01106: Added optional custom system instruction for ORB memory context
 */
// VTID-03579: `callGeminiWithTools` and `sendToolResultsToGemini` lived here —
// ~230 lines POSTing to generativelanguage.googleapis.com with a hardcoded
// gemini-2.5-pro. Both are removed rather than left unreferenced: dead code
// that still names a provider is the thing a future "quick fix" reaches for.
// The routed equivalents are `callVertexWithTools` and `sendToolResultsToVertex`
// above (names kept so this diff stays about behaviour, and now inaccurate).

/**
 * Local routing fallback when Gemini is not available
 * VTID-0541 D3: Enhanced to support natural conversation
 * VTID-01025: Fallback only handles task operations; general questions need AI backend
 * Uses keyword matching to determine tool calls
 * Always includes provider/model/mode metadata for transparency
 */
async function processLocalRouting(text: string, threadId: string): Promise<GeminiOperatorResponse> {
  const lowerText = text.toLowerCase().trim();
  const toolResults: GeminiToolResult[] = [];

  // VTID-0541: Base metadata for local routing - always transparent about provider
  const localRoutingMeta = {
    provider: 'local-router',
    model: 'keyword-matcher',
    mode: 'operator_local',
    vtid: 'VTID-01025'
  };

  // VTID-0541 D3: Handle conversational messages first (greetings, thanks, etc.)
  // These should NOT fall back to Knowledge search - they should get friendly responses
  const conversationalPatterns = [
    { pattern: /^(hi|hello|hey|good\s*(morning|afternoon|evening)|greetings)/i, response: "Hello! I'm the Vitana Operator Assistant. I can help you create tasks, check task status, or answer questions about Vitana. What would you like to do?" },
    { pattern: /^(thanks|thank\s*you|thx|ty)/i, response: "You're welcome! Let me know if you need anything else." },
    { pattern: /^(bye|goodbye|see\s*you|later)/i, response: "Goodbye! Feel free to return anytime you need assistance." },
    { pattern: /^(help|what\s+can\s+you\s+do|\?+)$/i, response: null }, // Will fall through to help message below
    { pattern: /^(ok|okay|sure|got\s*it|understood|alright)/i, response: "Great. I'd suggest we create a task or check the status of an existing VTID next — tell me which and I'll get it going." },
    { pattern: /^(yes|no|yeah|nope|yep|nah)/i, response: "Got it. Let's create a task or look up a VTID's status — just say the word and I'll handle it." },
  ];

  for (const { pattern, response } of conversationalPatterns) {
    if (pattern.test(lowerText)) {
      if (response) {
        return {
          reply: response,
          meta: { ...localRoutingMeta, conversational: true }
        };
      }
      // If response is null, fall through to the help message
      break;
    }
  }

  // Task creation requests are now handled by Gemini's tool-calling flow
  // (no hardcoded shortcut — let the AI ask for details when needed)

  // Detect status requests
  // VTID-01007: Updated to match 4-5 digit VTIDs
  if (
    lowerText.includes('status') ||
    lowerText.match(/what.*vtid/i) ||
    lowerText.match(/vtid-\d{4,5}/i)
  ) {
    // Extract VTID (supports 4-5 digit formats)
    const vtidMatch = text.match(/VTID-\d{4,5}/i);
    if (vtidMatch) {
      const result = await executeTool('autopilot_get_status', { vtid: vtidMatch[0].toUpperCase() }, threadId);
      toolResults.push({
        name: 'autopilot_get_status',
        response: {
          ok: result.ok,
          ...result.data,
          error: result.error
        }
      });
    } else {
      return {
        reply: 'I need a VTID to check the status. Please provide it in the format VTID-XXXX (e.g., "What is the status of VTID-0533?")',
        meta: localRoutingMeta
      };
    }
  }

  // VTID-01159: TASK_STATE_QUERY detection - OASIS-only task discovery
  // These patterns trigger discover_oasis_tasks for consistent behavior with ORB
  // MUST take precedence over generic list_recent_tasks
  else if (
    lowerText.match(/\b(scheduled|allocated|pending)\s+task/i) ||
    lowerText.match(/\btask.*\b(scheduled|allocated|pending)\b/i) ||
    lowerText.match(/\blist\s+(scheduled|allocated|pending)\b/i) ||
    lowerText.match(/\bshow\s+(scheduled|allocated|pending)\b/i) ||
    lowerText.match(/\bwhat.*\b(scheduled|in\s*progress|queue|pending)\b/i) ||
    lowerText.match(/\bin\s*progress\s+task/i) ||
    lowerText.match(/\btask.*in\s*progress\b/i) ||
    lowerText.match(/\bwhat's\s+(in\s+the\s+)?queue\b/i) ||
    lowerText.match(/\bshow\s+me\s+(the\s+)?queue\b/i) ||
    lowerText.match(/\bwork\s+(is\s+)?scheduled\b/i) ||
    lowerText.match(/\bscheduled\s+work\b/i)
  ) {
    // VTID-01159: Use OASIS-only discover_oasis_tasks tool
    console.log('[VTID-01159] TASK_STATE_QUERY detected - using discover_oasis_tasks');
    const result = await executeTool('discover_oasis_tasks', {}, threadId);
    toolResults.push({
      name: 'discover_oasis_tasks',
      response: {
        ok: result.ok,
        ...result.data,
        error: result.error
      }
    });
  }

  // Detect list requests (generic - for recent tasks without status filter)
  else if (
    lowerText.includes('list') && lowerText.includes('task') ||
    lowerText.includes('recent task') ||
    lowerText.includes('show task') ||
    lowerText.match(/show.*recent/i)
  ) {
    // Extract limit if specified
    const limitMatch = lowerText.match(/(\d+)\s*tasks?/);
    const limit = limitMatch ? parseInt(limitMatch[1]) : 10;

    const result = await executeTool('autopilot_list_recent_tasks', { limit }, threadId);
    toolResults.push({
      name: 'autopilot_list_recent_tasks',
      response: {
        ok: result.ok,
        ...result.data,
        error: result.error
      }
    });
  }

  // VTID-0538: Detect knowledge questions (What/How/Explain/Why about Vitana)
  else if (
    lowerText.match(/^what\s+(is|are|does)/i) ||
    lowerText.match(/^how\s+(does|do|can|to)/i) ||
    lowerText.match(/^explain\s+/i) ||
    lowerText.match(/^why\s+(is|are|does|do)/i) ||
    lowerText.includes('vitana index') ||
    lowerText.includes('oasis') ||
    lowerText.includes('command hub') ||
    lowerText.includes('autopilot') && !lowerText.includes('task') ||
    lowerText.includes('maxina') ||
    lowerText.includes('alkalma') ||
    lowerText.includes('earthlings') ||
    lowerText.includes('three tenants') ||
    lowerText.includes('architecture') ||
    lowerText.includes('governance')
  ) {
    // Use knowledge search for documentation questions
    const result = await executeTool('knowledge_search', { query: text }, threadId);
    toolResults.push({
      name: 'knowledge_search',
      response: {
        ok: result.ok,
        ...result.data,
        error: result.error
      }
    });
  }

  // No tool matched - return helpful message
  // VTID-01025: Fallback mode can only handle specific operations, not general questions
  if (toolResults.length === 0) {
    // Check if it looks like a general question
    const looksLikeQuestion = lowerText.includes('?') || lowerText.match(/^(can|could|would|will|do|does|is|are|how|what|when|where|why|who)/i);

    if (looksLikeQuestion) {
      // VTID-01025: In fallback mode, explain limitation for general questions
      return {
        reply: `I'm currently running in fallback mode (AI backend temporarily unavailable). In this mode, I can handle:

**Task Operations:**
- Create tasks: "Create a task to fix the health check"
- Check status: "What is the status of VTID-0540?"
- List tasks: "Show recent tasks"

**Vitana Knowledge:**
- "What is OASIS?"
- "Explain the Vitana Index"

For general questions, please try again in a moment when the AI service is available.`,
        meta: { ...localRoutingMeta, limited_mode: true }
      };
    }

    // Simple greeting fallback
    return {
      reply: `Hello! I'm the Vitana Operator Assistant. I can help you with:

- **Creating tasks**: "Create a task to..."
- **Checking status**: "Status of VTID-0540"
- **Listing tasks**: "Show recent tasks"
- **Vitana questions**: "What is OASIS?"

What would you like to do?`,
      meta: localRoutingMeta
    };
  }

  // Format tool results
  const successResults = toolResults.filter(r => r.response.ok);
  const failedResults = toolResults.filter(r => !r.response.ok);

  let reply = '';

  for (const result of successResults) {
    // VTID-0538: Handle knowledge_search answer format
    if (result.name === 'knowledge_search' && result.response.answer) {
      const answer = result.response.answer as string;
      // VTID-01025: Don't show NOT_VITANA_QUERY marker
      if (answer.startsWith('[NOT_VITANA_QUERY]')) {
        reply += 'I can help with that! However, I\'m currently in limited mode. Please try again.\n\n';
      } else {
        reply += answer + '\n\n';
        // Add sources if docs were found
        if (result.response.docs && (result.response.docs as any[]).length > 0) {
          reply += '_Sources: ' + (result.response.docs as any[]).map((d: any) => d.title).join(', ') + '_\n\n';
        }
      }
    } else if (result.response.message) {
      reply += result.response.message + '\n\n';
    }
  }

  for (const result of failedResults) {
    if (result.response.governanceBlocked) {
      reply += `**Governance Blocked:** ${result.response.error}\n\n`;
    } else {
      reply += `**Error:** ${result.response.error}\n\n`;
    }
  }

  return {
    reply: reply.trim() || 'Operation completed.',
    toolResults,
    meta: {
      ...localRoutingMeta,
      tool_calls: toolResults.length
    }
  };
}

// ==================== VTID-DEV-ASSIST: Developer Assistant Executor Functions ====================

/**
 * List tasks from vtid_ledger with OASIS-derived terminal state
 */
async function executeDevListTasks(
  args: { limit?: number; status?: string; layer?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const limit = args.limit || 50;
    let url = `${SUPABASE_URL}/rest/v1/vtid_ledger?order=updated_at.desc&limit=${limit}&status=neq.deleted`;
    if (args.status) url += `&status=eq.${args.status}`;
    if (args.layer) url += `&layer=eq.${args.layer}`;

    const resp = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}` },
    });

    if (!resp.ok) return { ok: false, error: `Query failed: ${resp.status}` };
    const rows = await resp.json() as any[];

    // Fetch OASIS events for terminal state derivation
    const eventsResp = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_events?order=created_at.desc&limit=500`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}` } }
    );
    const allEvents = eventsResp.ok ? (await eventsResp.json() as any[]) : [];

    const tasks = rows.map((row: any) => {
      const vtidEvents = allEvents.filter((e: any) => e.vtid === row.vtid);
      let column = 'SCHEDULED';
      let isTerminal = false;
      let terminalOutcome: string | null = null;
      const ledgerStatus = (row.status || '').toLowerCase();

      const hasCompleted = vtidEvents.some((e: any) => (e.topic || '').toLowerCase() === 'vtid.lifecycle.completed');
      const hasFailed = vtidEvents.some((e: any) => (e.topic || '').toLowerCase() === 'vtid.lifecycle.failed');

      if (hasCompleted) { isTerminal = true; terminalOutcome = 'success'; column = 'COMPLETED'; }
      else if (hasFailed) { isTerminal = true; terminalOutcome = 'failed'; column = 'COMPLETED'; }
      else if (['done', 'closed', 'deployed', 'completed'].includes(ledgerStatus)) { isTerminal = true; terminalOutcome = 'success'; column = 'COMPLETED'; }
      else if (['failed', 'error'].includes(ledgerStatus)) { isTerminal = true; terminalOutcome = 'failed'; column = 'COMPLETED'; }
      else if (['in_progress', 'running', 'active', 'validating'].includes(ledgerStatus)) { column = 'IN_PROGRESS'; }

      return {
        vtid: row.vtid,
        title: row.title || row.description,
        status: row.status,
        column,
        is_terminal: isTerminal,
        terminal_outcome: terminalOutcome,
        layer: row.layer,
        module: row.module,
        updated_at: row.updated_at,
      };
    });

    return { ok: true, data: { tasks, total: tasks.length } as any };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get full task detail for a VTID
 */
async function executeDevGetTaskDetail(
  args: { vtid: string },
  threadId: string
): Promise<ToolExecutionResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const headers = { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}` };

    // Fetch ledger entry
    const ledgerResp = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${args.vtid}&limit=1`,
      { headers }
    );
    const ledgerRows = ledgerResp.ok ? (await ledgerResp.json() as any[]) : [];
    const ledger = ledgerRows[0] || null;

    // Fetch OASIS events for this VTID
    const eventsResp = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_events?vtid=eq.${args.vtid}&order=created_at.desc&limit=50`,
      { headers }
    );
    const events = eventsResp.ok ? (await eventsResp.json() as any[]) : [];

    // Fetch spec if available
    const specResp = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_specs?vtid=eq.${args.vtid}&limit=1`,
      { headers }
    );
    const specRows = specResp.ok ? (await specResp.json() as any[]) : [];
    const spec = specRows[0] || null;

    return {
      ok: true,
      data: {
        vtid: args.vtid,
        ledger: ledger ? {
          title: ledger.title,
          summary: ledger.summary,
          status: ledger.status,
          layer: ledger.layer,
          module: ledger.module,
          created_at: ledger.created_at,
          updated_at: ledger.updated_at,
        } : null,
        spec: spec ? {
          status: spec.status,
          title: spec.title,
          updated_at: spec.updated_at,
          has_content: !!spec.spec_markdown,
        } : null,
        recent_events: events.slice(0, 20).map((e: any) => ({
          topic: e.topic,
          status: e.status,
          message: e.message,
          created_at: e.created_at,
        })),
        event_count: events.length,
      } as any,
    };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Generate spec for a VTID by calling the specs API internally
 */
async function executeDevGenerateSpec(
  args: { vtid: string; seed_notes?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const headers = { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}` };

    // Get ledger entry for task info
    const ledgerResp = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${args.vtid}&limit=1`,
      { headers }
    );
    const ledgerRows = ledgerResp.ok ? (await ledgerResp.json() as any[]) : [];
    if (ledgerRows.length === 0) {
      return { ok: false, error: `VTID ${args.vtid} not found in ledger` };
    }
    const ledger = ledgerRows[0];
    const title = ledger.title || ledger.description || args.vtid;
    const summary = ledger.summary || '';
    const seedNotes = args.seed_notes || summary || title;

    // Call the internal spec generation endpoint via HTTP
    const gatewayPort = process.env.PORT || '8080';
    const generateResp = await fetch(`http://localhost:${gatewayPort}/api/v1/specs/${args.vtid}/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({ seed_notes: seedNotes, source: 'developer_assistant' }),
    });

    const result = await generateResp.json() as any;
    if (!generateResp.ok) {
      return { ok: false, error: result.error || `Spec generation failed: ${generateResp.status}` };
    }

    await emitOasisEvent({
      vtid: args.vtid,
      type: 'dev_assist.spec.generated',
      source: 'developer-assistant',
      status: 'success',
      message: `Spec generated for ${args.vtid} via developer assistant`,
      payload: { thread_id: threadId },
    }).catch(() => {});

    return { ok: true, data: { vtid: args.vtid, message: `Spec generated successfully for ${args.vtid}`, spec_status: result.spec_status || 'draft' } as any };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get spec content for a VTID
 */
async function executeDevGetSpec(
  args: { vtid: string },
  threadId: string
): Promise<ToolExecutionResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const headers = { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}` };
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/oasis_specs?vtid=eq.${args.vtid}&limit=1`,
      { headers }
    );

    if (!resp.ok) return { ok: false, error: `Query failed: ${resp.status}` };
    const rows = await resp.json() as any[];

    if (rows.length === 0) {
      return { ok: true, data: { vtid: args.vtid, exists: false, message: 'No spec found for this VTID' } as any };
    }

    const spec = rows[0];
    return {
      ok: true,
      data: {
        vtid: args.vtid,
        exists: true,
        status: spec.status,
        title: spec.title,
        spec_markdown: spec.spec_markdown,
        hash: spec.hash,
        updated_at: spec.updated_at,
      } as any,
    };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Validate spec for a VTID
 */
async function executeDevValidateSpec(
  args: { vtid: string },
  threadId: string
): Promise<ToolExecutionResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const gatewayPort = process.env.PORT || '8080';
    const resp = await fetch(`http://localhost:${gatewayPort}/api/v1/specs/${args.vtid}/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    const result = await resp.json() as any;
    return { ok: resp.ok, data: result, error: resp.ok ? undefined : (result.error || 'Validation failed') };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Quality check spec for a VTID
 */
async function executeDevQualityCheck(
  args: { vtid: string },
  threadId: string
): Promise<ToolExecutionResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const gatewayPort = process.env.PORT || '8080';
    const resp = await fetch(`http://localhost:${gatewayPort}/api/v1/specs/${args.vtid}/quality-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    const result = await resp.json() as any;
    return { ok: resp.ok, data: result, error: resp.ok ? undefined : (result.error || 'Quality check failed') };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Approve spec for a VTID
 */
async function executeDevApproveSpec(
  args: { vtid: string },
  threadId: string
): Promise<ToolExecutionResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const gatewayPort = process.env.PORT || '8080';
    const resp = await fetch(`http://localhost:${gatewayPort}/api/v1/specs/${args.vtid}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({ approved_by: 'developer_assistant' }),
    });

    const result = await resp.json() as any;

    if (resp.ok) {
      await emitOasisEvent({
        vtid: args.vtid,
        type: 'dev_assist.spec.approved',
        source: 'developer-assistant',
        status: 'success',
        message: `Spec approved for ${args.vtid} via developer assistant`,
        payload: { thread_id: threadId },
      }).catch(() => {});
    }

    return { ok: resp.ok, data: result, error: resp.ok ? undefined : (result.error || 'Approval failed') };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * List pending approvals
 */
async function executeDevListApprovals(
  args: { limit?: number },
  threadId: string
): Promise<ToolExecutionResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const gatewayPort = process.env.PORT || '8080';
    const limit = args.limit || 50;
    const resp = await fetch(`http://localhost:${gatewayPort}/api/v1/approvals/pending?limit=${limit}`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    const result = await resp.json() as any;
    return { ok: resp.ok, data: result, error: resp.ok ? undefined : (result.error || 'Failed to fetch approvals') };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get pending approval count
 */
async function executeDevApprovalCount(threadId: string): Promise<ToolExecutionResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const gatewayPort = process.env.PORT || '8080';
    const resp = await fetch(`http://localhost:${gatewayPort}/api/v1/approvals/count`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    const result = await resp.json() as any;
    return { ok: resp.ok, data: result, error: resp.ok ? undefined : (result.error || 'Failed to get count') };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Approve a pending item
 */
async function executeDevApproveItem(
  args: { approval_id: string },
  threadId: string
): Promise<ToolExecutionResult> {
  try {
    const gatewayPort = process.env.PORT || '8080';
    const resp = await fetch(`http://localhost:${gatewayPort}/api/v1/approvals/${args.approval_id}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE!,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    const result = await resp.json() as any;

    if (resp.ok) {
      await emitOasisEvent({
        vtid: 'VTID-DEV-ASSIST',
        type: 'dev_assist.approval.approved',
        source: 'developer-assistant',
        status: 'success',
        message: `Approval ${args.approval_id} approved via developer assistant`,
        payload: { approval_id: args.approval_id, thread_id: threadId },
      }).catch(() => {});
    }

    return { ok: resp.ok, data: result, error: resp.ok ? undefined : (result.error || 'Approve failed') };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Reject a pending item
 */
async function executeDevRejectItem(
  args: { approval_id: string; reason?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  try {
    const gatewayPort = process.env.PORT || '8080';
    const resp = await fetch(`http://localhost:${gatewayPort}/api/v1/approvals/${args.approval_id}/reject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE!,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({ reason: args.reason || 'Rejected via developer assistant' }),
    });

    const result = await resp.json() as any;

    if (resp.ok) {
      await emitOasisEvent({
        vtid: 'VTID-DEV-ASSIST',
        type: 'dev_assist.approval.rejected',
        source: 'developer-assistant',
        status: 'success',
        message: `Approval ${args.approval_id} rejected via developer assistant`,
        payload: { approval_id: args.approval_id, reason: args.reason, thread_id: threadId },
      }).catch(() => {});
    }

    return { ok: resp.ok, data: result, error: resp.ok ? undefined : (result.error || 'Reject failed') };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Query OASIS events with filtering
 */
async function executeDevQueryOasisEvents(
  args: { vtid?: string; topic?: string; status?: string; limit?: number },
  threadId: string
): Promise<ToolExecutionResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const limit = args.limit || 50;
    let url = `${SUPABASE_URL}/rest/v1/oasis_events?order=created_at.desc&limit=${limit}`;
    if (args.vtid) url += `&vtid=eq.${args.vtid}`;
    if (args.topic) url += `&topic=ilike.*${encodeURIComponent(args.topic)}*`;
    if (args.status) url += `&status=eq.${args.status}`;

    const resp = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}` },
    });

    if (!resp.ok) return { ok: false, error: `Query failed: ${resp.status}` };
    const events = await resp.json() as any[];

    return {
      ok: true,
      data: {
        events: events.map((e: any) => ({
          vtid: e.vtid,
          topic: e.topic,
          status: e.status,
          message: e.message,
          created_at: e.created_at,
          metadata: e.metadata,
        })),
        total: events.length,
      } as any,
    };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Create a GitHub PR
 */
async function executeDevCreatePr(
  args: { vtid: string; head_branch: string; base_branch?: string; title?: string; body?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  try {
    const gatewayPort = process.env.PORT || '8080';
    const resp = await fetch(`http://localhost:${gatewayPort}/api/v1/github/create-pr`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE!,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({
        vtid: args.vtid,
        repo: 'exafyltd/vitana-platform',
        head_branch: args.head_branch,
        base_branch: args.base_branch || 'main',
        title: args.title || `${args.vtid}: ${args.head_branch}`,
        body: args.body || `PR created via Vitana Developer Assistant for ${args.vtid}`,
      }),
    });

    const result = await resp.json() as any;

    if (resp.ok) {
      await emitOasisEvent({
        vtid: args.vtid,
        type: 'dev_assist.pr.created',
        source: 'developer-assistant',
        status: 'success',
        message: `PR created for ${args.vtid} via developer assistant`,
        payload: { head_branch: args.head_branch, thread_id: threadId, pr_url: result.pr_url },
      }).catch(() => {});
    }

    return { ok: resp.ok, data: result, error: resp.ok ? undefined : (result.error || 'PR creation failed') };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Safe merge a PR
 */
async function executeDevMergePr(
  args: { vtid: string; pr_number: number; merge_method?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  try {
    const gatewayPort = process.env.PORT || '8080';
    const resp = await fetch(`http://localhost:${gatewayPort}/api/v1/github/safe-merge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE!,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({
        vtid: args.vtid,
        repo: 'exafyltd/vitana-platform',
        pr_number: args.pr_number,
        merge_method: args.merge_method || 'squash',
      }),
    });

    const result = await resp.json() as any;

    if (resp.ok) {
      await emitOasisEvent({
        vtid: args.vtid,
        type: 'dev_assist.pr.merged',
        source: 'developer-assistant',
        status: 'success',
        message: `PR #${args.pr_number} merged for ${args.vtid} via developer assistant`,
        payload: { pr_number: args.pr_number, thread_id: threadId },
      }).catch(() => {});
    }

    return { ok: resp.ok, data: result, error: resp.ok ? undefined : (result.error || 'Merge failed') };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Deploy a service
 */
async function executeDevDeployService(
  args: { service: string; vtid?: string; environment?: string },
  threadId: string
): Promise<ToolExecutionResult> {
  try {
    const gatewayPort = process.env.PORT || '8080';
    const resp = await fetch(`http://localhost:${gatewayPort}/api/v1/deploy/service`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE!,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({
        service: args.service,
        vtid: args.vtid || 'VTID-DEV-ASSIST',
        environment: args.environment || 'production',
      }),
    });

    const result = await resp.json() as any;

    if (resp.ok) {
      await emitOasisEvent({
        vtid: args.vtid || 'VTID-DEV-ASSIST',
        type: 'dev_assist.deploy.triggered',
        source: 'developer-assistant',
        status: 'success',
        message: `Deploy triggered for ${args.service} via developer assistant`,
        payload: { service: args.service, environment: args.environment, thread_id: threadId },
      }).catch(() => {});
    }

    return { ok: resp.ok, data: result, error: resp.ok ? undefined : (result.error || 'Deploy failed') };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Check deployment status/history
 */
async function executeDevDeploymentStatus(
  args: { service?: string; limit?: number },
  threadId: string
): Promise<ToolExecutionResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const limit = args.limit || 10;
    let url = `${SUPABASE_URL}/rest/v1/oasis_events?topic=ilike.deploy.*&order=created_at.desc&limit=${limit}`;
    if (args.service) url += `&topic=ilike.*${args.service}*`;

    const resp = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}` },
    });

    if (!resp.ok) return { ok: false, error: `Query failed: ${resp.status}` };
    const events = await resp.json() as any[];

    return {
      ok: true,
      data: {
        deployments: events.map((e: any) => ({
          vtid: e.vtid,
          topic: e.topic,
          status: e.status,
          message: e.message,
          created_at: e.created_at,
          metadata: e.metadata,
        })),
        total: events.length,
      } as any,
    };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Check CI/CD pipeline health
 */
async function executeDevCicdHealth(threadId: string): Promise<ToolExecutionResult> {
  try {
    const gatewayPort = process.env.PORT || '8080';
    const resp = await fetch(`http://localhost:${gatewayPort}/api/v1/cicd/health`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE!,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    const result = await resp.json() as any;
    return { ok: resp.ok, data: result };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/**
 * Check deploy concurrency lock status
 */
async function executeDevLockStatus(threadId: string): Promise<ToolExecutionResult> {
  try {
    const gatewayPort = process.env.PORT || '8080';
    const resp = await fetch(`http://localhost:${gatewayPort}/api/v1/cicd/lock-status`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE!,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    const result = await resp.json() as any;
    return { ok: resp.ok, data: result };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ==================== VTID-02000: Marketplace Tool Executors ====================

/**
 * Call the gateway's own discover-search endpoint. The tool runs in-process
 * with the user's effective context extracted via the JWT the caller attached
 * to the tool-execution path.
 */
async function executeSearchMarketplaceProducts(
  args: {
    q?: string;
    user_condition?: string;
    health_goals?: string[];
    ingredients_any?: string[];
    dietary_tags?: string[];
    form?: string;
    category?: string;
    price_max_cents?: number;
    limit?: number;
    scope?: string;
  },
  _threadId: string
): Promise<ToolExecutionResult> {
  try {
    const { getUserHealthContext, inferPrimaryCondition } = await import('./user-health-context');
    const { applyUserLimitations } = await import('./limitations-filter');
    const { getConditionMapping } = await import('./condition-matcher');
    const { getSupabase } = await import('../lib/supabase');

    // For tool calls we assume a per-thread user context is attached via
    // gateway machinery; for Phase 0 we fall back to an anonymous search.
    // Real integration with the orb-live session's user_id happens in the
    // orb-live -> gemini-operator wiring layer — we leave this runnable.
    const supabase = getSupabase();
    if (!supabase) return { ok: false, error: 'Supabase unavailable' };

    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    const conditionKey = args.user_condition;
    const mapping = conditionKey ? await getConditionMapping(conditionKey) : null;

    let healthGoals = args.health_goals;
    let ingredientsAny = args.ingredients_any;
    if (mapping) {
      if (!ingredientsAny?.length) ingredientsAny = mapping.recommended_ingredients;
      if (!healthGoals?.length) healthGoals = mapping.recommended_health_goals;
    }

    const { data: rows, error } = await repo.searchMarketplaceProducts(supabase, {
      q: args.q,
      category: args.category,
      form: args.form,
      healthGoals,
      ingredientsAny,
      dietary_tags: args.dietary_tags,
      price_max_cents: args.price_max_cents,
      orderLimit: limit * 3,
    });
    if (error) return { ok: false, error: error.message };

    const items = (rows ?? []) as Array<{ id: string; title: string; price_cents: number | null; currency: string | null; rating: number | null; ingredients_primary: string[]; origin_country: string | null; origin_region: string | null; contains_allergens: string[]; contraindicated_with_conditions: string[]; contraindicated_with_medications: string[]; ships_to_countries: string[] | null; ships_to_regions: string[] | null; excluded_from_regions: string[]; dietary_tags: string[] }>;

    // If we can resolve a user context (best-effort), apply limitations
    // For now this path runs without ctx — full wiring to per-session user_id
    // lands when orb-live passes it down.
    const matchReasonsFor = (p: typeof items[number]): Array<{ kind: string; text: string }> => {
      const reasons: Array<{ kind: string; text: string }> = [];
      if (mapping?.recommended_ingredients_ranked.length && p.ingredients_primary?.length) {
        const pIngs = new Set(p.ingredients_primary.map((x) => x.toLowerCase()));
        for (const rec of mapping.recommended_ingredients_ranked) {
          if (pIngs.has(rec.ingredient.toLowerCase())) {
            reasons.push({ kind: 'condition', text: `Contains ${rec.ingredient} (${rec.evidence} evidence for ${mapping.display_label})` });
            break;
          }
        }
      }
      if (p.rating !== null && p.rating >= 4.5) {
        reasons.push({ kind: 'rating', text: `Rated ${p.rating.toFixed(1)}/5` });
      }
      if (p.origin_country) {
        reasons.push({ kind: 'origin', text: `Ships from ${p.origin_country}` });
      }
      return reasons;
    };

    const result = {
      items: items.slice(0, limit).map((p) => ({
        product_id: p.id,
        title: p.title,
        price_cents: p.price_cents,
        currency: p.currency,
        rating: p.rating,
        origin_country: p.origin_country,
        match_reasons: matchReasonsFor(p),
      })),
      count: Math.min(items.length, limit),
      applied_filters: {
        user_condition: conditionKey ?? null,
        health_goals: healthGoals ?? null,
        ingredients_any: ingredientsAny ?? null,
        dietary_tags: args.dietary_tags ?? null,
        price_max_cents: args.price_max_cents ?? null,
      },
    };

    return { ok: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

async function executeOpenDiscoverFeed(
  args: { category?: string; limit?: number },
  _threadId: string
): Promise<ToolExecutionResult> {
  try {
    const { getSupabase } = await import('../lib/supabase');
    const supabase = getSupabase();
    if (!supabase) return { ok: false, error: 'Supabase unavailable' };

    const limit = Math.min(Math.max(args.limit ?? 10, 1), 30);
    const { data, error } = await repo.fetchDiscoverFeed(supabase, args.category, limit);
    if (error) return { ok: false, error: error.message };

    return {
      ok: true,
      data: {
        items: data ?? [],
        count: data?.length ?? 0,
        feed_context: {
          rationale: 'Top-rated products currently in stock. Personalized ranking applies when user context is available on the session.',
        },
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ==================== VTID-02100: Wearable Metrics Executor ====================

async function executeGetWearableMetrics(
  args: { days?: number },
  threadId: string
): Promise<ToolExecutionResult> {
  try {
    const { getSupabase } = await import('../lib/supabase');
    const supabase = getSupabase();
    if (!supabase) return { ok: false, error: 'Supabase unavailable' };

    // For tool calls we don't have per-thread user context attached at this
    // layer yet — we use the thread -> user map the orb maintains. For Phase 1
    // we fall back to returning aggregate shape so tests can exercise.
    // Real integration is completed when orb-live's session attaches user_id
    // to the tool-execution context.
    const threadUserId = await resolveThreadUserId(threadId);
    if (!threadUserId) {
      return {
        ok: true,
        data: {
          rollup_7d: null,
          recent_daily: [],
          note: 'No user context attached to this session — connect a wearable via /ecosystem to see your metrics.',
        },
      };
    }

    const limit = Math.min(Math.max(args.days ?? 7, 1), 30);

    const [rollupResp, recentResp] = await Promise.all([
      repo.fetchWearableRollup7d(supabase, threadUserId),
      repo.fetchRecentWearableDailyMetrics(supabase, threadUserId, limit),
    ]);

    if (rollupResp.error) return { ok: false, error: rollupResp.error.message };

    return {
      ok: true,
      data: {
        rollup_7d: rollupResp.data ?? null,
        recent_daily: recentResp.data ?? [],
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

async function resolveThreadUserId(threadId: string): Promise<string | null> {
  try {
    const { getSupabase } = await import('../lib/supabase');
    const supabase = getSupabase();
    if (!supabase) return null;
    const { data } = await repo.fetchConversationThreadUserId(supabase, threadId);
    return (data?.user_id as string | undefined) ?? null;
  } catch {
    return null;
  }
}

// ==================== Exports ====================

export {
  evaluateGovernance,
  executeCreateTask,
  executeGetStatus,
  executeListRecentTasks
};
