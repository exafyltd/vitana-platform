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
import * as repo from './calendar-repository';
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
  listCalendarWindow,
  moveBlockReason,
  getOwnCalendarEvent,
  rescheduleEvent,
} from '../services/calendar-service';
import { completeSourceForCalendarEvent } from '../services/calendar-producers';

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
    const { data: priorRow } = await repo.fetchVitanaIndexScoresForUserDate(admin, userId, today);

    const { data: newResult, error: rpcErr } = await repo.healthComputeVitanaIndexForUserRpc(admin, {
      p_user_id: userId,
      p_date: today,
      p_model_version: 'v3-5pillar',
    });
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

// VTID-LIVEKIT-TOOLS: apply optionalAuth so Bearer JWTs populate req.identity.
router.use(optionalAuth);

// SECURITY (post-audit hardening): require a verified identity on every
// route except /health. This router used to accept a bare X-User-ID /
// X-Vitana-User header or ?user_id= query param with no verification at
// all — any caller could read/write another user's calendar by setting
// that header. The orb-agent's GatewayClient (the one real caller with a
// legitimate reason to hit this API server-side) already sends a real
// Supabase-signed user JWT as the Bearer token in the common case — see
// gateway_client.py / session.py, which documents that anonymous sessions
// (no user_jwt) getting 401 from tool endpoints is expected/acceptable.
const OPEN_PATHS = new Set(['/health']);
// VTID-04358: /feed/<token>.ics is read by external calendar apps, which
// cannot send a bearer. The secret token in the path is the credential.
const isFeedPath = (p: string) => p.startsWith('/feed/');
router.use((req: Request, res: Response, next) => {
  if (OPEN_PATHS.has(req.path) || isFeedPath(req.path)) return next();
  if (!(req as AuthenticatedRequest).identity?.user_id) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }
  return next();
});

// =============================================================================
// Helpers
// =============================================================================

function getUserId(req: Request): string | null {
  return (req as AuthenticatedRequest).identity?.user_id ?? null;
}

function getActiveRole(req: Request): string | null {
  return (req.query.role as string) || req.get('X-Vitana-Active-Role') || null;
}

// =============================================================================
// VTID-04358 — private iCalendar subscription feed
//   GET    /subscription            → is a link active, created/last used
//   POST   /subscription            → create a new link (replaces the old one)
//   DELETE /subscription            → revoke it
//   GET    /feed/<token>.ics        → the feed (no bearer; the token is the key)
// The plain token is returned once, on POST; only its hash is stored.
// =============================================================================
router.get('/subscription', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const { getFeedStatus } = await import('../services/calendar-ics-feed');
    return res.json({ ok: true, data: await getFeedStatus(userId) });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /subscription error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

router.post('/subscription', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const { rotateFeedToken } = await import('../services/calendar-ics-feed');
    const token = await rotateFeedToken(userId);
    // The token never goes into the event: only that a link now exists.
    emitOasisEvent({
      vtid: 'VTID-04358',
      type: 'calendar.feed.link_created' as any,
      source: 'calendar-api',
      status: 'info',
      message: 'Calendar subscription link created',
      payload: { user_id: userId },
    }).catch(() => {});
    // A path, not a URL: the client prefixes the gateway base it already uses.
    return res.status(201).json({ ok: true, data: { feed_path: `/api/v1/calendar/feed/${token}.ics` } });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} POST /subscription error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

router.delete('/subscription', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const { revokeFeedToken } = await import('../services/calendar-ics-feed');
    await revokeFeedToken(userId);
    emitOasisEvent({
      vtid: 'VTID-04358',
      type: 'calendar.feed.link_revoked' as any,
      source: 'calendar-api',
      status: 'info',
      message: 'Calendar subscription link turned off',
      payload: { user_id: userId },
    }).catch(() => {});
    return res.json({ ok: true });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} DELETE /subscription error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// VTID-04372 — Google Calendar two-way sync (built, switched off)
//   GET  /google          → availability + this member's sync state
//   POST /google/enable   → turn on (needs a Google connection with the sync scopes)
//   POST /google/disable  → turn off; pulled busy times are removed
// =============================================================================
router.get('/google', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const { googleSyncAvailability, getSyncState, GOOGLE_SYNC_CONNECT_URL } = await import('../services/calendar-google-sync');
    const availability = googleSyncAvailability();
    const state = availability === 'ready' ? await getSyncState(userId) : null;
    return res.json({
      ok: true,
      data: {
        availability,
        enabled: state?.enabled === true,
        last_push_at: state?.last_push_at ?? null,
        last_pull_at: state?.last_pull_at ?? null,
        last_error: state?.last_error ?? null,
        connect_url: GOOGLE_SYNC_CONNECT_URL,
      },
    });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /google error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

router.post('/google/enable', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const { enableGoogleSync } = await import('../services/calendar-google-sync');
    const r = await enableGoogleSync(userId);
    if (!r.ok) {
      if (r.error === 'not_configured') return res.status(503).json({ ok: false, error: 'not_configured' });
      return res.status(409).json({ ok: false, error: 'not_connected', connect_url: r.connect_url });
    }
    emitOasisEvent({
      vtid: 'VTID-04372',
      type: 'calendar.google_sync.enabled' as any,
      source: 'calendar-api',
      status: 'info',
      message: 'Google Calendar sync turned on',
      payload: { user_id: userId },
    }).catch(() => {});
    return res.json({ ok: true, data: { enabled: true } });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} POST /google/enable error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

router.post('/google/disable', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const { disableGoogleSync } = await import('../services/calendar-google-sync');
    await disableGoogleSync(userId);
    emitOasisEvent({
      vtid: 'VTID-04372',
      type: 'calendar.google_sync.disabled' as any,
      source: 'calendar-api',
      status: 'info',
      message: 'Google Calendar sync turned off',
      payload: { user_id: userId },
    }).catch(() => {});
    return res.json({ ok: true, data: { enabled: false } });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} POST /google/disable error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

router.get('/feed/:file', async (req: Request, res: Response) => { // public-route — no user JWT; the 256-bit token in the path is the credential (hash-checked)
  try {
    const m = /^([A-Za-z0-9_-]+)\.ics$/.exec(String(req.params.file ?? ''));
    const { resolveFeedToken, buildFeedForUser } = await import('../services/calendar-ics-feed');
    const userId = m ? await resolveFeedToken(m[1]) : null;
    // One answer for malformed, unknown and revoked tokens: nothing to probe.
    if (!userId) return res.status(404).type('text/plain').send('Not found');
    const body = await buildFeedForUser(userId);
    res.set('Cache-Control', 'private, max-age=900');
    res.set('X-Robots-Tag', 'noindex');
    return res.type('text/calendar; charset=utf-8').send(body);
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /feed error:`, err.message);
    return res.status(500).type('text/plain').send('Error');
  }
});

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
// GET /events/window?from&to[&include_busy=false][&include_work=false] — VTID-04331
// Everything the calendar shows in a date range for the active role:
// recurring entries expanded into occurrences, entries from other lenses as
// grey busy blocks (time only). Max 62 days per request.
// =============================================================================
const WINDOW_MAX_MS = 62 * 86_400_000;

router.get('/events/window', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });

    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? '');
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) {
      return res.status(400).json({ ok: false, error: 'from and to must be ISO timestamps with to > from' });
    }
    if (toMs - fromMs > WINDOW_MAX_MS) {
      return res.status(400).json({ ok: false, error: 'window may span at most 62 days' });
    }

    const role = getActiveRole(req);
    const includeBusy = req.query.include_busy !== 'false';
    let userTimezone: string | undefined;
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const { getUserTimezone } = await import('../services/daily-pace-service');
      if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE) {
        userTimezone = await getUserTimezone(
          createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE) as any,
          userId,
        );
      }
    } catch {
      // fall back to the service default inside listCalendarWindow
    }

    const items = await listCalendarWindow(
      userId,
      role,
      { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
      { includeBusy, userTimezone },
    );
    // VTID-04351: the calendar screen shows each entry's emoji and the
    // reminders it will actually get — computed by the same rules the
    // reminder loop uses, so the screen can never promise a different time.
    const { reminderRules, entryEmoji } = await import('../services/calendar-reminders');
    const data = items.map((it) =>
      it.event
        ? {
            ...it,
            display_emoji: entryEmoji(it.event as any),
            reminders: reminderRules(it.event as any),
            // VTID-04374: may this member move it from the entry screen?
            movable: !it.busy && it.occurrence_index === null && moveBlockReason(it.event as any) === null,
          }
        : it,
    );
    // VTID-04357: developer/admin work lenses — computed live, read-only,
    // Exafy staff only (verified claim; the role header only picks the lens).
    const { workLensesFor, listWorkItems, mergeWorkItems } = await import('../services/calendar-work-lens');
    const lenses = req.query.include_work === 'false'
      ? []
      : workLensesFor(role, (req as AuthenticatedRequest).identity?.exafy_admin === true);
    const work = lenses.length
      ? (await listWorkItems(userId, lenses, { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() }))
          .map((it) => ({ ...it, display_emoji: it.event?.emoji ?? '📌', reminders: [] as unknown[] }))
      : [];
    // VTID-04372: busy times pulled from the member's Google calendar — times only.
    let external: any[] = [];
    if (includeBusy) {
      const { googleSyncAvailability, listExternalBusy } = await import('../services/calendar-google-sync');
      if (googleSyncAvailability() === 'ready') {
        external = await listExternalBusy(userId, { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() });
      }
    }
    const merged = mergeWorkItems<any>([...data, ...external], work);
    return res.json({ ok: true, data: merged, count: merged.length, timezone: userTimezone ?? null, work_lenses: lenses });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /events/window error:`, err.message);
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
// POST /events/:id/move — a member moves their own entry (VTID-04374)
//   body: { start_time, end_time? } — end_time defaults to the same length.
//   409 { error: 'NOT_MOVABLE', reason } when the entry belongs to its source
//   (booking, lab order, invite, plan step…), is done, cancelled or a series.
// =============================================================================
const MOVE_MAX_AHEAD_MS = 400 * 86_400_000;

router.post('/events/:id/move', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'User ID required' });
    const { id } = req.params;
    if (id.startsWith('work:')) return res.status(400).json({ ok: false, error: 'WORK_ITEM_READ_ONLY' });

    const startMs = Date.parse(String(req.body?.start_time ?? ''));
    const endRaw = req.body?.end_time;
    const endMs = endRaw == null ? NaN : Date.parse(String(endRaw));
    if (Number.isNaN(startMs)) return res.status(400).json({ ok: false, error: 'start_time must be an ISO timestamp' });
    if (endRaw != null && (Number.isNaN(endMs) || endMs <= startMs)) {
      return res.status(400).json({ ok: false, error: 'end_time must be after start_time' });
    }
    if (startMs < Date.now() - 86_400_000 || startMs > Date.now() + MOVE_MAX_AHEAD_MS) {
      return res.status(400).json({ ok: false, error: 'start_time out of range' });
    }

    const event = await getOwnCalendarEvent(id, userId);
    if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
    const blocked = moveBlockReason(event);
    if (blocked) return res.status(409).json({ ok: false, error: 'NOT_MOVABLE', reason: blocked });

    const oldStart = Date.parse(event.start_time);
    const oldEnd = event.end_time ? Date.parse(event.end_time) : NaN;
    const duration = Number.isNaN(oldEnd) || oldEnd < oldStart ? 30 * 60_000 : oldEnd - oldStart;
    const newEnd = Number.isNaN(endMs) ? startMs + duration : endMs;

    const moved = await rescheduleEvent(id, userId, new Date(startMs).toISOString(), new Date(newEnd).toISOString());
    if (!moved) return res.status(500).json({ ok: false, error: 'Move failed' });

    emitOasisEvent({
      vtid: 'VTID-04374',
      type: 'calendar.event.moved' as any,
      source: 'calendar-api',
      status: 'info',
      message: 'Calendar entry moved by its owner',
      payload: { event_id: id, user_id: userId, from: event.start_time, to: moved.start_time },
    }).catch(() => {});

    return res.json({ ok: true, data: moved });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} POST /events/:id/move error:`, err.message);
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
    // VTID-04357: work-lens items are computed from their own tables, not
    // calendar rows — they are finished where they live, never here.
    if (id.startsWith('work:')) {
      return res.status(400).json({ ok: false, error: 'work items are read-only in the calendar' });
    }
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
        source_type: event.source_type,
        source_ref_type: event.source_ref_type,
      },
    }).catch(() => {});

    // VTID-04331: ticking the entry off completes the thing it came from
    // (an Autopilot recommendation today). Best-effort; never fails the call.
    let sourceCompletion: Awaited<ReturnType<typeof completeSourceForCalendarEvent>> | null = null;
    if (parsed.data.completion_status === 'completed') {
      sourceCompletion = await completeSourceForCalendarEvent(event, userId).catch(() => null);
    }

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
      source_completed: sourceCompletion?.completed ?? false,
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
// POST /reschedule — Run smart rescheduler (staff only; normally in-process)
// =============================================================================
// VTID-04374: these run a job over EVERY user's calendar, so a signed-in
// member must not be able to trigger them. Exafy staff only; the in-process
// maintenance loop (CALENDAR_MAINTENANCE_ENABLED) is the normal caller.
function requireStaff(req: Request, res: Response): boolean {
  if ((req as AuthenticatedRequest).identity?.exafy_admin === true) return true;
  res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  return false;
}

router.post('/reschedule', async (req: Request, res: Response) => {
  if (!requireStaff(req, res)) return;
  try {
    const { rescheduleUnactivatedTasks } = await import('../services/calendar-rescheduler');
    const result: any = await rescheduleUnactivatedTasks();
    // A staff member ran a job over every member's calendar: record who and what.
    emitOasisEvent({
      vtid: 'VTID-04374',
      type: 'calendar.maintenance.manual_run' as any,
      source: 'calendar-api',
      status: 'info',
      message: 'Calendar reschedule run by staff',
      payload: {
        job: 'reschedule',
        run_by: (req as AuthenticatedRequest).identity?.user_id ?? null,
        rescheduled: result?.rescheduled ?? null,
        cancelled: result?.cancelled ?? null,
        users_processed: result?.users_processed ?? null,
        total_updated: result?.total_updated ?? null,
        errors: result?.errors ?? result?.total_errors ?? null,
      },
    }).catch(() => {});
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} POST /reschedule error:`, err.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// =============================================================================
// POST /reprioritize — Run dynamic prioritizer (staff only; normally in-process)
// =============================================================================
router.post('/reprioritize', async (req: Request, res: Response) => {
  if (!requireStaff(req, res)) return;
  try {
    const { reprioritizeAllUsers } = await import('../services/calendar-prioritizer');
    const result: any = await reprioritizeAllUsers();
    // A staff member ran a job over every member's calendar: record who and what.
    emitOasisEvent({
      vtid: 'VTID-04374',
      type: 'calendar.maintenance.manual_run' as any,
      source: 'calendar-api',
      status: 'info',
      message: 'Calendar reprioritize run by staff',
      payload: {
        job: 'reprioritize',
        run_by: (req as AuthenticatedRequest).identity?.user_id ?? null,
        rescheduled: result?.rescheduled ?? null,
        cancelled: result?.cancelled ?? null,
        users_processed: result?.users_processed ?? null,
        total_updated: result?.total_updated ?? null,
        errors: result?.errors ?? result?.total_errors ?? null,
      },
    }).catch(() => {});
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
