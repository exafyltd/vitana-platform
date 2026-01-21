/**
 * VTID-01200: Worker Runner Execution Plane - Type Definitions
 *
 * Type definitions for the worker-runner service.
 */

/**
 * Task domain types
 */
export type TaskDomain = 'frontend' | 'backend' | 'memory' | 'mixed';

/**
 * Worker subagent identifiers
 */
export type WorkerSubagent = 'worker-frontend' | 'worker-backend' | 'worker-memory';

/**
 * Terminal outcome for VTID completion
 */
export type TerminalOutcome = 'success' | 'failed' | 'cancelled';

/**
 * Runner state
 */
export type RunnerState = 'idle' | 'polling' | 'claiming' | 'executing' | 'completing' | 'terminalizing';

/**
 * Pending task from orchestrator
 */
export interface PendingTask {
  vtid: string;
  title: string;
  status: string;
  spec_status: string;
  spec_content?: string;
  task_domain?: TaskDomain;
  created_at: string;
  updated_at: string;
  is_terminal: boolean;
  claimed_by?: string | null;
  claim_expires_at?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Claim result from orchestrator
 */
export interface ClaimResult {
  ok: boolean;
  claimed: boolean;
  expires_at?: string;
  error?: string;
}

/**
 * Routing result from orchestrator
 */
export interface RoutingResult {
  ok: boolean;
  dispatched_to?: WorkerSubagent;
  run_id?: string;
  stages?: Array<{ domain: TaskDomain; order: number }>;
  error?: string;
  error_code?: string;
  identity: {
    repo: string;
    project: string;
    region: string;
    environment: string;
    tenant: string;
  };
  governance?: {
    proceed: boolean;
    summary: { passed: number; total: number };
    evaluations: Array<{
      skill: string;
      passed: boolean;
      message: string;
    }>;
  };
}

/**
 * Execution result from LLM
 */
export interface ExecutionResult {
  ok: boolean;
  files_changed?: string[];
  files_created?: string[];
  summary?: string;
  error?: string;
  violations?: string[];
  duration_ms?: number;
  model?: string;
  provider?: string;
}

/**
 * Completion result from orchestrator
 */
export interface CompletionResult {
  ok: boolean;
  verified?: boolean;
  should_retry?: boolean;
  reason?: string;
  event?: string;
}

/**
 * Terminalization result
 */
export interface TerminalizationResult {
  ok: boolean;
  already_terminal?: boolean;
  status?: string;
  is_terminal?: boolean;
  terminal_outcome?: TerminalOutcome;
  terminal_at?: string;
  event_id?: string;
  error?: string;
}

/**
 * OASIS event payload
 */
export interface OasisEventPayload {
  vtid: string;
  type: string;
  source: string;
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
  payload?: Record<string, unknown>;
}

/**
 * Worker runner configuration
 */
export interface RunnerConfig {
  workerId: string;
  gatewayUrl: string;
  supabaseUrl: string;
  supabaseKey: string;
  pollIntervalMs: number;
  autopilotEnabled: boolean;
  maxConcurrent: number;
  vertexProject?: string;
  vertexLocation?: string;
  vertexModel?: string;
}

/**
 * Runner metrics
 */
export interface RunnerMetrics {
  registered_at: string;
  last_heartbeat_at: string;
  last_poll_at?: string;
  tasks_polled: number;
  tasks_claimed: number;
  tasks_completed: number;
  tasks_failed: number;
  active_vtid?: string;
  state: RunnerState;
}
