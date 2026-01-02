/**
 * VTID-01122: Health State, Energy & Capacity Awareness Routes (D37)
 *
 * Gateway routes for the Health State, Energy & Capacity Awareness Engine.
 * Understands the user's current physical and mental capacity to act —
 * without diagnosing, medicalizing, or overreaching.
 *
 * Endpoints:
 * - POST /compute - Compute capacity state from signals
 * - GET /current - Get current capacity state
 * - POST /override - User correction to override capacity state
 * - POST /filter - Filter actions by capacity
 * - GET /orb-context - Get formatted context for ORB system prompt
 * - GET /summary - Quick capacity summary
 *
 * Hard Constraints (from spec):
 *   - NEVER diagnose or label conditions
 *   - NEVER push intensity upward when energy is low
 *   - Respect self-reported fatigue immediately
 *   - Health inference must always be reversible
 *   - Err on the side of rest and safety
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  computeCapacity,
  getCurrentCapacity,
  overrideCapacity,
  filterActions,
  getOrbCapacityContext,
  processMessageForOrb,
  isActionWithinCapacity,
  getCapacitySummary
} from '../services/health-capacity-awareness-engine';
import {
  ComputeCapacityRequestSchema,
  OverrideCapacityRequestSchema,
  FilterActionsRequestSchema,
  EnergyState
} from '../types/health-capacity-awareness';

const router = Router();

// VTID for logging
const VTID = 'VTID-01122';
const LOG_PREFIX = '[D37-Routes]';

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
// Compute capacity state from signals
// =============================================================================

router.post('/compute', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  // In dev mode, allow unauthenticated requests
  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /compute - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parsed = ComputeCapacityRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    console.warn(`${LOG_PREFIX} POST /compute - Invalid request:`, parsed.error.message);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'Invalid request body',
      details: parsed.error.errors
    });
  }

  // Compute capacity
  const result = await computeCapacity(parsed.data, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /compute - Compute failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} POST /compute - Success, state=${result.capacity_state?.energy_state}`);
  return res.json(result);
});

// =============================================================================
// GET /current
// Get current capacity state (checking for overrides)
// =============================================================================

router.get('/current', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /current - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Optional session filter
  const sessionId = req.query.session_id as string | undefined;

  const result = await getCurrentCapacity(sessionId, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} GET /current - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} GET /current - Success, state=${result.capacity_state?.energy_state}`);
  return res.json(result);
});

// =============================================================================
// POST /override
// User correction to immediately override capacity state
// =============================================================================

router.post('/override', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /override - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parsed = OverrideCapacityRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    console.warn(`${LOG_PREFIX} POST /override - Invalid request:`, parsed.error.message);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'Invalid request body. energy_state must be low, moderate, or high.',
      details: parsed.error.errors
    });
  }

  const result = await overrideCapacity(parsed.data, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /override - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} POST /override - Success, new_state=${result.new_state}`);
  return res.json(result);
});

// =============================================================================
// POST /filter
// Filter actions by current capacity
// =============================================================================

router.post('/filter', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /filter - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parsed = FilterActionsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    console.warn(`${LOG_PREFIX} POST /filter - Invalid request:`, parsed.error.message);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'Invalid request body',
      details: parsed.error.errors
    });
  }

  const result = await filterActions(parsed.data, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /filter - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} POST /filter - Success, blocked=${result.blocked_count}, recommended=${result.recommended_count}`);
  return res.json(result);
});

// =============================================================================
// GET /orb-context
// Get formatted capacity context for ORB system prompt injection
// =============================================================================

router.get('/orb-context', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /orb-context - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const sessionId = req.query.session_id as string | undefined;

  const result = await getOrbCapacityContext(sessionId, token || undefined);

  if (!result) {
    // No capacity data available - this is not an error
    return res.json({
      ok: true,
      has_capacity: false,
      context: null,
      orb_context: null
    });
  }

  console.log(`${LOG_PREFIX} GET /orb-context - Success`);
  return res.json({
    ok: true,
    has_capacity: true,
    context: result.context,
    orb_context: result.orbContext
  });
});

// =============================================================================
// POST /process
// Convenience endpoint: compute capacity and return ORB-ready context
// =============================================================================

router.post('/process', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /process - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { message, session_id } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'message is required and must be a string'
    });
  }

  const result = await processMessageForOrb(
    message,
    session_id,
    token || undefined
  );

  if (!result) {
    return res.json({
      ok: true,
      has_capacity: false,
      context: null,
      orb_context: null
    });
  }

  console.log(`${LOG_PREFIX} POST /process - Success`);
  return res.json({
    ok: true,
    has_capacity: true,
    context: result.context,
    orb_context: result.orbContext
  });
});

// =============================================================================
// GET /summary
// Quick capacity summary for fast checks
// =============================================================================

router.get('/summary', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /summary - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const result = await getCapacitySummary(token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} GET /summary - Failed:`, result.error);
    return res.status(500).json(result);
  }

  console.log(`${LOG_PREFIX} GET /summary - Success, state=${result.energy_state}`);
  return res.json(result);
});

// =============================================================================
// POST /check-action
// Quick check if a single action is within capacity
// =============================================================================

router.post('/check-action', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /check-action - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { action, intensity } = req.body;

  if (!action || typeof action !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'action is required and must be a string'
    });
  }

  if (!intensity || !['restorative', 'light', 'moderate', 'high'].includes(intensity)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'intensity is required and must be restorative, light, moderate, or high'
    });
  }

  const result = await isActionWithinCapacity(action, intensity, token || undefined);

  console.log(`${LOG_PREFIX} POST /check-action - action=${action}, recommended=${result.recommended}`);
  return res.json(result);
});

// =============================================================================
// GET /rules
// List active capacity rules (for debugging/admin)
// =============================================================================

router.get('/rules', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  try {
    const supabase = token ? createUserSupabaseClient(token) : null;

    if (!supabase) {
      return res.status(500).json({ ok: false, error: 'SERVICE_UNAVAILABLE' });
    }

    const { data, error } = await supabase
      .from('capacity_rules')
      .select('rule_key, rule_version, signal_source, target_dimension, weight, decay_minutes, active')
      .eq('active', true)
      .order('signal_source')
      .order('weight', { ascending: false });

    if (error) {
      console.error(`${LOG_PREFIX} GET /rules - Error:`, error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({
      ok: true,
      rules: data,
      count: data?.length || 0
    });

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} GET /rules - Error:`, errorMessage);
    return res.status(500).json({ ok: false, error: errorMessage });
  }
});

export default router;
