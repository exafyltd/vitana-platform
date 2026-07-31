/**
 * VTID-03460 — Watcher Phase 1 routes: /api/v1/watcher/*
 *
 * Plan: docs/WATCHER-AGENT-PLAN.md (VTID-03454).
 *
 *   GET  /timeline       — reconstruct what happened to a unit of work
 *   GET  /health         — per-source cursor state + resolved enabled flag
 *   POST /session-step   — push ingestion for Claude Code sessions
 *
 * Everything here is admin-gated except /session-step, which cannot use an
 * admin JWT (its caller is a session hook, not a logged-in human) and is
 * instead gated on a shared bearer secret. Absent that secret the endpoint
 * is CLOSED, not open — an unauthenticated write path into the timeline
 * would let anything forge development history, which is exactly the kind
 * of "memory you cannot trust" the whole Watcher is built to avoid.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getSupabase } from '../lib/supabase';
import { requireAdminAuth } from '../middleware/auth-supabase-jwt';
import type { AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import {
  OBSERVER_TICK_MS,
  OVERLAP_MS,
  isObserverRunning,
  observerTick,
  writeSteps,
} from '../services/watcher/watcher-observer';
import { SOURCE_SESSION, observedTopics } from '../services/watcher/normalizers';
import {
  buildReminders,
  remindersEnabled,
  renderRemindersBlock,
} from '../services/watcher/reminder';
import { recordFeedback, recordShown } from '../services/watcher/feedback';
import type { LessonStage } from '../services/watcher/lesson-types';
import type {
  SessionStepInput,
  StepOutcome,
  WatcherStepName,
} from '../services/watcher/types';

const router = Router();

const VALID_STEPS: readonly WatcherStepName[] = [
  'allocated', 'planned', 'queued', 'running', 'validated', 'pr_opened',
  'ci', 'merged', 'deploying', 'verified', 'completed', 'failed',
  'reverted', 'escalated', 'doc_updated', 'terminalized',
];

const VALID_OUTCOMES: readonly StepOutcome[] = ['success', 'failure', 'skipped', 'unknown'];

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

// =============================================================================
// GET /timeline
// =============================================================================

/**
 * Query by `vtid` (spans every execution/PR/session that carried it) or by
 * `work_unit_id` (one execution or session in isolation). Both are indexed.
 */
router.get('/timeline', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const vtid = typeof req.query.vtid === 'string' ? req.query.vtid.trim() : '';
  const workUnitId = typeof req.query.work_unit_id === 'string' ? req.query.work_unit_id.trim() : '';

  if (!vtid && !workUnitId) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_SELECTOR',
      detail: 'Provide either ?vtid= or ?work_unit_id=',
    });
  }

  const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const sb = getSupabase();
  if (!sb) {
    return res.status(503).json({ ok: false, error: 'SUPABASE_UNAVAILABLE' });
  }

  let query = sb
    .from('watcher_steps')
    .select('id, work_unit_kind, work_unit_id, vtid, step, outcome, actor, evidence, source, source_ref, observed_at')
    // Ascending: a timeline is read forwards. The DESC indexes still serve
    // this — Postgres reads a btree in either direction.
    .order('observed_at', { ascending: true })
    .limit(limit);

  query = vtid ? query.eq('vtid', vtid) : query.eq('work_unit_id', workUnitId);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ ok: false, error: 'QUERY_FAILED', detail: error.message });
  }

  const steps = data || [];
  return res.status(200).json({
    ok: true,
    data: {
      selector: vtid ? { vtid } : { work_unit_id: workUnitId },
      count: steps.length,
      // No silent caps: if the page is full the caller needs to know there
      // may be more rather than reading a partial timeline as complete.
      truncated: steps.length === limit,
      steps,
    },
  });
});

// =============================================================================
// GET /health
// =============================================================================

/**
 * Reports the RESOLVED enabled state, not the raw env var.
 *
 * This distinction is not pedantic — BOOTSTRAP-ORB-FASTSTART-DRIFT was
 * exactly this bug: `FEATURE_ORB_FAST_START_ENV` was present on the task
 * definition and the feature was still dead, because 'staging-only' resolves
 * to false in prod. "The var is set" never means "the thing is running", so
 * both values are reported side by side.
 */
router.get('/health', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const sb = getSupabase();
  const envVar = process.env.WATCHER_OBSERVER_ENABLED ?? null;
  const resolvedEnabled = (envVar || 'true').toLowerCase() !== 'false';

  let sources: unknown[] = [];
  let stateError: string | null = null;
  if (sb) {
    const { data, error } = await sb
      .from('watcher_observer_state')
      .select('source, cursor_at, last_run_at, last_error, last_written, updated_at')
      .order('source', { ascending: true });
    if (error) stateError = error.message;
    else sources = data || [];
  }

  // Optional forced scan, so an operator can prove the observer works
  // without waiting out a tick interval.
  let forced: unknown = null;
  if (String(req.query.tick) === 'true') {
    forced = await observerTick();
  }

  return res.status(200).json({
    ok: true,
    data: {
      observer: {
        env_var_present: envVar !== null,
        env_var_value: envVar,
        enabled_resolved: resolvedEnabled,
        running: isObserverRunning(),
        tick_ms: OBSERVER_TICK_MS,
        overlap_ms: OVERLAP_MS,
      },
      supabase_available: !!sb,
      state_error: stateError,
      sources,
      observed_topic_count: observedTopics().length,
      session_ingest_configured: !!process.env.WATCHER_SESSION_TOKEN,
      forced_tick: forced,
    },
  });
});

// =============================================================================
// POST /session-step
// =============================================================================

function tokenMatches(expected: string, presented: string): boolean {
  if (!presented || presented.length !== expected.length) return false;
  // Constant-time-ish compare. Length is already leaked by the check above,
  // which is acceptable for a deployment-scoped shared secret.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Auth for the session-ingest path. Deliberately real middleware rather than
 * an inline check inside the handler: the auth posture of a write endpoint
 * should be legible at the route declaration, to a human reader and to the
 * repo's own route scanners alike. An inline check reads as "no auth" from
 * the outside, which is the wrong signal for a path that writes history.
 */
export function requireSessionToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.WATCHER_SESSION_TOKEN;
  if (!expected) {
    res.status(503).json({
      ok: false,
      error: 'SESSION_INGEST_DISABLED',
      detail: 'WATCHER_SESSION_TOKEN is not set; session ingestion is closed by default.',
    });
    return;
  }
  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!tokenMatches(expected, presented)) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    return;
  }
  next();
}

router.post('/session-step', requireSessionToken, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: recording an observation is not a state
  // transition. CLAUDE.md §6 reserves OASIS for transitions and decisions,
  // and this handler is the push twin of the observer's poll — the observer
  // emits nothing for exactly the same reason. Emitting here would also be
  // self-referential: the observer scans oasis_events, so a watcher-authored
  // event would be re-observed as a development step, and the timeline would
  // start recording its own act of recording. Phase 3 emits precisely one
  // event type (vtid.decision.watcher.reminded) because raising a reminder
  // IS a decision.
  const body = (req.body || {}) as SessionStepInput;

  const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: 'MISSING_SESSION_ID' });
  }
  if (!VALID_STEPS.includes(body.step)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_STEP',
      detail: `step must be one of: ${VALID_STEPS.join(', ')}`,
    });
  }
  const outcome: StepOutcome = VALID_OUTCOMES.includes(body.outcome as StepOutcome)
    ? (body.outcome as StepOutcome)
    : 'unknown';

  // Reject a caller-supplied observed_at that isn't a real date rather than
  // letting `new Date(garbage).toISOString()` throw inside the insert.
  let observedAt = new Date().toISOString();
  if (body.observed_at) {
    const parsed = new Date(body.observed_at);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ ok: false, error: 'INVALID_OBSERVED_AT' });
    }
    observedAt = parsed.toISOString();
  }

  const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : body.step;

  const result = await writeSteps([
    {
      work_unit_kind: 'session',
      work_unit_id: sessionId,
      vtid: typeof body.vtid === 'string' && body.vtid.trim() ? body.vtid.trim() : null,
      step: body.step,
      outcome,
      actor: 'claude-session',
      evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
      source: SOURCE_SESSION,
      source_ref: `${sessionId}:${ref}`,
      observed_at: observedAt,
    },
  ]);

  // A failed write must surface as a failure. Reporting 200 here would tell a
  // session hook its step was recorded when it was not, and the hook would
  // never retry — the same conflation of "wrote nothing" with "write failed"
  // that the observer's cursor logic has to avoid.
  if (!result.ok) {
    return res.status(503).json({
      ok: false,
      error: 'WRITE_FAILED',
      detail: result.error || 'watcher_steps write failed',
    });
  }

  // written === 0 with ok === true means the step was already recorded (a
  // retried hook). That IS a success from the caller's point of view.
  return res.status(200).json({
    ok: true,
    data: { written: result.written, deduplicated: result.written === 0 },
  });
});

// =============================================================================
// GET /remind — VTID-03462 (Phase 3)
// =============================================================================

const VALID_STAGES = [
  'planning', 'execute', 'validate', 'ci', 'merge', 'deploy', 'verify', 'any',
] as const;

/**
 * Returns the ranked, budgeted reminder block for a context.
 *
 * Admin-gated like the rest: the reminder text quotes governance rules and
 * summarizes prior failures, which is internal engineering information.
 * In-process callers (the planner, the executor, the worker-runner bridge)
 * use buildReminders() directly and never traverse this route.
 */
router.get('/remind', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const stage = String(req.query.stage || '') as LessonStage;
  if (!VALID_STAGES.includes(stage as typeof VALID_STAGES[number])) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_STAGE',
      detail: `stage must be one of: ${VALID_STAGES.join(', ')}`,
    });
  }

  const touched = typeof req.query.touched_paths === 'string' && req.query.touched_paths
    ? req.query.touched_paths.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const bundle = await buildReminders({
    stage,
    vtid: typeof req.query.vtid === 'string' ? req.query.vtid : null,
    scanner: typeof req.query.scanner === 'string' ? req.query.scanner : undefined,
    service: typeof req.query.service === 'string' ? req.query.service : undefined,
    step: typeof req.query.step === 'string' ? req.query.step : undefined,
    actor: typeof req.query.actor === 'string' ? req.query.actor : undefined,
    touched_paths: touched,
  });

  // Only count a reminder as "shown" when the caller asked for the injectable
  // block. A Command Hub operator browsing what the Watcher knows must not
  // move the auto-mute denominator — that would let idle inspection silently
  // retire lessons nobody ever injected.
  if (String(req.query.record_shown) === 'true') {
    await recordShown(bundle.reminders.map((r) => r.reminder_id));
  }

  return res.status(200).json({
    ok: true,
    data: {
      enabled_resolved: remindersEnabled(),
      stage,
      ...bundle,
      block: renderRemindersBlock(bundle),
    },
  });
});

// =============================================================================
// POST /feedback — VTID-03462 (Phase 3)
// =============================================================================

/**
 * Closes the loop. Admin-gated for the same reason as /remind; the in-process
 * callers use recordFeedback() directly.
 */
router.post('/feedback', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const reminderId = typeof body.reminder_id === 'string' ? body.reminder_id.trim() : '';
  if (!reminderId) {
    return res.status(400).json({ ok: false, error: 'MISSING_REMINDER_ID' });
  }
  const outcome = body.outcome;
  if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'unknown') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_OUTCOME',
      detail: 'outcome must be success | failure | unknown',
    });
  }

  const result = await recordFeedback({
    reminder_id: reminderId,
    work_unit_id: typeof body.work_unit_id === 'string' ? body.work_unit_id : null,
    vtid: typeof body.vtid === 'string' ? body.vtid : null,
    stage: typeof body.stage === 'string' ? body.stage : null,
    outcome,
    repeated_mistake: !!body.repeated_mistake,
    note: typeof body.note === 'string' ? body.note : null,
  });

  if (!result.ok) {
    const status = result.error === 'INVALID_REMINDER_ID' ? 400 : 503;
    return res.status(status).json({ ok: false, error: result.error });
  }
  // `muted` is surfaced rather than applied silently — a lesson disappearing
  // from future prompts should be observable at the moment it happens.
  return res.status(200).json({ ok: true, data: { muted: !!result.muted } });
});

export default router;
