/**
 * Operator Command Types - VTID-0525
 *
 * Schema definitions for natural language → structured command flow.
 * The Operator Console Chat parses NL messages into these commands,
 * then executes them via the deploy orchestrator or task system.
 */

import { z } from 'zod';

// ==================== Operator Command Schema ====================

/**
 * Supported command actions.
 * 'deploy' - Deploy a service via the safe deploy orchestrator
 * 'task' - Create a task for non-deploy operations (diagnostics, queries, etc.)
 */
export const CommandActionSchema = z.enum(['deploy', 'task']);
export type CommandAction = z.infer<typeof CommandActionSchema>;

/**
 * Allowed services for operator commands.
 */
export const ALLOWED_COMMAND_SERVICES = ['gateway', 'oasis-operator', 'oasis-projector'] as const;
export const CommandServiceSchema = z.enum(ALLOWED_COMMAND_SERVICES);
export type CommandService = z.infer<typeof CommandServiceSchema>;

/**
 * Allowed environments for operator commands.
 */
export const CommandEnvironmentSchema = z.enum(['dev']);
export type CommandEnvironment = z.infer<typeof CommandEnvironmentSchema>;

/**
 * The structured command schema for deploy actions.
 */
export const DeployCommandSchema = z.object({
  action: z.literal('deploy'),
  service: CommandServiceSchema,
  environment: CommandEnvironmentSchema.default('dev'),
  branch: z.string().default('main'),
  vtid: z.string().min(1, 'VTID is required'),
  dry_run: z.boolean().default(false),
});

export type DeployCommand = z.infer<typeof DeployCommandSchema>;

/**
 * The structured command schema for task actions.
 */
export const TaskCommandSchema = z.object({
  action: z.literal('task'),
  task_type: z.string().min(1, 'Task type is required'),
  title: z.string().min(1, 'Title is required'),
  vtid: z.string().min(1, 'VTID is required'),
  metadata: z.record(z.any()).optional(),
});

export type TaskCommand = z.infer<typeof TaskCommandSchema>;

/**
 * Union type for all operator commands.
 */
export type OperatorCommand = DeployCommand | TaskCommand;

// ==================== API Request/Response Schemas ====================

/**
 * Request body for POST /api/v1/operator/command
 * VTID is optional - if not provided, one will be created automatically.
 */
export const OperatorCommandRequestSchema = z.object({
  message: z.string().min(1, 'Message is required'),
  vtid: z.string().optional(), // Optional - will be auto-created if missing
  environment: CommandEnvironmentSchema.default('dev'),
  default_branch: z.string().default('main'),
});

export type OperatorCommandRequest = z.infer<typeof OperatorCommandRequestSchema>;

/**
 * Response for POST /api/v1/operator/command
 * VTID-01018: Added operator_action_id for OASIS event trail tracking
 */
export interface OperatorCommandResponse {
  ok: boolean;
  vtid: string;
  reply: string; // Operator message explaining what happened
  command?: OperatorCommand;
  task_id?: string; // For task commands
  workflow_url?: string; // For deploy commands
  error?: string;
  details?: Record<string, unknown>;
  /** VTID-01018: Unique ID for this action's OASIS event trail */
  operator_action_id?: string;
}

// ==================== Operator Deploy Request ====================

/**
 * Request body for POST /api/v1/operator/deploy
 * This is the orchestrator that chains PR, merge, and deploy.
 */
export const OperatorDeployRequestSchema = z.object({
  vtid: z.string().min(1, 'VTID is required'),
  service: CommandServiceSchema,
  environment: CommandEnvironmentSchema.default('dev'),
  branch: z.string().default('main'),
  source: z.enum(['operator.console.chat', 'publish.modal', 'api']).default('api'),
});

export type OperatorDeployRequest = z.infer<typeof OperatorDeployRequestSchema>;

/**
 * Response for POST /api/v1/operator/deploy
 * VTID-01018: Added operator_action_id for OASIS event trail tracking
 */
export interface OperatorDeployResponse {
  ok: boolean;
  vtid: string;
  service: string;
  environment: string;
  workflow_run_id?: number;
  workflow_url?: string;
  error?: string;
  /** VTID-01018: Unique ID for this action's OASIS event trail */
  operator_action_id?: string;
}

// ==================== Gemini Command Parsing ====================

/**
 * Raw command structure from Gemini before validation.
 */
export interface GeminiParsedCommand {
  action?: 'deploy' | 'task';
  // For deploy commands
  service?: string;
  environment?: string;
  branch?: string;
  dry_run?: boolean;
  // For task commands
  task_type?: string;
  title?: string;
  // Common
  confidence?: number;
  error?: string;
}

/**
 * The prompt template for Gemini to parse commands.
 */
export const COMMAND_PARSE_PROMPT = `You are a DevOps command parser for the Vitana platform.
Parse the user's natural language message into a structured command.

COMMAND TYPES:
1. DEPLOY commands - Deploy a service to an environment
   ALLOWED SERVICES: gateway, oasis-operator, oasis-projector
   ALLOWED ENVIRONMENTS: dev (only dev is allowed)

2. TASK commands - Non-deploy operations like diagnostics, queries, tests
   Examples: show errors, run tests, check status, fetch logs

RESPONSE FORMAT (JSON only):

For DEPLOY commands:
{"action": "deploy", "service": "gateway", "environment": "dev", "branch": "main", "confidence": 0.95}

For TASK commands:
{"action": "task", "task_type": "operator.diagnostics.latest-errors", "title": "Show latest errors", "confidence": 0.9}

If the message is unclear or cannot be parsed:
{"error": "Could not understand command"}

EXAMPLES:
"Deploy gateway to dev" → {"action": "deploy", "service": "gateway", "environment": "dev", "branch": "main", "confidence": 0.95}
"Deploy oasis-operator" → {"action": "deploy", "service": "oasis-operator", "environment": "dev", "branch": "main", "confidence": 0.9}
"Show latest errors" → {"action": "task", "task_type": "operator.diagnostics.latest-errors", "title": "Show latest errors", "confidence": 0.9}
"Run tests for VTID-0517" → {"action": "task", "task_type": "operator.tests.run", "title": "Run tests for VTID-0517", "confidence": 0.85}
"What's the system status?" → {"action": "task", "task_type": "operator.diagnostics.status", "title": "Check system status", "confidence": 0.9}
"Hello" → {"error": "Could not understand command"}

USER MESSAGE: `;
