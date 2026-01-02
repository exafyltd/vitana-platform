/**
 * VTID-01127: Availability, Time-Window & Readiness Routes (D33)
 *
 * Gateway routes for the Availability, Time-Window & Readiness Engine.
 * Determines how much and how deep the system should act right now.
 *
 * Endpoints:
 * - POST /compute - Compute availability, time-window, and readiness
 * - GET /current - Get current cached availability for a session
 * - POST /override - Set user override (always wins immediately)
 * - DELETE /override - Clear user override
 * - GET /guardrails - Get guardrail context for downstream engines
 *
 * Hard Constraints:
 *   - Default to LOWER depth when uncertain
 *   - Never stack multiple asks in low availability
 *   - Monetization requires readiness_score >= threshold
 *   - User overrides always win immediately
 */

import { Router, Request, Response } from 'express';
import {
  computeAvailabilityReadiness,
  getCurrentAvailability,
  setUserOverride,
  clearUserOverride,
  getGuardrailContext,
  checkForAutoDowngrade,
  shouldPromptLightweightCorrection
} from '../services/d33-availability-readiness-engine';
import {
  ComputeAvailabilityRequestSchema,
  OverrideAvailabilityRequestSchema,
  formatGuardrailContextForPrompt
} from '../types/availability-readiness';

const router = Router();

// VTID for logging
const VTID = 'VTID-01127';
const LOG_PREFIX = '[D33-Routes]';

// =============================================================================
// Auth Helpers
// =============================================================================

/**
 * Extract Bearer token from Authorization header
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Check if running in dev-sandbox mode
 */
function isDevSandbox(): boolean {
  const env = (process.env.ENVIRONMENT || process.env.VITANA_ENV || '').toLowerCase();
  return env === 'dev-sandbox' ||
         env === 'dev' ||
         env === 'development' ||
         env === 'sandbox' ||
         env.includes('dev') ||
         env.includes('sandbox');
}

// =============================================================================
// POST /compute
// Compute availability, time-window, and readiness from signals
// =============================================================================

router.post('/compute', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  // In dev mode, allow unauthenticated requests
  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /compute - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parseResult = ComputeAvailabilityRequestSchema.safeParse(req.body);

  if (!parseResult.success) {
    console.warn(`${LOG_PREFIX} POST /compute - Invalid request:`, parseResult.error.message);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'Invalid request body',
      details: parseResult.error.errors
    });
  }

  const input = parseResult.data;

  // If time_context not provided, infer from server time
  if (!input.time_context) {
    const now = new Date();
    input.time_context = {
      current_hour: now.getHours(),
      day_of_week: now.getDay(),
      is_weekend: now.getDay() === 0 || now.getDay() === 6
    };
  }

  // Compute availability/readiness
  const result = await computeAvailabilityReadiness(input);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /compute - Computation failed:`, result.error);
    return res.status(500).json(result);
  }

  console.log(`${LOG_PREFIX} POST /compute - Success: tag=${result.bundle?.availability_tag}`);
  return res.json(result);
});

// =============================================================================
// GET /current
// Get current cached availability for a session
// =============================================================================

router.get('/current', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /current - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const sessionId = req.query.session_id as string;

  if (!sessionId) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'session_id query parameter is required'
    });
  }

  const result = await getCurrentAvailability(sessionId);

  if (!result.cached) {
    console.log(`${LOG_PREFIX} GET /current - No cached data for ${sessionId}`);
    return res.json({
      ok: true,
      has_data: false,
      cached: false,
      message: 'No cached availability data. Call POST /compute first.'
    });
  }

  console.log(`${LOG_PREFIX} GET /current - Success: session=${sessionId}, age=${result.cache_age_seconds?.toFixed(1)}s`);
  return res.json({
    ok: true,
    has_data: true,
    ...result
  });
});

// =============================================================================
// POST /override
// Set user override for availability/readiness (always wins)
// =============================================================================

router.post('/override', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /override - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const sessionId = req.query.session_id as string || req.body.session_id;

  if (!sessionId) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'session_id is required'
    });
  }

  // Validate override request
  const parseResult = OverrideAvailabilityRequestSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'Invalid override request',
      details: parseResult.error.errors
    });
  }

  const override = parseResult.data;

  // At least one override field must be provided
  if (!override.availability && override.time_available_minutes === undefined && !override.readiness) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'At least one of availability, time_available_minutes, or readiness must be provided'
    });
  }

  const result = await setUserOverride(sessionId, override);

  console.log(`${LOG_PREFIX} POST /override - Success: session=${sessionId}, override_id=${result.override_id}`);
  return res.json(result);
});

// =============================================================================
// DELETE /override
// Clear user override
// =============================================================================

router.delete('/override', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} DELETE /override - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const sessionId = req.query.session_id as string;

  if (!sessionId) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'session_id query parameter is required'
    });
  }

  const result = await clearUserOverride(sessionId);

  console.log(`${LOG_PREFIX} DELETE /override - session=${sessionId}, cleared=${result.cleared}`);
  return res.json(result);
});

// =============================================================================
// GET /guardrails
// Get formatted guardrail context for downstream engines
// =============================================================================

router.get('/guardrails', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /guardrails - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const sessionId = req.query.session_id as string;

  if (!sessionId) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'session_id query parameter is required'
    });
  }

  const currentResult = await getCurrentAvailability(sessionId);

  if (!currentResult.cached || !currentResult.bundle) {
    return res.json({
      ok: true,
      has_guardrails: false,
      message: 'No availability data. Guardrails will use defaults.'
    });
  }

  const guardrailContext = getGuardrailContext(currentResult.bundle);
  const promptContext = formatGuardrailContextForPrompt(guardrailContext);

  console.log(`${LOG_PREFIX} GET /guardrails - Success: tag=${guardrailContext.availability_tag}`);
  return res.json({
    ok: true,
    has_guardrails: true,
    guardrails: guardrailContext,
    prompt_context: promptContext
  });
});

// =============================================================================
// POST /check-downgrade
// Check if we should auto-downgrade based on hesitation signals
// =============================================================================

router.post('/check-downgrade', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { session_id, hesitation_detected } = req.body;

  if (!session_id) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'session_id is required'
    });
  }

  const result = await checkForAutoDowngrade(session_id, hesitation_detected === true);

  return res.json({
    ok: true,
    ...result
  });
});

// =============================================================================
// GET /should-prompt-correction
// Check if we should show "Too much right now?" prompt
// =============================================================================

router.get('/should-prompt-correction', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const sessionId = req.query.session_id as string;

  if (!sessionId) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'session_id query parameter is required'
    });
  }

  const currentResult = await getCurrentAvailability(sessionId);

  if (!currentResult.cached || !currentResult.bundle) {
    return res.json({
      ok: true,
      should_prompt: false,
      reason: 'No availability data'
    });
  }

  const shouldPrompt = shouldPromptLightweightCorrection(currentResult.bundle);

  return res.json({
    ok: true,
    should_prompt: shouldPrompt,
    readiness_score: currentResult.bundle.readiness.score,
    risk_flags: currentResult.bundle.readiness.risk_flags
  });
});

// =============================================================================
// GET /health
// Health check endpoint
// =============================================================================

router.get('/health', async (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    service: 'D33 Availability & Readiness Engine',
    vtid: VTID,
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// =============================================================================
// GET /info
// Service info endpoint
// =============================================================================

router.get('/info', async (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    service: 'D33 Availability, Time-Window & Readiness Engine',
    vtid: VTID,
    version: '1.0.0',
    description: 'Determines how much and how deep the system should act right now',
    endpoints: [
      { method: 'POST', path: '/compute', description: 'Compute availability, time-window, and readiness' },
      { method: 'GET', path: '/current', description: 'Get current cached availability' },
      { method: 'POST', path: '/override', description: 'Set user override (always wins)' },
      { method: 'DELETE', path: '/override', description: 'Clear user override' },
      { method: 'GET', path: '/guardrails', description: 'Get guardrail context for downstream engines' },
      { method: 'POST', path: '/check-downgrade', description: 'Check for auto-downgrade on hesitation' },
      { method: 'GET', path: '/should-prompt-correction', description: 'Check if should show "Too much right now?"' },
      { method: 'GET', path: '/health', description: 'Health check' }
    ],
    availability_levels: ['low', 'medium', 'high', 'unknown'],
    time_windows: ['immediate', 'short', 'extended', 'defer'],
    availability_tags: ['quick_only', 'light_flow_ok', 'deep_flow_ok', 'defer_actions'],
    behavioral_rules: [
      'Default to LOWER depth when uncertain',
      'Never stack multiple asks in low availability',
      'Monetization requires readiness_score >= 0.6',
      'User overrides always win immediately'
    ]
  });
});

export default router;
