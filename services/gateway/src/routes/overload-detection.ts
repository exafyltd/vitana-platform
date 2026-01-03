/**
 * VTID-01145: D51 Predictive Fatigue, Burnout & Overload Detection Routes
 *
 * Gateway routes for the Overload Detection Engine.
 * Detects early patterns of fatigue, cognitive overload, emotional strain,
 * or burnout risk BEFORE they escalate, and surfaces them as gentle awareness signals.
 *
 * Endpoints:
 * - POST /detect - Compute detections from observed patterns
 * - GET /detections - Get current active detections
 * - POST /dismiss - Dismiss a detection
 * - GET /explain/:id - Get detailed explanation for a detection
 * - GET /baselines - Get user baselines
 * - POST /baselines/compute - Compute/recompute baselines
 * - POST /patterns/record - Record an observed pattern
 * - POST /analyze - Run full analysis pipeline
 * - GET /orb-context - Get formatted context for ORB system prompt
 *
 * Hard Constraints (from spec):
 *   - Memory-first: All outputs logged to OASIS
 *   - Safety-first: No medical or psychological diagnosis
 *   - Detection ≠ labeling: No diagnostic terms
 *   - No urgency or alarm framing
 *   - Explainability mandatory
 *   - Always dismissible
 */

import { Router, Request, Response } from 'express';
import {
  computeBaselines,
  getBaselines,
  recordPattern,
  computeDetections,
  getDetections,
  dismissDetection,
  explainDetection,
  analyzeAndRecordPatterns,
  getOverloadContextForOrb,
  VTID
} from '../services/d51-overload-detection-engine';
import {
  ComputeDetectionRequestSchema,
  GetDetectionsRequestSchema,
  DismissDetectionRequestSchema,
  ExplainDetectionRequestSchema,
  GetBaselineRequestSchema,
  OverloadDimension,
  OverloadSignalSource,
  PatternType,
  OVERLOAD_DISCLAIMER
} from '../types/overload-detection';
import { z } from 'zod';

const router = Router();

// Route-level constants
const LOG_PREFIX = '[D51-Routes]';

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
// POST /detect
// Compute detections from observed patterns
// =============================================================================

router.post('/detect', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  // In dev mode, allow unauthenticated requests
  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /detect - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parsed = ComputeDetectionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    console.warn(`${LOG_PREFIX} POST /detect - Invalid request:`, parsed.error.message);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'Invalid request body',
      details: parsed.error.errors
    });
  }

  // Compute detections
  const result = await computeDetections(parsed.data, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /detect - Compute failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} POST /detect - Success, ${result.detections?.length || 0} detections found`);
  return res.json({
    ...result,
    disclaimer: OVERLOAD_DISCLAIMER
  });
});

// =============================================================================
// GET /detections
// Get current active detections
// =============================================================================

router.get('/detections', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /detections - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Parse query params
  const includeDismissed = req.query.include_dismissed === 'true';
  const limit = parseInt(req.query.limit as string) || 10;

  const result = await getDetections(
    { include_dismissed: includeDismissed, limit },
    token || undefined
  );

  if (!result.ok) {
    console.error(`${LOG_PREFIX} GET /detections - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} GET /detections - Success, ${result.count} detections`);
  return res.json({
    ...result,
    disclaimer: OVERLOAD_DISCLAIMER
  });
});

// =============================================================================
// POST /dismiss
// Dismiss a detection
// =============================================================================

router.post('/dismiss', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /dismiss - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parsed = DismissDetectionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    console.warn(`${LOG_PREFIX} POST /dismiss - Invalid request:`, parsed.error.message);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'Invalid request body. overload_id (UUID) is required.',
      details: parsed.error.errors
    });
  }

  const result = await dismissDetection(parsed.data, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /dismiss - Failed:`, result.error);
    const statusCode =
      result.error === 'UNAUTHENTICATED' ? 401 :
      result.error === 'NOT_FOUND' ? 404 :
      result.error === 'ALREADY_DISMISSED' ? 400 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} POST /dismiss - Success, dismissed ${result.overload_id}`);
  return res.json(result);
});

// =============================================================================
// GET /explain/:id
// Get detailed explanation for a detection
// =============================================================================

router.get('/explain/:id', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /explain - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const overloadId = req.params.id;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(overloadId)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'Invalid overload_id format. Must be a valid UUID.'
    });
  }

  const result = await explainDetection(
    { overload_id: overloadId },
    token || undefined
  );

  if (!result.ok) {
    console.error(`${LOG_PREFIX} GET /explain - Failed:`, result.error);
    const statusCode =
      result.error === 'UNAUTHENTICATED' ? 401 :
      result.error === 'NOT_FOUND' ? 404 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} GET /explain - Success for ${overloadId}`);
  return res.json({
    ...result,
    disclaimer: OVERLOAD_DISCLAIMER
  });
});

// =============================================================================
// GET /baselines
// Get user baselines
// =============================================================================

router.get('/baselines', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /baselines - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Parse dimensions from query if provided
  let dimensions: OverloadDimension[] | undefined;
  if (req.query.dimensions) {
    const rawDimensions = (req.query.dimensions as string).split(',');
    dimensions = rawDimensions.filter(d =>
      ['physical', 'cognitive', 'emotional', 'routine', 'social', 'context'].includes(d)
    ) as OverloadDimension[];
  }

  const result = await getBaselines(
    { dimensions, recompute: false },
    token || undefined
  );

  if (!result.ok) {
    console.error(`${LOG_PREFIX} GET /baselines - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} GET /baselines - Success, ${result.baselines?.length || 0} baselines`);
  return res.json(result);
});

// =============================================================================
// POST /baselines/compute
// Compute/recompute baselines
// =============================================================================

router.post('/baselines/compute', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /baselines/compute - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parsed = GetBaselineRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    console.warn(`${LOG_PREFIX} POST /baselines/compute - Invalid request:`, parsed.error.message);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'Invalid request body',
      details: parsed.error.errors
    });
  }

  const result = await computeBaselines(parsed.data, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /baselines/compute - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} POST /baselines/compute - Success, ${result.baselines?.length || 0} baselines computed`);
  return res.json(result);
});

// =============================================================================
// POST /patterns/record
// Record an observed pattern (for testing/integration)
// =============================================================================

const RecordPatternRequestSchema = z.object({
  pattern_type: z.enum([
    'sustained_low_energy', 'cognitive_decline', 'emotional_volatility',
    'routine_rigidity', 'social_withdrawal', 'context_thrashing',
    'recovery_deficit', 'capacity_erosion', 'engagement_drop', 'stress_accumulation'
  ]),
  dimension: z.enum(['physical', 'cognitive', 'emotional', 'routine', 'social', 'context']),
  signal_sources: z.array(z.enum([
    'longitudinal_trends', 'risk_windows', 'behavioral_signals',
    'sleep_recovery', 'calendar_density', 'conversation_cadence',
    'social_load', 'diary_sentiment'
  ])).min(1),
  intensity: z.number().min(0).max(100).optional().default(50),
  trend_direction: z.enum(['worsening', 'stable', 'improving']).optional().default('stable'),
  supporting_evidence: z.string().optional()
});

router.post('/patterns/record', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /patterns/record - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const parsed = RecordPatternRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    console.warn(`${LOG_PREFIX} POST /patterns/record - Invalid request:`, parsed.error.message);
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'Invalid request body',
      details: parsed.error.errors
    });
  }

  const { pattern_type, dimension, signal_sources, intensity, trend_direction, supporting_evidence } = parsed.data;

  const result = await recordPattern(
    pattern_type as PatternType,
    dimension as OverloadDimension,
    signal_sources as OverloadSignalSource[],
    intensity,
    trend_direction as 'worsening' | 'stable' | 'improving',
    supporting_evidence,
    token || undefined
  );

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /patterns/record - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} POST /patterns/record - Success, pattern_id=${result.pattern_id}`);
  return res.json(result);
});

// =============================================================================
// POST /analyze
// Run full analysis pipeline (gather patterns from all sources)
// =============================================================================

router.post('/analyze', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /analyze - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const result = await analyzeAndRecordPatterns(token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /analyze - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} POST /analyze - Success, ${result.patterns_recorded} patterns recorded`);
  return res.json(result);
});

// =============================================================================
// GET /orb-context
// Get formatted overload context for ORB system prompt injection
// =============================================================================

router.get('/orb-context', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /orb-context - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const result = await getOverloadContextForOrb(token || undefined);

  if (!result) {
    // No context available - this is not an error
    return res.json({
      ok: true,
      has_detections: false,
      context: null
    });
  }

  console.log(`${LOG_PREFIX} GET /orb-context - Success, has_detections=${result.hasActiveDetections}`);
  return res.json({
    ok: true,
    has_detections: result.hasActiveDetections,
    context: result.context,
    disclaimer: OVERLOAD_DISCLAIMER
  });
});

// =============================================================================
// GET /dimensions
// List available dimensions with metadata
// =============================================================================

router.get('/dimensions', async (_req: Request, res: Response) => {
  const dimensions = [
    {
      id: 'physical',
      label: 'Physical Fatigue',
      description: 'Patterns suggesting physical tiredness or energy depletion',
      icon: 'battery-low'
    },
    {
      id: 'cognitive',
      label: 'Cognitive Overload',
      description: 'Patterns suggesting mental load or processing strain',
      icon: 'brain'
    },
    {
      id: 'emotional',
      label: 'Emotional Strain',
      description: 'Patterns suggesting emotional capacity depletion',
      icon: 'heart'
    },
    {
      id: 'routine',
      label: 'Routine Saturation',
      description: 'Patterns suggesting routine demands exceeding capacity',
      icon: 'calendar'
    },
    {
      id: 'social',
      label: 'Social Exhaustion',
      description: 'Patterns suggesting social energy depletion',
      icon: 'users'
    },
    {
      id: 'context',
      label: 'Context Switching Load',
      description: 'Patterns suggesting excessive task/context transitions',
      icon: 'shuffle'
    }
  ];

  return res.json({
    ok: true,
    dimensions,
    count: dimensions.length
  });
});

// =============================================================================
// GET /pattern-types
// List available pattern types
// =============================================================================

router.get('/pattern-types', async (_req: Request, res: Response) => {
  const patternTypes = [
    { id: 'sustained_low_energy', label: 'Sustained Low Energy', dimension: 'physical' },
    { id: 'cognitive_decline', label: 'Cognitive Decline', dimension: 'cognitive' },
    { id: 'emotional_volatility', label: 'Emotional Volatility', dimension: 'emotional' },
    { id: 'routine_rigidity', label: 'Routine Rigidity', dimension: 'routine' },
    { id: 'social_withdrawal', label: 'Social Withdrawal', dimension: 'social' },
    { id: 'context_thrashing', label: 'Context Thrashing', dimension: 'context' },
    { id: 'recovery_deficit', label: 'Recovery Deficit', dimension: 'physical' },
    { id: 'capacity_erosion', label: 'Capacity Erosion', dimension: 'cognitive' },
    { id: 'engagement_drop', label: 'Engagement Drop', dimension: 'cognitive' },
    { id: 'stress_accumulation', label: 'Stress Accumulation', dimension: 'emotional' }
  ];

  return res.json({
    ok: true,
    pattern_types: patternTypes,
    count: patternTypes.length
  });
});

// =============================================================================
// GET /signal-sources
// List available signal sources
// =============================================================================

router.get('/signal-sources', async (_req: Request, res: Response) => {
  const signalSources = [
    { id: 'longitudinal_trends', label: 'Longitudinal Trends (D43)', required: true },
    { id: 'risk_windows', label: 'Risk Windows (D45)', required: true },
    { id: 'behavioral_signals', label: 'Behavioral Signals (D44)', required: true },
    { id: 'sleep_recovery', label: 'Sleep & Recovery', required: false },
    { id: 'calendar_density', label: 'Calendar Density', required: false },
    { id: 'conversation_cadence', label: 'Conversation Cadence', required: false },
    { id: 'social_load', label: 'Social Load', required: false },
    { id: 'diary_sentiment', label: 'Diary Sentiment', required: false }
  ];

  return res.json({
    ok: true,
    signal_sources: signalSources,
    count: signalSources.length
  });
});

// =============================================================================
// GET /health
// Health check for the overload detection service
// =============================================================================

router.get('/health', async (_req: Request, res: Response) => {
  return res.json({
    ok: true,
    vtid: VTID,
    service: 'D51 Overload Detection Engine',
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

export default router;
