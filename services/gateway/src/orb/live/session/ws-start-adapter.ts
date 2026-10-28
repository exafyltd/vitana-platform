/**
 * VTID-03471 (L-04/L-05): run the WebSocket transport's
 * `start` message through the SAME session-start pipeline the HTTP/SSE
 * transport uses (`handleLiveSessionStart`).
 *
 * Why this exists
 * ---------------
 * The ORB has had two independent session-start implementations since
 * VTID-01222:
 *
 *   - `POST /api/v1/orb/live/session/start` → `handleLiveSessionStart`
 *     (live-session-controller.ts) — the path every feature since has been
 *     built on.
 *   - the WS `start` frame → `handleWsStartMessage` (routes/orb-live.ts) —
 *     a fork of the 2026-01 version of the same logic.
 *
 * The fork never received wake-brief selection (VTID-03079/03101), journey
 * guidance (VTID-03300), guided-topic narration (VTID-03290), fast-start
 * wake deferral (ORB-FAST-START), the voice quota gate (VTID-03107), the
 * `AUTH_TOKEN_INVALID` re-auth signal (VTID-AUTH-BACKEND-REJECT), or
 * reconnect continuity (VTID-02020: `transcript_history` / `reconnect_stage`
 * / `conversation_id`). While the WS transport was opt-in that was merely
 * untidy; making it the browser default (L-04/L-05) would have silently
 * regressed the opener for every logged-in session. So the fork goes away
 * instead of being hand-patched a sixth time.
 *
 * How it works
 * ------------
 * `handleLiveSessionStart` touches only `req.identity`, `req.headers`,
 * `req.body`, `req.get()` and `res.status().json()` — a surface small enough
 * to satisfy from a WebSocket upgrade. This module builds that surface,
 * invokes the controller, and hands back the status + JSON body it produced.
 * The caller then binds the resulting session (already registered in
 * `liveSessions` by the controller) to the socket.
 *
 * Nothing about the wire protocol changes: the caller still replies with a
 * `session_started` frame carrying the same fields it always did.
 */

import type { IncomingHttpHeaders } from 'http';
import type { Response } from 'express';
import type {
  AuthenticatedRequest,
  SupabaseIdentity,
} from '../../../middleware/auth-supabase-jwt';
import { handleLiveSessionStart } from './live-session-controller';

/**
 * Result of a WS-originated session start. Mirrors what the HTTP route
 * would have sent to an SSE client.
 */
export interface WsSessionStartResult {
  /** HTTP status the controller chose (200 on success). */
  status: number;
  /** The JSON body the controller produced (`{ ok, session_id, ... }`). */
  body: {
    ok?: boolean;
    error?: string;
    message?: string;
    session_id?: string;
    conversation_id?: string | null;
    meta?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface WsSessionStartInput {
  /**
   * The client's `start` frame, minus the `type` discriminator. Field names
   * are identical to the HTTP start body — that symmetry is what makes this
   * adapter a pass-through rather than a translation layer.
   */
  startMessage: Record<string, unknown>;
  /**
   * Identity already verified by the WS upgrade handler (query token /
   * Authorization header / Sec-WebSocket-Protocol). Undefined for an
   * anonymous socket.
   */
  identity?: SupabaseIdentity;
  /** Raw upgrade request headers — origin/referer/user-agent all matter. */
  upgradeHeaders: IncomingHttpHeaders;
  /**
   * The bearer token the socket authenticated with, if any. Supplied so the
   * controller's `Bearer present but identity missing → 401 AUTH_TOKEN_INVALID`
   * guard behaves the same on both transports: a browser holding an expired
   * JWT gets told to re-auth instead of silently dropping to an anonymous
   * greeting.
   */
  token?: string;
}

/**
 * Invoke the canonical session-start pipeline on behalf of a WebSocket
 * client. The created session is registered in `liveSessions` under the id
 * returned in `body.session_id` — the caller looks it up there and binds
 * `session.clientWs`.
 */
export async function startLiveSessionForWs(
  input: WsSessionStartInput,
): Promise<WsSessionStartResult> {
  const headers: IncomingHttpHeaders = { ...input.upgradeHeaders };
  if (input.token) {
    headers.authorization = `Bearer ${input.token}`;
  } else {
    // A socket that never presented a token must not inherit a stale
    // Authorization header from the upgrade request.
    delete headers.authorization;
  }

  const body: Record<string, unknown> = { ...input.startMessage };
  delete body.type;
  // Read back by the controller's session-start telemetry so the
  // `voice.session.started` stream can separate WS from SSE sessions
  // without a second event type.
  body.transport = 'ws';

  const req = {
    identity: input.identity,
    headers,
    body,
    get(name: string): string | undefined {
      const v = headers[name.toLowerCase() as keyof IncomingHttpHeaders];
      return Array.isArray(v) ? v[0] : (v as string | undefined);
    },
  } as unknown as AuthenticatedRequest;

  let status = 200;
  let payload: WsSessionStartResult['body'] = {};

  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(obj: WsSessionStartResult['body']) {
      payload = obj ?? {};
      return this;
    },
  } as unknown as Response;

  await handleLiveSessionStart(req, res);

  return { status, body: payload };
}
