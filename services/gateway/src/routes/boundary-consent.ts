/**
 * VTID-01135: D41 - Ethical Boundaries, Personal Limits & Consent Sensitivity Routes
 *
 * Gateway routes for the Boundary & Consent Sensitivity Engine.
 * Ensures the system NEVER crosses personal, ethical, or psychological boundaries.
 *
 * Endpoints:
 * - GET /boundaries - Get personal boundaries
 * - POST /boundaries - Set a personal boundary
 * - GET /consent - Get consent bundle
 * - POST /consent - Set consent for a topic
 * - DELETE /consent/:topic - Revoke consent for a topic
 * - POST /check - Check if an action is within boundaries
 * - POST /filter - Filter a set of actions based on boundaries
 * - GET /vulnerability - Get current vulnerability indicators
 * - GET /orb-context - Get formatted context for ORB system prompt
 *
 * Hard Constraints (from spec):
 *   - Never infer sensitive traits without explicit consent
 *   - Never escalate intimacy or depth automatically
 *   - Silence is NOT consent
 *   - Emotional vulnerability suppresses monetization
 *   - Default to protection when uncertain
 *   - Boundaries override optimization goals
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  getPersonalBoundaries,
  setPersonalBoundary,
  getConsentBundle,
  setConsent,
  revokeConsent,
  checkConsent,
  checkBoundary,
  filterActions,
  detectVulnerability,
  getOrbBoundaryContext,
  isActionAllowed
} from '../services/d41-boundary-consent-engine';
import {
  SetBoundaryRequestSchema,
  SetConsentRequestSchema,
  RevokeConsentRequestSchema,
  BoundaryCheckInputSchema,
  FilterActionsRequestSchema,
  ConsentTopic
} from '../types/boundary-consent';

const router = Router();

// VTID for logging
const VTID = 'VTID-01135';
const LOG_PREFIX = '[D41-Routes]';

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
 * Require auth or dev mode
 */
function requireAuth(req: Request, res: Response): string | null {
  const token = getBearerToken(req);
  if (!token && !isDevSandbox()) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    return null;
  }
  return token || '';
}

// =============================================================================
// GET /boundaries
// Get personal boundaries for the current user
// =============================================================================

router.get('/boundaries', async (req: Request, res: Response) => {
  const token = requireAuth(req, res);
  if (token === null) return;

  try {
    const result = await getPersonalBoundaries(token || undefined);

    if (!result.ok) {
      console.error(`${LOG_PREFIX} GET /boundaries - Failed:`, result.error);
      return res.status(500).json(result);
    }

    console.log(`${LOG_PREFIX} GET /boundaries - Success`);
    return res.json(result);

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} GET /boundaries - Error:`, errorMessage);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// =============================================================================
// POST /boundaries
// Set a personal boundary
// =============================================================================

router.post('/boundaries', async (req: Request, res: Response) => {
  const token = requireAuth(req, res);
  if (token === null) return;

  try {
    // Validate request body
    const parseResult = SetBoundaryRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      console.warn(`${LOG_PREFIX} POST /boundaries - Invalid request:`, parseResult.error.message);
      return res.status(400).json({
        ok: false,
        error: 'INVALID_REQUEST',
        message: parseResult.error.message
      });
    }

    const result = await setPersonalBoundary(parseResult.data, token || undefined);

    if (!result.ok) {
      console.error(`${LOG_PREFIX} POST /boundaries - Failed:`, result.error);
      return res.status(500).json(result);
    }

    console.log(`${LOG_PREFIX} POST /boundaries - Success, type=${parseResult.data.boundary_type}`);
    return res.json(result);

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} POST /boundaries - Error:`, errorMessage);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// =============================================================================
// GET /consent
// Get consent bundle for the current user
// =============================================================================

router.get('/consent', async (req: Request, res: Response) => {
  const token = requireAuth(req, res);
  if (token === null) return;

  try {
    const result = await getConsentBundle(token || undefined);

    if (!result.ok) {
      console.error(`${LOG_PREFIX} GET /consent - Failed:`, result.error);
      return res.status(500).json(result);
    }

    console.log(`${LOG_PREFIX} GET /consent - Success, count=${result.consent_bundle?.consent_count || 0}`);
    return res.json(result);

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} GET /consent - Error:`, errorMessage);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// =============================================================================
// POST /consent
// Set consent for a topic
// =============================================================================

router.post('/consent', async (req: Request, res: Response) => {
  const token = requireAuth(req, res);
  if (token === null) return;

  try {
    // Validate request body
    const parseResult = SetConsentRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      console.warn(`${LOG_PREFIX} POST /consent - Invalid request:`, parseResult.error.message);
      return res.status(400).json({
        ok: false,
        error: 'INVALID_REQUEST',
        message: parseResult.error.message
      });
    }

    const result = await setConsent(parseResult.data, token || undefined);

    if (!result.ok) {
      console.error(`${LOG_PREFIX} POST /consent - Failed:`, result.error);
      return res.status(500).json(result);
    }

    console.log(`${LOG_PREFIX} POST /consent - Success, topic=${parseResult.data.topic}, status=${parseResult.data.status}`);
    return res.json(result);

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} POST /consent - Error:`, errorMessage);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// =============================================================================
// DELETE /consent/:topic
// Revoke consent for a topic
// =============================================================================

router.delete('/consent/:topic', async (req: Request, res: Response) => {
  const token = requireAuth(req, res);
  if (token === null) return;

  try {
    const { topic } = req.params;
    const { reason } = req.body || {};

    if (!topic) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_REQUEST',
        message: 'topic is required'
      });
    }

    const result = await revokeConsent(
      { topic: topic as ConsentTopic, reason },
      token || undefined
    );

    if (!result.ok) {
      console.error(`${LOG_PREFIX} DELETE /consent - Failed:`, result.error);
      return res.status(500).json(result);
    }

    console.log(`${LOG_PREFIX} DELETE /consent - Success, topic=${topic}`);
    return res.json(result);

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} DELETE /consent - Error:`, errorMessage);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// =============================================================================
// GET /consent/:topic
// Check consent for a specific topic
// =============================================================================

router.get('/consent/:topic', async (req: Request, res: Response) => {
  const token = requireAuth(req, res);
  if (token === null) return;

  try {
    const { topic } = req.params;

    if (!topic) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_REQUEST',
        message: 'topic is required'
      });
    }

    const result = await checkConsent(topic as ConsentTopic, token || undefined);

    console.log(`${LOG_PREFIX} GET /consent/${topic} - Success, granted=${result.granted}`);
    return res.json({
      ok: true,
      topic,
      granted: result.granted,
      status: result.status,
      confidence: result.confidence
    });

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} GET /consent/:topic - Error:`, errorMessage);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// =============================================================================
// POST /check
// Check if an action is within boundaries
// =============================================================================

router.post('/check', async (req: Request, res: Response) => {
  const token = requireAuth(req, res);
  if (token === null) return;

  try {
    // Validate request body
    const parseResult = BoundaryCheckInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      console.warn(`${LOG_PREFIX} POST /check - Invalid request:`, parseResult.error.message);
      return res.status(400).json({
        ok: false,
        error: 'INVALID_REQUEST',
        message: parseResult.error.message
      });
    }

    const result = await checkBoundary(parseResult.data, token || undefined);

    if (!result.ok) {
      console.error(`${LOG_PREFIX} POST /check - Failed:`, result.error);
      return res.status(500).json(result);
    }

    console.log(`${LOG_PREFIX} POST /check - Success, allowed=${result.result?.allowed}`);
    return res.json(result);

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} POST /check - Error:`, errorMessage);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// =============================================================================
// POST /filter
// Filter a set of actions based on boundaries
// =============================================================================

router.post('/filter', async (req: Request, res: Response) => {
  const token = requireAuth(req, res);
  if (token === null) return;

  try {
    // Validate request body
    const parseResult = FilterActionsRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      console.warn(`${LOG_PREFIX} POST /filter - Invalid request:`, parseResult.error.message);
      return res.status(400).json({
        ok: false,
        error: 'INVALID_REQUEST',
        message: parseResult.error.message
      });
    }

    const result = await filterActions(parseResult.data, token || undefined);

    if (!result.ok) {
      console.error(`${LOG_PREFIX} POST /filter - Failed:`, result.error);
      return res.status(500).json(result);
    }

    console.log(`${LOG_PREFIX} POST /filter - Success, allowed=${result.allowed_count}/${result.filtered_count}`);
    return res.json(result);

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} POST /filter - Error:`, errorMessage);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// =============================================================================
// GET /vulnerability
// Get current vulnerability indicators
// =============================================================================

router.get('/vulnerability', async (req: Request, res: Response) => {
  const token = requireAuth(req, res);
  if (token === null) return;

  try {
    // Optional D28 and D36 signals from query/headers
    const emotionalSignals = req.query.emotional_signals ?
      JSON.parse(req.query.emotional_signals as string) : undefined;
    const financialSignals = req.query.financial_signals ?
      JSON.parse(req.query.financial_signals as string) : undefined;

    const result = await detectVulnerability(
      token || undefined,
      emotionalSignals,
      financialSignals
    );

    if (!result.ok) {
      console.error(`${LOG_PREFIX} GET /vulnerability - Failed:`, result.error);
      return res.status(500).json(result);
    }

    console.log(`${LOG_PREFIX} GET /vulnerability - Success, score=${result.indicators?.overall_vulnerability_score}`);
    return res.json(result);

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} GET /vulnerability - Error:`, errorMessage);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// =============================================================================
// GET /orb-context
// Get formatted boundary context for ORB system prompt injection
// =============================================================================

router.get('/orb-context', async (req: Request, res: Response) => {
  const token = requireAuth(req, res);
  if (token === null) return;

  try {
    // Optional D28 and D36 signals from query/headers
    const emotionalSignals = req.query.emotional_signals ?
      JSON.parse(req.query.emotional_signals as string) : undefined;
    const financialSignals = req.query.financial_signals ?
      JSON.parse(req.query.financial_signals as string) : undefined;

    const result = await getOrbBoundaryContext(
      token || undefined,
      emotionalSignals,
      financialSignals
    );

    if (!result) {
      // Return safe defaults if no context available
      return res.json({
        ok: true,
        has_boundaries: false,
        context: null,
        orb_context: null
      });
    }

    console.log(`${LOG_PREFIX} GET /orb-context - Success`);
    return res.json({
      ok: true,
      has_boundaries: true,
      context: result.context,
      orb_context: result.orbContext
    });

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} GET /orb-context - Error:`, errorMessage);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// =============================================================================
// GET /allowed/:actionType
// Quick check if an action type is allowed
// =============================================================================

router.get('/allowed/:actionType', async (req: Request, res: Response) => {
  const token = requireAuth(req, res);
  if (token === null) return;

  try {
    const { actionType } = req.params;

    if (!actionType) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_REQUEST',
        message: 'actionType is required'
      });
    }

    // Validate action type
    const validActionTypes = [
      'health_guidance',
      'social_introduction',
      'monetization',
      'proactive_nudge',
      'memory_surfacing',
      'autonomy_action',
      'content_delivery',
      'data_access'
    ];

    if (!validActionTypes.includes(actionType)) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_REQUEST',
        message: `Invalid actionType. Must be one of: ${validActionTypes.join(', ')}`
      });
    }

    const allowed = await isActionAllowed(
      actionType as 'health_guidance' | 'social_introduction' | 'monetization' | 'proactive_nudge' | 'memory_surfacing' | 'autonomy_action' | 'content_delivery' | 'data_access',
      token || undefined
    );

    console.log(`${LOG_PREFIX} GET /allowed/${actionType} - ${allowed ? 'ALLOWED' : 'BLOCKED'}`);
    return res.json({
      ok: true,
      action_type: actionType,
      allowed
    });

  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`${LOG_PREFIX} GET /allowed/:actionType - Error:`, errorMessage);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// =============================================================================
// GET /status
// Health check and status endpoint
// =============================================================================

router.get('/status', async (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    service: 'D41 Boundary & Consent Engine',
    vtid: VTID,
    version: '1.0.0',
    status: 'operational',
    hard_constraints: {
      no_sensitive_inference: true,
      no_auto_escalation: true,
      silence_not_consent: true,
      vulnerability_suppresses_monetization: true,
      default_protective: true,
      boundaries_override_optimization: true
    }
  });
});

export default router;
