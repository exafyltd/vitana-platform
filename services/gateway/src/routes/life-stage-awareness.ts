/**
 * VTID-01124: Life Stage, Goals & Trajectory Awareness Routes (D40)
 *
 * Gateway routes for the Deep Context Intelligence Engine.
 * Understands where the user is in their life journey and aligns
 * intelligence with long-term goals, not just immediate desires.
 *
 * Endpoints:
 * - POST /assess - Assess life stage from user context
 * - GET /current - Get current life stage assessment
 * - POST /override/:assessmentId - User correction to override assessment
 * - GET /explain/:assessmentId - Get detailed evidence for an assessment
 * - GET /orb-context - Get formatted context for ORB system prompt
 * - POST /goals/detect - Detect and register a goal
 * - GET /goals - Get all user goals
 * - PATCH /goals/:goalId - Update a goal
 * - POST /trajectory/score - Score actions against trajectory
 *
 * Hard Constraints (from spec):
 *   - NEVER impose goals
 *   - NEVER shame deviations
 *   - Treat goals as evolving, not fixed
 *   - Allow conscious contradictions when user chooses
 *   - Keep goal inference transparent and correctable
 */

import { Router, Request, Response } from 'express';
import { createUserSupabaseClient } from '../lib/supabase-user';
import {
  assessLifeStage,
  getCurrentLifeStage,
  overrideLifeStage,
  explainLifeStage,
  getOrbLifeStageContext,
  processForOrb,
  detectGoal,
  getGoals,
  updateGoal,
  scoreTrajectory
} from '../services/d40-life-stage-awareness-engine';

const router = Router();

// VTID for logging
const VTID = 'VTID-01124';
const LOG_PREFIX = '[D40-Routes]';

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
// POST /assess
// Assess life stage from user context and history
// =============================================================================

router.post('/assess', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  // In dev mode, allow unauthenticated requests
  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /assess - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { session_id, include_goals, include_trajectory, context_window_days } = req.body;

  const result = await assessLifeStage({
    session_id,
    include_goals: include_goals ?? true,
    include_trajectory: include_trajectory ?? false,
    context_window_days: context_window_days ?? 30
  }, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /assess - Assessment failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} POST /assess - Success, phase=${result.life_stage?.phase}`);
  return res.json(result);
});

// =============================================================================
// GET /current
// Get current life stage assessment for a user
// =============================================================================

router.get('/current', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /current - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const sessionId = req.query.session_id as string | undefined;

  const result = await getCurrentLifeStage(sessionId, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} GET /current - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} GET /current - Success, needs_refresh=${result.needs_refresh}`);
  return res.json(result);
});

// =============================================================================
// POST /override/:assessmentId
// User correction to immediately override assessment
// =============================================================================

router.post('/override/:assessmentId', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /override - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { assessmentId } = req.params;
  const override = req.body;

  if (!assessmentId) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'assessmentId is required'
    });
  }

  if (!override || typeof override !== 'object') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'override data is required in request body'
    });
  }

  const result = await overrideLifeStage(assessmentId, override, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /override - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 :
                       result.error === 'ASSESSMENT_NOT_FOUND' ? 404 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} POST /override - Success, assessmentId=${assessmentId}`);
  return res.json(result);
});

// =============================================================================
// GET /explain/:assessmentId
// Get detailed evidence for an assessment (D59 explainability support)
// =============================================================================

router.get('/explain/:assessmentId', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /explain - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { assessmentId } = req.params;

  if (!assessmentId) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'assessmentId is required'
    });
  }

  const result = await explainLifeStage(assessmentId, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} GET /explain - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 :
                       result.error === 'ASSESSMENT_NOT_FOUND' ? 404 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} GET /explain - Success, assessmentId=${assessmentId}`);
  return res.json(result);
});

// =============================================================================
// GET /orb-context
// Get formatted life stage context for ORB system prompt injection
// =============================================================================

router.get('/orb-context', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /orb-context - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const sessionId = req.query.session_id as string | undefined;

  const result = await getOrbLifeStageContext(sessionId, token || undefined);

  if (!result) {
    // No life stage available - this is not an error
    return res.json({
      ok: true,
      has_life_stage: false,
      context: null,
      orb_context: null
    });
  }

  console.log(`${LOG_PREFIX} GET /orb-context - Success`);
  return res.json({
    ok: true,
    has_life_stage: true,
    context: result.context,
    orb_context: result.orbContext
  });
});

// =============================================================================
// POST /process
// Convenience endpoint: assess life stage and return ORB-ready context
// =============================================================================

router.post('/process', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /process - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { session_id } = req.body;

  const result = await processForOrb(session_id, token || undefined);

  if (!result) {
    return res.json({
      ok: true,
      has_life_stage: false,
      context: null,
      orb_context: null
    });
  }

  console.log(`${LOG_PREFIX} POST /process - Success`);
  return res.json({
    ok: true,
    has_life_stage: true,
    context: result.context,
    orb_context: result.orbContext,
    assessment_id: result.assessmentId
  });
});

// =============================================================================
// Goal Management Routes
// =============================================================================

// POST /goals/detect - Detect and register a goal
router.post('/goals/detect', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /goals/detect - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { message, session_id, source } = req.body;

  if (!source) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'source is required (explicit, conversation, behavior, preference)'
    });
  }

  const result = await detectGoal({
    message,
    session_id,
    source
  }, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /goals/detect - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} POST /goals/detect - Success`);
  return res.json(result);
});

// GET /goals - Get all user goals
router.get('/goals', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} GET /goals - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const result = await getGoals(token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} GET /goals - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} GET /goals - Success, count=${result.goals?.length || 0}`);
  return res.json(result);
});

// PATCH /goals/:goalId - Update a goal
router.patch('/goals/:goalId', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} PATCH /goals/:goalId - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { goalId } = req.params;
  const updates = req.body;

  if (!goalId) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'goalId is required'
    });
  }

  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'update data is required in request body'
    });
  }

  const result = await updateGoal(goalId, updates, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} PATCH /goals/:goalId - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 :
                       result.error === 'GOAL_NOT_FOUND' ? 404 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} PATCH /goals/:goalId - Success, goalId=${goalId}`);
  return res.json(result);
});

// =============================================================================
// Trajectory Scoring Routes
// =============================================================================

// POST /trajectory/score - Score actions against user trajectory
router.post('/trajectory/score', async (req: Request, res: Response) => {
  const token = getBearerToken(req);

  if (!token && !isDevSandbox()) {
    console.warn(`${LOG_PREFIX} POST /trajectory/score - Missing bearer token`);
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const { actions, session_id, include_trade_offs } = req.body;

  if (!actions || !Array.isArray(actions) || actions.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_REQUEST',
      message: 'actions array is required and must not be empty'
    });
  }

  const result = await scoreTrajectory({
    actions,
    session_id,
    include_trade_offs: include_trade_offs ?? true
  }, token || undefined);

  if (!result.ok) {
    console.error(`${LOG_PREFIX} POST /trajectory/score - Failed:`, result.error);
    const statusCode = result.error === 'UNAUTHENTICATED' ? 401 : 500;
    return res.status(statusCode).json(result);
  }

  console.log(`${LOG_PREFIX} POST /trajectory/score - Success, scored=${result.scored_actions?.length || 0}`);
  return res.json(result);
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
      .from('life_stage_rules')
      .select('rule_key, rule_version, domain, target, weight, active')
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
