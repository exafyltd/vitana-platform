/**
 * VTID-01208: LLM Telemetry Types
 *
 * Type definitions for LLM telemetry events and routing policy.
 */

import { LLMStage, LLMProvider, LLMRoutingPolicy, StageRoutingConfig } from '../constants/llm-defaults';

// Re-export for convenience
export { LLMStage, LLMProvider, LLMRoutingPolicy, StageRoutingConfig };

/**
 * Worker domain types (for Worker stage routing)
 */
export type WorkerDomain = 'frontend' | 'backend' | 'memory' | 'mixed';

/**
 * LLM Telemetry event payload
 * Emitted for every LLM call (started/completed/failed)
 */
export interface LLMTelemetryPayload {
  // Task identification
  vtid: string | null;
  thread_id?: string;                // For Operator free chat when VTID absent

  // Service identification
  service: string;                   // gateway | orchestrator | worker-runner | validator-core | memory-indexer
  stage: LLMStage;
  domain?: WorkerDomain;             // For Worker stage routing

  // Model identification
  provider: LLMProvider | string;
  model: string;

  // Fallback tracking
  fallback_used: boolean;
  fallback_from?: string;            // Original model if fallback was used
  fallback_to?: string;              // Fallback model used
  retry_count?: number;              // Current retry attempt (0-based)

  // Request tracking
  request_id?: string;               // Provider request ID if available
  trace_id: string;                  // Internal trace ID for correlation

  // Performance metrics
  latency_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_estimate_usd?: number;

  // Audit/reproducibility
  agent_config_version?: string;     // Hash of agent YAML / policy
  prompt_hash: string;               // SHA256 hash of prompt (no raw prompts stored)

  // Error information (for failed events)
  error_code?: string;
  error_message?: string;

  // Timestamp
  created_at: string;
}

/**
 * LLM Call Event types
 */
export type LLMCallEventType = 'llm.call.started' | 'llm.call.completed' | 'llm.call.failed';

/**
 * LLM Call Event (full OASIS event structure)
 */
export interface LLMCallEvent {
  vtid: string | null;
  type: LLMCallEventType;
  source: string;
  status: 'info' | 'success' | 'error';
  message: string;
  payload: LLMTelemetryPayload;
}

/**
 * LLM Routing Policy from database
 */
export interface LLMRoutingPolicyRecord {
  id: string;
  environment: string;
  version: number;
  is_active: boolean;
  policy: LLMRoutingPolicy;
  created_by: string;
  created_at: string;
  activated_at: string | null;
  deactivated_at: string | null;
}

/**
 * Allowed provider from database
 */
export interface AllowedProvider {
  provider_key: string;
  display_name: string;
  is_active: boolean;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Allowed model from database
 */
export interface AllowedModel {
  id: string;
  provider_key: string;
  model_id: string;
  display_name: string;
  is_active: boolean;
  is_recommended: boolean;
  applicable_stages: LLMStage[];
  cost_per_1m_input: number | null;
  cost_per_1m_output: number | null;
  max_context_tokens: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Policy audit record
 */
export interface PolicyAuditRecord {
  id: string;
  policy_id: string | null;
  action: 'created' | 'activated' | 'deactivated' | 'updated';
  actor_id: string;
  actor_role: string;
  before_state: LLMRoutingPolicy | null;
  after_state: LLMRoutingPolicy | null;
  reason: string | null;
  created_at: string;
}

/**
 * VTID policy snapshot (for in-flight policy locking)
 */
export interface VTIDPolicySnapshot {
  id: string;
  vtid: string;
  policy_version: number;
  policy_snapshot: LLMRoutingPolicy;
  environment: string;
  created_at: string;
}

/**
 * Request to update LLM routing policy
 */
export interface UpdatePolicyRequest {
  policy: LLMRoutingPolicy;
  reason?: string;
  actor_id: string;
  actor_role: string;
}

/**
 * Response from routing policy API
 */
export interface RoutingPolicyResponse {
  ok: boolean;
  policy?: LLMRoutingPolicyRecord;
  providers?: AllowedProvider[];
  models?: AllowedModel[];
  recommended?: LLMRoutingPolicy;
  error?: string;
}

/**
 * Telemetry query parameters
 */
export interface TelemetryQueryParams {
  vtid?: string;
  stage?: LLMStage;
  provider?: LLMProvider | string;
  model?: string;
  service?: string;
  status?: 'success' | 'error';
  limit?: number;
  offset?: number;
  since?: string;           // ISO timestamp
  until?: string;           // ISO timestamp
}

/**
 * Telemetry query response
 */
export interface TelemetryQueryResponse {
  ok: boolean;
  events: LLMTelemetryPayload[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    has_more: boolean;
  };
  error?: string;
}

/**
 * LLM Telemetry event type constants
 */
export const LLM_TELEMETRY_EVENT_TYPES = [
  'llm.call.started',
  'llm.call.completed',
  'llm.call.failed',
] as const;

/**
 * LLM Policy event type constants
 */
export const LLM_POLICY_EVENT_TYPES = [
  'governance.llm_policy.updated',
  'governance.llm_policy.activated',
  'governance.llm_policy.reset',
] as const;
