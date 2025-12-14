/**
 * CICD Types - VTID-0516 Autonomous Safe-Merge Layer
 * Type definitions for GitHub PR, Safe-Merge, and Deploy operations
 */

import { z } from 'zod';

// ==================== Create PR ====================
export const CreatePrRequestSchema = z.object({
  vtid: z.string().min(1, 'VTID is required'),
  branch: z.string().optional(), // Can be auto-generated if missing
  title: z.string().min(1, 'PR title is required'),
  body: z.string().min(1, 'PR body/description is required'),
  base: z.string().default('main'),
  head: z.string().min(1, 'Head branch is required'),
});

export type CreatePrRequest = z.infer<typeof CreatePrRequestSchema>;

export interface CreatePrResponse {
  ok: boolean;
  pr_number?: number;
  pr_url?: string;
  vtid: string;
  error?: string;
  details?: Record<string, unknown>;
}

// ==================== Safe Merge ====================
export const SafeMergeRequestSchema = z.object({
  vtid: z.string().min(1, 'VTID is required'),
  repo: z.string().default('exafyltd/vitana-platform'),
  pr_number: z.number().int().positive('PR number must be a positive integer'),
  require_checks: z.boolean().default(true),
  merge_strategy: z.enum(['squash', 'merge', 'rebase']).default('squash'),
});

export type SafeMergeRequest = z.infer<typeof SafeMergeRequestSchema>;

export interface SafeMergeResponse {
  ok: boolean;
  merged?: boolean;
  branch?: string;
  repo?: string;
  vtid: string;
  reason?: string;
  details?: {
    pr_state?: string;
    base?: string;
    head?: string;
    checks?: CheckStatus[];
    files_touched?: string[];
    services_impacted?: string[];
    governance_decision?: 'approved' | 'blocked';
  };
  next?: {
    can_auto_deploy: boolean;
    service: string;
    environment: string;
  };
}

export interface CheckStatus {
  name: string;
  status: 'success' | 'failure' | 'pending' | 'neutral' | 'skipped';
  conclusion?: string;
}

// ==================== Deploy Service ====================
export const DeployServiceRequestSchema = z.object({
  vtid: z.string().min(1, 'VTID is required'),
  service: z.string().min(1, 'Service name is required'),
  environment: z.enum(['dev'], { errorMap: () => ({ message: "Only 'dev' environment is allowed" }) }),
  trigger_workflow: z.boolean().default(true),
});

export type DeployServiceRequest = z.infer<typeof DeployServiceRequestSchema>;

export interface DeployServiceResponse {
  ok: boolean;
  status: 'queued' | 'blocked' | 'failed';
  vtid: string;
  service?: string;
  environment?: string;
  workflow_run_id?: number;
  workflow_url?: string;
  error?: string;
  details?: Record<string, unknown>;
}

// ==================== PR Details from GitHub ====================
export interface GitHubPullRequest {
  number: number;
  state: 'open' | 'closed' | 'merged';
  title: string;
  body: string | null;
  base: {
    ref: string;
    sha: string;
  };
  head: {
    ref: string;
    sha: string;
  };
  mergeable: boolean | null;
  mergeable_state: string;
  html_url: string;
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | null;
}

export interface GitHubCombinedStatus {
  state: 'success' | 'failure' | 'pending';
  statuses: Array<{
    context: string;
    state: 'success' | 'failure' | 'pending' | 'error';
    description: string | null;
  }>;
}

// ==================== Governance ====================
export interface GovernanceEvaluation {
  decision: 'approved' | 'blocked';
  vtid: string;
  files_touched: string[];
  services_impacted: string[];
  blocked_reasons: string[];
  timestamp: string;
}

// ==================== OASIS Events ====================
export type CicdEventType =
  | 'cicd.github.create_pr.requested'
  | 'cicd.github.create_pr.succeeded'
  | 'cicd.github.create_pr.failed'
  | 'cicd.github.safe_merge.requested'
  | 'cicd.github.safe_merge.evaluated'
  | 'cicd.github.safe_merge.approved'
  | 'cicd.github.safe_merge.blocked'
  | 'cicd.github.safe_merge.executed'
  | 'cicd.deploy.service.requested'
  | 'cicd.deploy.service.accepted'
  | 'cicd.deploy.service.blocked'
  | 'cicd.deploy.service.succeeded'
  | 'cicd.deploy.service.failed'
  | 'cicd.deploy.service.validated'
  | 'cicd.deploy.version.recorded'  // VTID-0510: Software version recorded
  // VTID-0407: Governance deploy enforcement events
  | 'governance.deploy.blocked'
  | 'governance.deploy.allowed'
  // VTID-0536: Gemini Operator Tools Bridge events
  | 'assistant.turn'
  // VTID-0150-B: Assistant Core events
  | 'assistant.session.started'
  | 'autopilot.intent.created'
  | 'autopilot.intent.approved'
  | 'autopilot.intent.rejected'
  | 'autopilot.intent.executed'
  | 'governance.evaluate'
  | 'vtid.created'
  | 'autopilot.status.requested'
  | 'autopilot.list.requested';

export interface CicdOasisEvent {
  vtid: string;
  type: CicdEventType;
  source: string;
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
  payload?: Record<string, unknown>;
}

// ==================== Allowed Services for Deploy ====================
export const ALLOWED_DEPLOY_SERVICES = ['gateway', 'oasis-operator', 'oasis-projector'] as const;
export type AllowedDeployService = typeof ALLOWED_DEPLOY_SERVICES[number];

// ==================== Governance Rules ====================
export const BLOCKED_FILE_PATTERNS = [
  /\.env(\..+)?$/,           // Environment files
  /secrets?\//i,             // Secrets directories
  /credentials?/i,           // Credential files
  /\.key$/,                  // Key files
  /\.pem$/,                  // PEM certificates
  /gcp.*\.json$/i,           // GCP service account keys
  /firebase.*\.json$/i,      // Firebase configs
] as const;

export const SENSITIVE_PATHS = [
  'production/',
  'prod/',
  '.github/workflows/',      // Workflow modifications need extra review
] as const;
