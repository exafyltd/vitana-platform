/**
 * Intelligent Calendar — REST API Routes
 *
 * Mounted at: /api/v1/calendar
 *
 * Provides server-side calendar CRUD so the assistant, autopilot,
 * and background services can read/write calendar events.
 * All endpoints are role-aware via X-Vitana-Active-Role header.
 *
 * The frontend continues using its existing direct Supabase access
 * for real-time subscriptions; this API is for server-side producers.
 */

import { Router, Request, Response } from 'express';
import { emitOasisEvent } from '../services/oasis-event-service';
import { getSupabase } from '../lib/supabase';
import { optionalAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import {
  CreateCalendarEventSchema,
  UpdateCalendarEventSchema,
  ListCalendarEventsSchema,
  CompleteEventSchema,
} from '../types/calendar';
import {
  listCalendarEvents,
  getUserUpcomingEvents,
  getUserTodayEvents,
  getUserCalendarHistory,
  getCalendarGaps,
  checkConflicts,
  createCalendarEvent,
  bulkCreateCalendarEvents,
  updateCalendarEvent,
  markEventCompleted,
  softDeleteEvent,
  toSummary,
} from '../services/calendar-service';

// Pillar keys — must match the 5 canonical Vitana pillars.
const PILLAR_KEYS = ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'] as const;
type PillarKey = typeof PILLAR_KEYS[number];

/**
 * Read prior vitana_index_scores row, invoke the admin-callable recompute RPC,
 * diff the results, emit an index.recomputed OASIS event, and return the new
 * row + per_pillar_delta. Best-effort — errors are logged and swallowed so a
 * failed recompute never blocks a successful calendar completion.
 */
async function recomputeVitanaIndexForUser(
  userId: string,
  eventMetadata: Record<string, unknown> = {},
): Promise<{ new_index?: Record<string, number>; per_pillar_delta?: Record<PillarKey, number>; delta_total?: number } | null> {
  const admin = getSupabase();
  if (!admin) return null;
  const today = new Date().toISOString().slice(0, 10);

  try {
    // Snapshot prior row (if any) so we can compute deltas.
    const { data: priorRow } = await admin
      .from('vitana_index_scores')
      .select('score_total, score_nutrition, score_hydration, score_exercise, score_sleep, score_mental')
      .eq('user_id', userId)
      .eq('date', today)
      .maybeSingle();

    const { data: newResult, error: rpcErr } = await admin.rpc(
      'health_compute_vitana_index_for_user',
      { p_user_id: userId, p_date: today, p_model_version: 'v3-5pillar' },
    );
    if (rpcErr || !(newResult as any)?.ok) {
      console.warn('[Calendar] recompute RPC failed:', rpcErr?.message || (newResult as any)?.error);
      return null;
    }
    const n = newResult as any;

    const prior = (priorRow as any) ?? {
      score_total: 0, score_nutrition: 0, score_hydration: 0,
      score_exercise: 0, score_sleep: 0, score_mental: 0,
    };
    const per_pillar_delta: Record<PillarKey, number> = {
      nutrition: (n.score_nutrition ?? 0) - (prior.score_nutrition ?? 0),
      hydration: (n.score_hydration ?? 0) - (prior.score_hydration ?? 0),
      exercise:  (n.score_exercise  ?? 0) - (prior.score_exercise  ?? 0),
      sleep:     (n.score_sleep     ?? 0) - (prior.score_sleep     ?? 0),
      mental:    (n.score_mental    ?? 0) - (prior.score_mental    ?? 0),
    };
    const delta_total = (n.score_total ?? 0) - (prior.score_total ?? 0);

    emitOasisEvent({
      vtid: 'SYSTEM',
      type: 'index.recomputed' as any,
      source: 'calendar-api',
      status: 'info',
      message: `Vitana Index recomputed: ${prior.score_total ?? 0} → ${n.score_total} (Δ${delta_total >= 0 ? '+' : ''}${delta_total})`,
      payload: {
        user_id: userId,
        date: today,
        new_score_total: n.score_total,
        prior_score_total: prior.score_total ?? 0,
        delta_total,
        per_pillar_delta,
        subscores: n.subscores,
        balance_factor: n.balance_factor,
        trigger: eventMetadata,
      },
    }).catch(() => {});

    return {
      new_index: {
        score_total: n.score_total,
        score_nutrition: n.score_nutrition,
        score_hydration: n.score_hydration,
        score_exercise: n.score_exercise,
        score_sleep: n.score_sleep,
        score_mental: n.score_mental,
      },
      per_pillar_delta,
      delta_total,
    };
  } catch (err: any) {
    console.warn('[Calendar] recomputeVitanaIndexForUser error:', err.message);
    return null;
  }
}

const router = Router();
const LOG_PREFIX = '[Calendar]';

// VTID-LIVEKIT-TOOLS: apply optionalAuth so Bearer JWTs populate
// req.identity. Mirrors the pattern in reminders.ts:60. Doesn't 401 when
// absent — keeps X-User-ID + service-role paths working for older callers.
router.use(optionalAuth);

// =============================================================================
// Helpers
// =============================================================================

function getUserId(req: Request): string | null {
  // VTID-LIVEKIT-TOOLS: prefer the canonical Supabase JWT identity attached
  // by middleware/auth-supabase-jwt.ts (the LiveKit orb-agent's
  // GatewayClient sends a Bearer JWT). Fall back to the legacy `req.user.id`
  // set by older middleware, then the X-User-* headers, then a
  // query-string user_id.
  const ident = (req as AuthenticatedRequest).identity;
  if (ident?.user_id) return ident.user_id;
  // @ts-ignore - legacy middleware sets req.user
  if (req.user?.id) return req.user.id;
  // @ts-ignore
  if (req.user?.sub) return req.user.sub;
  return req.get('X-User-ID') || req.get('X-Vitana-User') || (req.query.user_id as string) || null;
}

function getActiveRole(req: Request): string | null {
  return (req.query.role as string) || req.get('X-Vitana-Active-Role') || null;
}

// =============================================================================
// GET /events — List events (role-filtered, paginated)
// =============================================================================
router.get('/events', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });

    const role = getActiveRole(req);
    const parsed = ListCalendarEventsSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues });
    }

    const { data, count } = await listCalendarEvents(userId, role, parsed.data);
    return res.json({ ok: true, data, count, limit: parsed.data.limit, offset: parsed.data.offset });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /events error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// GET /events/upcoming — Next N events (for assistant context)
// =============================================================================
router.get('/events/upcoming', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });

    const role = getActiveRole(req);
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const events = await getUserUpcomingEvents(userId, role, limit);
    return res.json({ ok: true, data: events.map(toSummary), count: events.length });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /events/upcoming error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// GET /events/today — Today's events
// =============================================================================
router.get('/events/today', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });

    const role = getActiveRole(req);
    const timezone = (req.query.timezone as string) || 'UTC';
    const events = await getUserTodayEvents(userId, role, timezone);
    return res.json({ ok: true, data: events.map(toSummary), count: events.length });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /events/today error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// GET /events/history — Past events for adaptive suggestions
// =============================================================================
router.get('/events/history', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });

    const role = getActiveRole(req);
    const daysBack = Math.min(parseInt(req.query.days as string) || 30, 365);
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const events = await getUserCalendarHistory(userId, role, daysBack, limit);
    return res.json({ ok: true, data: events, count: events.length });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /events/history error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// GET /events/gaps — Free time slots for a given day
// =============================================================================
router.get('/events/gaps', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });

    const role = getActiveRole(req);
    const dateStr = req.query.date as string;
    const date = dateStr ? new Date(dateStr) : new Date();
    const gaps = await getCalendarGaps(userId, role, date);
    return res.json({ ok: true, data: gaps, count: gaps.length });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /events/gaps error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// GET /conflicts — Check conflicts for proposed window
// =============================================================================
router.get('/conflicts', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });

    const role = getActiveRole(req);
    const startTime = req.query.start_time as string;
    const endTime = req.query.end_time as string;
    if (!startTime || !endTime) {
      return res.status(400).json({ ok: false, error: 'start_time and end_time required' });
    }

    const conflicts = await checkConflicts(userId, role, startTime, endTime);
    return res.json({ ok: true, data: conflicts.map(toSummary), has_conflicts: conflicts.length > 0 });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /conflicts error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// POST /events — Create a calendar event
// =============================================================================
router.post('/events', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });

    const parsed = CreateCalendarEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues });
    }

    // Auto-tag role_context from active role if not explicitly set
    const role = getActiveRole(req);
    const input = { ...parsed.data };
    if (!req.body.role_context && role) {
      if (role === 'developer' || role === 'infra' || role === 'DEV') {
        input.role_context = 'developer';
      } else if (role === 'admin' || role === 'staff') {
        input.role_context = 'admin';
      }
      // community is the default
    }

    const event = await createCalendarEvent(userId, input);
    if (!event) {
      return res.status(500).json({ ok: false, error: 'Failed to create event' });
    }

    emitOasisEvent({
      vtid: 'SYSTEM',
      type: 'calendar.event.created' as any,
      source: 'calendar-api',
      status: 'info',
      message: `Calendar event created: ${event.title}`,
      payload: { event_id: event.id, user_id: userId, event_type: event.event_type, role_context: event.role_context },
    }).catch(() => {});

    return res.status(201).json({ ok: true, data: event });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} POST /events error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// POST /events/bulk — Bulk-create events (journey initialization)
// =============================================================================
router.post('/events/bulk', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });

    const events = req.body.events;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ ok: false, error: 'events array required' });
    }

    if (events.length > 200) {
      return res.status(400).json({ ok: false, error: 'Maximum 200 events per batch' });
    }

    // Validate each event
    const validated: any[] = [];
    for (let i = 0; i < events.length; i++) {
      const parsed = CreateCalendarEventSchema.safeParse(events[i]);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: `Event ${i}: ${JSON.stringify(parsed.error.issues)}` });
      }
      validated.push(parsed.data);
    }

    const created = await bulkCreateCalendarEvents(userId, validated);

    console.log(`${LOG_PREFIX} Bulk created ${created.length} events for user ${userId.slice(0, 8)}...`);

    return res.status(201).json({ ok: true, created_count: created.length, data: created.map(toSummary) });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} POST /events/bulk error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// PATCH /events/:id — Update a calendar event
// =============================================================================
router.patch('/events/:id', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });

    const { id } = req.params;
    const parsed = UpdateCalendarEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues });
    }

    const event = await updateCalendarEvent(id, userId, parsed.data);
    if (!event) {
      return res.status(404).json({ ok: false, error: 'Event not found or update failed' });
    }

    return res.json({ ok: true, data: event });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} PATCH /events/:id error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// POST /events/:id/complete — Mark event as completed/skipped/partial
// =============================================================================
router.post('/events/:id/complete', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });

    const { id } = req.params;
    const parsed = CompleteEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: parsed.error.issues });
    }

    const event = await markEventCompleted(
      id, userId, parsed.data.completion_status, parsed.data.completion_notes,
    );
    if (!event) {
      return res.status(404).json({ ok: false, error: 'Event not found' });
    }

    emitOasisEvent({
      vtid: 'SYSTEM',
      type: 'calendar.event.completed' as any,
      source: 'calendar-api',
      status: 'info',
      message: `Calendar event ${parsed.data.completion_status}: ${event.title}`,
      payload: {
        event_id: id,
        user_id: userId,
        completion_status: parsed.data.completion_status,
        wellness_tags: event.wellness_tags ?? [],
        event_type: event.event_type,
        source_ref_type: event.source_type,
      },
    }).catch(() => {});

    // Recompute the Vitana Index for this user (only if the event was
    // actually completed — skips/partials don't yet feed the Index).
    let indexDelta: Awaited<ReturnType<typeof recomputeVitanaIndexForUser>> = null;
    if (parsed.data.completion_status === 'completed') {
      indexDelta = await recomputeVitanaIndexForUser(userId, {
        event_id: id,
        wellness_tags: event.wellness_tags ?? [],
        event_type: event.event_type,
      });
    }

    return res.json({
      ok: true,
      data: event,
      vitana_index: indexDelta,
    });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} POST /events/:id/complete error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// DELETE /events/:id — Soft-delete (status → cancelled)
// =============================================================================
router.delete('/events/:id', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });

    const { id } = req.params;
    const event = await softDeleteEvent(id, userId);
    if (!event) {
      return res.status(404).json({ ok: false, error: 'Event not found' });
    }

    return res.json({ ok: true, data: event });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} DELETE /events/:id error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// POST /journey/initialize — Pre-populate 90-day journey calendar
// =============================================================================
router.post('/journey/initialize', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });

    const tenantId = req.get('X-Vitana-Tenant') || 'default';
    const language = (req.body.language as string) || 'en';

    const { initializeJourneyCalendar } = await import('../services/journey-calendar-mapper');
    const result = await initializeJourneyCalendar(userId, tenantId, new Date(), language);

    return res.status(result.ok ? 201 : 500).json(result);
  } catch (err: any) {
    console.error(`${LOG_PREFIX} POST /journey/initialize error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// POST /reschedule — Run smart rescheduler (called by Cloud Scheduler)
// =============================================================================
router.post('/reschedule', async (_req: Request, res: Response) => {
  try {
    const { rescheduleUnactivatedTasks } = await import('../services/calendar-rescheduler');
    const result = await rescheduleUnactivatedTasks();
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} POST /reschedule error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// POST /reprioritize — Run dynamic prioritizer (called by Cloud Scheduler)
// =============================================================================
router.post('/reprioritize', async (_req: Request, res: Response) => {
  try {
    const { reprioritizeAllUsers } = await import('../services/calendar-prioritizer');
    const result = await reprioritizeAllUsers();
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} POST /reprioritize error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// GET /health — Health check
// =============================================================================
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'intelligent-calendar',
    phases: [1, 2, 3, 4, 5, 6, 7, 8],
    features: [
      'role-aware-filtering',
      'crud-operations',
      'conflict-detection',
      'gap-analysis',
      'bulk-create',
      'completion-tracking',
      'rsvp-sync-triggers',
      'autopilot-calendar-bridge',
      '90-day-journey-package',
      'd-layer-memory-integration',
      'conversational-nl-parser',
      'smart-rescheduler',
      'dynamic-prioritizer',
      'pattern-evolution',
    ],
  });
});

export default router;
