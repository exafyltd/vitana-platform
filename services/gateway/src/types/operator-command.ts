/**
 * Operator Command Types - VTID-0525
 *
 * Schema definitions for natural language → structured command flow.
 * The Operator Console Chat parses NL messages into these commands,
 * then executes them via the deploy orchestrator.
 */

import { z } from 'zod';

// ==================== Operator Command Schema ====================

/**
 * Supported command actions.
 * Currently only 'deploy' is implemented. Future: 'inspect', 'rollback', etc.
 */
export const CommandActionSchema = z.enum(['deploy']);
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
 * The structured command schema parsed from natural language.
 */
export const OperatorCommandSchema = z.object({
  action: CommandActionSchema,
  service: CommandServiceSchema,
  environment: CommandEnvironmentSchema.default('dev'),
  branch: z.string().default('main'),
  vtid: z.string().min(1, 'VTID is required'),
  dry_run: z.boolean().default(false),
});

export type OperatorCommand = z.infer<typeof OperatorCommandSchema>;

// ==================== API Request/Response Schemas ====================

/**
 * Request body for POST /api/v1/operator/command
 */
export const OperatorCommandRequestSchema = z.object({
  message: z.string().min(1, 'Message is required'),
  vtid: z.string().min(1, 'VTID is required'),
  environment: CommandEnvironmentSchema.default('dev'),
  default_branch: z.string().default('main'),
});

export type OperatorCommandRequest = z.infer<typeof OperatorCommandRequestSchema>;

/**
 * Response for POST /api/v1/operator/command
 */
export interface OperatorCommandResponse {
  ok: boolean;
  vtid: string;
  command?: OperatorCommand;
  orchestrator_result?: OrchestratorResult;
  error?: string;
  details?: Record<string, unknown>;
}

/**
 * Result from the deploy orchestrator.
 */
export interface OrchestratorResult {
  ok: boolean;
  steps: OrchestratorStep[];
  error?: string;
}

export interface OrchestratorStep {
  step: 'create_pr' | 'safe_merge' | 'deploy_service';
  status: 'success' | 'skipped' | 'failed' | 'pending';
  details?: Record<string, unknown>;
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
});

export type OperatorDeployRequest = z.infer<typeof OperatorDeployRequestSchema>;

/**
 * Response for POST /api/v1/operator/deploy
 */
export interface OperatorDeployResponse {
  ok: boolean;
  vtid: string;
  steps: OrchestratorStep[];
  error?: string;
  details?: Record<string, unknown>;
}

// ==================== Gemini Command Parsing ====================

/**
 * Raw command structure from Gemini before validation.
 */
export interface GeminiParsedCommand {
  action?: string;
  service?: string;
  environment?: string;
  branch?: string;
  dry_run?: boolean;
  confidence?: number;
  error?: string;
}

/**
 * The prompt template for Gemini to parse commands.
 */
export const COMMAND_PARSE_PROMPT = `You are a DevOps command parser for the Vitana platform.
Parse the user's natural language message into a structured deploy command.

ALLOWED SERVICES: gateway, oasis-operator, oasis-projector
ALLOWED ENVIRONMENTS: dev (only dev is allowed)
ALLOWED ACTIONS: deploy

If the message is not a deploy command, respond with: {"error": "Not a deploy command"}
If you cannot determine the service, respond with: {"error": "Could not determine service"}

EXAMPLES:
"Deploy gateway to dev" → {"action": "deploy", "service": "gateway", "environment": "dev", "branch": "main", "confidence": 0.95}
"Deploy oasis-operator using feature-branch" → {"action": "deploy", "service": "oasis-operator", "environment": "dev", "branch": "feature-branch", "confidence": 0.9}
"Deploy latest gateway to dev from main branch" → {"action": "deploy", "service": "gateway", "environment": "dev", "branch": "main", "confidence": 0.98}
"What's the weather?" → {"error": "Not a deploy command"}
"Deploy something" → {"error": "Could not determine service"}

USER MESSAGE: `;
