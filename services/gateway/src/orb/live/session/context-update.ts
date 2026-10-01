/**
 * VTID-04425 (Plan v1 WS-3.3) — screen and app state during the conversation.
 *
 * Until now the widget reported the screen once, in the session start
 * payload. A screen the user navigated to by hand mid-conversation never
 * reached the server; `session.current_route` moved only when Vitana
 * navigated herself. So `get_current_screen`, the navigator and the brain
 * answered about a screen the user had already left.
 *
 * The widget now sends a `context_update` message (WebSocket frame, or the
 * SSE `/live/stream/send` body) whenever the host route or its small app
 * state changes during a live session. This module validates it and updates
 * the session fields those readers already use.
 *
 * It is never injected into the model's stream. The WS-3.1 probe
 * (VTID-04424) showed that mid-session SYSTEM text fails the Nova stream and
 * that USER text either is ignored or makes Nova answer it unprompted. The
 * model reaches this state through its tools (`get_current_screen`, and the
 * guidance tool planned for WS-3.2). The tool list itself is fixed for the
 * stream, so a surface change here does not change the declared tools.
 */

export const CONTEXT_UPDATE_MAX_ROUTE_CHARS = 300;
export const CONTEXT_UPDATE_MAX_TITLE_CHARS = 120;
export const CONTEXT_UPDATE_MAX_STATE_KEYS = 12;
export const CONTEXT_UPDATE_MAX_STATE_VALUE_CHARS = 120;
export const CONTEXT_UPDATE_MAX_RECENT_ROUTES = 5;
/** Route-change diagnostics per session; the counters keep counting past it. */
export const CONTEXT_UPDATE_MAX_DIAGS = 20;

const STATE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export type AppStateValue = string | number | boolean;

export interface SanitizedContextUpdate {
  current_route: string | null;
  recent_routes: string[] | null;
  screen_title: string | null;
  app_state: Record<string, AppStateValue> | null;
  is_mobile: boolean | null;
}

export interface ContextUpdateStats {
  received: number;
  applied: number;
  route_changes: number;
  ignored: number;
  last_at: number | null;
}

/** The session fields this module reads and writes. */
export interface ContextUpdateTarget {
  current_route?: string;
  recent_routes?: string[];
  clientContext?: { isMobile?: boolean };
  /** Latest screen title and app state from the host, in memory only. */
  screenContext?: { screen_title: string | null; app_state: Record<string, AppStateValue>; updated_at: number } | null;
  contextUpdateStats?: ContextUpdateStats;
}

export interface ContextUpdateResult {
  applied: boolean;
  route_changed: boolean;
  previous_route: string | null;
  reason?: 'invalid' | 'unchanged';
  /** True when a route-change diagnostic should be emitted (bounded). */
  emit_diag: boolean;
}

function cleanRoute(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const r = v.trim();
  if (!r.startsWith('/') || r.startsWith('//') || r.length > CONTEXT_UPDATE_MAX_ROUTE_CHARS) return null;
  if (/[\s<>"'`]/.test(r)) return null;
  return r;
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Validates an untrusted `context_update` body. Unknown fields are dropped;
 * values that do not validate are dropped individually. Returns null when
 * nothing usable remains.
 */
export function sanitizeContextUpdate(raw: unknown): SanitizedContextUpdate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;

  const current_route = cleanRoute(p.current_route);

  let recent_routes: string[] | null = null;
  if (Array.isArray(p.recent_routes)) {
    recent_routes = p.recent_routes
      .map(cleanRoute)
      .filter((r): r is string => r !== null)
      .slice(0, CONTEXT_UPDATE_MAX_RECENT_ROUTES);
  }

  const screen_title = cleanText(p.screen_title, CONTEXT_UPDATE_MAX_TITLE_CHARS);

  let app_state: Record<string, AppStateValue> | null = null;
  if (p.app_state && typeof p.app_state === 'object' && !Array.isArray(p.app_state)) {
    app_state = {};
    let n = 0;
    for (const [k, v] of Object.entries(p.app_state as Record<string, unknown>)) {
      if (n >= CONTEXT_UPDATE_MAX_STATE_KEYS) break;
      if (!STATE_KEY_RE.test(k)) continue;
      if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) {
        app_state[k] = v;
        n++;
      } else if (typeof v === 'string') {
        const t = cleanText(v, CONTEXT_UPDATE_MAX_STATE_VALUE_CHARS);
        if (t !== null) {
          app_state[k] = t;
          n++;
        }
      }
    }
  }

  const is_mobile = typeof p.is_mobile === 'boolean' ? p.is_mobile : null;

  if (current_route === null && recent_routes === null && screen_title === null && app_state === null && is_mobile === null) {
    return null;
  }
  return { current_route, recent_routes, screen_title, app_state, is_mobile };
}

function sameState(a: Record<string, AppStateValue> | undefined, b: Record<string, AppStateValue>): boolean {
  if (!a) return Object.keys(b).length === 0;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => a[k] === b[k]);
}

/**
 * Applies a `context_update` to the session. A route change pushes the
 * previous route onto `recent_routes` (newest first, deduplicated, at most 5)
 * unless the host sent its own trail. Duplicate updates change nothing.
 */
export function applyContextUpdate(
  session: ContextUpdateTarget,
  raw: unknown,
  nowMs: number = Date.now(),
): ContextUpdateResult {
  const stats: ContextUpdateStats = session.contextUpdateStats
    ?? (session.contextUpdateStats = { received: 0, applied: 0, route_changes: 0, ignored: 0, last_at: null });
  stats.received += 1;

  const previous = session.current_route ?? null;
  const update = sanitizeContextUpdate(raw);
  if (!update) {
    stats.ignored += 1;
    return { applied: false, route_changed: false, previous_route: previous, reason: 'invalid', emit_diag: false };
  }

  let changed = false;
  let routeChanged = false;

  if (update.current_route !== null && update.current_route !== previous) {
    session.current_route = update.current_route;
    routeChanged = true;
    changed = true;
    if (update.recent_routes === null && previous) {
      const trail = (session.recent_routes ?? []).filter((r) => r !== previous && r !== update.current_route);
      session.recent_routes = [previous, ...trail].slice(0, CONTEXT_UPDATE_MAX_RECENT_ROUTES);
    }
  }

  if (update.recent_routes !== null) {
    const next = update.recent_routes.filter((r) => r !== session.current_route);
    const cur = session.recent_routes ?? [];
    if (next.length !== cur.length || next.some((r, i) => r !== cur[i])) {
      session.recent_routes = next;
      changed = true;
    }
  }

  if (update.is_mobile !== null) {
    const cc = session.clientContext ?? (session.clientContext = {});
    if (cc.isMobile !== update.is_mobile) {
      cc.isMobile = update.is_mobile;
      changed = true;
    }
  }

  if (update.screen_title !== null || update.app_state !== null || routeChanged) {
    const prev = session.screenContext ?? null;
    // A new screen starts with a clean state: state from the old screen does
    // not describe the new one.
    const title = update.screen_title ?? (routeChanged ? null : prev?.screen_title ?? null);
    const state = update.app_state ?? (routeChanged ? {} : prev?.app_state ?? {});
    if (!prev || prev.screen_title !== title || !sameState(prev.app_state, state)) {
      session.screenContext = { screen_title: title, app_state: state, updated_at: nowMs };
      changed = true;
    }
  }

  if (!changed) {
    stats.ignored += 1;
    return { applied: false, route_changed: false, previous_route: previous, reason: 'unchanged', emit_diag: false };
  }

  stats.applied += 1;
  stats.last_at = nowMs;
  if (routeChanged) stats.route_changes += 1;
  return {
    applied: true,
    route_changed: routeChanged,
    previous_route: previous,
    emit_diag: routeChanged && stats.route_changes <= CONTEXT_UPDATE_MAX_DIAGS,
  };
}

/** Compact counters for the session's finalized event. */
export function contextUpdateSummary(session: { contextUpdateStats?: ContextUpdateStats }): Omit<ContextUpdateStats, 'last_at'> | undefined {
  const s = session.contextUpdateStats;
  if (!s || s.received === 0) return undefined;
  return { received: s.received, applied: s.applied, route_changes: s.route_changes, ignored: s.ignored };
}

/**
 * The one entry point both transports use: apply the update and, on a route
 * change, emit one bounded `context_update` diagnostic through the caller's
 * emitter. Returns the apply result.
 */
export function handleContextUpdateMessage<S>(
  session: S,
  raw: unknown,
  emitDiag: (session: S, stage: string, extra?: Record<string, unknown>) => void,
  nowMs: number = Date.now(),
): ContextUpdateResult {
  const target = session as unknown as ContextUpdateTarget;
  const r = applyContextUpdate(target, raw, nowMs);
  if (r.emit_diag) {
    try {
      emitDiag(session, 'context_update', {
        route: target.current_route ?? null,
        previous_route: r.previous_route,
        route_changes: target.contextUpdateStats?.route_changes ?? 0,
      });
    } catch {
      /* a diagnostic never affects the session */
    }
  }
  return r;
}
