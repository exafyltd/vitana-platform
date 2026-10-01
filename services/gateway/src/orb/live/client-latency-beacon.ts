/**
 * VTID-04542 — client latency beacon receiver.
 *
 * `POST /api/v1/orb/live/client-latency` (mounted in routes/orb-live.ts next
 * to /live/session/start, with optionalAuth). The widget posts what only the
 * browser can see — ms since the member tapped the ORB for each client-side
 * milestone — and the gateway files it as one `voice.latency.client` OASIS
 * event, joinable to `voice.latency.measured` by session_id.
 *
 * Body contract (exact; the client side is built by another stream):
 *   {
 *     session_id: string,                      // ≤ 64 chars
 *     entry: 'mobile' | 'desktop' | 'command_hub',
 *     transport: 'ws' | 'sse',
 *     marks: { [name: string]: number },       // ≤ 20 marks, name ≤ 64 chars,
 *                                              // value 0..600000 (ms since tap)
 *     prewarm_socket_ready?: boolean,
 *   }
 *
 * Telemetry posture: 400 on a bad body, 413 on a body over 4 KB, otherwise
 * 204 immediately — the OASIS write happens after the response and its
 * failure is swallowed. This route never answers 5xx for a telemetry fault.
 * `text/plain` bodies (navigator.sendBeacon's default) are accepted: a
 * string body is parsed as JSON here.
 */

import type { Response } from 'express';
import { z } from 'zod';
import { emitOasisEvent } from '../../services/oasis-event-service';
import { VITANA_ENV } from '../../env';

export const CLIENT_LATENCY_MAX_BODY_BYTES = 4096;
export const CLIENT_LATENCY_MAX_MARKS = 20;
export const CLIENT_LATENCY_MAX_MARK_MS = 600_000;

const shortString = z.string().min(1).max(64);

export const clientLatencyBeaconSchema = z
  .object({
    // Empty when the member closed the overlay before a session existed
    // (found on staging: that cycle was rejected with a 400 and lost). The key
    // stays required; an empty value is recorded as session_id null.
    session_id: z.string().max(64),
    entry: z.enum(['mobile', 'desktop', 'command_hub']),
    transport: z.enum(['ws', 'sse']),
    marks: z
      .record(shortString, z.number().finite().min(0).max(CLIENT_LATENCY_MAX_MARK_MS))
      .refine((m) => Object.keys(m).length <= CLIENT_LATENCY_MAX_MARKS, {
        message: `at most ${CLIENT_LATENCY_MAX_MARKS} marks`,
      }),
    prewarm_socket_ready: z.boolean().optional(),
  });
// Unknown top-level keys are stripped, not rejected: a newer widget adding a
// field must not turn every beacon into a 400.

export type ClientLatencyBeacon = z.infer<typeof clientLatencyBeaconSchema>;

interface BeaconRequest {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  identity?: { user_id?: string | null } | null;
}

function bodySizeBytes(req: BeaconRequest, parsed: unknown): number {
  const header = req.headers['content-length'];
  const declared = Number(Array.isArray(header) ? header[0] : header);
  if (Number.isFinite(declared) && declared > 0) return declared;
  try {
    return Buffer.byteLength(typeof parsed === 'string' ? parsed : JSON.stringify(parsed ?? ''));
  } catch {
    return 0;
  }
}

/** Express handler. Exported separately from the route so it is testable. */
export function handleClientLatencyBeacon(req: BeaconRequest, res: Response): Response | void {
  let raw: unknown = req.body;
  if (bodySizeBytes(req, raw) > CLIENT_LATENCY_MAX_BODY_BYTES) {
    return res.status(413).json({ ok: false, error: 'BODY_TOO_LARGE' });
  }
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return res.status(400).json({ ok: false, error: 'INVALID_JSON' });
    }
  }
  const parsed = clientLatencyBeaconSchema.safeParse(raw);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_BODY',
      details: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
  }

  const beacon = parsed.data;
  const userId = req.identity?.user_id ?? null;
  res.status(204).end();

  // After the response: fire-and-forget, never throws.
  try {
    void emitOasisEvent({
      vtid: 'VTID-04542',
      type: 'voice.latency.client',
      source: 'gateway/client-latency-beacon',
      status: 'info',
      message: `client latency ${beacon.entry}/${beacon.transport} (${Object.keys(beacon.marks).length} marks)`,
      actor_id: userId ?? undefined,
      payload: {
        session_id: beacon.session_id || null,
        entry: beacon.entry,
        transport: beacon.transport,
        marks: beacon.marks,
        prewarm_socket_ready: beacon.prewarm_socket_ready ?? null,
        user_id: userId,
        env: VITANA_ENV,
      },
    }).catch(() => { /* telemetry only */ });
  } catch {
    /* telemetry only */
  }
}
