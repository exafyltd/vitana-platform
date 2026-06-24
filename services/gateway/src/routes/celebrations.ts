/**
 * POST /api/v1/celebrations/dispatch — real-time My Journey celebration
 * push entrypoint. Authenticated; the frontend calls this when a client-
 * detected milestone fires (daily goal completed, phase milestone, progress
 * threshold). The route picks the right tone, renders the localized title +
 * body via the i18n catalog, dedupes against `user_notifications`, and
 * dispatches via the existing notifyUserAsync push pipeline.
 *
 * Body: { kind: CelebrationKind, dedupe_key: string, extra?: Record<string, string> }
 *   - kind         which celebration tone to send (see CELEBRATION_KINDS)
 *   - dedupe_key   client-supplied opaque string that uniquely identifies
 *                  the milestone instance — e.g. "2026-06-05" for daily_goal,
 *                  "phase:3" for phase_milestone, fixed "progress:50" for
 *                  progress_50. Stored in user_notifications.data and used
 *                  to guarantee one-and-only-one push per logical milestone.
 *   - extra        optional template params for the body (e.g. { phase: "Rhythmus" })
 *
 * Returns: { ok: true, dispatched: 0|1, skipped?: 'already_sent' | 'unknown_kind' }
 */

import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { notifyUserAsync, TYPE_META } from '../services/notification-service';
import { tt, type GatewayI18nKey } from '../i18n/catalog';
import { getUserLocale } from '../i18n/server-locale';

const router = Router();
// Explicit file-level auth marker for the impact-scan rule. Every route in
// this file requires a logged-in user; per-route requireAuth below is the
// same gate, kept inline so the route signature reads clearly.
router.use(requireAuth);

type CelebrationKind =
  | 'daily_goal'
  | 'phase_milestone'
  | 'progress_25'
  | 'progress_50'
  | 'progress_75'
  | 'progress_100';

// Maps each kind to its push TYPE_META key + the title/body catalog keys.
// progress_* all share progress_milestone_celebration on the wire so dedupe
// + notification-prefs gating treat them as one category.
const CELEBRATION_KINDS: Record<
  CelebrationKind,
  { type: string; titleKey: GatewayI18nKey; bodyKey: GatewayI18nKey }
> = {
  daily_goal: {
    type: 'daily_goal_celebration',
    titleKey: 'notif.celebration.daily_goal.title',
    bodyKey: 'notif.celebration.daily_goal.body',
  },
  phase_milestone: {
    type: 'phase_milestone_celebration',
    titleKey: 'notif.celebration.phase_milestone.title',
    bodyKey: 'notif.celebration.phase_milestone.body',
  },
  progress_25: {
    type: 'progress_milestone_celebration',
    titleKey: 'notif.celebration.progress_25.title',
    bodyKey: 'notif.celebration.progress_25.body',
  },
  progress_50: {
    type: 'progress_milestone_celebration',
    titleKey: 'notif.celebration.progress_50.title',
    bodyKey: 'notif.celebration.progress_50.body',
  },
  progress_75: {
    type: 'progress_milestone_celebration',
    titleKey: 'notif.celebration.progress_75.title',
    bodyKey: 'notif.celebration.progress_75.body',
  },
  progress_100: {
    type: 'progress_milestone_celebration',
    titleKey: 'notif.celebration.progress_100.title',
    bodyKey: 'notif.celebration.progress_100.body',
  },
};

function getServiceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  // Use the canonical SUPABASE_SERVICE_ROLE that the EXEC-DEPLOY workflow
  // already binds (see scheduled-notifications.ts pattern). The older
  // SUPABASE_SERVICE_ROLE_KEY name is not bound in any deploy config.
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

router.post(
  '/dispatch',
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.identity?.user_id;
    const tenantId = req.identity?.tenant_id;
    if (!userId || !tenantId) {
      return res.status(401).json({ ok: false, error: 'auth required' });
    }

    const kind = req.body?.kind as CelebrationKind | undefined;
    const dedupeKey = (req.body?.dedupe_key as string | undefined) ?? '';
    const extra = (req.body?.extra as Record<string, string> | undefined) ?? {};

    if (!kind || !CELEBRATION_KINDS[kind]) {
      return res.status(400).json({ ok: false, error: 'invalid kind', skipped: 'unknown_kind' });
    }
    if (!dedupeKey) {
      return res.status(400).json({ ok: false, error: 'dedupe_key required' });
    }

    const spec = CELEBRATION_KINDS[kind];

    const supa = getServiceClient();
    if (!supa) return res.status(503).json({ ok: false, error: 'Supabase unavailable' });

    // Dedupe — one push per (user, type, dedupe_key). Look back 365 days; the
    // dedupe_key shape encodes recurrence (daily_goal uses a local date, so a
    // new push lands every day; progress_50 uses a fixed string, so it fires
    // exactly once for the lifetime of this goal).
    try {
      const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      const { data: prior } = await supa
        .from('user_notifications')
        .select('id')
        .eq('user_id', userId)
        .eq('tenant_id', tenantId)
        .eq('type', spec.type)
        .gte('created_at', since)
        .filter('data->>dedupe_key', 'eq', dedupeKey)
        .limit(1)
        .maybeSingle();
      if (prior) {
        return res.json({ ok: true, dispatched: 0, skipped: 'already_sent' });
      }
    } catch (err: any) {
      // Don't let dedupe-read errors block a legitimate push — log and proceed.
      console.warn(`[celebrations] dedupe read failed for ${userId.slice(0, 8)}: ${err?.message || err}`);
    }

    const lc = await getUserLocale(supa, userId);
    const title = tt(spec.titleKey, lc, extra as any);
    const body = tt(spec.bodyKey, lc, extra as any);

    const dataPayload: Record<string, string> = {
      type: spec.type,
      kind,
      dedupe_key: dedupeKey,
      url: '/autopilot',
      deeplink: '/autopilot',
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])),
    };

    // Synchronous pre-insert closes the race window: two near-simultaneous
    // /dispatch calls would both pass the dedupe lookup above because
    // notifyUserAsync writes its canonical row asynchronously (a few awaits
    // deep inside notifyUser). Landing a durable dedupe marker now means the
    // second caller's lookup finds this row and short-circuits. push_sent_at
    // is set so /push-dispatch (which scans push_sent_at IS NULL within the
    // last 5 min) ignores this row — notifyUserAsync writes its own canonical
    // row and the FCM/Appilix push goes out through that path exactly once.
    const meta = TYPE_META?.[spec.type as keyof typeof TYPE_META];
    try {
      await supa.from('user_notifications').insert({
        user_id: userId,
        tenant_id: tenantId,
        type: spec.type,
        title,
        body,
        data: dataPayload,
        channel: meta?.channel ?? 'push_and_inapp',
        priority: meta?.priority ?? 'p1',
        category: meta?.category ?? 'growth',
        push_sent_at: new Date().toISOString(),
      });
    } catch (insErr: any) {
      // notifyUserAsync below still writes its own canonical row; this is a
      // best-effort dedup hint. Don't fail the user-facing dispatch on it.
      console.warn(
        `[celebrations] pre-insert failed for ${userId.slice(0, 8)} kind=${kind}: ${insErr?.message || insErr}`,
      );
    }

    notifyUserAsync(
      userId,
      tenantId,
      spec.type,
      {
        title,
        body,
        data: dataPayload,
      },
      supa,
    );

    // Record the dispatch as a state transition — the user just crossed a
    // real milestone in their journey, not a poll. Best-effort; OASIS write
    // failures must never break the user-facing response.
    try {
      const { emitOasisEvent } = await import('../services/oasis-event-service');
      await emitOasisEvent({
        type: 'notification.journey_celebration.dispatched' as any,
        source: 'gateway',
        // VTID format VTID-\d{4,5} per CLAUDE.md §4; no real VTID is bound
        // to this feature yet, so use the BOOTSTRAP- prefix accepted by the
        // OASIS validator and the AUTO-DEPLOY regex.
        vtid: 'BOOTSTRAP-JOURNEY-CELEBRATIONS',
        status: 'info',
        message: `journey_celebration ${kind} dispatched`,
        payload: {
          tenant_id: tenantId,
          user_id: userId,
          kind,
          dedupe_key: dedupeKey,
          type: spec.type,
        },
      });
    } catch (oasisErr: any) {
      console.warn(`[celebrations] OASIS emit failed for ${userId.slice(0, 8)}: ${oasisErr?.message || oasisErr}`);
    }

    return res.json({ ok: true, dispatched: 1 });
  },
);

export default router;
