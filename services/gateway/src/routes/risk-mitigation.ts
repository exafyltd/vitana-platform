/**
 * VTID-01143: D49 Proactive Health & Lifestyle Risk Mitigation Layer Routes
 *
 * Endpoints for the D49 Risk Mitigation Engine.
 * Provides mitigation generation, dismissal, acknowledgment, and history.
 *
 * Endpoints:
 * - POST /api/v1/mitigation/generate     - Generate mitigations from risk windows
 * - POST /api/v1/mitigation/dismiss      - Dismiss a mitigation
 * - POST /api/v1/mitigation/acknowledge  - Acknowledge a mitigation
 * - GET  /api/v1/mitigation/active       - Get active mitigations
 * - GET  /api/v1/mitigation/history      - Get mitigation history
 * - POST /api/v1/mitigation/expire       - Expire old mitigations (admin)
 * - GET  /api/v1/mitigation/health       - Health check
 * - GET  /api/v1/mitigation/config       - Get configuration
 * - GET  /api/v1/mitigation/domains      - Get available domains
 *
 * HARD GOVERNANCE (NON-NEGOTIABLE):
 * - Safety > optimization
 * - No diagnosis, no treatment
 * - No medical claims
 * - Suggestions only, never actions
 * - Explainability mandatory
 *
 * Position in Intelligence Stack:
 * D44 Early Signals -> D45 Risk Windows -> D49 Risk Mitigation
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  generateMitigations,
  dismissMitigation,
  getActiveMitigations,
  getMitigationHistory,
  acknowledgeMitigation,
  expireOldMitigations,
  VTID
} from '../services/d49-risk-mitigation-engine';
import {
  MitigationDomain,
  MitigationStatus,
  MITIGATION_THRESHOLDS,
  DOMAIN_CONFIG,
  SAFE_LANGUAGE_PATTERNS,
  GenerateMitigationsRequestSchema,
  DismissMitigationRequestSchema,
  GetActiveMitigationsRequestSchema,
  GetMitigationHistoryRequestSchema
} from '../types/risk-mitigation';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();
const ENGINE_VERSION = '1.0.0';

// =============================================================================
// VTID-01143: Request Validation Schemas
// =============================================================================

/**
 * Schema for acknowledge request
 */
const AcknowledgeRequestSchema = z.object({
  mitigation_id: z.string().uuid()
});

// =============================================================================
// VTID-01143: POST /api/v1/mitigation/generate
// =============================================================================

/**
 * Generate mitigations from risk windows and early signals
 *
 * This is the primary endpoint for D49. It takes risk windows from D45
 * and early signals from D44, and generates low-friction mitigation suggestions.
 *
 * Mitigation Rules:
 * - Risk confidence >= 75%
 * - Low effort, reversible, non-invasive actions only
 * - No similar mitigation shown in last 14 days
 */
router.post('/generate', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    // Validate request body
    const parseResult = GenerateMitigationsRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid request body',
        details: parseResult.error.errors
      });
    }

    const authToken = req.headers.authorization?.replace('Bearer ', '');
    const result = await generateMitigations(parseResult.data, authToken);

    const duration = Date.now() - startTime;

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.error,
        duration_ms: duration
      });
    }

    return res.json({
      ok: true,
      mitigations: result.mitigations,
      count: result.mitigations?.length || 0,
      skipped_count: result.skipped_count,
      generation_id: result.generation_id,
      duration_ms: duration,
      disclaimer: SAFE_LANGUAGE_PATTERNS.disclaimers[0]
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[D49-Routes] Error in /generate:`, errorMessage);

    await emitOasisEvent({
      vtid: VTID,
      type: 'risk_mitigation.error' as any,
      source: 'd49-risk-mitigation-routes',
      status: 'error',
      message: `Mitigation generation failed: ${errorMessage}`,
      payload: { error: errorMessage }
    });

    return res.status(500).json({
      ok: false,
      error: errorMessage
    });
  }
});

// =============================================================================
// VTID-01143: POST /api/v1/mitigation/dismiss
// =============================================================================

/**
 * Dismiss a mitigation
 *
 * Users can always dismiss any mitigation without consequence.
 * This is a core safety feature - users are never forced to act.
 */
router.post('/dismiss', async (req: Request, res: Response) => {
  try {
    const parseResult = DismissMitigationRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid request body',
        details: parseResult.error.errors
      });
    }

    const authToken = req.headers.authorization?.replace('Bearer ', '');
    const result = await dismissMitigation(parseResult.data, authToken);

    if (!result.ok) {
      const status = result.error === 'NOT_FOUND' ? 404 : 500;
      return res.status(status).json({
        ok: false,
        error: result.error
      });
    }

    return res.json({
      ok: true,
      mitigation_id: result.mitigation_id,
      dismissed_at: result.dismissed_at,
      message: 'Mitigation dismissed - thank you for the feedback'
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[D49-Routes] Error in /dismiss:`, errorMessage);
    return res.status(500).json({
      ok: false,
      error: errorMessage
    });
  }
});

// =============================================================================
// VTID-01143: POST /api/v1/mitigation/acknowledge
// =============================================================================

/**
 * Acknowledge a mitigation (mark as viewed)
 *
 * This indicates the user saw the suggestion. It does not imply
 * they will act on it.
 */
router.post('/acknowledge', async (req: Request, res: Response) => {
  try {
    const parseResult = AcknowledgeRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid request body',
        details: parseResult.error.errors
      });
    }

    const authToken = req.headers.authorization?.replace('Bearer ', '');
    const result = await acknowledgeMitigation(parseResult.data.mitigation_id, authToken);

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.error
      });
    }

    return res.json({
      ok: true,
      mitigation_id: parseResult.data.mitigation_id,
      acknowledged: true
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[D49-Routes] Error in /acknowledge:`, errorMessage);
    return res.status(500).json({
      ok: false,
      error: errorMessage
    });
  }
});

// =============================================================================
// VTID-01143: GET /api/v1/mitigation/active
// =============================================================================

/**
 * Get active mitigations for the current user
 */
router.get('/active', async (req: Request, res: Response) => {
  try {
    const domains = req.query.domains
      ? (req.query.domains as string).split(',') as MitigationDomain[]
      : undefined;
    const limit = req.query.limit
      ? parseInt(req.query.limit as string, 10)
      : 10;

    const parseResult = GetActiveMitigationsRequestSchema.safeParse({ domains, limit });
    if (!parseResult.success) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid query parameters',
        details: parseResult.error.errors
      });
    }

    const authToken = req.headers.authorization?.replace('Bearer ', '');
    const result = await getActiveMitigations(parseResult.data, authToken);

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.error
      });
    }

    return res.json({
      ok: true,
      mitigations: result.mitigations,
      count: result.count,
      disclaimer: SAFE_LANGUAGE_PATTERNS.disclaimers[0]
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[D49-Routes] Error in /active:`, errorMessage);
    return res.status(500).json({
      ok: false,
      error: errorMessage
    });
  }
});

// =============================================================================
// VTID-01143: GET /api/v1/mitigation/history
// =============================================================================

/**
 * Get mitigation history for the current user
 */
router.get('/history', async (req: Request, res: Response) => {
  try {
    const domains = req.query.domains
      ? (req.query.domains as string).split(',') as MitigationDomain[]
      : undefined;
    const statuses = req.query.statuses
      ? (req.query.statuses as string).split(',') as MitigationStatus[]
      : undefined;
    const since = req.query.since as string | undefined;
    const limit = req.query.limit
      ? parseInt(req.query.limit as string, 10)
      : 20;

    const parseResult = GetMitigationHistoryRequestSchema.safeParse({
      domains,
      statuses,
      since,
      limit
    });

    if (!parseResult.success) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid query parameters',
        details: parseResult.error.errors
      });
    }

    const authToken = req.headers.authorization?.replace('Bearer ', '');
    const result = await getMitigationHistory(parseResult.data, authToken);

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.error
      });
    }

    return res.json({
      ok: true,
      mitigations: result.mitigations,
      count: result.count
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[D49-Routes] Error in /history:`, errorMessage);
    return res.status(500).json({
      ok: false,
      error: errorMessage
    });
  }
});

// =============================================================================
// VTID-01143: POST /api/v1/mitigation/expire (Admin)
// =============================================================================

/**
 * Expire old mitigations (cleanup job)
 *
 * This endpoint is typically called by a scheduled job.
 */
router.post('/expire', async (req: Request, res: Response) => {
  try {
    const authToken = req.headers.authorization?.replace('Bearer ', '');
    const result = await expireOldMitigations(authToken);

    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.error
      });
    }

    return res.json({
      ok: true,
      expired_count: result.expired_count,
      message: `Expired ${result.expired_count} old mitigation(s)`
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[D49-Routes] Error in /expire:`, errorMessage);
    return res.status(500).json({
      ok: false,
      error: errorMessage
    });
  }
});

// =============================================================================
// VTID-01143: GET /api/v1/mitigation/health
// =============================================================================

/**
 * Health check endpoint
 */
router.get('/health', async (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    vtid: VTID,
    engine: 'D49 Risk Mitigation Engine',
    version: ENGINE_VERSION,
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// =============================================================================
// VTID-01143: GET /api/v1/mitigation/config
// =============================================================================

/**
 * Get current configuration
 */
router.get('/config', async (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    vtid: VTID,
    version: ENGINE_VERSION,
    thresholds: MITIGATION_THRESHOLDS,
    governance: {
      safety_first: true,
      no_diagnosis: true,
      no_treatment: true,
      no_medical_claims: true,
      suggestions_only: true,
      always_dismissible: true,
      explainability_mandatory: true
    },
    safe_language_patterns: {
      prefixes: SAFE_LANGUAGE_PATTERNS.prefixes,
      suffixes: SAFE_LANGUAGE_PATTERNS.suffixes
    }
  });
});

// =============================================================================
// VTID-01143: GET /api/v1/mitigation/domains
// =============================================================================

/**
 * Get available mitigation domains
 */
router.get('/domains', async (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    domains: Object.entries(DOMAIN_CONFIG).map(([key, config]) => ({
      id: key,
      label: config.label,
      description: config.description,
      icon: config.icon,
      priority: config.priority,
      example_suggestions: config.example_suggestions
    }))
  });
});

// =============================================================================
// VTID-01143: GET /api/v1/mitigation/disclaimer
// =============================================================================

/**
 * Get safety disclaimer text
 */
router.get('/disclaimer', async (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    disclaimers: SAFE_LANGUAGE_PATTERNS.disclaimers,
    governance_statement: `
D49 Risk Mitigation Layer - Safety Statement

This system provides gentle, low-friction suggestions only.
It does NOT provide:
- Medical diagnosis
- Medical treatment recommendations
- Health outcome guarantees

All suggestions are:
- Low effort and reversible
- Always dismissible without consequence
- Based on general wellness principles

When in doubt, consult a qualified healthcare professional.
    `.trim()
  });
});

export default router;
