/**
 * VTID-0536: Gemini Operator Tools Bridge v1
 * VTID-01023: Wire /api/v1/operator/chat to Vertex Gemini
 *
 * Provides Gemini function-calling tools for the Operator Chat.
 * Tools can trigger Autopilot and OASIS actions, governed by the 0400 Governance Engine.
 *
 * VTID-01023: Added Vertex AI support using ADC (Application Default Credentials).
 * When running on Cloud Run, uses the service account for authentication.
 * Priority: Vertex AI > Gemini API Key > Local Router
 *
 * Tools:
 * - autopilot.create_task: Create a new Autopilot task (with governance)
 * - autopilot.get_status: Get status of an existing task
 * - autopilot.list_recent_tasks: List recent Autopilot tasks
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
import { emitOasisEvent } from './oasis-event-service';
// VTID-0538: Knowledge Hub integration
import { executeKnowledgeSearch, KNOWLEDGE_SEARCH_TOOL_DEFINITION } from './knowledge-hub';

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

**When to use tools:**
- Task creation requests (e.g., "Create a task to deploy gateway") → use autopilot_create_task
- Status checks (e.g., "Status of VTID-0540") → use autopilot_get_status
- Task listing (e.g., "Show recent tasks") → use autopilot_list_recent_tasks
- Vitana-specific questions → use knowledge_search

**For all other questions** (math, general knowledge, coding, etc.), answer directly without using tools.

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
  customSystemInstruction?: string
): Promise<{
  reply: string;
  toolCalls?: GeminiToolCall[];
}> {
  if (!vertexAI) {
    throw new Error('Vertex AI not initialized');
  }

  // VTID-01106: Use custom system instruction if provided (for ORB memory context)
  const systemPrompt = customSystemInstruction || `${OPERATOR_SYSTEM_PROMPT}\n\nCurrent thread: ${threadId}`;

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

  console.log(`[VTID-01023] Calling Vertex AI: model=${VERTEX_MODEL}, history_messages=${conversationHistory.length}`);
  const response = await generativeModel.generateContent(request);

  const candidate = response.response?.candidates?.[0];
  const content = candidate?.content;

  if (!content) {
    return { reply: 'I apologize, but I could not generate a response. Please try again.' };
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
    return { reply: '', toolCalls };
  }

  // Extract text response
  const textPart = content.parts?.find((part: Part) => 'text' in part);
  const reply = textPart ? (textPart as any).text : '';
  console.log(`[VTID-01023] Vertex AI returned text response (${reply.length} chars)`);
  return { reply };
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
  customSystemInstruction?: string
): Promise<{
  reply: string;
  toolCalls?: GeminiToolCall[];
}> {
  if (!GOOGLE_GEMINI_API_KEY) {
    throw new Error('GOOGLE_GEMINI_API_KEY not configured');
  }

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
  const systemPrompt = customSystemInstruction || `${OPERATOR_SYSTEM_PROMPT}\n\nCurrent thread: ${threadId}`;

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

  if (!content) {
    return { reply: 'I apologize, but I could not generate a response. Please try again.' };
  }

  // Check for function calls
  const functionCalls = content.parts?.filter((part: any) => part.functionCall);

  if (functionCalls && functionCalls.length > 0) {
    const toolCalls: GeminiToolCall[] = functionCalls.map((fc: any) => ({
      name: fc.functionCall.name,
      args: fc.functionCall.args || {}
    }));
    return { reply: '', toolCalls };
  }

  // Extract text response
  const textPart = content.parts?.find((part: any) => part.text);
  return { reply: textPart?.text || '' };
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

  // Detect list requests
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
