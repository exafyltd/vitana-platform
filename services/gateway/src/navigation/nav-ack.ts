/**
 * VTID-04520 — the app confirms what a navigation actually did.
 *
 * The server used to assume every directive worked: it moved
 * `current_route` the moment the directive left, so a refused or failed
 * navigation turned into a false "you are already there" on the next
 * request. With the registry dispatcher (NAV_V2_ENABLED) the widget reports
 * `nav_result` after the app handled the directive:
 *
 *   opened      the screen or overlay is showing
 *   refused     the app declined (e.g. a desktop-only screen on mobile)
 *   not_found   the app does not know the screen / nothing opened
 *   error       the handler threw
 *   unknown     the host did not say (older app builds) — treated as opened
 *
 * `current_route` moves only on `opened`. A failure is kept for the next
 * navigation tool result so the model can say what happened, and is emitted
 * as `orb.navigator.acknowledged` so dispatched-vs-opened can be measured.
 */
import { pageOf } from './nav-registry';

export type NavAckStatus = 'opened' | 'refused' | 'not_found' | 'error' | 'unknown';
const STATUSES: ReadonlySet<string> = new Set(['opened', 'refused', 'not_found', 'error', 'unknown']);

export interface PendingNavAck {
  screen_id: string;
  route: string;
  entry_kind: string;
  sent_at: number;
}

export interface NavFailure {
  screen_id: string;
  status: NavAckStatus;
  reason: string | null;
  at: number;
}

/** The slice of the live session this module reads and writes. */
export interface NavAckSession {
  sessionId?: string;
  current_route?: string | null;
  recent_routes?: string[];
  pendingNavAck?: PendingNavAck | null;
  lastNavFailure?: NavFailure | null;
}

export function recordPendingNavAck(session: NavAckSession, directive: Record<string, unknown>): void {
  session.pendingNavAck = {
    screen_id: String(directive.screen_id || ''),
    route: String(directive.route || ''),
    entry_kind: String(directive.entry_kind || 'route'),
    sent_at: Date.now(),
  };
}

export interface NavResultMessage {
  screen_id: string | null;
  route: string | null;
  status: NavAckStatus;
  reason: string | null;
  entry_kind: string;
}

/** Validate a client nav_result frame. Returns null when it is not one. */
export function sanitizeNavResult(body: unknown): NavResultMessage | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.type !== 'nav_result') return null;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const status = typeof b.status === 'string' && STATUSES.has(b.status) ? (b.status as NavAckStatus) : 'unknown';
  return {
    screen_id: str(b.screen_id, 80),
    route: str(b.route, 300),
    status,
    reason: str(b.reason, 200),
    entry_kind: b.entry_kind === 'overlay' ? 'overlay' : 'route',
  };
}

export interface NavAckOutcome {
  applied: boolean;
  status: NavAckStatus;
  route_changed: boolean;
  latency_ms: number | null;
}

/** Apply a confirmed result to the session. Pure apart from the session. */
export function applyNavResult(session: NavAckSession, msg: NavResultMessage, now = Date.now()): NavAckOutcome {
  const pending = session.pendingNavAck || null;
  const latency = pending ? now - pending.sent_at : null;
  if (pending && msg.screen_id && pending.screen_id && msg.screen_id !== pending.screen_id) {
    // A result for a directive we are not waiting on (stale or duplicate).
    return { applied: false, status: msg.status, route_changed: false, latency_ms: null };
  }
  session.pendingNavAck = null;
  let routeChanged = false;
  // 'unknown' is a host that does not report yet (it returned nothing):
  // believe the directive, as before this change, and record no failure.
  if (msg.status === 'opened' || msg.status === 'unknown') {
    session.lastNavFailure = null;
    const route = msg.route || pending?.route || null;
    if (route && msg.entry_kind !== 'overlay') {
      const next = pageOf(route);
      const previous = session.current_route || null;
      if (previous !== next) {
        session.current_route = next;
        routeChanged = true;
        if (previous) {
          const trail = Array.isArray(session.recent_routes) ? session.recent_routes.filter((r) => r !== previous) : [];
          session.recent_routes = [previous, ...trail].slice(0, 5);
        }
      }
    }
  } else {
    session.lastNavFailure = {
      screen_id: msg.screen_id || pending?.screen_id || '',
      status: msg.status,
      reason: msg.reason,
      at: now,
    };
  }
  return { applied: true, status: msg.status, route_changed: routeChanged, latency_ms: latency };
}

/**
 * One line for the next navigation tool result when the previous attempt
 * did not open anything, so the model can say so instead of claiming it did.
 * Consumed once.
 */
export function takeNavFailureNote(session: NavAckSession, now = Date.now()): string | null {
  const f = session.lastNavFailure;
  if (!f || now - f.at > 5 * 60_000) return null;
  session.lastNavFailure = null;
  const what = f.status === 'refused' ? 'the app declined to open it'
    : f.status === 'not_found' ? 'the app could not find that screen'
      : 'opening it failed';
  return `NOTE: the previous navigation (${f.screen_id || 'unknown screen'}) did not open — ${what}${f.reason ? ` (${f.reason})` : ''}. If the member mentions it, say so plainly.`;
}

/** Record the outcome as an OASIS event (fire-and-forget). */
export async function emitNavAck(session: NavAckSession, msg: NavResultMessage, outcome: NavAckOutcome): Promise<void> {
  const { emitOasisEvent } = await import('../services/oasis-event-service');
  emitOasisEvent({
    vtid: 'VTID-04520',
    type: 'orb.navigator.acknowledged',
    source: 'nav-ack',
    status: msg.status === 'opened' ? 'info' : 'warning',
    message: `${msg.screen_id || '?'}: ${msg.status}`,
    payload: {
      session_id: session.sessionId || null,
      screen_id: msg.screen_id,
      route: msg.route,
      status: msg.status,
      reason: msg.reason,
      entry_kind: msg.entry_kind,
      applied: outcome.applied,
      route_changed: outcome.route_changed,
      latency_ms: outcome.latency_ms,
    },
  }).catch(() => {});
}

/** Handle a nav_result frame end to end. Returns null when body is not one. */
export function handleNavResultMessage(session: NavAckSession, body: unknown): NavAckOutcome | null {
  const msg = sanitizeNavResult(body);
  if (!msg) return null;
  const outcome = applyNavResult(session, msg);
  void emitNavAck(session, msg, outcome);
  return outcome;
}
