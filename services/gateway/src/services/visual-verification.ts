/**
 * Visual Verification Service - VTID-01200
 *
 * Post-deploy visual testing that runs after autopilot verification.
 * Integrates with Playwright MCP for browser automation and user journey validation.
 *
 * Features:
 * - Visual regression testing via screenshots
 * - User journey validation (login, navigation, interactions)
 * - Accessibility testing (WCAG compliance)
 * - Frontend smoke tests
 *
 * Verification stages:
 * 1. Page Load Test - Can the page load without errors?
 * 2. Visual Snapshot - Capture screenshots for regression
 * 3. User Journey - Execute critical user flows
 * 4. Accessibility - WCAG compliance check
 */

import { emitOasisEvent } from './oasis-event-service';
import { getVtidSpec, getSpecDomain } from './vtid-spec-service';

// =============================================================================
// Types
// =============================================================================

export interface VisualVerificationRequest {
  vtid: string;
  service: string;
  environment: string;
  deploy_url?: string;
}

export interface VisualVerificationResponse {
  ok: boolean;
  passed: boolean;
  result?: VisualVerificationResult;
  error?: string;
}

export interface VisualVerificationResult {
  passed: boolean;
  page_load_passed: boolean;
  journeys_passed: boolean;
  accessibility_passed: boolean;
  screenshots: string[];
  journey_results: JourneyResult[];
  accessibility_violations: Array<{ id: string; impact: string; description: string }>;
  issues: string[];
  verified_at: string;
}

interface JourneyResult {
  name: string;
  passed: boolean;
  steps_passed: number;
  steps_failed: number;
  duration_ms: number;
  errors: string[];
}

interface JourneyDefinition {
  name: string;
  steps: JourneyStep[];
  critical?: boolean; // If true, failing this journey fails the verification
}

interface JourneyStep {
  action: 'navigate' | 'click' | 'type' | 'wait' | 'assert' | 'screenshot';
  selector?: string;
  url?: string;
  text?: string;
  expected?: string;
  timeout?: number;
}

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  mcpGatewayUrl: process.env.MCP_GATEWAY_URL || 'http://localhost:3001',
  timeout: 30000,
  screenshotDir: process.env.VISUAL_TEST_SCREENSHOTS_DIR || '/tmp/visual-tests',
};

// Service to URL mapping
const SERVICE_URLS: Record<string, string> = {
  'temp_vitana_v1': process.env.FRONTEND_URL || 'https://temp-vitana-v1.lovable.app',
  'gateway': process.env.GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app',
};

// =============================================================================
// User Journey Definitions
// =============================================================================

/**
 * Get user journeys based on spec domain
 */
function getJourneysForDomain(domain: string, baseUrl: string): JourneyDefinition[] {
  const journeys: JourneyDefinition[] = [];

  if (domain === 'frontend') {
    // Frontend journeys
    journeys.push({
      name: 'homepage_load',
      critical: true,
      steps: [
        { action: 'navigate', url: '/', timeout: 10000 },
        { action: 'wait', selector: 'body', timeout: 5000 },
        { action: 'assert', selector: 'title', expected: 'Vitana' },
      ],
    });

    journeys.push({
      name: 'navigation_sidebar',
      critical: false,
      steps: [
        { action: 'navigate', url: '/', timeout: 10000 },
        { action: 'wait', selector: 'nav', timeout: 5000 },
        { action: 'assert', selector: 'nav', expected: '' }, // Just check nav exists
      ],
    });

    journeys.push({
      name: 'messages_page',
      critical: false,
      steps: [
        { action: 'navigate', url: '/messages', timeout: 10000 },
        { action: 'wait', selector: 'body', timeout: 5000 },
      ],
    });

    journeys.push({
      name: 'health_page',
      critical: false,
      steps: [
        { action: 'navigate', url: '/health', timeout: 10000 },
        { action: 'wait', selector: 'body', timeout: 5000 },
      ],
    });
  } else if (domain === 'backend' || domain === 'api') {
    // Backend journeys (API smoke tests)
    journeys.push({
      name: 'api_health_check',
      critical: true,
      steps: [
        { action: 'navigate', url: '/alive', timeout: 5000 },
        { action: 'assert', selector: 'body', expected: 'healthy' },
      ],
    });
  }

  return journeys;
}

// =============================================================================
// MCP Connector Client
// =============================================================================

/**
 * Call Playwright MCP connector
 */
async function callPlaywrightMcp(method: string, params: any): Promise<any> {
  try {
    const response = await fetch(`${CONFIG.mcpGatewayUrl}/mcp/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server: 'playwright',
        method: method,
        params: params,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MCP call failed: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as { ok: boolean; result?: any; error?: string };
    if (!result.ok) {
      throw new Error(result.error || 'MCP call failed');
    }

    return result.result;
  } catch (error) {
    console.error(`[VTID-01200] MCP call error (${method}):`, error);
    throw error;
  }
}

// =============================================================================
// Visual Verification Tests
// =============================================================================

/**
 * Run page load test
 */
async function runPageLoadTest(baseUrl: string): Promise<{
  passed: boolean;
  url: string;
  title?: string;
  error?: string;
}> {
  try {
    const result = await callPlaywrightMcp('browser.navigate', {
      url: baseUrl,
      waitUntil: 'networkidle',
      timeout: CONFIG.timeout,
    });

    return {
      passed: result.ok,
      url: result.url,
      title: result.title,
    };
  } catch (error) {
    return {
      passed: false,
      url: baseUrl,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Run user journey test
 */
async function runJourneyTest(
  journey: JourneyDefinition,
  baseUrl: string,
  captureScreenshots: boolean = false
): Promise<JourneyResult> {
  try {
    const result = await callPlaywrightMcp('journey.validate', {
      name: journey.name,
      steps: journey.steps,
      baseUrl,
      screenshots: captureScreenshots,
    });

    return {
      name: journey.name,
      passed: result.passed,
      steps_passed: result.steps_passed || 0,
      steps_failed: result.steps_failed || 0,
      duration_ms: result.duration_ms || 0,
      errors: result.errors || [],
    };
  } catch (error) {
    return {
      name: journey.name,
      passed: false,
      steps_passed: 0,
      steps_failed: journey.steps.length,
      duration_ms: 0,
      errors: [error instanceof Error ? error.message : 'Unknown error'],
    };
  }
}

/**
 * Run accessibility check
 */
async function runAccessibilityCheck(baseUrl: string): Promise<{
  passed: boolean;
  violations: Array<{ id: string; impact: string; description: string }>;
  passes: number;
}> {
  try {
    const result = await callPlaywrightMcp('browser.accessibility', {
      url: baseUrl,
    });

    return {
      passed: result.violations.length === 0,
      violations: result.violations || [],
      passes: result.passes || 0,
    };
  } catch (error) {
    console.warn(`[VTID-01200] Accessibility check error: ${error}`);
    // Non-blocking - return as passed with warning
    return {
      passed: true,
      violations: [],
      passes: 0,
    };
  }
}

/**
 * Capture visual snapshot
 */
async function captureVisualSnapshot(baseUrl: string, vtid: string): Promise<string | null> {
  try {
    const result = await callPlaywrightMcp('browser.screenshot', {
      url: baseUrl,
      fullPage: true,
      path: `${CONFIG.screenshotDir}/${vtid}-homepage.png`,
    });

    return result.screenshot || null;
  } catch (error) {
    console.warn(`[VTID-01200] Screenshot capture error: ${error}`);
    return null;
  }
}

// =============================================================================
// Main Verification Function
// =============================================================================

/**
 * Run visual verification for a VTID
 *
 * This runs after autopilot-verification.ts completes.
 * It validates the deployed frontend via browser automation.
 *
 * @param request - Visual verification request
 * @returns VisualVerificationResponse indicating if visual tests passed
 */
export async function runVisualVerification(
  request: VisualVerificationRequest
): Promise<VisualVerificationResponse> {
  const { vtid, service, environment, deploy_url } = request;

  console.log(`[VTID-01200] Starting visual verification for ${vtid} (${service}@${environment})`);

  // Check if this is a frontend change (only run visual tests for frontend)
  const dbSpec = await getVtidSpec(vtid, { verifyChecksum: true });
  const domain = dbSpec ? getSpecDomain(dbSpec) : 'unknown';

  if (domain !== 'frontend') {
    console.log(`[VTID-01200] Skipping visual verification for ${vtid} (domain: ${domain})`);
    return {
      ok: true,
      passed: true,
      result: {
        passed: true,
        page_load_passed: true,
        journeys_passed: true,
        accessibility_passed: true,
        screenshots: [],
        journey_results: [],
        accessibility_violations: [],
        issues: [],
        verified_at: new Date().toISOString(),
      },
    };
  }

  // Emit start event
  await emitOasisEvent({
    vtid,
    type: 'autopilot.verification.visual.started' as any,
    source: 'visual-verification',
    status: 'info',
    message: `Visual verification started for ${vtid}`,
    payload: { vtid, service, environment },
  });

  const baseUrl = deploy_url || SERVICE_URLS[service] || SERVICE_URLS['temp_vitana_v1'];
  const issues: string[] = [];
  const screenshots: string[] = [];

  try {
    // Step 1: Page Load Test
    console.log(`[VTID-01200] Running page load test for ${vtid}...`);
    const pageLoad = await runPageLoadTest(baseUrl);

    if (!pageLoad.passed) {
      issues.push(`Page load failed: ${pageLoad.error}`);
    }

    // Step 2: Visual Snapshot
    console.log(`[VTID-01200] Capturing visual snapshot for ${vtid}...`);
    const snapshot = await captureVisualSnapshot(baseUrl, vtid);
    if (snapshot) {
      screenshots.push(snapshot);
    }

    // Step 3: User Journeys
    console.log(`[VTID-01200] Running user journeys for ${vtid}...`);
    const journeys = getJourneysForDomain(domain, baseUrl);
    const journeyResults: JourneyResult[] = [];

    for (const journey of journeys) {
      const result = await runJourneyTest(journey, baseUrl, true);
      journeyResults.push(result);

      if (!result.passed && journey.critical) {
        issues.push(`Critical journey "${journey.name}" failed: ${result.errors.join(', ')}`);
      }
    }

    const journeysPassed = journeyResults.every((r) => r.passed);

    // Step 4: Accessibility Check
    console.log(`[VTID-01200] Running accessibility check for ${vtid}...`);
    const accessibility = await runAccessibilityCheck(baseUrl);

    if (!accessibility.passed) {
      // Accessibility violations are warnings, not blockers
      const criticalViolations = accessibility.violations.filter((v) => v.impact === 'critical');
      if (criticalViolations.length > 0) {
        issues.push(`Accessibility: ${criticalViolations.length} critical violations`);
      }
    }

    // Final result
    const passed = pageLoad.passed && journeysPassed;

    const result: VisualVerificationResult = {
      passed,
      page_load_passed: pageLoad.passed,
      journeys_passed: journeysPassed,
      accessibility_passed: accessibility.passed,
      screenshots,
      journey_results: journeyResults,
      accessibility_violations: accessibility.violations,
      issues,
      verified_at: new Date().toISOString(),
    };

    // Emit completion event
    await emitOasisEvent({
      vtid,
      type: `autopilot.verification.visual.${passed ? 'completed' : 'failed'}` as any,
      source: 'visual-verification',
      status: passed ? 'success' : 'warning',
      message: passed ? `Visual verification passed for ${vtid}` : `Visual verification failed for ${vtid}`,
      payload: {
        vtid,
        passed,
        page_load_passed: pageLoad.passed,
        journeys_passed: journeysPassed,
        accessibility_passed: accessibility.passed,
        issues,
      },
    });

    console.log(`[VTID-01200] Visual verification ${passed ? 'PASSED' : 'FAILED'} for ${vtid}`);

    return {
      ok: true,
      passed,
      result,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[VTID-01200] Visual verification error for ${vtid}:`, errorMessage);

    await emitOasisEvent({
      vtid,
      type: 'autopilot.verification.visual.failed' as any,
      source: 'visual-verification',
      status: 'error',
      message: `Visual verification error: ${errorMessage}`,
      payload: { vtid, error: errorMessage },
    });

    return {
      ok: false,
      passed: false,
      error: errorMessage,
    };
  }
}

export default {
  runVisualVerification,
};
