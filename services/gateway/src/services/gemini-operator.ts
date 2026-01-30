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
import { VertexAI, GenerateContentResult, Content, Part, FunctionDeclaration, Tool } from '@google-cloud/vertexai';
import {
  createOperatorTask,
  getAutopilotTaskStatus,
  getPendingPlanTasks,
  ingestOperatorEvent,
  CreatedTask,
  TaskStatusResponse
} from './operator-service';
import { emitOasisEvent, recommendationSyncEvents } from './oasis-event-service';
// VTID-01221: Sync Brief formatter for recommendation presentation
import { formatSyncBrief, isWhatNextIntent, shouldFetchRecommendations, SyncBriefContext, Recommendation } from './sync-brief-formatter';
// VTID-0538: Knowledge Hub integration
import { executeKnowledgeSearch, KNOWLEDGE_SEARCH_TOOL_DEFINITION } from './knowledge-hub';
// VTID-01208: LLM Telemetry
import {
  startLLMCall,
  completeLLMCall,
  failLLMCall,
  LLMCallContext,
  hashPrompt
} from './llm-telemetry-service';

// Environment config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

// VTID-01023: Vertex AI configuration - uses ADC (Application Default Credentials)
// On Cloud Run, this automatically uses the service account
const VERTEX_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'lovable-vitana-vers1';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const VERTEX_MODEL = process.env.VERTEX_MODEL || 'gemini-2.5-pro';

// VTID-01023: Check which AI backends are configured
const hasGeminiConfig = !!GOOGLE_GEMINI_API_KEY;
// Vertex AI is available if we have project and location (uses ADC for auth)
const hasVertexConfig = !!VERTEX_PROJECT && !!VERTEX_LOCATION;
const hasAnyAIConfig = hasGeminiConfig || hasVertexConfig;

// VTID-01023: Initialize Vertex AI client (uses ADC automatically on Cloud Run)
let vertexAI: VertexAI | null = null;
if (hasVertexConfig) {
  try {
    vertexAI = new VertexAI({
      project: VERTEX_PROJECT,
      location: VERTEX_LOCATION,
    });
    console.log(`[VTID-01023] Vertex AI initialized: project=${VERTEX_PROJECT}, location=${VERTEX_LOCATION}, model=${VERTEX_MODEL}`);
  } catch (err: any) {
    console.warn(`[VTID-01023] Failed to initialize Vertex AI: ${err.message}`);
  }
}

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

// ==================== Tool Definitions ====================

/**
 * Tool definitions for Gemini function calling
 * These are registered with Gemini for function calling capability
 */
export const GEMINI_TOOL_DEFINITIONS = {
  functionDeclarations: [
    {
      name: 'autopilot_create_task',
      description: 'Create a new Autopilot task in the Vitana system. This will create a VTID, register the task, and trigger planning. Use this when the operator wants to create a new task for the Autopilot system to handle.',
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
  await emitOasisEvent({
    vtid: params.vtid,
    type: `autopilot.intent.${params.action}`,
    source: 'operator-console',
    status: params.action === 'rejected' ? 'warning' : 'success',
    message: `Autopilot intent ${params.action}`,
    payload: {
      threadId: params.threadId,
      ...params.details
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
    let queryUrl = `${SUPABASE_URL}/rest/v1/VtidLedger?select=vtid,title,status,created_at&order=created_at.desc&limit=${limit}`;

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
 * VTID-01023: System prompt for Operator Chat Gemini/Vertex integration
 * VTID-01025: Open chat mode - general knowledge + task operations
 */
const OPERATOR_SYSTEM_PROMPT = `You are a helpful AI assistant with access to the Vitana Autopilot system. You can answer any question and also help manage Vitana tasks.

**Available tools (use when appropriate):**
- autopilot_create_task: Create a new Autopilot task
- autopilot_get_status: Check the status of an existing task by VTID
- autopilot_list_recent_tasks: List recent tasks
- knowledge_search: Search Vitana documentation (use for Vitana-specific questions like "What is OASIS?", "Explain the Vitana Index", etc.)
- run_code: Execute JavaScript code for calculations, date math, conversions, data processing

**When to use tools:**
- Task creation requests (e.g., "Create a task to deploy gateway") → use autopilot_create_task
- Status checks (e.g., "Status of VTID-0540") → use autopilot_get_status
- Task listing (e.g., "Show recent tasks") → use autopilot_list_recent_tasks
- Vitana-specific questions → use knowledge_search
- Calculations, date math, age calculations, unit conversions → use run_code

**IMPORTANT: Always use run_code for ANY calculation:**
- "How old am I?" → run_code
- "Days between two dates" → run_code
- "What percentage is X of Y?" → run_code
- "Convert miles to kilometers" → run_code
- "Age difference between people" → run_code

Be helpful, accurate, and concise. If a task is blocked by governance, explain the reason clearly.`;

/**
 * VTID-01023: Convert tool definitions to Vertex AI format
 * Uses explicit typing to match Vertex AI SDK requirements
 */
function getVertexToolDefinitions(): Tool[] {
  // Convert our tool definitions to Vertex AI format
  // The Vertex AI SDK expects a specific schema structure
  const functionDeclarations: FunctionDeclaration[] = GEMINI_TOOL_DEFINITIONS.functionDeclarations.map(fd => ({
    name: fd.name,
    description: fd.description,
    // Cast parameters through unknown to satisfy TypeScript
    parameters: fd.parameters as unknown as FunctionDeclaration['parameters']
  }));

  return [{ functionDeclarations }];
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
  vtid?: string | null
): Promise<{
  reply: string;
  toolCalls?: GeminiToolCall[];
  telemetryContext?: LLMCallContext;
}> {
  if (!vertexAI) {
    throw new Error('Vertex AI not initialized');
  }

  // VTID-01208: Start LLM telemetry tracking
  const llmContext = await startLLMCall({
    vtid: vtid || null,
    threadId,
    service: 'gemini-operator',
    stage: 'operator',
    provider: 'vertex',
    model: VERTEX_MODEL,
    prompt: text,
  });

  // VTID-01106: Use custom system instruction if provided (for ORB memory context)
  // VTID-01192: ALWAYS include tool instructions - merge with custom instruction
  const toolInstructions = `
**Available tools (ALWAYS use for calculations):**
- run_code: Execute JavaScript code for calculations, date math, conversions

**CRITICAL: When you have data in your context and need to calculate:**
- Age difference, days between dates, percentages → CALL run_code
- Extract the dates/numbers from context, then call run_code with JS code
- NEVER say "I don't have access" when data IS in your context`;

  const systemPrompt = customSystemInstruction
    ? `${customSystemInstruction}\n\n${toolInstructions}`
    : `${OPERATOR_SYSTEM_PROMPT}\n\nCurrent thread: ${threadId}`;

  const generativeModel = vertexAI.getGenerativeModel({
    model: VERTEX_MODEL,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
      topP: 0.95,
      topK: 40
    },
    systemInstruction: {
      role: 'system',
      parts: [{ text: systemPrompt }]
    },
    tools: getVertexToolDefinitions()
  });

  // VTID-01027: Build contents array with conversation history
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

  // Add conversation history (map 'assistant' to 'model' for Vertex AI)
  for (const msg of conversationHistory) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    });
  }

  // Add current user message
  contents.push({
    role: 'user',
    parts: [{ text }]
  });

  const request = { contents };

  try {
    console.log(`[VTID-01023] Calling Vertex AI: model=${VERTEX_MODEL}, history_messages=${conversationHistory.length}`);
    const response = await generativeModel.generateContent(request);

    const candidate = response.response?.candidates?.[0];
    const content = candidate?.content;

    // VTID-01208: Extract usage metadata if available
    const usageMetadata = (response.response as any)?.usageMetadata;
    const inputTokens = usageMetadata?.promptTokenCount;
    const outputTokens = usageMetadata?.candidatesTokenCount;

    if (!content) {
      // VTID-01208: Complete telemetry for empty response
      await completeLLMCall(llmContext, { inputTokens, outputTokens });
      return { reply: 'I apologize, but I could not generate a response. Please try again.', telemetryContext: llmContext };
    }

    // Check for function calls
    const functionCallParts = content.parts?.filter((part: Part) => 'functionCall' in part);

    if (functionCallParts && functionCallParts.length > 0) {
      const toolCalls: GeminiToolCall[] = functionCallParts.map((fc: Part) => {
        const functionCall = (fc as any).functionCall;
        return {
          name: functionCall.name,
          args: functionCall.args || {}
        };
      });
      console.log(`[VTID-01023] Vertex AI returned ${toolCalls.length} tool call(s)`);

      // VTID-01208: Complete telemetry for tool call response
      await completeLLMCall(llmContext, { inputTokens, outputTokens });
      return { reply: '', toolCalls, telemetryContext: llmContext };
    }

    // Extract text response
    const textPart = content.parts?.find((part: Part) => 'text' in part);
    const reply = textPart ? (textPart as any).text : '';
    console.log(`[VTID-01023] Vertex AI returned text response (${reply.length} chars)`);

    // VTID-01208: Complete telemetry for text response
    await completeLLMCall(llmContext, { inputTokens, outputTokens });
    return { reply, telemetryContext: llmContext };
  } catch (error: any) {
    // VTID-01208: Record failure in telemetry
    await failLLMCall(llmContext, {
      code: 'VERTEX_ERROR',
      message: error.message || 'Unknown Vertex AI error'
    });
    throw error;
  }
}

/**
 * VTID-01023: Send tool results back to Vertex AI for final response
 */
async function sendToolResultsToVertex(
  originalText: string,
  toolResults: GeminiToolResult[],
  threadId: string
): Promise<{ reply: string }> {
  if (!vertexAI) {
    // Fallback: format tool results as response
    return formatToolResultsAsResponse(toolResults);
  }

  const generativeModel = vertexAI.getGenerativeModel({
    model: VERTEX_MODEL,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
    systemInstruction: {
      role: 'system',
      parts: [{ text: `You are the Vitana Operator Assistant. Summarize the tool results for the operator in a clear, helpful way.
If there were errors or governance blocks, explain them clearly.
If successful, confirm what was done and any next steps.` }]
    }
  });

  // Build conversation with tool results
  const contents: Content[] = [
    {
      role: 'user',
      parts: [{ text: originalText }]
    },
    {
      role: 'model',
      parts: toolResults.map(tr => ({
        functionResponse: {
          name: tr.name,
          response: tr.response
        }
      })) as Part[]
    }
  ];

  try {
    const response = await generativeModel.generateContent({ contents });
    const textPart = response.response?.candidates?.[0]?.content?.parts?.find((p: Part) => 'text' in p);
    const reply = textPart ? (textPart as any).text : 'Operation completed.';
    return { reply };
  } catch (err: any) {
    console.warn(`[VTID-01023] Vertex tool results call failed: ${err.message}`);
    return formatToolResultsAsResponse(toolResults);
  }
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
}): Promise<GeminiOperatorResponse> {
  const { text, threadId, attachments = [], context = {}, conversationHistory = [], conversationId, systemInstruction } = input;

  console.log(`[VTID-01023] Processing message: "${text.substring(0, 50)}..."`);
  if (conversationHistory.length > 0) {
    console.log(`[VTID-01027] Including ${conversationHistory.length} context messages from conversation ${conversationId}`);
  }

  // VTID-01023: Try Vertex AI first (uses ADC, works on Cloud Run without API key)
  if (vertexAI) {
    try {
      console.log('[VTID-01023] Using Vertex AI with ADC');
      // VTID-01106: Pass custom system instruction if provided (for ORB memory context)
      const vertexResponse = await callVertexWithTools(text, threadId, conversationHistory, systemInstruction);

      // Check if Vertex wants to call any tools
      if (vertexResponse.toolCalls && vertexResponse.toolCalls.length > 0) {
        const toolResults: GeminiToolResult[] = [];

        for (const toolCall of vertexResponse.toolCalls) {
          const result = await executeTool(toolCall.name, toolCall.args, threadId);
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
        const finalResponse = await sendToolResultsToVertex(text, toolResults, threadId);

        return {
          reply: finalResponse.reply,
          toolResults,
          meta: {
            provider: 'vertex',
            model: VERTEX_MODEL,
            mode: 'operator_vertex',
            tool_calls: vertexResponse.toolCalls.length,
            vtid: 'VTID-01023'
          }
        };
      }

      // No tool calls, return Vertex's direct response
      return {
        reply: vertexResponse.reply,
        meta: {
          provider: 'vertex',
          model: VERTEX_MODEL,
          mode: 'operator_vertex',
          tool_calls: 0,
          vtid: 'VTID-01023'
        }
      };
    } catch (error: any) {
      console.warn(`[VTID-01023] Vertex AI error, trying fallback: ${error.message}`);
      // Fall through to Gemini API or local routing
    }
  }

  // VTID-01023: Fallback to Gemini API key if available
  if (GOOGLE_GEMINI_API_KEY) {
    try {
      console.log('[VTID-01023] Falling back to Gemini API key');
      // Call Gemini API with function calling
      // VTID-01027: Pass conversation history
      // VTID-01106: Pass custom system instruction if provided (for ORB memory context)
      const geminiResponse = await callGeminiWithTools(text, threadId, conversationHistory, systemInstruction);

      // Check if Gemini wants to call any tools
      if (geminiResponse.toolCalls && geminiResponse.toolCalls.length > 0) {
        const toolResults: GeminiToolResult[] = [];

        for (const toolCall of geminiResponse.toolCalls) {
          const result = await executeTool(toolCall.name, toolCall.args, threadId);
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

        // Send tool results back to Gemini for final response
        const finalResponse = await sendToolResultsToGemini(text, toolResults, threadId);

        return {
          reply: finalResponse.reply,
          toolResults,
          meta: {
            provider: 'gemini-api',
            model: 'gemini-pro',
            mode: 'operator_gemini',
            tool_calls: geminiResponse.toolCalls.length,
            vtid: 'VTID-01023'
          }
        };
      }

      // No tool calls, return Gemini's direct response
      return {
        reply: geminiResponse.reply,
        meta: {
          provider: 'gemini-api',
          model: 'gemini-pro',
          mode: 'operator_gemini',
          tool_calls: 0,
          vtid: 'VTID-01023'
        }
      };
    } catch (error: any) {
      console.error(`[VTID-01023] Gemini API error:`, error.message);
    }
  }

  // VTID-01023: Final fallback to local routing
  console.log('[VTID-01023] Using local routing fallback');
  const fallbackResponse = await processLocalRouting(text, threadId);
  if (fallbackResponse.meta) {
    fallbackResponse.meta.fallback_reason = vertexAI ? 'vertex_error' : 'no_ai_backend';
  }
  return fallbackResponse;
}

/**
 * Call Gemini API with tool definitions
 * VTID-01027: Added conversation history support
 * VTID-01106: Added optional custom system instruction for ORB memory context
 */
async function callGeminiWithTools(
  text: string,
  threadId: string,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  customSystemInstruction?: string,
  vtid?: string | null
): Promise<{
  reply: string;
  toolCalls?: GeminiToolCall[];
  telemetryContext?: LLMCallContext;
}> {
  if (!GOOGLE_GEMINI_API_KEY) {
    throw new Error('GOOGLE_GEMINI_API_KEY not configured');
  }

  // VTID-01208: Start LLM telemetry tracking
  const llmContext = await startLLMCall({
    vtid: vtid || null,
    threadId,
    service: 'gemini-operator',
    stage: 'operator',
    provider: 'vertex',
    model: 'gemini-pro',
    prompt: text,
  });

  // VTID-01027: Build contents array with conversation history
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  // Add conversation history (map 'assistant' to 'model' for Gemini API)
  for (const msg of conversationHistory) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    });
  }

  // Add current user message
  contents.push({
    role: 'user',
    parts: [{ text }]
  });

  // VTID-01106: Use custom system instruction if provided (for ORB memory context)
  // VTID-01192: ALWAYS include tool instructions - merge with custom instruction
  const geminiToolInstructions = `
**Available tools (ALWAYS use for calculations):**
- run_code: Execute JavaScript code for calculations, date math, conversions

**CRITICAL: When you have data in your context and need to calculate:**
- Age difference, days between dates, percentages → CALL run_code
- Extract the dates/numbers from context, then call run_code with JS code
- NEVER say "I don't have access" when data IS in your context`;

  const systemPrompt = customSystemInstruction
    ? `${customSystemInstruction}\n\n${geminiToolInstructions}`
    : `${OPERATOR_SYSTEM_PROMPT}\n\nCurrent thread: ${threadId}`;

  const requestBody = {
    contents,
    tools: [GEMINI_TOOL_DEFINITIONS],
    systemInstruction: {
      parts: [{
        text: systemPrompt
      }]
    },
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024
    }
  };

  try {
    console.log(`[VTID-01027] Calling Gemini API with ${conversationHistory.length} history messages`);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GOOGLE_GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as any;
    const candidate = result.candidates?.[0];
    const content = candidate?.content;

    // VTID-01208: Extract usage metadata if available
    const usageMetadata = result.usageMetadata;
    const inputTokens = usageMetadata?.promptTokenCount;
    const outputTokens = usageMetadata?.candidatesTokenCount;

    if (!content) {
      await completeLLMCall(llmContext, { inputTokens, outputTokens });
      return { reply: 'I apologize, but I could not generate a response. Please try again.', telemetryContext: llmContext };
    }

    // Check for function calls
    const functionCalls = content.parts?.filter((part: any) => part.functionCall);

    if (functionCalls && functionCalls.length > 0) {
      const toolCalls: GeminiToolCall[] = functionCalls.map((fc: any) => ({
        name: fc.functionCall.name,
        args: fc.functionCall.args || {}
      }));
      await completeLLMCall(llmContext, { inputTokens, outputTokens });
      return { reply: '', toolCalls, telemetryContext: llmContext };
    }

    // Extract text response
    const textPart = content.parts?.find((part: any) => part.text);
    await completeLLMCall(llmContext, { inputTokens, outputTokens });
    return { reply: textPart?.text || '', telemetryContext: llmContext };
  } catch (error: any) {
    // VTID-01208: Record failure in telemetry
    await failLLMCall(llmContext, {
      code: 'GEMINI_API_ERROR',
      message: error.message || 'Unknown Gemini API error'
    });
    throw error;
  }
}

/**
 * Send tool results back to Gemini for final response
 */
async function sendToolResultsToGemini(
  originalText: string,
  toolResults: GeminiToolResult[],
  threadId: string
): Promise<{ reply: string }> {
  if (!GOOGLE_GEMINI_API_KEY) {
    // Format tool results as response
    const successResults = toolResults.filter(r => r.response.ok);
    const failedResults = toolResults.filter(r => !r.response.ok);

    let reply = '';

    for (const result of successResults) {
      if (result.response.message) {
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

  // Build conversation with tool results
  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [{ text: originalText }]
      },
      {
        role: 'model',
        parts: toolResults.map(tr => ({
          functionResponse: {
            name: tr.name,
            response: tr.response
          }
        }))
      }
    ],
    systemInstruction: {
      parts: [{
        text: `You are the Vitana Operator Assistant. Summarize the tool results for the operator in a clear, helpful way.
If there were errors or governance blocks, explain them clearly.
If successful, confirm what was done and any next steps.`
      }]
    },
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024
    }
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GOOGLE_GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    }
  );

  if (!response.ok) {
    // Fallback to formatted results
    return sendToolResultsToGemini(originalText, toolResults, threadId);
  }

  const result = await response.json() as any;
  const textPart = result.candidates?.[0]?.content?.parts?.find((p: any) => p.text);

  return { reply: textPart?.text || 'Operation completed.' };
}

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
    { pattern: /^(ok|okay|sure|got\s*it|understood|alright)/i, response: "Great! Let me know what you'd like to do next." },
    { pattern: /^(yes|no|yeah|nope|yep|nah)/i, response: "I understand. What would you like me to help you with?" },
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

  // Detect task creation requests
  if (
    lowerText.includes('create') && lowerText.includes('task') ||
    lowerText.includes('new task') ||
    lowerText.includes('add a task') ||
    lowerText.match(/create.*autopilot/i)
  ) {
    // Extract description - take everything after "task" keyword or use full text
    let description = text;
    const taskMatch = text.match(/(?:create\s+(?:a\s+)?task\s+(?:to\s+)?|new\s+task[:\s]+|add\s+(?:a\s+)?task\s+(?:to\s+)?)(.*)/i);
    if (taskMatch && taskMatch[1]) {
      description = taskMatch[1].trim();
    }

    const result = await executeTool('autopilot_create_task', { description }, threadId);
    toolResults.push({
      name: 'autopilot_create_task',
      response: {
        ok: result.ok,
        ...result.data,
        error: result.error,
        governanceBlocked: result.governanceBlocked
      }
    });
  }

  // Detect status requests
  // VTID-01007: Updated to match 4-5 digit VTIDs
  else if (
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

// ==================== Exports ====================

export {
  evaluateGovernance,
  executeCreateTask,
  executeGetStatus,
  executeListRecentTasks
};
