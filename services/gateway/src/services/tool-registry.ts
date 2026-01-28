/**
 * VTID-01216: Tool Registry + Health (D4)
 *
 * Single registry for all tools available to both ORB and Operator Console.
 * Provides:
 * - Tool definitions with schemas
 * - Role-based allowlists
 * - Availability and latency tracking
 * - Health checks
 *
 * No arbitrary code execution allowed.
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { ToolDefinition, ToolHealthStatus, ToolHealthResponse, ToolRegistryResponse } from '../types/conversation';

// =============================================================================
// Tool Definitions
// =============================================================================

/**
 * All registered tools for the unified conversation layer
 */
const TOOL_REGISTRY: Map<string, ToolDefinition> = new Map([
  // ===== Autopilot Tools =====
  [
    'autopilot_create_task',
    {
      name: 'autopilot_create_task',
      description: 'Create a new Autopilot task in the Vitana system. This will create a VTID, register the task, and trigger planning.',
      parameters_schema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'A detailed description of the task to be created.',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical'],
            description: 'Priority level for the task. Defaults to medium.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags to categorize the task.',
          },
        },
        required: ['description'],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'system'],
      enabled: true,
      category: 'autopilot',
      vtid: 'VTID-0536',
    },
  ],
  [
    'autopilot_get_status',
    {
      name: 'autopilot_get_status',
      description: 'Get the current status of an existing Autopilot task by its VTID.',
      parameters_schema: {
        type: 'object',
        properties: {
          vtid: {
            type: 'string',
            description: 'The VTID of the task to check. Format: VTID-XXXX.',
          },
        },
        required: ['vtid'],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'user', 'system'],
      enabled: true,
      category: 'autopilot',
      vtid: 'VTID-0536',
    },
  ],
  [
    'autopilot_list_recent_tasks',
    {
      name: 'autopilot_list_recent_tasks',
      description: 'List recent Autopilot tasks with optional filtering.',
      parameters_schema: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: 'Maximum number of tasks to return. Defaults to 10.',
          },
          status: {
            type: 'string',
            enum: ['pending', 'scheduled', 'planned', 'in-progress', 'completed', 'validated', 'failed', 'cancelled'],
            description: 'Filter tasks by status.',
          },
        },
        required: [],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'user', 'system'],
      enabled: true,
      category: 'autopilot',
      vtid: 'VTID-0536',
    },
  ],

  // ===== Knowledge Tools =====
  [
    'knowledge_search',
    {
      name: 'knowledge_search',
      description: 'Search the Vitana documentation and knowledge base to answer questions about Vitana concepts, architecture, features, and specifications.',
      parameters_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query or question about Vitana documentation.',
          },
        },
        required: ['query'],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'user', 'system'],
      enabled: true,
      category: 'knowledge',
      vtid: 'VTID-0538',
    },
  ],

  // ===== Memory Tools =====
  [
    'memory_write',
    {
      name: 'memory_write',
      description: 'Write a new memory item to the Memory Garden for the current user.',
      parameters_schema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The content to remember.',
          },
          category_key: {
            type: 'string',
            enum: ['conversation', 'health', 'relationships', 'community', 'preferences', 'goals', 'tasks', 'products_services', 'events_meetups', 'notes', 'personal'],
            description: 'Category for the memory item.',
          },
          importance: {
            type: 'integer',
            description: 'Importance score (1-100). Defaults to 10.',
          },
        },
        required: ['content'],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'user', 'system'],
      enabled: true,
      category: 'memory',
      vtid: 'VTID-01105',
    },
  ],
  [
    'memory_search',
    {
      name: 'memory_search',
      description: 'Search the Memory Garden for relevant memories.',
      parameters_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query for memories.',
          },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Categories to filter by.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results. Defaults to 10.',
          },
        },
        required: ['query'],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'user', 'system'],
      enabled: true,
      category: 'memory',
      vtid: 'VTID-01085',
    },
  ],

  // ===== System Tools =====
  [
    'discover_oasis_tasks',
    {
      name: 'discover_oasis_tasks',
      description: 'Query pending tasks from OASIS. OASIS is the only source of truth for task discovery.',
      parameters_schema: {
        type: 'object',
        properties: {
          status_filter: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by task status.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of tasks to return.',
          },
        },
        required: [],
      },
      allowed_roles: ['operator', 'admin', 'developer', 'system'],
      enabled: true,
      category: 'system',
      vtid: 'VTID-01159',
    },
  ],
]);

// =============================================================================
// Tool Health Tracking
// =============================================================================

interface ToolHealthRecord {
  name: string;
  available: boolean;
  last_checked: string;
  latency_ms?: number;
  error?: string;
  check_count: number;
  success_count: number;
}

const toolHealthRecords: Map<string, ToolHealthRecord> = new Map();

/**
 * Update health record for a tool
 */
export function updateToolHealth(
  toolName: string,
  available: boolean,
  latency_ms?: number,
  error?: string
): void {
  const existing = toolHealthRecords.get(toolName) || {
    name: toolName,
    available: true,
    last_checked: new Date().toISOString(),
    check_count: 0,
    success_count: 0,
  };

  toolHealthRecords.set(toolName, {
    ...existing,
    available,
    latency_ms,
    error,
    last_checked: new Date().toISOString(),
    check_count: existing.check_count + 1,
    success_count: existing.success_count + (available ? 1 : 0),
  });
}

// =============================================================================
// Registry API
// =============================================================================

/**
 * Get all registered tools
 */
export function getAllTools(): ToolDefinition[] {
  return Array.from(TOOL_REGISTRY.values());
}

/**
 * Get tools allowed for a specific role
 */
export function getToolsForRole(role: string): ToolDefinition[] {
  return Array.from(TOOL_REGISTRY.values()).filter(
    tool => tool.enabled && tool.allowed_roles.includes(role)
  );
}

/**
 * Get tool by name
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return TOOL_REGISTRY.get(name);
}

/**
 * Check if tool is available for role
 */
export function isToolAvailableForRole(toolName: string, role: string): boolean {
  const tool = TOOL_REGISTRY.get(toolName);
  if (!tool) return false;
  return tool.enabled && tool.allowed_roles.includes(role);
}

/**
 * Get tool health status for all tools
 */
export function getToolHealthStatus(): ToolHealthStatus[] {
  const now = new Date().toISOString();
  const statuses: ToolHealthStatus[] = [];

  for (const [name, tool] of TOOL_REGISTRY) {
    const healthRecord = toolHealthRecords.get(name);

    statuses.push({
      name,
      available: tool.enabled && (!healthRecord || healthRecord.available),
      latency_ms: healthRecord?.latency_ms,
      last_checked: healthRecord?.last_checked || now,
      error: !tool.enabled ? 'Tool is disabled' : healthRecord?.error,
    });
  }

  return statuses;
}

/**
 * Build tool registry response
 */
export function buildToolRegistryResponse(): ToolRegistryResponse {
  const tools = getAllTools();

  return {
    ok: true,
    tools,
    total_count: tools.length,
    enabled_count: tools.filter(t => t.enabled).length,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build tool health response
 */
export function buildToolHealthResponse(): ToolHealthResponse {
  const statuses = getToolHealthStatus();
  const healthyCount = statuses.filter(s => s.available).length;

  return {
    ok: true,
    tools: statuses,
    healthy_count: healthyCount,
    unhealthy_count: statuses.length - healthyCount,
    last_check: new Date().toISOString(),
  };
}

/**
 * Run health checks for all tools
 */
export async function runToolHealthChecks(): Promise<ToolHealthResponse> {
  const startTime = Date.now();

  // Check Supabase-dependent tools
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
  const supabaseAvailable = !!SUPABASE_URL && !!SUPABASE_SERVICE_ROLE;

  // Update health for Supabase-dependent tools
  const supabaseTools = ['autopilot_create_task', 'autopilot_get_status', 'autopilot_list_recent_tasks', 'knowledge_search', 'memory_write', 'memory_search', 'discover_oasis_tasks'];
  for (const toolName of supabaseTools) {
    updateToolHealth(
      toolName,
      supabaseAvailable,
      undefined,
      supabaseAvailable ? undefined : 'Supabase not configured'
    );
  }

  // Log health check
  await emitOasisEvent({
    vtid: 'VTID-01216',
    type: 'conversation.tool.health_check',
    source: 'tool-registry',
    status: 'info',
    message: `Tool health check completed: ${supabaseAvailable ? 'healthy' : 'degraded'}`,
    payload: {
      duration_ms: Date.now() - startTime,
      supabase_available: supabaseAvailable,
    },
  }).catch(() => {});

  return buildToolHealthResponse();
}

/**
 * Get Gemini-compatible tool definitions for function calling
 */
export function getGeminiToolDefinitions(role: string): {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
} {
  const tools = getToolsForRole(role);

  return {
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters_schema,
    })),
  };
}

/**
 * Log tool execution to OASIS
 */
export async function logToolExecution(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  success: boolean,
  duration_ms: number,
  context: {
    tenant_id: string;
    user_id: string;
    thread_id: string;
    channel: string;
  }
): Promise<void> {
  // Update health record
  updateToolHealth(toolName, success, duration_ms, success ? undefined : 'Execution failed');

  // Emit OASIS event
  await emitOasisEvent({
    vtid: 'VTID-01216',
    type: 'conversation.tool.called',
    source: `conversation-${context.channel}`,
    status: success ? 'success' : 'error',
    message: `Tool ${toolName} ${success ? 'executed successfully' : 'failed'}`,
    payload: {
      tool_name: toolName,
      args_preview: JSON.stringify(args).substring(0, 200),
      success,
      duration_ms,
      ...context,
    },
  }).catch(err => {
    console.warn(`[VTID-01216] Failed to log tool execution: ${err.message}`);
  });
}
