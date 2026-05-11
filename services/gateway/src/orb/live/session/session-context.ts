/**
 * A6 (orb-live-refactor): SessionContext — the typed, read-only view of
 * GeminiLiveSession that tool handlers consume.
 *
 * Per the approved plan:
 *   "A6. Split tool execution by domain. Replace executeLiveApiToolInner()
 *    with dispatcher; each domain in tools/handlers/. Handlers receive a
 *    typed SessionContext API; NO direct session-state mutation."
 *
 * This module is **A6.1** — it establishes the typed seam. The full per-
 * handler split (A6.2 / A6.3) consumes this type without inventing its
 * own shape, and the dispatcher in `orb/live/tools/live-tool-executor.ts`
 * (lifted in a follow-up PR) accepts `SessionContext` instead of the full
 * `GeminiLiveSession`. Handler files end up with a tiny API surface
 * (read-only inputs + a typed mutator API exposed by the controller).
 *
 * Why the type lives separately from the function extraction:
 *   - The full executeLiveApiToolInner lift is ~2,600 lines with many
 *     cross-file dependencies (handleGetCurrentScreen, createContextLens,
 *     ADMIN_TOOL_HANDLERS, dispatchOrbToolForVertex, etc.). Doing it as
 *     one PR creates blast-radius risk that A3 + A5 avoided.
 *   - Future PRs (A6.2 starting with navigator handlers, then memory
 *     domain, then health domain, then social domain) each move one
 *     bounded set of handlers and migrate them to SessionContext. This
 *     incremental path keeps every PR small enough to review.
 *
 * Hard guardrail (from plan + match-journey injection):
 *   - SessionContext is **read-only**. Mutation must go through a typed
 *     mutator API on the SessionController (A8). Handlers MUST NOT
 *     reach into the underlying session map directly.
 */

import type { SupabaseIdentity } from '../../../middleware/auth-supabase-jwt';
import type { ClientContext } from '../types';

/**
 * The read-only view of an ORB voice session that tool handlers see.
 *
 * **Critical:** every field here is either:
 *   - a primitive (string, number, boolean) — copy semantics, can't mutate
 *     the underlying session even if a handler tried; OR
 *   - a `Readonly<...>` / `ReadonlyArray<...>` — TypeScript prevents
 *     mutation at compile time; OR
 *   - a structurally-cloned snapshot — a deliberate copy, not a reference.
 *
 * No `live*` runtime handles (WebSocket, AbortController, AudioContext)
 * appear here. Those live on the underlying `GeminiLiveSession` only and
 * are accessed through the SessionController's typed action API.
 */
export interface SessionContext {
  /** Server-issued session ID (`live-<uuid>` for SSE, `ws-<uuid>` for WebSocket). */
  readonly sessionId: string;

  /** Stable thread ID across reconnects, if the client supplied one. */
  readonly threadId: string | null;

  /** Authenticated user identity, or null for anonymous onboarding sessions. */
  readonly identity: Readonly<SupabaseIdentity> | null;

  /** Active role (community / admin / developer / etc.). Authoritative for this session. */
  readonly activeRole: string | null;

  /** Session language (en / de / fr / ...). */
  readonly lang: string;

  /** Vitana ID handle ("@alex3700") if provisioned, else null. */
  readonly vitanaId: string | null;

  /** Client context envelope (IP geo, time-of-day, device class). */
  readonly clientContext: Readonly<ClientContext> | undefined;

  /** Current navigation route reported by the host app. */
  readonly currentRoute: string | null;

  /** Recent navigation trail (newest → oldest), bounded length. */
  readonly recentRoutes: ReadonlyArray<string>;

  /** Number of completed user turns so far in this session. */
  readonly turnCount: number;

  /** ISO timestamp the session was created on the server. */
  readonly createdAt: string;

  /** Whether the current invocation is the start of a transparent reconnect (VTID-02020). */
  readonly isReconnect: boolean;
}

/**
 * Build a `SessionContext` from the underlying session shape used inside
 * `orb-live.ts`. Accepts a structural shape (not the named type) so this
 * module doesn't have to import the route file — avoids a cycle.
 *
 * Callers (currently the dispatcher inside orb-live.ts; in A6.2 the
 * extracted dispatcher) pass `buildSessionContext(session)` once per
 * tool call and forward the resulting `SessionContext` to handlers.
 */
export function buildSessionContext(session: SessionLike): SessionContext {
  const clientContext = session.clientContext
    ? Object.freeze({ ...session.clientContext }) as Readonly<ClientContext>
    : undefined;

  const identity = session.identity
    ? Object.freeze({ ...session.identity }) as Readonly<SupabaseIdentity>
    : null;

  // Defensive copy of route trail. We slice + freeze so a handler can't
  // even theoretically mutate the source array.
  const recentRoutes = Array.isArray(session.recentRoutes)
    ? Object.freeze(session.recentRoutes.slice()) as ReadonlyArray<string>
    : Object.freeze([]) as ReadonlyArray<string>;

  return Object.freeze({
    sessionId: session.sessionId,
    threadId: session.thread_id ?? null,
    identity,
    activeRole: session.identity?.role ?? null,
    lang: session.lang ?? 'en',
    vitanaId: session.identity?.vitana_id ?? null,
    clientContext,
    currentRoute: session.current_route ?? null,
    recentRoutes,
    turnCount: session.turn_count ?? 0,
    createdAt: session.createdAt instanceof Date
      ? session.createdAt.toISOString()
      : (typeof session.createdAt === 'string' ? session.createdAt : new Date(0).toISOString()),
    isReconnect: Boolean(session.isReconnectStart),
  });
}

/**
 * Structural shape `buildSessionContext` accepts.
 *
 * This is intentionally NOT `import { GeminiLiveSession }` — that would
 * pull the runtime session map types (WebSocket, AbortController, etc.)
 * into this module. We declare only the read-only subset we actually
 * consume. The runtime `GeminiLiveSession` is a superset and will
 * satisfy this type structurally.
 */
export interface SessionLike {
  sessionId: string;
  thread_id?: string | null;
  identity?: SupabaseIdentity | null;
  lang?: string;
  clientContext?: ClientContext;
  current_route?: string | null;
  recentRoutes?: string[];
  turn_count?: number;
  createdAt: Date | string;
  isReconnectStart?: boolean;
}
