/**
 * VTID-0536: Gemini Operator Tools Bridge v1
 *
 * Provides Gemini function-calling tools for the Operator Chat.
 * Tools can trigger Autopilot and OASIS actions, governed by the 0400 Governance Engine.
 *
 * Tools:
 * - autopilot.create_task: Create a new Autopilot task (with governance)
 * - autopilot.get_status: Get status of an existing task
 * - autopilot.list_recent_tasks: List recent Autopilot tasks
 */

import fetch from 'node-fetch';
import { randomUUID } from 'crypto';
import {
  createOperatorTask,
  getAutopilotTaskStatus,
  getPendingPlanTasks,
  ingestOperatorEvent,
  CreatedTask,
  TaskStatusResponse
} from './operator-service';
import { emitOasisEvent } from './oasis-event-service';

// Environment config
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

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
  const vtidRegex = /^(VTID-\d{4}(-[A-Za-z0-9]+)?|[A-Z]+-[A-Z0-9]+-\d{4}-\d{4})$/;
  if (!vtidRegex.test(args.vtid)) {
    return {
      ok: false,
      error: `Invalid VTID format: ${args.vtid}. Expected format like VTID-0533 or DEV-COMHU-2024-0001`
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
 * Process a message with Gemini, including function calling
 */
export async function processWithGemini(input: {
  text: string;
  threadId: string;
  attachments?: Array<{ oasis_ref: string; kind: string }>;
  context?: Record<string, unknown>;
}): Promise<GeminiOperatorResponse> {
  const { text, threadId, attachments = [], context = {} } = input;

  console.log(`[VTID-0536] Processing message with Gemini: "${text.substring(0, 50)}..."`);

  // Check if Gemini API key is configured
  if (!GOOGLE_GEMINI_API_KEY) {
    console.warn('[VTID-0536] GOOGLE_GEMINI_API_KEY not configured, using local routing');
    return processLocalRouting(text, threadId);
  }

  try {
    // Call Gemini API with function calling
    const geminiResponse = await callGeminiWithTools(text, threadId);

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
          model: 'gemini-pro',
          tool_calls: geminiResponse.toolCalls.length,
          vtid: 'VTID-0536'
        }
      };
    }

    // No tool calls, return Gemini's direct response
    return {
      reply: geminiResponse.reply,
      meta: {
        model: 'gemini-pro',
        tool_calls: 0,
        vtid: 'VTID-0536'
      }
    };
  } catch (error: any) {
    console.error(`[VTID-0536] Gemini processing error:`, error);
    // Fallback to local routing on error
    return processLocalRouting(text, threadId);
  }
}

/**
 * Call Gemini API with tool definitions
 */
async function callGeminiWithTools(text: string, threadId: string): Promise<{
  reply: string;
  toolCalls?: GeminiToolCall[];
}> {
  if (!GOOGLE_GEMINI_API_KEY) {
    throw new Error('GOOGLE_GEMINI_API_KEY not configured');
  }

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [{ text }]
      }
    ],
    tools: [GEMINI_TOOL_DEFINITIONS],
    systemInstruction: {
      parts: [{
        text: `You are the Vitana Operator Assistant, helping operators manage the Autopilot system.

When operators want to:
- Create a new task: Use the autopilot_create_task function
- Check task status: Use the autopilot_get_status function
- See recent tasks: Use the autopilot_list_recent_tasks function

Be helpful and concise. When calling tools, explain what you're doing.
If a task is blocked by governance, explain the reason clearly.

Current thread: ${threadId}`
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
 * Uses keyword matching to determine tool calls
 */
async function processLocalRouting(text: string, threadId: string): Promise<GeminiOperatorResponse> {
  const lowerText = text.toLowerCase();
  const toolResults: GeminiToolResult[] = [];

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
  else if (
    lowerText.includes('status') ||
    lowerText.match(/what.*vtid/i) ||
    lowerText.match(/vtid-\d{4}/i)
  ) {
    // Extract VTID
    const vtidMatch = text.match(/VTID-\d{4}/i);
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
        meta: { model: 'local-router', vtid: 'VTID-0536' }
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

  // No tool matched - return helpful message
  if (toolResults.length === 0) {
    return {
      reply: `I can help you with Autopilot tasks. Try:
- "Create a task to fix the health check endpoint"
- "What is the status of VTID-0533?"
- "Show recent tasks"

What would you like to do?`,
      meta: { model: 'local-router', vtid: 'VTID-0536' }
    };
  }

  // Format tool results
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

  return {
    reply: reply.trim() || 'Operation completed.',
    toolResults,
    meta: {
      model: 'local-router',
      tool_calls: toolResults.length,
      vtid: 'VTID-0536'
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
