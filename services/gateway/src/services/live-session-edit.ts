/**
 * VTID-05559 (live-room-edit-cohost / gateway-cohost) — session edit rules.
 *
 * Pure functions: which fields are locked while a session is live or in the
 * lobby, and how an accepted edit maps onto the session row and the listing.
 * The route does the reads and writes; these functions decide what they are.
 */

export const LOCKED_WHILE_OPEN = ['starts_at', 'duration_minutes'] as const;

export interface SessionEditBody {
  session_title?: string;
  topic_keys?: string[];
  starts_at?: string;
  duration_minutes?: number;
  co_hosts?: string[];
}

export interface CurrentSessionTimes {
  starts_at: string;
  ends_at?: string | null;
}

/** Fields the body wants to change that are locked for this session status. */
export function lockedFieldsRequested(body: SessionEditBody, sessionStatus: string): string[] {
  if (sessionStatus !== 'live' && sessionStatus !== 'lobby') return [];
  return LOCKED_WHILE_OPEN.filter((k) => body[k] !== undefined);
}

export interface SessionEditPatch {
  session: Record<string, unknown>;
  listing: Record<string, unknown>;
}

/**
 * Maps an accepted edit to the session row and the listing row. Only keys the
 * body sends are written. ends_at follows starts_at + duration when either changes.
 */
export function buildSessionEditPatch(body: SessionEditBody, current: CurrentSessionTimes): SessionEditPatch {
  const session: Record<string, unknown> = {};
  const listing: Record<string, unknown> = {};

  if (body.session_title !== undefined) {
    session.session_title = body.session_title;
    listing.title = body.session_title;
  }
  if (body.topic_keys !== undefined) {
    session.topic_keys = body.topic_keys;
    listing.tags = body.topic_keys;
  }
  if (body.starts_at !== undefined || body.duration_minutes !== undefined) {
    const startsAt = body.starts_at ?? current.starts_at;
    const startMs = Date.parse(startsAt);
    const minutes = body.duration_minutes ?? durationMinutes(current);
    session.starts_at = startsAt;
    session.ends_at = new Date(startMs + minutes * 60_000).toISOString();
    listing.scheduled_for = startsAt;
    listing.duration_minutes = minutes;
  }
  if (body.co_hosts !== undefined) {
    listing.co_hosts = body.co_hosts;
  }
  return { session, listing };
}

function durationMinutes(current: CurrentSessionTimes): number {
  if (!current.ends_at) return 60;
  const ms = Date.parse(current.ends_at) - Date.parse(current.starts_at);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60_000) : 60;
}
