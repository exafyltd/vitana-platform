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

const router = Router();
const LOG_PREFIX = '[Calendar]';

// =============================================================================
// Helpers
// =============================================================================

function getUserId(req: Request): string | null {
  // @ts-ignore
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
      },
    }).catch(() => {});

    return res.json({ ok: true, data: event });
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

// =============================================================================
// GET /journey/debug — Diagnose why journey init fails (temporary)
// =============================================================================
router.get('/journey/debug', async (_req: Request, res: Response) => {
  const testUserId = '00000000-debug-0000-0000-' + Date.now().toString().slice(-12);
  const steps: Record<string, any> = {};

  try {
    const { getSupabaseConfig, headers: sbHeaders, bulkCreateCalendarEvents, getEventsBySourceRef } = await import('../services/calendar-service');

    // 1. Config check
    const config = getSupabaseConfig();
    if (!config) {
      return res.json({ ok: false, step: 'config', error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE' });
    }
    steps.config = 'ok';

    // 2. Test getEventsBySourceRef (idempotency check)
    const existing = await getEventsBySourceRef(testUserId, 'journey-calendar-init');
    steps.idempotency_check = { existing_count: existing.length };

    // 3. Test bulkCreateCalendarEvents with 2 events (the exact function journey uses)
    const testEvents = [
      {
        title: '__DEBUG_BULK_1__',
        start_time: new Date().toISOString(),
        end_time: new Date(Date.now() + 3600000).toISOString(),
        event_type: 'autopilot' as const,
        source_type: 'journey' as const,
        status: 'pending' as const,
        priority: 'low' as const,
        role_context: 'community' as const,
        source_ref_id: '__debug_bulk_1__',
        source_ref_type: 'debug',
        priority_score: 0,
        wellness_tags: ['test'],
        metadata: { debug: true },
      },
      {
        title: '__DEBUG_BULK_2__',
        start_time: new Date().toISOString(),
        end_time: new Date(Date.now() + 3600000).toISOString(),
        event_type: 'journey_milestone' as const,
        source_type: 'journey' as const,
        status: 'confirmed' as const,
        priority: 'medium' as const,
        role_context: 'community' as const,
        source_ref_id: 'journey-calendar-init',
        source_ref_type: 'journey_sentinel',
        priority_score: 100,
        wellness_tags: ['onboarding'],
        metadata: { debug: true },
      },
    ];

    const created = await bulkCreateCalendarEvents(testUserId, testEvents as any);
    steps.bulk_insert = { sent: testEvents.length, created: created.length, ids: created.map((e: any) => e.id) };

    // 4. Also try raw fetch to see exact error
    if (created.length === 0) {
      const rawResp = await fetch(`${config.url}/rest/v1/calendar_events`, {
        method: 'POST',
        headers: sbHeaders(config.key, { Prefer: 'return=representation' }),
        body: JSON.stringify(testEvents.map(e => ({ user_id: testUserId, ...e }))),
      });
      const rawBody = await rawResp.text();
      steps.raw_insert = { status: rawResp.status, ok: rawResp.ok, body: rawBody.slice(0, 1000) };
    }

    // 5. Cleanup
    if (created.length > 0) {
      for (const e of created) {
        await fetch(`${config.url}/rest/v1/calendar_events?id=eq.${(e as any).id}`, {
          method: 'DELETE', headers: sbHeaders(config.key),
        });
      }
      steps.cleanup = 'ok';
    }

    // 6. Also try full initializeJourneyCalendar with another test user
    const { initializeJourneyCalendar } = await import('../services/journey-calendar-mapper');
    const initResult = await initializeJourneyCalendar(testUserId + 'b', 'default', new Date(), 'en');
    steps.full_init = initResult;

    // Cleanup full init events
    await fetch(`${config.url}/rest/v1/calendar_events?user_id=eq.${testUserId}b`, {
      method: 'DELETE', headers: sbHeaders(config.key),
    });

    return res.json({ ok: steps.bulk_insert?.created > 0 && steps.full_init?.events_created > 0, steps });
  } catch (err: any) {
    return res.status(500).json({ ok: false, steps, error: err.message, stack: err.stack?.split('\n').slice(0, 5) });
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
