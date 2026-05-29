/**
 * L2.2b.1 (VTID-02987): minimal OASIS-emit proxy for the LiveKit orb-agent
 * service (and other future service-token holders).
 *
 * The Python `services/agents/orb-agent` worker POSTs lifecycle telemetry to
 * `/api/v1/oasis/emit` so the agent's room-join + tool-dispatch state is
 * visible in OASIS without giving the agent a direct Supabase write surface.
 * The agent uses `Authorization: Bearer ${GATEWAY_SERVICE_TOKEN}`; admins
 * can also call this route from CLI/Cmd-Hub using their normal JWT (must be
 * `exafy_admin`).
 *
 * Hard rules:
 *   - NO unauthenticated access. The route is service+admin only.
 *   - Topic prefix allowlist: ONLY `orb.livekit.`, `livekit.`, and
 *     `vtid.live.` (VTID-02992: matches Vertex's vtid.live.session.*
 *     namespace so the agent's session-lifecycle emits land in the same
 *     Voice Lab query) topics are accepted. Arbitrary topics would let
 *     the agent forge events from other surfaces — refuse them.
 *   - Body size cap (16 KiB) — telemetry payloads are tiny by design.
 *   - The route delegates to `emitOasisEvent` (the same function the gateway
 *     uses internally), so OASIS persistence stays unified.
 *   - Failures here NEVER affect the voice/data path — they return 4xx and
 *     the agent's `OasisEmitter` logs + drops them.
 *
 * L2.2b.2+ may extend the allowlist as additional `livekit.*` topics are
 * emitted. The list intentionally starts narrow.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  optionalAuth,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import type { CicdEventType } from '../types/cicd';

const router = Router();

const VTID = 'VTID-02987';

// Cap body at 16 KiB. Telemetry payloads are small by design.
const MAX_BODY_BYTES = 16 * 1024;

// Allowed topic prefixes — refuse everything else.
// VTID-02992: `vtid.live.` added so the orb-agent's session-lifecycle
// emits from VTID-02986 (vtid.live.session.start/stop +
// vtid.live.stall_detected) reach oasis_events. Voice Lab's
// /api/v1/voice-lab/live/sessions query filters on the same prefix to
// surface LiveKit sessions next to Vertex's vtid.live.session.* rows in
// the same panel. Without this entry the topics 400 here and silently
// disappear — Voice Lab stays empty for LiveKit, and the failure
// classifier sees no session-stop metrics.
const ALLOWED_PREFIXES = ['orb.livekit.', 'livekit.', 'vtid.live.'] as const;

function isAllowedTopic(topic: unknown): topic is string {
  if (typeof topic !== 'string') return false;
  if (topic.length === 0 || topic.length > 256) return false;
  return ALLOWED_PREFIXES.some((p) => topic.startsWith(p));
}

const BodySchema = z.object({
  topic: z.string().min(1).max(256),
  payload: z.record(z.unknown()).optional(),
  vtid: z.string().max(64).optional(),
});

type ParsedBody = z.infer<typeof BodySchema>;

/**
 * Auth middleware: accept EITHER
 *   - `Authorization: Bearer <GATEWAY_SERVICE_TOKEN>` (the orb-agent path), OR
 *   - `Authorization: Bearer <JWT>` where the validated JWT has
 *     `exafy_admin === true` (operator CLI / Command Hub path).
 *
 * Service-token path is checked FIRST so an unauthenticated request never
 * triggers JWT validation overhead, and so a malformed JWT can't accidentally
 * match the service-token comparison.
 */
function emitAuthGate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.header('authorization') ?? req.header('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({ ok: false, error: 'missing bearer token', vtid: VTID });
    return;
  }
  const token = header.slice('bearer '.length).trim();
  if (!token) {
    res.status(401).json({ ok: false, error: 'empty bearer token', vtid: VTID });
    return;
  }

  // Path 1: service-token match.
  const serviceToken = process.env.GATEWAY_SERVICE_TOKEN ?? '';
  if (serviceToken.length > 0 && token === serviceToken) {
    (req as AuthenticatedRequest).identity = undefined;
    (req as Request & { __emit_actor?: string }).__emit_actor = 'service:orb-agent';
    next();
    return;
  }

  // Path 2: JWT — must be exafy_admin. Defer to optionalAuth to populate
  // req.identity, then assert exafy_admin.
  optionalAuth(req as AuthenticatedRequest, res, () => {
    const id = (req as AuthenticatedRequest).identity;
    if (id && id.exafy_admin === true) {
      (req as Request & { __emit_actor?: string }).__emit_actor =
        `admin:${id.user_id ?? 'unknown'}`;
      next();
      return;
    }
    res.status(401).json({
      ok: false,
      error: 'unauthorized — service token or exafy_admin JWT required',
      vtid: VTID,
    });
  });
}

/**
 * Body-size guard. Express's default JSON parser already enforces a global
 * limit, but we want a tighter telemetry-specific cap so the agent can't
 * accidentally pump large payloads through this surface.
 */
function bodySizeGuard(req: Request, res: Response, next: NextFunction): void {
  const lenHeader = req.header('content-length');
  if (lenHeader && Number(lenHeader) > MAX_BODY_BYTES) {
    res
      .status(413)
      .json({ ok: false, error: 'payload too large', max_bytes: MAX_BODY_BYTES, vtid: VTID });
    return;
  }
  next();
}

router.post(
  '/oasis/emit',
  bodySizeGuard,
  emitAuthGate,
  async (req: Request, res: Response) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: 'invalid request body',
        issues: parsed.error.issues,
        vtid: VTID,
      });
      return;
    }
    const body: ParsedBody = parsed.data;

    if (!isAllowedTopic(body.topic)) {
      res.status(400).json({
        ok: false,
        error: `topic must start with one of: ${ALLOWED_PREFIXES.join(', ')}`,
        topic: body.topic,
        vtid: VTID,
      });
      return;
    }

    // Body-size post-parse check (covers chunked requests without
    // content-length).
    try {
      const serialized = JSON.stringify(body);
      if (serialized.length > MAX_BODY_BYTES) {
        res
          .status(413)
          .json({ ok: false, error: 'payload too large', max_bytes: MAX_BODY_BYTES, vtid: VTID });
        return;
      }
    } catch {
      // Shouldn't happen — Zod already parsed the body, so JSON.stringify
      // will succeed. Defensive only.
      res.status(400).json({ ok: false, error: 'payload not serializable', vtid: VTID });
      return;
    }

    const actor = (req as Request & { __emit_actor?: string }).__emit_actor ?? 'service:unknown';
    const emitVtid = body.vtid && body.vtid.length > 0 ? body.vtid : VTID;

    const result = await emitOasisEvent({
      vtid: emitVtid,
      type: body.topic as CicdEventType,
      source: 'orb-agent',
      status: 'info',
      message: `[${body.topic}] emitted via /api/v1/oasis/emit`,
      payload: body.payload ?? {},
      actor_role: actor.startsWith('admin:') ? 'admin' : 'agent',
      surface: 'api',
    });

    if (!result.ok) {
      res.status(500).json({
        ok: false,
        error: result.error ?? 'emit failed',
        vtid: VTID,
      });
      return;
    }
    res.json({ ok: true, event_id: result.event_id, vtid: VTID });
  },
);

export default router;
