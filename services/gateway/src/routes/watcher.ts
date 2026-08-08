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
  distilBackfill,
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
import { emitOasisEvent } from '../services/oasis-event-service';
import type { LessonStage } from '../services/watcher/lesson-types';
import type {
  SessionStepInput,
  StepOutcome,
  WatcherStepName,
} from '../services/watcher/types';

const router = Router();

/**
 * VTID stamped on the one event this module emits (an auto-mute decision)
 * when the caller supplied no VTID of its own. Mirrors dev-autopilot's
 * WATCHER_VTID convention for machine-originated lifecycle events.
 */
const WATCHER_VTID = 'VTID-WATCHER';

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

  // Whether ANY instance ticked recently, derived from the cursor rows.
  //
  // `isObserverRunning()` below is a PER-PROCESS flag, and the gateway runs
  // more than one instance — so the instance answering this request is
  // usually not the one holding the timer. Observed live: running=false while
  // last_run_at was four seconds old. Reporting only the local flag makes a
  // perfectly healthy observer look dead, which is the same class of lying
  // health field as the hard-zero last_written (VTID-03473). Three tick
  // intervals of slack absorbs a slow scan without flapping.
  const lastRunAt = (sources as Array<{ last_run_at?: string | null }>)
    .map((s) => (s.last_run_at ? Date.parse(s.last_run_at) : NaN))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];
  const tickingRecently = lastRunAt !== undefined
    ? Date.now() - lastRunAt < OBSERVER_TICK_MS * 3
    : false;

  // Learned-memory counts. Reported because "the observer is healthy" and
  // "the Watcher is learning" are independent facts, and for the system's
  // first three days they diverged completely: 591 steps recorded against 0
  // lessons, because the distiller had no call site (VTID-03531). Cursor
  // health alone could never have shown that — a reader has to be able to see
  // that steps are going in AND lessons are coming out.
  let lessons: { total: number; injectable: number } | null = null;
  if (sb) {
    const [all, mature] = await Promise.all([
      sb.from('watcher_lessons').select('id', { count: 'exact', head: true }),
      sb.from('watcher_lessons').select('id', { count: 'exact', head: true })
        .eq('status', 'active').gt('frequency', 1),
    ]);
    lessons = { total: all.count ?? 0, injectable: mature.count ?? 0 };
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
        // `running` answers the question a reader is actually asking — is the
        // observer ticking — so it reports the cross-instance derived value.
        // The per-process timer flag is kept alongside it for diagnosis, but
        // it is NOT the headline: it is false on every instance that does not
        // happen to hold the timer, and the Command Hub panel renders this
        // field directly.
        running: tickingRecently,
        running_this_instance: isObserverRunning(),
        last_run_at: lastRunAt !== undefined ? new Date(lastRunAt).toISOString() : null,
        tick_ms: OBSERVER_TICK_MS,
        overlap_ms: OVERLAP_MS,
      },
      supabase_available: !!sb,
      state_error: stateError,
      sources,
      lessons,
      observed_topic_count: observedTopics().length,
      session_ingest_configured: !!process.env.WATCHER_SESSION_TOKEN,
      forced_tick: forced,
    },
  });
});

// =============================================================================
// POST /distil-backfill
// =============================================================================

/**
 * Spend the failure history recorded before the distiller was wired up.
 *
 * Admin-gated and deliberate — see distilBackfill()'s own comment for why
 * this is not automatic. `since` is required rather than defaulted: an
 * unbounded backfill over a table that grows forever is the kind of endpoint
 * that is harmless the day it ships and a problem a year later.
 */
router.post('/distil-backfill', requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const since = String((req.body as { since?: unknown })?.since ?? '').trim();
  if (!since) {
    return res.status(400).json({ ok: false, error: 'MISSING_SINCE', message: 'since (ISO timestamp) is required' });
  }
  const parsed = new Date(since);
  if (Number.isNaN(parsed.getTime())) {
    return res.status(400).json({ ok: false, error: 'INVALID_SINCE', message: 'since must be a parseable ISO timestamp' });
  }

  const rawLimit = Number((req.body as { limit?: unknown })?.limit);
  const result = await distilBackfill({
    sinceIso: parsed.toISOString(),
    limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
  });

  // This one DOES get an OASIS event, unlike /session-step.
  //
  // The distinction is the one CLAUDE.md section 6 draws. A session step is an
  // observation — the observer's own scan is a poll, and "polling is not
  // progress". A backfill is an operator DECISION that materially changes the
  // memory every later prompt draws on, and it is not reconstructible from
  // the lesson rows afterwards (an upserted lesson looks the same whether it
  // came from a live tick or a backfill). If nobody records that someone ran
  // it, a later reader cannot explain why frequencies jumped.
  await emitOasisEvent({
    vtid: WATCHER_VTID,
    type: 'vtid.decision.watcher.backfill',
    source: 'watcher',
    status: result.ok ? 'info' : 'error',
    message: result.ok
      ? `Watcher distilled ${result.lessons} lesson(s) from ${result.scanned} historical failure step(s) since ${parsed.toISOString()}`
      : `Watcher backfill failed: ${result.error}`,
    payload: {
      since: parsed.toISOString(),
      scanned: result.scanned,
      lessons: result.lessons,
      error: result.error ?? null,
    },
  });

  return res.status(result.ok ? 200 : 500).json({
    ok: result.ok,
    data: { scanned: result.scanned, lessons: result.lessons },
    error: result.error,
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

  // impact-allow-no-oasis (for the ordinary path only — see below).
  //
  // Recording feedback is an observation, not a state transition, and gets no
  // event: it is the push twin of the observer's poll, which emits nothing
  // for the same reason (CLAUDE.md §6 — polling is not progress).
  //
  // An auto-MUTE is different, and this is the distinction worth drawing.
  // Muting a lesson changes what every subsequent planner/executor/worker
  // prompt sees, permanently and without a human in the loop. That is a
  // decision, and §6 reserves `vtid.decision.*` for exactly that. It is also
  // the one Watcher outcome someone would want to audit after the fact —
  // "why did the system stop reminding us about X?" needs an answer.
  if (result.muted) {
    await emitOasisEvent({
      vtid: (typeof body.vtid === 'string' && body.vtid) || WATCHER_VTID,
      type: 'vtid.decision.watcher.lesson_muted',
      source: 'watcher',
      status: 'info',
      message: `Watcher auto-muted reminder ${reminderId} after repeated non-correlation`,
      payload: {
        reminder_id: reminderId,
        stage: typeof body.stage === 'string' ? body.stage : null,
        work_unit_id: typeof body.work_unit_id === 'string' ? body.work_unit_id : null,
        repeated_mistake: !!body.repeated_mistake,
      },
    });
  }

  // `muted` is surfaced rather than applied silently — a lesson disappearing
  // from future prompts should be observable at the moment it happens.
  return res.status(200).json({ ok: true, data: { muted: !!result.muted } });
});

export default router;
