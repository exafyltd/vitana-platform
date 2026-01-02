/**
 * VTID-01120: Emotional & Cognitive Signal Routes (D28)
 *
 * Gateway routes for the Emotional & Cognitive Signal Interpretation Engine.
 * Intelligence responds to *state*, not just content.
 *
 * Endpoints:
 * - POST /compute - Compute signals from a user message
 * - GET /current - Get current (non-decayed) signals
 * - POST /override/:signalId - User correction to override signals
 * - GET /explain/:signalId - Get detailed evidence for a signal
 * - GET /orb-context - Get formatted context for ORB system prompt
 *
 * Hard Constraints (from spec):
 *   - NO medical or psychological diagnosis
 *   - NO permanent emotional labeling
 *   - NO autonomy escalation from signals alone
 *   - Signals only modulate tone, pacing, and depth
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  computeSignals,
  getCurrentSignals,
  overrideSignal,
  explainSignal,
  getOrbSignalContext,
  processMessageForOrb
} from '../services/d28-emotional-cognitive-engine';

const router = Router();

// VTID for logging
const VTID = 'VTID-01120';
const LOG_PREFIX = '[D28-Routes]';

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

/**
 * Get user context from me_context RPC
 */
async function getUserContext(token: string): Promise<{
  ok: boolean;
  tenant_id: string | null;
  user_id: string | null;
  active_role: string | null;
  error?: string;
}> {
  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('me_context');

    if (error) {
      return { ok: false, tenant_id: null, user_id: null, active_role: null, error: error.message };
    }

    return {
      ok: true,
      tenant_id: data?.tenant_id || null,
      user_id: data?.user_id || data?.id || null,
      active_role: data?.active_role || null,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, tenant_id: null, user_id: null, active_role: null, error: errorMessage };
  }
}

// =============================================================================
// POST /compute
// Compute emotional & cognitive signals from a user message
// =============================================================================

router.post('/compute', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  // In dev mode, allow unauthenticated requests
  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /compute - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const { message, session_id, turn_id, response_time_seconds, correction_count, interaction_count } = req.body;

  if (!message || typeof message !== 'string') {
    console.warn(`${LOG_PREFIX} POST /compute - Missing or invalid message`);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'message is required and must be a string'
    });
  }

  // Compute signals
  const result = await computeSignals({
    message,
    session_id,
    turn_id,
    response_time_seconds,
    correction_count,
    interaction_count
  }, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /compute - Compute failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} POST /compute - Success, rules=${result.rules_applied?.length || 0}`);
  return res.json(result);
});

// =============================================================================
// GET /current
// Get current (non-decayed) signals for a user/session
// =============================================================================

router.get('/current', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /current - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Optional session filter
  const sessionId = req.query.session_id as string | undefined;

  const result = await getCurrentSignals(sessionId, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} GET /current - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} GET /current - Success, count=${result.count}`);
  return res.json(result);
});

// =============================================================================
// POST /override/:signalId
// User correction to immediately override signals
// =============================================================================

router.post('/override/:signalId', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /override - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { signalId } = req.params;
  const override = req.body;

  if (!signalId) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'signalId is required'
    });
  }

  if (!override || typeof override !== 'object') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'override data is required in request body'
    });
  }

  const result = await overrideSignal(signalId, override, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /override - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 :
                       result.error === 'SIGNAL_NOT_FOUND' ? 404 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} POST /override - Success, signalId=${signalId}`);
  return res.json(result);
});

// =============================================================================
// GET /explain/:signalId
// Get detailed evidence for a signal (D59 explainability support)
// =============================================================================

router.get('/explain/:signalId', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /explain - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { signalId } = req.params;

  if (!signalId) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'signalId is required'
    });
  }

  const result = await explainSignal(signalId, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} GET /explain - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 :
                       result.error === 'SIGNAL_NOT_FOUND' ? 404 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} GET /explain - Success, signalId=${signalId}`);
  return res.json(result);
});

// =============================================================================
// GET /orb-context
// Get formatted signal context for ORB system prompt injection
// =============================================================================

router.get('/orb-context', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /orb-context - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const sessionId = req.query.session_id as string | undefined;

  const result = await getOrbSignalContext(sessionId, token || undefined);

  if (!result) {
    // No signals available - this is not an error
    return res.json({
      ok: true,
      has_signals: false,
      context: null,
      orb_context: null
    });
  }

  console.log(`${LOG_PREFIX} GET /orb-context - Success`);
  return res.json({
    ok: true,
    has_signals: true,
    context: result.context,
    orb_context: result.orbContext
  });
});

// =============================================================================
// POST /process
// Convenience endpoint: compute signals and return ORB-ready context
// =============================================================================

router.post('/process', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /process - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { message, session_id, turn_id, response_time_seconds } = req.body;

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
    turn_id,
    response_time_seconds,
    token || undefined
  );

  if (!result) {
    return res.json({
      ok: true,
      has_signals: false,
      context: null,
      orb_context: null
    });
  }

  console.log(`${LOG_PREFIX} POST /process - Success`);
  return res.json({
    ok: true,
    has_signals: true,
    context: result.context,
    orb_context: result.orbContext,
    signal_id: result.signalId
  });
});

// =============================================================================
// GET /rules
// List active rules (for debugging/admin)
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
      .from('emotional_cognitive_rules')
      .select('rule_key, rule_version, domain, target_state, weight, decay_minutes, active')
      .eq('active', true)
      .order('domain')
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
