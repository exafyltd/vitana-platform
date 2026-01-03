/**
 * VTID-01141: D47 Proactive Social & Community Alignment Engine Routes
 *
 * API endpoints for social alignment suggestions that anticipate social needs
 * and proactively surface relevant people, groups, events, or activities.
 *
 * Endpoints:
 * - POST /api/v1/alignment/generate     - Generate new suggestions
 * - GET  /api/v1/alignment/suggestions  - Get current suggestions
 * - POST /api/v1/alignment/shown        - Mark suggestion as shown
 * - POST /api/v1/alignment/action       - Record action on suggestion
 * - POST /api/v1/alignment/cleanup      - Cleanup expired (service)
 * - GET  /api/v1/alignment/health       - Health check
 *
 * Hard Constraints (GOVERNANCE):
 * - Suggestions only (consent-by-design)
 * - No forced matchmaking
 * - Explainability mandatory
 * - All outputs logged to OASIS
 *
 * Dependencies: D35 (Social Context), D87 (Relationships)
 */

import { Router, Request, Response } from 'express';
import {
  generateSuggestions,
  getSuggestions,
  markSuggestionShown,
  actOnSuggestion,
  cleanupExpiredSuggestions
} from '../services/d47-social-alignment-engine';
import {
  GenerateSuggestionsRequestSchema,
  GetSuggestionsRequestSchema,
  MarkShownRequestSchema,
  ActOnSuggestionRequestSchema,
  ALIGNMENT_DOMAINS,
  ALIGNMENT_ACTIONS,
  ALIGNMENT_STATUSES
} from '../types/social-alignment';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// VTID-01141: Constants
// =============================================================================

const VTID = 'VTID-01141';
const LOG_PREFIX = '[D47-Routes]';

// =============================================================================
// VTID-01141: Helper Functions
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
 * Emit a social alignment OASIS event
 */
async function emitAlignmentEvent(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: VTID,
    type: type as any,
    source: 'gateway-d47',
    status,
    message,
    payload
  }).catch(err => console.warn(`${LOG_PREFIX} Failed to emit ${type}:`, err.message));
}

// =============================================================================
// VTID-01141: Routes
// =============================================================================

/**
 * POST /generate -> POST /api/v1/alignment/generate
 *
 * Generate new alignment suggestions for the current user.
 */
router.post('/generate', async (req: Request, res: Response) => {
  console.log(`${LOG_PREFIX} POST /alignment/generate`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Authentication required'
    });
  }

  // Validate request body
  const validation = GenerateSuggestionsRequestSchema.safeParse(req.body || {});
  if (!validation.success) {
    console.warn(`${LOG_PREFIX} Validation failed:`, validation.error.errors);
    await emitAlignmentEvent('social_alignment.error', 'warning', 'Validation failed', {
      errors: validation.error.errors
    });
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  try {
    const result = await generateSuggestions(validation.data, token);

    if (!result.ok) {
      return res.status(400).json(result);
    }

    console.log(`${LOG_PREFIX} Generated ${result.count} suggestions (batch: ${result.batch_id})`);

    return res.status(200).json(result);
  } catch (err: any) {
    console.error(`${LOG_PREFIX} generate error:`, err.message);
    await emitAlignmentEvent('social_alignment.error', 'error', err.message, { error: err.message });
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

/**
 * GET /suggestions -> GET /api/v1/alignment/suggestions
 *
 * Get current alignment suggestions for the user.
 */
router.get('/suggestions', async (req: Request, res: Response) => {
  console.log(`${LOG_PREFIX} GET /alignment/suggestions`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Authentication required'
    });
  }

  // Parse query parameters
  let status: string[] | undefined;
  let alignmentDomains: string[] | undefined;
  let limit: number | undefined;

  if (req.query.status) {
    status = Array.isArray(req.query.status)
      ? req.query.status as string[]
      : [req.query.status as string];
  }

  if (req.query.alignment_domains) {
    alignmentDomains = Array.isArray(req.query.alignment_domains)
      ? req.query.alignment_domains as string[]
      : [req.query.alignment_domains as string];
  }

  if (req.query.limit) {
    limit = parseInt(req.query.limit as string, 10);
    if (isNaN(limit)) limit = undefined;
  }

  // Validate parameters
  const validation = GetSuggestionsRequestSchema.safeParse({
    status,
    alignment_domains: alignmentDomains,
    limit
  });

  if (!validation.success) {
    console.warn(`${LOG_PREFIX} Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  try {
    const result = await getSuggestions(validation.data, token);

    if (!result.ok) {
      return res.status(400).json(result);
    }

    console.log(`${LOG_PREFIX} Retrieved ${result.count} suggestions`);

    return res.status(200).json(result);
  } catch (err: any) {
    console.error(`${LOG_PREFIX} get suggestions error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

/**
 * POST /shown -> POST /api/v1/alignment/shown
 *
 * Mark a suggestion as shown to the user.
 */
router.post('/shown', async (req: Request, res: Response) => {
  console.log(`${LOG_PREFIX} POST /alignment/shown`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Authentication required'
    });
  }

  // Validate request body
  const validation = MarkShownRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`${LOG_PREFIX} Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  try {
    const result = await markSuggestionShown(validation.data, token);

    if (!result.ok) {
      return res.status(400).json(result);
    }

    console.log(`${LOG_PREFIX} Suggestion ${validation.data.suggestion_id} marked as shown`);

    return res.status(200).json(result);
  } catch (err: any) {
    console.error(`${LOG_PREFIX} mark shown error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

/**
 * POST /action -> POST /api/v1/alignment/action
 *
 * Record user action on a suggestion (view, connect, save, not_now).
 */
router.post('/action', async (req: Request, res: Response) => {
  console.log(`${LOG_PREFIX} POST /alignment/action`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED',
      message: 'Authentication required'
    });
  }

  // Validate request body
  const validation = ActOnSuggestionRequestSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn(`${LOG_PREFIX} Validation failed:`, validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  try {
    const result = await actOnSuggestion(validation.data, token);

    if (!result.ok) {
      return res.status(400).json(result);
    }

    console.log(`${LOG_PREFIX} Suggestion ${validation.data.suggestion_id} action: ${validation.data.action}`);

    return res.status(200).json(result);
  } catch (err: any) {
    console.error(`${LOG_PREFIX} action error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

/**
 * POST /cleanup -> POST /api/v1/alignment/cleanup
 *
 * Cleanup expired suggestions (service/scheduler job).
 */
router.post('/cleanup', async (req: Request, res: Response) => {
  console.log(`${LOG_PREFIX} POST /alignment/cleanup`);

  const token = getBearerToken(req);
  // Cleanup can be called by service role without user token

  try {
    const result = await cleanupExpiredSuggestions(token || undefined);

    if (!result.ok) {
      return res.status(400).json(result);
    }

    console.log(`${LOG_PREFIX} Cleanup: ${result.expired_count} suggestions expired`);

    return res.status(200).json(result);
  } catch (err: any) {
    console.error(`${LOG_PREFIX} cleanup error:`, err.message);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: err.message
    });
  }
});

/**
 * GET /health -> GET /api/v1/alignment/health
 *
 * Health check for social alignment engine.
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_ANON_KEY;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'D47 Social Alignment Engine',
    version: '1.0.0',
    vtid: VTID,
    phase: 'D47',
    timestamp: new Date().toISOString(),
    capabilities: {
      generate_suggestions: hasSupabaseUrl && hasSupabaseKey,
      get_suggestions: hasSupabaseUrl && hasSupabaseKey,
      mark_shown: hasSupabaseUrl && hasSupabaseKey,
      act_on_suggestion: hasSupabaseUrl && hasSupabaseKey,
      cleanup: hasSupabaseUrl && hasSupabaseKey,
      alignment_domains: ALIGNMENT_DOMAINS,
      alignment_actions: ALIGNMENT_ACTIONS,
      alignment_statuses: ALIGNMENT_STATUSES
    },
    matching_thresholds: {
      min_relevance: 75,
      min_shared_signals: 2,
      max_suggestions: 20,
      min_social_energy: 20
    },
    governance: {
      memory_first: true,
      consent_by_design: true,
      no_forced_matchmaking: true,
      no_social_graph_exposure: true,
      explainability_mandatory: true,
      no_cold_start_hallucinations: true,
      oasis_logging: true
    },
    dependencies: {
      'VTID-01129': 'D35 Social Context',
      'VTID-01087': 'D87 Relationship Graph',
      'VTID-01084': 'D84 Community Personalization'
    }
  });
});

export default router;
