/**
 * Self-Healing System Types
 * Type definitions for the autonomous self-healing pipeline.
 */

// ==================== Health Report (from collect-status.py) ====================

export interface HealthReport {
  timestamp: string;
  total: number;
  live: number;
  services: ServiceStatus[];
}

export interface ServiceStatus {
  name: string;
  endpoint: string;
  status: 'live' | 'down' | 'timeout';
  http_status: number | null;
  response_body: string;
  response_time_ms: number;
  error_message: string | null;
}

// ==================== Failure Classification ====================

export enum FailureClass {
  ROUTE_NOT_REGISTERED = 'route_not_registered',
  HANDLER_CRASH = 'handler_crash',
  MISSING_ENV_VAR = 'missing_env_var',
  IMPORT_ERROR = 'import_error',
  DEPENDENCY_TIMEOUT = 'dependency_timeout',
  STALE_DEPLOYMENT = 'stale_deployment',
  REGRESSION = 'regression',
  DATABASE_SCHEMA_DRIFT = 'database_schema_drift',
  INTEGRATION_FAILURE = 'integration_failure',
  RESOURCE_EXHAUSTION = 'resource_exhaustion',
  MIDDLEWARE_REJECTION = 'middleware_rejection',
  UNKNOWN = 'unknown',
  EXTERNAL_DEPENDENCY = 'external_dependency',
  DATA_CORRUPTION = 'data_corruption',
}

// ==================== Diagnosis ====================

export interface CommitInfo {
  sha: string;
  message: string;
  date: string;
  author: string;
  diff_summary?: string;
}

export interface CodebaseAnalysis {
  route_file: string | null;
  route_file_exists: boolean;
  /** Held in memory during a single diagnosis run for regex checks; STRIPPED
   * by redactDiagnosisForPersistence() before any write to self_healing_log
   * or vtid_ledger.metadata. Use route_file_excerpt for durable storage. */
  route_file_content: string | null;
  /** Where the source was read from. 'fs' = local container filesystem;
   * 'github_deployed_sha' = GitHub Contents API at the SHA the running
   * revision was built from (read from BUILD_INFO); 'github_main' =
   * last-resort fallback against ref=main. */
  route_file_source?: 'fs' | 'github_deployed_sha' | 'github_main';
  /** SHA of the resolved file content (when fetched via GitHub) or null
   * for filesystem reads. Lets us detect drift between diagnosis time and
   * any subsequent fix attempt. */
  route_file_sha?: string | null;
  /** Short ≤500-char excerpt around the matched health handler, safe for
   * persistence. Populated alongside route_file_content. */
  route_file_excerpt?: string | null;
  health_handler_exists: boolean;
  handler_has_errors: boolean;
  error_description: string | null;
  router_export_name: string | null;
  imports: string[];
  env_vars_used: string[];
  supabase_tables_used: string[];
  related_service_files: string[];
  files_read: string[];
  evidence: string[];
}

export interface GitAnalysis {
  latest_commit: string | null;
  last_modified: string | null;
  recent_commits: CommitInfo[];
  breaking_commit: CommitInfo | null;
  code_exists_but_not_deployed: boolean;
  deployed_sha: string | null;
  evidence: string[];
}

export interface DependencyAnalysis {
  missing_import: string | null;
  missing_env_vars: string[];
  missing_db_table: string | null;
  evidence: string[];
}

export interface WorkflowAnalysis {
  route_mounted_in_index: boolean;
  mount_path: string | null;
  middleware_chain: string[];
  middleware_blocking: boolean;
  blocking_middleware: string | null;
  auth_required: boolean;
  health_exempt_from_auth: boolean;
  evidence: string[];
}

export interface Diagnosis {
  service_name: string;
  endpoint: string;
  vtid: string;
  failure_class: FailureClass;
  confidence: number;
  root_cause: string;
  suggested_fix: string;
  auto_fixable: boolean;
  evidence: string[];
  codebase_analysis: CodebaseAnalysis | null;
  git_analysis: GitAnalysis | null;
  dependency_analysis: DependencyAnalysis | null;
  workflow_analysis: WorkflowAnalysis | null;
  files_to_modify: string[];
  files_read: string[];
}

// ==================== Health Snapshots ====================

export interface EndpointState {
  endpoint: string;
  status: 'healthy' | 'down' | 'timeout';
  http_status: number | null;
  response_time_ms: number;
}

export interface HealthSnapshot {
  id: string;
  vtid: string;
  phase: 'pre_fix' | 'post_fix';
  timestamp: string;
  total: number;
  healthy: number;
  endpoints: EndpointState[];
  git_sha: string | null;
  cloud_run_revision: string | null;
}

// ==================== Verification ====================

export interface VerificationResult {
  vtid: string;
  target_endpoint_fixed: boolean;
  blast_radius: 'none' | 'contained' | 'critical';
  newly_broken: string[];
  newly_fixed: string[];
  net_health_delta: number;
  action: 'keep' | 'rollback' | 'escalate' | 'none';
  pre_fix_snapshot_id: string;
  post_fix_snapshot_id: string;
}

// ==================== Autonomy Levels ====================

export enum AutonomyLevel {
  OBSERVE_ONLY = 0,
  DIAGNOSE_ONLY = 1,
  SPEC_AND_WAIT = 2,
  AUTO_FIX_SIMPLE = 3,
  FULL_AUTO = 4,
}

// ==================== Self-Healing Report Response ====================

export interface SelfHealingReportResponse {
  ok: boolean;
  processed: number;
  vtids_created: number;
  skipped: number;
  /** Count of failures that the pre-probe found already healthy at report
   * time — no VTID allocated, no self_healing_log row written. */
  recovered_externally?: number;
  details: Array<{
    service: string;
    endpoint: string;
    action: 'created' | 'skipped' | 'escalated' | 'disabled' | 'recovered_externally';
    vtid?: string;
    reason?: string;
  }>;
}

// ==================== Endpoint-to-File Map ====================

export const ENDPOINT_FILE_MAP: Record<string, string> = {
  '/health': 'services/gateway/src/index.ts',
  '/alive': 'services/gateway/src/index.ts',
  '/api/v1/auth/health': 'services/gateway/src/routes/auth.ts',
  '/api/v1/cicd/health': 'services/gateway/src/routes/cicd.ts',
  '/api/v1/execute/health': 'services/gateway/src/routes/execute.ts',
  '/api/v1/operator/health': 'services/gateway/src/routes/operator.ts',
  '/api/v1/operator/deployments/health': 'services/gateway/src/routes/operator.ts',
  '/api/v1/telemetry/health': 'services/gateway/src/routes/telemetry.ts',
  '/events/health': 'services/gateway/src/routes/events.ts',
  '/command-hub/health': 'services/gateway/src/routes/command-hub.ts',
  '/api/v1/assistant/health': 'services/gateway/src/routes/assistant.ts',
  '/api/v1/assistant/knowledge/health': 'services/gateway/src/routes/assistant.ts',
  '/api/v1/orb/health': 'services/gateway/src/routes/orb-live.ts',
  // PR-A (VTID-02922): operator-armed canary for end-to-end self-healing
  // smoke tests. Endpoint returns 500 iff system_config.self_healing_canary_armed=true.
  '/api/v1/self-healing/canary/failing-health': 'services/gateway/src/routes/self-healing-canary.ts',
  '/api/v1/voice-lab/health': 'services/gateway/src/routes/voice-lab.ts',
  '/api/v1/conversation/health': 'services/gateway/src/routes/conversation.ts',
  '/api/v1/conversation/tool-health': 'services/gateway/src/routes/conversation.ts',
  '/api/v1/autopilot/health': 'services/gateway/src/routes/autopilot.ts',
  '/api/v1/autopilot/pipeline/health': 'services/gateway/src/routes/autopilot.ts',
  '/api/v1/autopilot/prompts/health': 'services/gateway/src/routes/autopilot-prompts.ts',
  '/api/v1/autopilot/recommendations/health': 'services/gateway/src/routes/autopilot-recommendations.ts',
  '/api/v1/automations/health': 'services/gateway/src/routes/automations.ts',
  '/api/v1/recommendations/health': 'services/gateway/src/routes/recommendation-inbox.ts',
  '/api/v1/memory/health': 'services/gateway/src/routes/memory.ts',
  '/api/v1/memory/semantic/health': 'services/gateway/src/routes/semantic-memory.ts',
  '/api/v1/diary/health': 'services/gateway/src/routes/diary.ts',
  '/api/v1/capacity/health': 'services/gateway/src/routes/health-capacity.ts',
  '/api/v1/scheduler/health': 'services/gateway/src/routes/scheduler.ts',
  '/api/v1/scheduled-notifications/health': 'services/gateway/src/routes/scheduled-notifications.ts',
  '/api/v1/intake/email/health': 'services/gateway/src/routes/email-intake.ts',
  '/api/v1/community/health': 'services/gateway/src/routes/community.ts',
  '/api/v1/relationships/health': 'services/gateway/src/routes/relationships.ts',
  '/api/v1/match/health': 'services/gateway/src/routes/matchmaking.ts',
  '/api/v1/personalization/health': 'services/gateway/src/routes/personalization.ts',
  '/api/v1/live/health': 'services/gateway/src/routes/live.ts',
  '/api/v1/social/health': 'services/gateway/src/routes/social-context.ts',
  '/api/v1/social-accounts/health': 'services/gateway/src/routes/social-connect.ts',
  '/api/v1/alignment/health': 'services/gateway/src/routes/social-alignment.ts',
  '/api/v1/topics/health': 'services/gateway/src/routes/topics.ts',
  '/api/v1/routing/health': 'services/gateway/src/routes/domain-routing.ts',
  '/api/v1/locations/health': 'services/gateway/src/routes/locations.ts',
  '/api/v1/offers/health': 'services/gateway/src/routes/offers.ts',
  '/api/v1/feedback/health': 'services/gateway/src/routes/feedback-correction.ts',
  '/api/v1/voice-feedback/health': 'services/gateway/src/routes/voice-feedback.ts',
  '/api/v1/situational/health': 'services/gateway/src/routes/situational-awareness.ts',
  '/api/v1/availability/health': 'services/gateway/src/routes/availability-readiness.ts',
  '/api/v1/context/mobility/health': 'services/gateway/src/routes/environmental-mobility-context.ts',
  '/api/v1/user-preferences/health': 'services/gateway/src/routes/user-preferences.ts',
  '/api/v1/taste-alignment/health': 'services/gateway/src/routes/taste-alignment.ts',
  '/api/v1/overload/health': 'services/gateway/src/routes/overload-detection.ts',
  '/api/v1/mitigation/health': 'services/gateway/src/routes/risk-mitigation.ts',
  '/api/v1/opportunities/health': 'services/gateway/src/routes/opportunity-surfacing.ts',
  '/api/v1/visual/health': 'services/gateway/src/routes/visual-interactive.ts',
  '/api/v1/oasis/vtid/terminalize/health': 'services/gateway/src/routes/vtid-terminalize.ts',
  '/api/v1/vtid/health': 'services/gateway/src/routes/vtid.ts',
};

// Map service display names to vtid_ledger module values
export const SERVICE_MODULE_MAP: Record<string, string> = {
  'Gateway': 'GATEWAY',
  'Auth': 'GATEWAY',
  'CI/CD': 'OASIS',
  'Execute Runner': 'OASIS',
  'Operator': 'OASIS',
  'Command Hub UI': 'COMHU',
  'Assistant': 'AGENTS',
  'ORB Live': 'AGENTS',
  'Voice Lab': 'AGENTS',
  'Autopilot': 'COMHU',
  'Memory': 'GATEWAY',
  'Health Capacity': 'GATEWAY',
  'Visual Interactive': 'GATEWAY',
};
