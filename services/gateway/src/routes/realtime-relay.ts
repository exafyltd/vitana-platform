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
 * Ships endpoints for 2 of the 3 tables the inventory found genuinely
 * live-critical: `user_notifications` and `user_activity_log` — both fit
 * the same "row ownership = column equality" authorization shape, so both
 * go through the shared `generic-cursor-relay` poller.
 * `chat_messages` does NOT fit that shape (needs thread/group membership,
 * not just row ownership) and is explicitly NOT covered here — separate
 * follow-up work, not an oversight.
 *
 * Feature-flagged OFF by default (one `FEATURE_..._ENV` var per table,
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
import { startRowPolling, DEFAULT_POLL_INTERVAL_MS, type RelayTableConfig, type RowCursor } from '../services/realtime/generic-cursor-relay';

const router = Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
}

const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * Shared SSE handler for a row-ownership relay table: opens the stream,
 * starts the generic poller scoped to `config`, and cleans up on
 * disconnect. `eventName` becomes the SSE `event:` field so different
 * tables are distinguishable on the wire without separate endpoints
 * needing separate handler bodies.
 */
function streamTable(featureFlagName: string, eventName: string, buildConfig: (identity: NonNullable<AuthenticatedRequest['identity']>) => RelayTableConfig) {
  return (req: Request, res: Response) => {
    // impact-allow-no-oasis: a read-only relay of rows the caller already
    // owns — no DB write, no state transition to record.
    if (!isFeatureLive(featureFlagName)) {
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

    // Start the cursor at "now" — a stream delivers rows created from the
    // moment of connection onward, matching what a WAL-based subscription
    // would have done (no backlog replay; the existing REST history
    // endpoints already serve anything older).
    const initialCursor: RowCursor = { sinceCreatedAt: new Date().toISOString(), sinceId: null };

    const stopPolling = startRowPolling(
      supabase,
      buildConfig(identity),
      initialCursor,
      (rows) => {
        for (const row of rows) {
          const id = (row as { id: string }).id;
          res.write(`id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(row)}\n\n`);
        }
      },
      {
        intervalMs: DEFAULT_POLL_INTERVAL_MS,
        onError: (message) => {
          console.error(`[realtime-relay] ${eventName} poll error:`, message);
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
  };
}

router.get(
  '/user-notifications/stream',
  requireAuth,
  requireTenant,
  streamTable('REALTIME_RELAY_USER_NOTIFICATIONS', 'user_notification', (identity) => ({
    table: 'user_notifications',
    filters: { user_id: identity.user_id, tenant_id: identity.tenant_id },
  })),
);

// user_activity_log has no tenant_id column — user_id is the sole
// ownership key (confirmed against both the read side,
// user-context-profiler-repository.ts's fetchActivityLogRows(), and the
// write side, timeline-projector.ts's writeTimelineRow()).
router.get(
  '/user-activity-log/stream',
  requireAuth,
  requireTenant,
  streamTable('REALTIME_RELAY_USER_ACTIVITY_LOG', 'user_activity', (identity) => ({
    table: 'user_activity_log',
    filters: { user_id: identity.user_id },
  })),
);

export default router;
