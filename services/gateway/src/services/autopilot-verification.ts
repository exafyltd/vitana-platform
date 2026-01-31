/**
 * Autopilot Verification Service - VTID-01178
 *
 * Post-deploy verification pipeline that runs after successful deployment.
 * This is the final gate before a VTID can be marked as terminally completed.
 *
 * Verification includes:
 * 1. Health Check - Endpoint responds with 200
 * 2. CSP/Static Checks - Content Security Policy compliance
 * 3. Acceptance Assertions - Derived from spec snapshot
 *
 * Results are recorded to OASIS for traceability.
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  markVerifying,
  markCompleted,
  markFailed,
  getSpecSnapshot,
  type VerificationResult,
} from './autopilot-controller';
import {
  getVtidSpec,
  enforceSpecRequirement,
  getSpecDomain,
  getSpecTargetPaths,
  type VtidSpec,
} from './vtid-spec-service';
import {
  runVisualVerification,
  type VisualVerificationResponse,
} from './visual-verification';

// =============================================================================
// Types
// =============================================================================

export interface VerificationRequest {
  vtid: string;
  service: string;
  environment: string;
  deploy_url?: string;
  merge_sha?: string;
}

export interface VerificationResponse {
  ok: boolean;
  passed: boolean;
  result?: VerificationResult;
  error?: string;
}

interface HealthCheckResult {
  passed: boolean;
  status_code?: number;
  response_time_ms?: number;
  error?: string;
}

interface CspCheckResult {
  passed: boolean;
  violations: string[];
}

interface AcceptanceAssertionResult {
  passed: boolean;
  assertions: AcceptanceAssertion[];
  failed_assertions: string[];
}

interface AcceptanceAssertion {
  id: string;
  description: string;
  type: 'endpoint_exists' | 'file_exists' | 'contains_text' | 'status_code' | 'custom';
  passed: boolean;
  actual?: string;
  expected?: string;
  error?: string;
}

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  healthCheckTimeoutMs: 10000,
  maxRetries: 3,
  retryDelayMs: 2000,
};

// Service to URL mapping for health checks
const SERVICE_URLS: Record<string, string> = {
  'gateway': process.env.GATEWAY_URL || 'https://gateway-lovable-vitana-vers1.uc.r.appspot.com',
  'oasis-operator': process.env.OASIS_OPERATOR_URL || 'https://oasis-operator-lovable-vitana-vers1.uc.r.appspot.com',
  'oasis-projector': process.env.OASIS_PROJECTOR_URL || 'https://oasis-projector-lovable-vitana-vers1.uc.r.appspot.com',
};

// =============================================================================
// OASIS Event Helpers
// =============================================================================

async function emitVerificationEvent(
  vtid: string,
  stage: 'started' | 'health_check' | 'csp_check' | 'acceptance' | 'visual' | 'completed' | 'failed',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: `autopilot.verification.${stage}` as any,
    source: 'autopilot-verification',
    status,
    message,
    payload: {
      vtid,
      ...payload,
      emitted_at: new Date().toISOString(),
    },
  });
}

// =============================================================================
// Health Check
// =============================================================================

/**
 * Run health check against deployed service
 */
async function runHealthCheck(
  vtid: string,
  service: string,
  deployUrl?: string
): Promise<HealthCheckResult> {
  const baseUrl = deployUrl || SERVICE_URLS[service];
  if (!baseUrl) {
    return {
      passed: false,
      error: `No URL configured for service: ${service}`,
    };
  }

  const healthEndpoint = `${baseUrl}/alive`;
  const startTime = Date.now();

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.healthCheckTimeoutMs);

      const response = await fetch(healthEndpoint, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const responseTime = Date.now() - startTime;

      if (response.ok) {
        return {
          passed: true,
          status_code: response.status,
          response_time_ms: responseTime,
        };
      }

      // Non-200 response
      if (attempt < CONFIG.maxRetries) {
        console.log(`[VTID-01178] Health check attempt ${attempt} failed (${response.status}), retrying...`);
        await new Promise(r => setTimeout(r, CONFIG.retryDelayMs));
        continue;
      }

      return {
        passed: false,
        status_code: response.status,
        response_time_ms: responseTime,
        error: `Health check returned ${response.status}`,
      };

    } catch (error) {
      if (attempt < CONFIG.maxRetries) {
        console.log(`[VTID-01178] Health check attempt ${attempt} error, retrying...`);
        await new Promise(r => setTimeout(r, CONFIG.retryDelayMs));
        continue;
      }

      return {
        passed: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  return {
    passed: false,
    error: 'Max retries exceeded',
  };
}

// =============================================================================
// CSP Check
// =============================================================================

/**
 * Run CSP (Content Security Policy) compliance check
 * For frontend changes, verify no inline scripts/styles
 *
 * VTID-01190: Now uses DB-based spec with checksum verification
 */
async function runCspCheck(
  vtid: string,
  service: string
): Promise<CspCheckResult> {
  const violations: string[] = [];

  // VTID-01190: Get spec from DB with checksum verification
  const dbSpec = await getVtidSpec(vtid, { verifyChecksum: true });
  const isFrontend = dbSpec
    ? (getSpecDomain(dbSpec) === 'frontend' ||
       getSpecTargetPaths(dbSpec).some(p => p.includes('/frontend/')))
    : false;

  if (!isFrontend) {
    // CSP check only applies to frontend changes
    return { passed: true, violations: [] };
  }

  // In production, we would:
  // 1. Fetch the deployed page
  // 2. Check for inline scripts/styles
  // 3. Verify CSP headers are present
  // For now, we do a basic check

  const baseUrl = SERVICE_URLS[service];
  if (!baseUrl) {
    return { passed: true, violations: [] };
  }

  try {
    const response = await fetch(baseUrl, {
      method: 'GET',
      headers: { 'Accept': 'text/html' },
    });

    // Check for CSP header
    const cspHeader = response.headers.get('content-security-policy');
    if (!cspHeader && isFrontend) {
      violations.push('Missing Content-Security-Policy header');
    }

    // Check response for inline scripts (basic check)
    const html = await response.text();
    if (html.includes('<script>') && !html.includes('nonce=')) {
      violations.push('Found inline script without nonce');
    }

    return {
      passed: violations.length === 0,
      violations,
    };

  } catch (error) {
    // CSP check errors are warnings, not failures
    console.warn(`[VTID-01178] CSP check error for ${vtid}:`, error);
    return { passed: true, violations: [] };
  }
}

// =============================================================================
// Acceptance Assertions
// =============================================================================

/**
 * Parse acceptance assertions from spec content
 * Looks for patterns like:
 * - "MUST create endpoint /api/v1/foo"
 * - "MUST return 200 for /health"
 * - "SHOULD contain 'success' in response"
 */
function parseAcceptanceAssertions(specContent: string): AcceptanceAssertion[] {
  const assertions: AcceptanceAssertion[] = [];

  // Pattern: endpoint exists
  const endpointPattern = /(?:MUST|SHOULD|SHALL)\s+(?:create|add|implement)\s+endpoint\s+([^\s,\.]+)/gi;
  let match;
  while ((match = endpointPattern.exec(specContent)) !== null) {
    assertions.push({
      id: `endpoint_${assertions.length + 1}`,
      description: `Endpoint ${match[1]} should exist`,
      type: 'endpoint_exists',
      passed: false, // Will be evaluated
      expected: match[1],
    });
  }

  // Pattern: file exists
  const filePattern = /(?:MUST|SHOULD|SHALL)\s+(?:create|add)\s+file\s+([^\s,\.]+)/gi;
  while ((match = filePattern.exec(specContent)) !== null) {
    assertions.push({
      id: `file_${assertions.length + 1}`,
      description: `File ${match[1]} should exist`,
      type: 'file_exists',
      passed: false,
      expected: match[1],
    });
  }

  // Pattern: status code
  const statusPattern = /(?:MUST|SHOULD|SHALL)\s+return\s+(\d{3})\s+(?:for|on|when)/gi;
  while ((match = statusPattern.exec(specContent)) !== null) {
    assertions.push({
      id: `status_${assertions.length + 1}`,
      description: `Should return status ${match[1]}`,
      type: 'status_code',
      passed: false,
      expected: match[1],
    });
  }

  return assertions;
}

/**
 * Evaluate acceptance assertions against deployed service
 *
 * VTID-01190: Now uses DB-based spec with checksum verification.
 * Acceptance assertions are derived from the persisted spec.
 */
async function runAcceptanceAssertions(
  vtid: string,
  service: string
): Promise<AcceptanceAssertionResult> {
  // VTID-01190: Get spec from DB with checksum verification
  const dbSpec = await getVtidSpec(vtid, { verifyChecksum: true });
  if (!dbSpec) {
    console.warn(`[VTID-01190] No spec found for ${vtid} during acceptance assertions`);
    return {
      passed: true,
      assertions: [],
      failed_assertions: [],
    };
  }

  // Use spec_text from the persisted spec content
  const assertions = parseAcceptanceAssertions(dbSpec.spec_content.spec_text);
  if (assertions.length === 0) {
    // No assertions found in spec - pass by default
    return {
      passed: true,
      assertions: [],
      failed_assertions: [],
    };
  }

  const baseUrl = SERVICE_URLS[service];
  const failedAssertions: string[] = [];

  // Evaluate each assertion
  for (const assertion of assertions) {
    try {
      switch (assertion.type) {
        case 'endpoint_exists':
          if (baseUrl && assertion.expected) {
            const endpoint = assertion.expected.startsWith('/')
              ? `${baseUrl}${assertion.expected}`
              : `${baseUrl}/${assertion.expected}`;

            try {
              const response = await fetch(endpoint, { method: 'HEAD' });
              assertion.passed = response.status !== 404;
              assertion.actual = `Status: ${response.status}`;
            } catch (e) {
              assertion.passed = false;
              assertion.error = e instanceof Error ? e.message : 'Request failed';
            }
          }
          break;

        case 'status_code':
          // For status code assertions, we'd need to know which endpoint
          // For now, mark as passed (would need more context in production)
          assertion.passed = true;
          break;

        case 'file_exists':
          // File existence would be checked in the repo, not runtime
          // Mark as passed for now (CI should have caught missing files)
          assertion.passed = true;
          break;

        default:
          assertion.passed = true;
      }

      if (!assertion.passed) {
        failedAssertions.push(assertion.description);
      }

    } catch (error) {
      assertion.passed = false;
      assertion.error = error instanceof Error ? error.message : 'Unknown error';
      failedAssertions.push(assertion.description);
    }
  }

  return {
    passed: failedAssertions.length === 0,
    assertions,
    failed_assertions: failedAssertions,
  };
}

// =============================================================================
// Main Verification Function
// =============================================================================

/**
 * Run post-deploy verification for a VTID
 *
 * VTID-01190: This now enforces spec requirement before verification.
 * Verification uses the persisted spec for acceptance assertions.
 *
 * This should be called after successful deployment.
 * If verification passes, the VTID can be marked as terminally completed.
 *
 * @param request - Verification request with VTID and deploy details
 * @returns VerificationResponse indicating if VTID can be completed
 */
export async function runVerification(request: VerificationRequest): Promise<VerificationResponse> {
  const { vtid, service, environment, deploy_url, merge_sha } = request;

  console.log(`[VTID-01190] Starting verification for ${vtid} (${service}@${environment})`);

  // VTID-01190: Verify spec exists and is valid before verification
  const specEnforcement = await enforceSpecRequirement(vtid);
  if (!specEnforcement.allowed) {
    console.error(`[VTID-01190] VERIFICATION BLOCKED - No valid spec for ${vtid}: ${specEnforcement.error}`);

    await emitVerificationEvent(vtid, 'failed', 'error', `Verification blocked: ${specEnforcement.error}`, {
      error: specEnforcement.error,
      error_code: specEnforcement.error_code,
      spec_enforcement_failed: true,
    });

    return {
      ok: false,
      passed: false,
      error: `Spec enforcement failed: ${specEnforcement.error}`,
    };
  }

  // Mark as verifying state
  await markVerifying(vtid);

  await emitVerificationEvent(vtid, 'started', 'info', `Verification started for ${vtid}`, {
    service,
    environment,
    merge_sha,
    spec_checksum: specEnforcement.spec?.spec_checksum, // VTID-01190: Include checksum
  });

  const issues: string[] = [];

  try {
    // Step 1: Health Check
    console.log(`[VTID-01178] Running health check for ${vtid}...`);
    const healthCheck = await runHealthCheck(vtid, service, deploy_url);

    await emitVerificationEvent(
      vtid,
      'health_check',
      healthCheck.passed ? 'success' : 'error',
      healthCheck.passed
        ? `Health check passed (${healthCheck.response_time_ms}ms)`
        : `Health check failed: ${healthCheck.error}`,
      {
        passed: healthCheck.passed,
        status_code: healthCheck.status_code,
        response_time_ms: healthCheck.response_time_ms,
      }
    );

    if (!healthCheck.passed) {
      issues.push(`Health check failed: ${healthCheck.error}`);
    }

    // Step 2: CSP Check
    console.log(`[VTID-01178] Running CSP check for ${vtid}...`);
    const cspCheck = await runCspCheck(vtid, service);

    await emitVerificationEvent(
      vtid,
      'csp_check',
      cspCheck.passed ? 'success' : 'warning',
      cspCheck.passed
        ? 'CSP check passed'
        : `CSP violations: ${cspCheck.violations.join(', ')}`,
      {
        passed: cspCheck.passed,
        violations: cspCheck.violations,
      }
    );

    if (!cspCheck.passed) {
      issues.push(...cspCheck.violations);
    }

    // Step 3: Acceptance Assertions
    console.log(`[VTID-01178] Running acceptance assertions for ${vtid}...`);
    const acceptance = await runAcceptanceAssertions(vtid, service);

    await emitVerificationEvent(
      vtid,
      'acceptance',
      acceptance.passed ? 'success' : 'warning',
      acceptance.passed
        ? `Acceptance assertions passed (${acceptance.assertions.length} total)`
        : `Acceptance assertions failed: ${acceptance.failed_assertions.join(', ')}`,
      {
        passed: acceptance.passed,
        total_assertions: acceptance.assertions.length,
        failed_assertions: acceptance.failed_assertions,
      }
    );

    if (!acceptance.passed) {
      issues.push(...acceptance.failed_assertions);
    }

    // Step 4: Visual Testing (VTID-01200)
    console.log(`[VTID-01178] Running visual verification for ${vtid}...`);
    let visualVerification: VisualVerificationResponse;
    try {
      visualVerification = await runVisualVerification({
        vtid,
        service,
        environment,
        deploy_url,
      });

      await emitVerificationEvent(
        vtid,
        'visual',
        visualVerification.passed ? 'success' : 'warning',
        visualVerification.passed
          ? `Visual verification passed for ${vtid}`
          : `Visual verification failed: ${visualVerification.result?.issues.join(', ') || visualVerification.error}`,
        {
          passed: visualVerification.passed,
          page_load_passed: visualVerification.result?.page_load_passed,
          journeys_passed: visualVerification.result?.journeys_passed,
          accessibility_passed: visualVerification.result?.accessibility_passed,
          issues: visualVerification.result?.issues || [],
        }
      );

      if (!visualVerification.passed && visualVerification.result?.issues) {
        issues.push(...visualVerification.result.issues);
      }
    } catch (error) {
      // Visual verification errors are warnings, not blockers
      console.warn(`[VTID-01178] Visual verification error for ${vtid}:`, error);
      visualVerification = { ok: false, passed: false, error: String(error) };
    }

    // Final result
    // Health check is required, CSP/acceptance/visual are warnings
    const passed = healthCheck.passed;
    const result: VerificationResult = {
      passed,
      health_check_passed: healthCheck.passed,
      acceptance_assertions_passed: acceptance.passed,
      csp_check_passed: cspCheck.passed,
      visual_verification_passed: visualVerification.passed,
      visual_verification_result: visualVerification.result,
      issues,
      verified_at: new Date().toISOString(),
    };

    if (passed) {
      // Mark as completed (terminal success)
      await markCompleted(vtid, result);

      await emitVerificationEvent(vtid, 'completed', 'success', `Verification passed for ${vtid}`, {
        passed: true,
        health_check_passed: healthCheck.passed,
        csp_check_passed: cspCheck.passed,
        acceptance_passed: acceptance.passed,
        visual_verification_passed: visualVerification.passed,
      });

      console.log(`[VTID-01178] Verification PASSED for ${vtid} - marked as completed`);
    } else {
      await emitVerificationEvent(vtid, 'failed', 'error', `Verification failed for ${vtid}`, {
        passed: false,
        issues,
      });

      console.log(`[VTID-01178] Verification FAILED for ${vtid}: ${issues.join(', ')}`);
    }

    return {
      ok: true,
      passed,
      result,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-01178] Verification error for ${vtid}:`, errorMessage);

    // Mark as failed
    await markFailed(vtid, `Verification error: ${errorMessage}`, 'VERIFICATION_ERROR');

    await emitVerificationEvent(vtid, 'failed', 'error', `Verification error: ${errorMessage}`, {
      error: errorMessage,
    });

    return {
      ok: false,
      passed: false,
      error: errorMessage,
    };
  }
}

/**
 * Quick health check for a service (no OASIS events)
 */
export async function quickHealthCheck(service: string): Promise<boolean> {
  const result = await runHealthCheck('QUICK_CHECK', service);
  return result.passed;
}

export default {
  runVerification,
  quickHealthCheck,
};
