/**
 * VTID-01130: D36 Financial Monetization Routes
 *
 * Gateway routes for the Financial Sensitivity, Monetization Readiness & Value Perception Engine.
 * Ensures monetization is context-appropriate, socially safe, and aligned with user value perception.
 *
 * Endpoints:
 * - POST /context       - Compute full monetization context
 * - GET  /envelope      - Get current monetization envelope
 * - POST /signal        - Record a monetization signal (financial or value)
 * - POST /attempt       - Record a monetization attempt outcome
 * - GET  /history       - Get monetization attempt history
 * - GET  /orb-context   - Get formatted context for ORB system prompt
 * - POST /process       - Process message and return ORB-ready context
 *
 * Hard Constraints (Non-Negotiable):
 *   - Never lead with price — always lead with value
 *   - Never stack multiple paid suggestions
 *   - No monetization when emotional vulnerability is detected
 *   - Explicit user "no" blocks monetization immediately
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  computeMonetizationContext,
  getMonetizationEnvelope,
  recordSignal,
  recordAttempt,
  getMonetizationHistory,
  getOrbMonetizationContext,
  processMessageForOrb,
  detectFinancialSignals,
  detectValueSignals
} from '../services/d36-financial-monetization-engine';
import {
  FINANCIAL_SIGNAL_TYPES,
  VALUE_SIGNAL_TYPES,
  MONETIZATION_TYPES,
  MONETIZATION_OUTCOMES
} from '../types/financial-monetization';

const router = Router();

// VTID for logging
const VTID = 'VTID-01130';
const LOG_PREFIX = '[D36-Routes]';

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
// POST /context
// Compute full monetization context including sensitivity, readiness, and envelope
// =============================================================================

router.post('/context', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /context - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { message, session_id, intent, product_type } = req.body;

  const result = await computeMonetizationContext(
    message,
    session_id,
    token || undefined
  );

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /context - Failed:`, result.error);
    return res.status(500).json(result);
  }

  console.log(`${LOG_PREFIX} POST /context - Success, allow_paid=${result.envelope?.allow_paid}`);
  return res.json(result);
});

// =============================================================================
// GET /envelope
// Get current monetization envelope (what types of paid actions are allowed)
// =============================================================================

router.get('/envelope', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /envelope - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const sessionId = req.query.session_id as string | undefined;
  const productType = req.query.product_type as string | undefined;
  const forceRecompute = req.query.force === 'true';

  const result = await getMonetizationEnvelope(
    sessionId,
    productType as any,
    forceRecompute,
    token || undefined
  );

  if (!result.ok) {
    console.error(`${LOG_PREFIX} GET /envelope - Failed:`, result.error);
    return res.status(500).json(result);
  }

  console.log(`${LOG_PREFIX} GET /envelope - Success, allow_paid=${result.envelope?.allow_paid}`);
  return res.json(result);
});

// =============================================================================
// POST /signal
// Record a monetization signal (from user behavior)
// =============================================================================

router.post('/signal', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /signal - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { signal_type, indicator, context, session_id } = req.body;

  // Validate signal type
  const validSignalTypes = [...FINANCIAL_SIGNAL_TYPES, ...VALUE_SIGNAL_TYPES];
  if (!signal_type || !validSignalTypes.includes(signal_type)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: `signal_type must be one of: ${validSignalTypes.join(', ')}`
    });
  }

  // Validate indicator
  if (indicator && !['positive', 'negative', 'neutral'].includes(indicator)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'indicator must be positive, negative, or neutral'
    });
  }

  const result = await recordSignal(
    signal_type,
    indicator || 'neutral',
    context,
    session_id,
    token || undefined
  );

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /signal - Failed:`, result.error);
    return res.status(500).json(result);
  }

  console.log(`${LOG_PREFIX} POST /signal - Recorded ${signal_type}`);
  return res.json(result);
});

// =============================================================================
// POST /attempt
// Record a monetization attempt outcome
// =============================================================================

router.post('/attempt', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /attempt - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { attempt_type, outcome, user_response, session_id } = req.body;

  // Validate attempt type
  if (!attempt_type || !MONETIZATION_TYPES.includes(attempt_type)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: `attempt_type must be one of: ${MONETIZATION_TYPES.join(', ')}`
    });
  }

  // Validate outcome
  if (!outcome || !MONETIZATION_OUTCOMES.includes(outcome)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: `outcome must be one of: ${MONETIZATION_OUTCOMES.join(', ')}`
    });
  }

  const result = await recordAttempt(
    attempt_type,
    outcome,
    user_response,
    session_id,
    token || undefined
  );

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /attempt - Failed:`, result.error);
    return res.status(500).json(result);
  }

  console.log(`${LOG_PREFIX} POST /attempt - Recorded ${attempt_type}:${outcome}, cooldown=${result.cooldown_triggered}`);
  return res.json(result);
});

// =============================================================================
// GET /history
// Get monetization attempt history
// =============================================================================

router.get('/history', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /history - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const limit = parseInt(req.query.limit as string) || 20;

  const result = await getMonetizationHistory(limit, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} GET /history - Failed:`, result.error);
    return res.status(500).json(result);
  }

  console.log(`${LOG_PREFIX} GET /history - Success, count=${result.attempts?.length}`);
  return res.json(result);
});

// =============================================================================
// GET /orb-context
// Get formatted monetization context for ORB system prompt injection
// =============================================================================

router.get('/orb-context', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /orb-context - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const sessionId = req.query.session_id as string | undefined;

  const result = await getOrbMonetizationContext(sessionId, token || undefined);

  if (!result) {
    return res.json({
      ok: true,
      has_context: false,
      context: null,
      orb_context: null
    });
  }

  console.log(`${LOG_PREFIX} GET /orb-context - Success`);
  return res.json({
    ok: true,
    has_context: true,
    context: result.context,
    orb_context: result.orbContext
  });
});

// =============================================================================
// POST /process
// Process a message and return ORB-ready monetization context
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

  const result = await processMessageForOrb(message, session_id, token || undefined);

  if (!result) {
    return res.json({
      ok: true,
      has_context: false,
      context: null,
      orb_context: null
    });
  }

  console.log(`${LOG_PREFIX} POST /process - Success`);
  return res.json({
    ok: true,
    has_context: true,
    context: result.context,
    orb_context: result.orbContext
  });
});

// =============================================================================
// POST /detect
// Detect signals from a message without recording (for testing/debugging)
// =============================================================================

router.post('/detect', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /detect - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { message } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'message is required and must be a string'
    });
  }

  const financialSignals = detectFinancialSignals(message);
  const valueSignals = detectValueSignals(message);

  console.log(`${LOG_PREFIX} POST /detect - Found ${financialSignals.length} financial, ${valueSignals.length} value signals`);

  return res.json({
    ok: true,
    financial_signals: financialSignals,
    value_signals: valueSignals,
    total_count: financialSignals.length + valueSignals.length
  });
});

// =============================================================================
// GET /config
// Get current monetization configuration (for admin/debugging)
// =============================================================================

router.get('/config', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  return res.json({
    ok: true,
    config: {
      vtid: VTID,
      readiness_threshold: 0.6,
      rejection_cooldown_minutes: 30,
      max_attempts_per_session: 2,
      envelope_validity_minutes: 15,
      blocking_emotional_states: ['stressed', 'frustrated', 'anxious'],
      valid_signal_types: [...FINANCIAL_SIGNAL_TYPES],
      valid_value_signal_types: [...VALUE_SIGNAL_TYPES],
      valid_monetization_types: [...MONETIZATION_TYPES],
      valid_outcomes: [...MONETIZATION_OUTCOMES]
    }
  });
});

export default router;
