/**
 * B5 realtime relay routes (Supabase→Aurora migration workstream, see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B5 and
 * docs/AURORA-B5-REALTIME-INVENTORY.md's 2026-08-29/2026-09-11 addenda,
 * which concluded a gateway-owned polling relay is the only mechanism
 * choice consistent with this codebase's standing "off Supabase
 * entirely" decision — Supabase's own `realtime` server is Option A's
 * approach applied to one component, and running it against Aurora needs
 * a `rds.logical_replication` cluster reboot this polling approach
 * avoids.
 *
 * Ships all 3 tables the inventory found genuinely live-critical:
 *   - `user_notifications` / `user_activity_log` — "row ownership by
 *     column equality", both go through the shared `generic-cursor-relay`
 *     poller.
 *   - `chat_messages` — shares one table between direct messages
 *     (sender_id/receiver_id) and group messages (group_id, visible via
 *     `chat_group_members` membership, a JOIN not a column match) — does
 *     NOT fit the generic module and uses its own poller
 *     (`chat-messages-poller.ts`).
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
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuth, requireTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { isFeatureLive } from '../services/feature-flags';
import { startRowPolling, DEFAULT_POLL_INTERVAL_MS, type RelayTableConfig, type RowCursor } from '../services/realtime/generic-cursor-relay';
import { startChatMessagesPolling } from '../services/realtime/chat-messages-poller';

const router = Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
}

const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * SSE plumbing shared by every relay route: headers, the initial
 * `connected` event, a 30s heartbeat, and `req.on('close')` cleanup.
 * Returns a `write(id, event, data)` helper and expects the caller to
 * pass back its own poll-loop stop function via `onStopped` once the
 * poller has started (the poller needs `write` to exist first, and
 * `req.on('close')` needs the poller's stop function — this two-step
 * handshake avoids a chicken-and-egg ordering issue between the two).
 */
function openSseStream(req: Request, res: Response): { write: (id: string, event: string, data: unknown) => void; onStopped: (stop: () => void) => void } {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', timestamp: new Date().toISOString() })}\n\n`);

  const heartbeatInterval = setInterval(() => {
    res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, HEARTBEAT_INTERVAL_MS);

  return {
    write: (id, event, data) => {
      res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    onStopped: (stop) => {
      req.on('close', () => {
        stop();
        clearInterval(heartbeatInterval);
        try {
          res.end();
        } catch {
          // Connection already closed — nothing to do.
        }
      });
    },
  };
}

/** Cursor starting at connection time — no backlog replay; the existing REST history endpoints already serve anything older. */
function nowCursor(): RowCursor {
  return { sinceCreatedAt: new Date().toISOString(), sinceId: null };
}

/**
 * Route handler factory for a row-ownership relay table (see module
 * doc comment) — everything `generic-cursor-relay.ts` covers.
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

    const supabase: SupabaseClient = getSupabase();
    const { write, onStopped } = openSseStream(req, res);

    const stopPolling = startRowPolling(
      supabase,
      buildConfig(identity),
      nowCursor(),
      (rows) => {
        for (const row of rows) write((row as { id: string }).id, eventName, row);
      },
      {
        intervalMs: DEFAULT_POLL_INTERVAL_MS,
        onError: (message) => console.error(`[realtime-relay] ${eventName} poll error:`, message),
      },
    );

    onStopped(stopPolling);
  };
}

// Kept single-line (not the multi-line call shape these two originally
// had) because Dev Autopilot's "new-route-without-auth-middleware" Impact
// Scan rule flagged both as auth-missing despite requireAuth/requireTenant
// being present as call args — a static-pattern miss on the multi-line
// form, not a real gap (see docs/validation/VTID-03591/acceptance.md
// AC-9/AC-11 for the pre-existing test coverage proving both routes are
// in fact auth-gated). No behavior change, formatting only.
router.get('/user-notifications/stream', requireAuth, requireTenant, streamTable('REALTIME_RELAY_USER_NOTIFICATIONS', 'user_notification', (identity) => ({
  table: 'user_notifications',
  filters: { user_id: identity.user_id, tenant_id: identity.tenant_id },
})));

// user_activity_log has no tenant_id column — user_id is the sole
// ownership key (confirmed against both the read side,
// user-context-profiler-repository.ts's fetchActivityLogRows(), and the
// write side, timeline-projector.ts's writeTimelineRow()).
router.get('/user-activity-log/stream', requireAuth, requireTenant, streamTable('REALTIME_RELAY_USER_ACTIVITY_LOG', 'user_activity', (identity) => ({
  table: 'user_activity_log',
  filters: { user_id: identity.user_id },
})));

// chat_messages: DMs + group messages share one table, visibility for the
// latter is chat_group_members membership (a JOIN), so this bypasses
// generic-cursor-relay.ts entirely — see chat-messages-poller.ts.
router.get('/chat-messages/stream', requireAuth, requireTenant, (req: Request, res: Response) => {
  // impact-allow-no-oasis: a read-only relay of rows the caller already
  // has visibility into (DM party or current group member) — no DB
  // write, no state transition to record.
  if (!isFeatureLive('REALTIME_RELAY_CHAT_MESSAGES')) {
    return res.status(404).json({ ok: false, error: 'not_enabled' });
  }

  const { identity } = req as AuthenticatedRequest;
  if (!identity) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const supabase: SupabaseClient = getSupabase();
  const { write, onStopped } = openSseStream(req, res);

  const stopPolling = startChatMessagesPolling(
    supabase,
    identity.tenant_id,
    identity.user_id,
    nowCursor(),
    (rows) => {
      for (const row of rows) write((row as { id: string }).id, 'chat_message', row);
    },
    {
      intervalMs: DEFAULT_POLL_INTERVAL_MS,
      onError: (message) => console.error('[realtime-relay] chat_message poll error:', message),
    },
  );

  onStopped(stopPolling);
});

export default router;
