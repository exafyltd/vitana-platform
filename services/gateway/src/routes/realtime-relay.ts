/**
 * B5 realtime relay routes (Supabase→Aurora migration workstream, see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B5 and
 * docs/AURORA-B5-REALTIME-INVENTORY.md's 2026-08-29 addendum, which
 * concluded a gateway-owned polling relay is the only mechanism choice
 * consistent with this codebase's standing "off Supabase entirely"
 * decision — Supabase's own `realtime` server is Option A's approach
 * applied to one component, and running it against Aurora needs a
 * `rds.logical_replication` cluster reboot this polling approach avoids.
 *
 * Ships one endpoint for the first (simplest-authorization) of the 3
 * tables the inventory found genuinely live-critical: `user_notifications`.
 * `user_activity_log` and `chat_messages` are NOT covered here — their
 * authorization models are more involved (activity log has broader
 * visibility rules; chat_messages needs thread/group membership, not just
 * row ownership) and are explicitly left as separate follow-up work.
 *
 * Feature-flagged OFF by default (`FEATURE_REALTIME_RELAY_USER_NOTIFICATIONS_ENV`,
 * same on/off/staging-only/staging+prod convention as every other flag in
 * `services/feature-flags.ts`) — this ships the seam without flipping it
 * live, the same pattern B6's `STORAGE_PROVIDER` and B7's
 * `AI_BRIDGE_PROVIDER` already used. No frontend consumer exists yet;
 * wiring one up is separate, later work.
 */

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, requireTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { isFeatureLive } from '../services/feature-flags';
import { startNotificationPolling, DEFAULT_POLL_INTERVAL_MS } from '../services/realtime/user-notifications-poller';
import type { NotificationCursor } from '../services/realtime/user-notifications-relay-repository';

const router = Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
}

const HEARTBEAT_INTERVAL_MS = 30000;

router.get('/user-notifications/stream', requireAuth, requireTenant, (req: Request, res: Response) => {
  // impact-allow-no-oasis: a read-only relay of rows the caller already
  // owns (same scoping as GET /notifications) — no DB write, no state
  // transition to record.
  if (!isFeatureLive('REALTIME_RELAY_USER_NOTIFICATIONS')) {
    return res.status(404).json({ ok: false, error: 'not_enabled' });
  }

  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase = getSupabase();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  // Start the cursor at "now" — a stream delivers notifications created
  // from the moment of connection onward, matching what a WAL-based
  // subscription would have done (no backlog replay; GET / already serves
  // history for anything older).
  const initialCursor: NotificationCursor = { sinceCreatedAt: new Date().toISOString(), sinceId: null };

  const stopPolling = startNotificationPolling(
    supabase,
    identity.user_id,
    identity.tenant_id,
    initialCursor,
    (rows) => {
      for (const row of rows) {
        const id = (row as { id: string }).id;
        res.write(`id: ${id}\nevent: user_notification\ndata: ${JSON.stringify(row)}\n\n`);
      }
    },
    {
      intervalMs: DEFAULT_POLL_INTERVAL_MS,
      onError: (message) => {
        console.error('[realtime-relay] user_notifications poll error:', message);
      },
    },
  );

  const heartbeatInterval = setInterval(() => {
    res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, HEARTBEAT_INTERVAL_MS);

  req.on('close', () => {
    stopPolling();
    clearInterval(heartbeatInterval);
    try {
      res.end();
    } catch {
      // Connection already closed — nothing to do.
    }
  });
});

export default router;
