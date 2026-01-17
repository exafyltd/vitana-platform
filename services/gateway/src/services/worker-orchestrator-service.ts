/**
 * Worker Orchestrator Service - VTID-01163
 *
 * Routes incoming work orders to specialized domain worker subagents
 * (frontend, backend, memory). Implements deterministic routing based on
 * task_domain field and keyword heuristics.
 *
 * VTID-01175: Integrated with Verification Engine to validate worker output
 * before marking tasks as complete.
 *
 * This service does NOT edit code directly - it only validates, routes,
 * and coordinates execution stages via OASIS events.
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// VTID-01175: Verification Engine Configuration
// =============================================================================

const VERIFICATION_ENGINE_URL = process.env.VERIFICATION_ENGINE_URL ||
  'https://vitana-verification-engine-q74ibpv6ia-uc.a.run.app';

const VERIFICATION_TIMEOUT_MS = parseInt(process.env.VERIFICATION_TIMEOUT_MS || '30000', 10);
const MAX_VERIFICATION_RETRIES = parseInt(process.env.MAX_VERIFICATION_RETRIES || '2', 10);

// =============================================================================
// VTID-01167 + VTID-01170: Identity Defaults (Canonical Identity Enforcement)
// =============================================================================
// Claude must NEVER ask "which project/repo is this?" - these are derived from environment.
//
// VTID-01170 ENFORCEMENT:
// Every VTID MUST have canonical identity injected. If identity is missing:
// - Gateway injects these defaults automatically
// - Agents MUST NOT ask the user for identity values
// =============================================================================

/**
 * Get tenant from environment.
 * For Dev Sandbox: defaults to 'vitana'
 * For multi-tenancy (Maxina/Earthlings/AlKalma): derived from VITANA_TENANT env var
 */
function deriveTenant(): string {
  return process.env.VITANA_TENANT || 'vitana';
}

/**
 * Identity context for the current environment.
 * Infrastructure values are fixed; tenant/environment are derived from context.
 * Claude NEVER asks for these - they are always available.
 */
export const IDENTITY_DEFAULTS = {
  // Infrastructure identifiers - fixed for this deployment
  repo: 'vitana-platform',
  project: process.env.GCP_PROJECT || 'lovable-vitana-vers1',
  region: process.env.GCP_REGION || 'us-central1',
  // Environment and tenant - derived from environment variables
  environment: process.env.VITANA_ENVIRONMENT || 'vitana_dev_sandbox',
  tenant: deriveTenant(),
} as const;

// =============================================================================
// Types
// =============================================================================

/**
 * Task domains for routing
 */
export type TaskDomain = 'frontend' | 'backend' | 'memory' | 'mixed';

/**
 * Worker subagent identifiers
 */
export type WorkerSubagent = 'worker-frontend' | 'worker-backend' | 'worker-memory';

/**
 * Change budget limits
 */
export interface ChangeBudget {
  max_files?: number;
  max_directories?: number;
}

/**
 * Work order payload for routing
 */
export interface WorkOrderPayload {
  vtid: string;
  title: string;
  task_family?: string;
  task_domain?: TaskDomain;
  target_paths?: string[];
  change_budget?: ChangeBudget;
  spec_content?: string;
  run_id?: string;
}

/**
 * Routing result - always includes identity context
 */
export interface RoutingResult {
  ok: boolean;
  dispatched_to?: WorkerSubagent;
  run_id?: string;
  stages?: Array<{ domain: TaskDomain; order: number }>;
  error?: string;
  error_code?: string;
  // VTID-01167: Identity context injected into every routing result
  identity: typeof IDENTITY_DEFAULTS;
}

/**
 * Subagent execution result
 */
export interface SubagentResult {
  ok: boolean;
  files_changed?: string[];
  files_created?: string[];
  summary?: string;
  error?: string;
  violations?: string[];
}

// =============================================================================
// VTID-01175: Verification Types
// =============================================================================

/**
 * File change claimed by a worker
 */
interface FileChange {
  file_path: string;
  action: 'created' | 'modified' | 'deleted';
}

/**
 * Request payload for verification engine
 */
interface VerifyRequest {
  vtid: string;
  domain: TaskDomain;
  claimed_changes: FileChange[];
  claimed_output?: string;
  started_at?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Response from verification engine
 */
interface VerifyResponse {
  passed: boolean;
  verification_result: string;
  reason: string;
  checks_run: string[];
  checks_passed: string[];
  checks_failed: string[];
  duration_ms: number;
  oasis_event_id?: string;
  recommended_action: 'complete' | 'retry' | 'fail' | 'manual_review';
  details: Record<string, unknown>;
}

/**
 * Result of verification with retry support
 */
export interface VerificationOutcome {
  passed: boolean;
  should_retry: boolean;
  reason: string;
  verification_response?: VerifyResponse;
}

// =============================================================================
// Domain Detection Keywords
// =============================================================================

const FRONTEND_KEYWORDS = [
  'Command Hub', 'UI', 'CSS', 'SPA', 'CSP', 'styles', 'orb overlay',
  'frontend', 'component', 'layout', 'button', 'modal', 'form', 'input',
  'display', 'render', 'view', 'page', 'template', 'tailwind', 'web', 'browser'
];

const BACKEND_KEYWORDS = [
  'endpoint', 'api/v1', 'gateway', 'controller', 'route mount', 'SSE',
  'operator', 'service', 'middleware', 'handler', 'API', 'REST', 'POST',
  'GET', 'PATCH', 'DELETE', 'express', 'router', 'request', 'response',
  'authentication', 'authorization', 'CICD', 'deploy'
];

const MEMORY_KEYWORDS = [
  'supabase', 'rpc', 'vectors', 'qdrant', 'mem0', 'embedding', 'context',
  'memory', 'migration', 'database', 'table', 'schema', 'index', 'query',
  'OASIS', 'ledger', 'tenant', 'user context'
];

// =============================================================================
// Path Patterns for Domain Detection
// =============================================================================

const FRONTEND_PATH_PATTERNS = [
  /services\/gateway\/src\/frontend\//,
  /services\/gateway\/dist\/frontend\//,
  /\.html$/,
  /\.css$/,
  /\/frontend\//,
  /\/web\//
];

const BACKEND_PATH_PATTERNS = [
  /services\/gateway\/src\//,
  /services\/.*\/src\//,
  /\.ts$/,
  /\/routes\//,
  /\/controllers\//,
  /\/services\//,
  /\/middleware\//
];

const MEMORY_PATH_PATTERNS = [
  /supabase\/migrations\//,
  /services\/agents\/memory-indexer\//,
  /\/memory\//,
  /\.sql$/
];

// =============================================================================
// Default Change Budgets
// =============================================================================

const DEFAULT_BUDGETS: Record<TaskDomain, ChangeBudget> = {
  frontend: { max_files: 10, max_directories: 5 },
  backend: { max_files: 15, max_directories: 8 },
  memory: { max_files: 5, max_directories: 3 },
  mixed: { max_files: 20, max_directories: 10 }
};

// =============================================================================
// OASIS Event Helpers
// =============================================================================

/**
 * Emit orchestrator stage event
 */
async function emitOrchestratorEvent(
  vtid: string,
  stage: 'start' | 'route' | 'success' | 'failed',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: `vtid.stage.worker_orchestrator.${stage}` as any,
    source: 'worker-orchestrator',
    status,
    message,
    payload: {
      vtid,
      stage,
      ...payload,
      emitted_at: new Date().toISOString()
    }
  });
}

/**
 * Emit subagent stage event
 */
async function emitSubagentEvent(
  vtid: string,
  domain: TaskDomain,
  stage: 'start' | 'success' | 'failed',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: `vtid.stage.worker_${domain}.${stage}` as any,
    source: `worker-${domain}`,
    status,
    message,
    payload: {
      vtid,
      domain,
      stage,
      ...payload,
      emitted_at: new Date().toISOString()
    }
  });
}

// =============================================================================
// Domain Detection Logic
// =============================================================================

/**
 * Detect domain from keywords in title/spec
 */
function detectDomainFromKeywords(text: string): TaskDomain[] {
  const normalizedText = text.toLowerCase();
  const domains: TaskDomain[] = [];

  // Check frontend keywords
  if (FRONTEND_KEYWORDS.some(kw => normalizedText.includes(kw.toLowerCase()))) {
    domains.push('frontend');
  }

  // Check backend keywords
  if (BACKEND_KEYWORDS.some(kw => normalizedText.includes(kw.toLowerCase()))) {
    domains.push('backend');
  }

  // Check memory keywords
  if (MEMORY_KEYWORDS.some(kw => normalizedText.includes(kw.toLowerCase()))) {
    domains.push('memory');
  }

  return domains;
}

/**
 * Detect domain from target paths
 */
function detectDomainFromPaths(paths: string[]): TaskDomain[] {
  const domains: TaskDomain[] = [];

  for (const path of paths) {
    if (FRONTEND_PATH_PATTERNS.some(pattern => pattern.test(path))) {
      if (!domains.includes('frontend')) domains.push('frontend');
    }
    if (BACKEND_PATH_PATTERNS.some(pattern => pattern.test(path))) {
      // Exclude frontend paths from backend detection
      if (!FRONTEND_PATH_PATTERNS.some(p => p.test(path))) {
        if (!domains.includes('backend')) domains.push('backend');
      }
    }
    if (MEMORY_PATH_PATTERNS.some(pattern => pattern.test(path))) {
      if (!domains.includes('memory')) domains.push('memory');
    }
  }

  return domains;
}

/**
 * Infer task domain from payload
 */
function inferTaskDomain(payload: WorkOrderPayload): TaskDomain {
  const detectedDomains: TaskDomain[] = [];

  // Check target_paths first (most explicit)
  if (payload.target_paths && payload.target_paths.length > 0) {
    detectedDomains.push(...detectDomainFromPaths(payload.target_paths));
  }

  // Check title keywords
  if (payload.title) {
    detectedDomains.push(...detectDomainFromKeywords(payload.title));
  }

  // Check spec content if available
  if (payload.spec_content) {
    detectedDomains.push(...detectDomainFromKeywords(payload.spec_content));
  }

  // Deduplicate
  const uniqueDomains = [...new Set(detectedDomains)];

  // Determine final domain
  if (uniqueDomains.length === 0) {
    // Default to backend if no domain detected (most common case)
    return 'backend';
  } else if (uniqueDomains.length === 1) {
    return uniqueDomains[0];
  } else {
    return 'mixed';
  }
}

/**
 * Get subagent ID for domain
 */
function getSubagentForDomain(domain: TaskDomain): WorkerSubagent | null {
  switch (domain) {
    case 'frontend':
      return 'worker-frontend';
    case 'backend':
      return 'worker-backend';
    case 'memory':
      return 'worker-memory';
    case 'mixed':
      return null; // Mixed requires splitting
    default:
      return null;
  }
}

// =============================================================================
// Path Validation
// =============================================================================

/**
 * Validate that target paths are allowed for a domain
 */
function validatePathsForDomain(
  domain: TaskDomain,
  paths: string[]
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];

  if (domain === 'mixed') {
    // Mixed domain doesn't have specific path restrictions
    return { valid: true, violations: [] };
  }

  for (const path of paths) {
    let isValid = false;

    switch (domain) {
      case 'frontend':
        isValid = FRONTEND_PATH_PATTERNS.some(pattern => pattern.test(path));
        // Also check it's not a forbidden backend path
        if (isValid && /\/routes\/|\/services\/|\/middleware\//.test(path)) {
          isValid = false;
        }
        break;

      case 'backend':
        isValid = BACKEND_PATH_PATTERNS.some(pattern => pattern.test(path));
        // Exclude frontend paths
        if (isValid && FRONTEND_PATH_PATTERNS.some(p => p.test(path))) {
          isValid = false;
        }
        // Exclude memory paths
        if (isValid && MEMORY_PATH_PATTERNS.some(p => p.test(path))) {
          isValid = false;
        }
        break;

      case 'memory':
        isValid = MEMORY_PATH_PATTERNS.some(pattern => pattern.test(path));
        break;
    }

    if (!isValid) {
      violations.push(`Path "${path}" is not allowed for domain "${domain}"`);
    }
  }

  return {
    valid: violations.length === 0,
    violations
  };
}

// =============================================================================
// Payload Validation
// =============================================================================

const VTID_PATTERN = /^VTID-\d{4,}$/;

/**
 * Validate work order payload
 */
function validatePayload(payload: WorkOrderPayload): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Required fields
  if (!payload.vtid) {
    errors.push('vtid is required');
  } else if (!VTID_PATTERN.test(payload.vtid)) {
    errors.push('vtid must match pattern VTID-XXXXX');
  }

  if (!payload.title || payload.title.trim() === '') {
    errors.push('title is required and must be non-empty');
  }

  // Validate task_domain if provided
  if (payload.task_domain) {
    const validDomains: TaskDomain[] = ['frontend', 'backend', 'memory', 'mixed'];
    if (!validDomains.includes(payload.task_domain)) {
      errors.push(`task_domain must be one of: ${validDomains.join(', ')}`);
    }
  }

  // Validate change_budget if provided
  if (payload.change_budget) {
    if (payload.change_budget.max_files !== undefined && payload.change_budget.max_files < 1) {
      errors.push('change_budget.max_files must be at least 1');
    }
    if (payload.change_budget.max_directories !== undefined && payload.change_budget.max_directories < 1) {
      errors.push('change_budget.max_directories must be at least 1');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// =============================================================================
// Main Routing Function
// =============================================================================

/**
 * Route work order to appropriate subagent
 *
 * This is the main entry point for the orchestrator. It:
 * 1. Validates the payload
 * 2. Determines the target domain
 * 3. Validates paths for the domain
 * 4. Emits routing events
 * 5. Returns routing result (does NOT execute the work)
 */
export async function routeWorkOrder(payload: WorkOrderPayload): Promise<RoutingResult> {
  const run_id = payload.run_id || `route_${randomUUID().slice(0, 8)}`;
  const vtid = payload.vtid || 'UNKNOWN';

  console.log(`[VTID-01163] Routing work order: ${vtid} (run_id=${run_id})`);

  // Step 1: Emit orchestrator start event
  await emitOrchestratorEvent(vtid, 'start', 'info', `Orchestrator started for ${vtid}`, {
    run_id,
    title: payload.title
  });

  try {
    // Step 2: Validate payload
    const validation = validatePayload(payload);
    if (!validation.valid) {
      const errorMsg = `Validation failed: ${validation.errors.join('; ')}`;
      console.error(`[VTID-01163] ${errorMsg}`);
      await emitOrchestratorEvent(vtid, 'failed', 'error', errorMsg, {
        run_id,
        error_code: 'VALIDATION_FAILED',
        errors: validation.errors
      });
      return {
        ok: false,
        error: errorMsg,
        error_code: 'VALIDATION_FAILED',
        run_id,
        identity: IDENTITY_DEFAULTS
      };
    }

    // Step 3: Determine task domain
    let domain: TaskDomain;
    if (payload.task_domain) {
      domain = payload.task_domain;
    } else {
      domain = inferTaskDomain(payload);
      console.log(`[VTID-01163] Inferred domain: ${domain} for ${vtid}`);
    }

    // Step 4: Validate paths for domain
    if (payload.target_paths && payload.target_paths.length > 0) {
      const pathValidation = validatePathsForDomain(domain, payload.target_paths);
      if (!pathValidation.valid) {
        const errorMsg = `Path validation failed: ${pathValidation.violations.join('; ')}`;
        console.error(`[VTID-01163] ${errorMsg}`);
        await emitOrchestratorEvent(vtid, 'failed', 'error', errorMsg, {
          run_id,
          error_code: 'PATH_FORBIDDEN',
          violations: pathValidation.violations
        });
        return {
          ok: false,
          error: errorMsg,
          error_code: 'PATH_FORBIDDEN',
          run_id,
          identity: IDENTITY_DEFAULTS
        };
      }
    }

    // Step 5: Handle mixed domain (split into stages)
    if (domain === 'mixed') {
      const detectedDomains = [...new Set([
        ...detectDomainFromPaths(payload.target_paths || []),
        ...detectDomainFromKeywords(payload.title),
        ...detectDomainFromKeywords(payload.spec_content || '')
      ])];

      // Order: memory -> backend -> frontend
      const orderedDomains: TaskDomain[] = [];
      if (detectedDomains.includes('memory')) orderedDomains.push('memory');
      if (detectedDomains.includes('backend')) orderedDomains.push('backend');
      if (detectedDomains.includes('frontend')) orderedDomains.push('frontend');

      const stages = orderedDomains.map((d, i) => ({ domain: d, order: i + 1 }));

      await emitOrchestratorEvent(vtid, 'route', 'info', `Mixed task split into ${stages.length} stages`, {
        run_id,
        domain: 'mixed',
        stages
      });

      console.log(`[VTID-01163] Mixed task ${vtid} split into stages:`, stages);

      return {
        ok: true,
        run_id,
        stages,
        identity: IDENTITY_DEFAULTS
      };
    }

    // Step 6: Route to single subagent
    const subagent = getSubagentForDomain(domain);
    if (!subagent) {
      const errorMsg = `No subagent available for domain: ${domain}`;
      console.error(`[VTID-01163] ${errorMsg}`);
      await emitOrchestratorEvent(vtid, 'failed', 'error', errorMsg, {
        run_id,
        error_code: 'SUBAGENT_UNAVAILABLE',
        domain
      });
      return {
        ok: false,
        error: errorMsg,
        error_code: 'SUBAGENT_UNAVAILABLE',
        run_id,
        identity: IDENTITY_DEFAULTS
      };
    }

    // Step 7: Emit routing event
    await emitOrchestratorEvent(vtid, 'route', 'info', `Routing to ${subagent}`, {
      run_id,
      domain,
      dispatched_to: subagent,
      target_paths: payload.target_paths,
      change_budget: payload.change_budget || DEFAULT_BUDGETS[domain]
    });

    console.log(`[VTID-01163] Routed ${vtid} to ${subagent}`);

    return {
      ok: true,
      dispatched_to: subagent,
      run_id,
      identity: IDENTITY_DEFAULTS
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown routing error';
    console.error(`[VTID-01163] Routing error for ${vtid}:`, errorMsg);

    await emitOrchestratorEvent(vtid, 'failed', 'error', `Routing failed: ${errorMsg}`, {
      run_id,
      error_code: 'ROUTING_ERROR',
      error: errorMsg
    });

    return {
      ok: false,
      error: errorMsg,
      error_code: 'ROUTING_ERROR',
      run_id,
      identity: IDENTITY_DEFAULTS
    };
  }
}

/**
 * Mark orchestrator success after all subagents complete
 */
export async function markOrchestratorSuccess(
  vtid: string,
  run_id: string,
  summary: string
): Promise<void> {
  await emitOrchestratorEvent(vtid, 'success', 'success', summary, {
    run_id,
    completed_at: new Date().toISOString()
  });
}

/**
 * Mark orchestrator failed
 */
export async function markOrchestratorFailed(
  vtid: string,
  run_id: string,
  error: string
): Promise<void> {
  await emitOrchestratorEvent(vtid, 'failed', 'error', error, {
    run_id,
    failed_at: new Date().toISOString()
  });
}

/**
 * Emit subagent start event (called when subagent begins work)
 */
export async function emitSubagentStart(
  vtid: string,
  domain: TaskDomain,
  run_id: string
): Promise<void> {
  await emitSubagentEvent(
    vtid,
    domain,
    'start',
    'info',
    `Worker ${domain} started for ${vtid}`,
    { run_id }
  );
}

/**
 * Emit subagent success event
 */
export async function emitSubagentSuccess(
  vtid: string,
  domain: TaskDomain,
  run_id: string,
  result: SubagentResult
): Promise<void> {
  await emitSubagentEvent(
    vtid,
    domain,
    'success',
    'success',
    result.summary || `Worker ${domain} completed for ${vtid}`,
    {
      run_id,
      files_changed: result.files_changed,
      files_created: result.files_created
    }
  );
}

/**
 * Emit subagent failed event
 */
export async function emitSubagentFailed(
  vtid: string,
  domain: TaskDomain,
  run_id: string,
  error: string,
  violations?: string[]
): Promise<void> {
  await emitSubagentEvent(
    vtid,
    domain,
    'failed',
    'error',
    `Worker ${domain} failed: ${error}`,
    {
      run_id,
      error,
      violations
    }
  );
}

// =============================================================================
// VTID-01175: Verification Engine Integration
// =============================================================================

/**
 * Emit verification stage event
 */
async function emitVerificationEvent(
  vtid: string,
  stage: 'start' | 'passed' | 'failed' | 'error',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: `vtid.stage.verification.${stage}` as any,
    source: 'worker-orchestrator',
    status,
    message,
    payload: {
      vtid,
      stage,
      ...payload,
      emitted_at: new Date().toISOString()
    }
  });
}

/**
 * Call the verification engine to validate worker output
 *
 * VTID-01175: This is the integration point between the orchestrator and
 * the verification engine. The verification engine validates that:
 * - Claimed files actually exist
 * - Files were actually modified (not just claimed)
 * - Domain-specific rules are satisfied
 * - No safety violations occurred
 */
export async function verifyWorkerOutput(
  vtid: string,
  domain: TaskDomain,
  result: SubagentResult,
  run_id: string,
  startedAt?: Date
): Promise<VerificationOutcome> {
  console.log(`[VTID-01175] Verifying worker output for ${vtid} (domain=${domain})`);

  // Emit verification start event
  await emitVerificationEvent(vtid, 'start', 'info', `Verification started for ${vtid}`, {
    run_id,
    domain,
    files_count: (result.files_changed?.length || 0) + (result.files_created?.length || 0)
  });

  // Build claimed changes from result
  const claimedChanges: FileChange[] = [
    ...(result.files_changed || []).map(f => ({ file_path: f, action: 'modified' as const })),
    ...(result.files_created || []).map(f => ({ file_path: f, action: 'created' as const }))
  ];

  // If no files claimed, pass verification (nothing to verify)
  if (claimedChanges.length === 0) {
    console.log(`[VTID-01175] No files claimed for ${vtid}, skipping verification`);
    await emitVerificationEvent(vtid, 'passed', 'success', 'No files to verify', {
      run_id,
      domain,
      skipped: true
    });
    return {
      passed: true,
      should_retry: false,
      reason: 'No files to verify'
    };
  }

  const request: VerifyRequest = {
    vtid,
    domain,
    claimed_changes: claimedChanges,
    claimed_output: result.summary || '',
    started_at: startedAt?.toISOString(),
    metadata: {
      run_id,
      files_changed: result.files_changed,
      files_created: result.files_created
    }
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VERIFICATION_TIMEOUT_MS);

    const response = await fetch(`${VERIFICATION_ENGINE_URL}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VTID': vtid,
        'X-Run-ID': run_id
      },
      body: JSON.stringify(request),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.error(`[VTID-01175] Verification request failed: ${response.status} - ${errorText}`);

      await emitVerificationEvent(vtid, 'error', 'error', `Verification service error: ${response.status}`, {
        run_id,
        domain,
        http_status: response.status,
        error: errorText
      });

      // On service error, recommend manual review
      return {
        passed: false,
        should_retry: false,
        reason: `Verification service error: ${response.status}`
      };
    }

    const verifyResponse: VerifyResponse = await response.json();

    console.log(`[VTID-01175] Verification result for ${vtid}: ${verifyResponse.passed ? 'PASSED' : 'FAILED'} - ${verifyResponse.reason}`);

    if (verifyResponse.passed) {
      await emitVerificationEvent(vtid, 'passed', 'success', verifyResponse.reason, {
        run_id,
        domain,
        checks_passed: verifyResponse.checks_passed,
        duration_ms: verifyResponse.duration_ms
      });

      return {
        passed: true,
        should_retry: false,
        reason: verifyResponse.reason,
        verification_response: verifyResponse
      };
    } else {
      await emitVerificationEvent(vtid, 'failed', 'warning', verifyResponse.reason, {
        run_id,
        domain,
        checks_failed: verifyResponse.checks_failed,
        recommended_action: verifyResponse.recommended_action,
        duration_ms: verifyResponse.duration_ms,
        details: verifyResponse.details
      });

      return {
        passed: false,
        should_retry: verifyResponse.recommended_action === 'retry',
        reason: verifyResponse.reason,
        verification_response: verifyResponse
      };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown verification error';
    console.error(`[VTID-01175] Verification error for ${vtid}:`, errorMsg);

    await emitVerificationEvent(vtid, 'error', 'error', `Verification error: ${errorMsg}`, {
      run_id,
      domain,
      error: errorMsg
    });

    // On network/timeout error, allow retry
    return {
      passed: false,
      should_retry: true,
      reason: `Verification error: ${errorMsg}`
    };
  }
}

/**
 * Complete subagent execution with verification
 *
 * VTID-01175: This is the main entry point for completing a subagent task.
 * It verifies worker output before marking success. On verification failure,
 * it returns a result indicating whether to retry.
 *
 * Flow:
 * 1. Call verification engine
 * 2. If passed: emit success event, return success
 * 3. If failed + retriable: return should_retry=true
 * 4. If failed + not retriable: emit failure event, return failure
 */
export async function completeSubagentWithVerification(
  vtid: string,
  domain: TaskDomain,
  run_id: string,
  result: SubagentResult,
  startedAt?: Date,
  retryCount: number = 0
): Promise<{
  ok: boolean;
  should_retry: boolean;
  reason: string;
  retry_count: number;
}> {
  console.log(`[VTID-01175] Completing subagent ${domain} for ${vtid} (attempt=${retryCount + 1})`);

  // Step 1: Verify worker output
  const verification = await verifyWorkerOutput(vtid, domain, result, run_id, startedAt);

  // Step 2: Handle verification result
  if (verification.passed) {
    // Verification passed - emit success
    await emitSubagentSuccess(vtid, domain, run_id, result);
    return {
      ok: true,
      should_retry: false,
      reason: verification.reason,
      retry_count: retryCount
    };
  }

  // Step 3: Verification failed
  if (verification.should_retry && retryCount < MAX_VERIFICATION_RETRIES) {
    // Can retry - don't emit failure yet
    console.log(`[VTID-01175] Verification failed for ${vtid}, recommending retry (${retryCount + 1}/${MAX_VERIFICATION_RETRIES})`);
    return {
      ok: false,
      should_retry: true,
      reason: verification.reason,
      retry_count: retryCount
    };
  }

  // Step 4: Cannot retry or max retries exceeded - emit failure
  const failureReason = retryCount >= MAX_VERIFICATION_RETRIES
    ? `Verification failed after ${retryCount + 1} attempts: ${verification.reason}`
    : `Verification failed (not retriable): ${verification.reason}`;

  await emitSubagentFailed(vtid, domain, run_id, failureReason, [verification.reason]);
  return {
    ok: false,
    should_retry: false,
    reason: failureReason,
    retry_count: retryCount
  };
}

/**
 * Complete orchestrator with verification of all subagent results
 *
 * VTID-01175: Verifies all work before marking orchestrator complete.
 * This is called after all subagents have reported completion.
 */
export async function completeOrchestratorWithVerification(
  vtid: string,
  run_id: string,
  domain: TaskDomain,
  result: SubagentResult,
  startedAt?: Date
): Promise<{
  ok: boolean;
  should_retry: boolean;
  reason: string;
}> {
  const completion = await completeSubagentWithVerification(
    vtid,
    domain,
    run_id,
    result,
    startedAt,
    0
  );

  if (completion.ok) {
    // Verification passed - mark orchestrator success
    await markOrchestratorSuccess(vtid, run_id, `Task completed and verified: ${completion.reason}`);
  } else if (!completion.should_retry) {
    // Verification failed and cannot retry - mark orchestrator failed
    await markOrchestratorFailed(vtid, run_id, completion.reason);
  }
  // If should_retry, caller decides whether to retry the worker

  return {
    ok: completion.ok,
    should_retry: completion.should_retry,
    reason: completion.reason
  };
}

// =============================================================================
// Exports for Testing
// =============================================================================

export const _internal = {
  detectDomainFromKeywords,
  detectDomainFromPaths,
  inferTaskDomain,
  validatePathsForDomain,
  validatePayload,
  getSubagentForDomain,
  FRONTEND_KEYWORDS,
  BACKEND_KEYWORDS,
  MEMORY_KEYWORDS,
  DEFAULT_BUDGETS,
  // VTID-01175: Verification internals
  VERIFICATION_ENGINE_URL,
  VERIFICATION_TIMEOUT_MS,
  MAX_VERIFICATION_RETRIES
};
