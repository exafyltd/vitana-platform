/**
 * VTID-05541 (plan eng-gitlab-m2 §3.5): GitLab project webhooks → OASIS events.
 *
 *   POST /api/v1/internal/gitlab/webhook
 *
 * Caller: GitLab project webhooks (from the vitana-v1 cutover; no project has a hook in milestone 2).
 * No JWT and no service token: the Standard Webhooks signature is the gate. GitLab signs
 * `${webhook-id}.${webhook-timestamp}.${raw body}` with HMAC-SHA256, keyed by the base64 part of the
 * signing token `whsec_<base64>`, and sends `webhook-signature: v1,<base64>`. The shared verifier
 * verifySvix (connectors/runtime/webhook-signature.ts) checks exactly that scheme; it takes
 * { id, timestamp, signature } and reads no header itself, so the header names are mapped here
 * (as connectors/wearable/vital.ts does for svix-*). A request with only svix-* headers is refused.
 *
 * index.ts mounts express.raw for this path before express.json(), so the signature is checked over
 * the exact bytes GitLab sent; the JSON is parsed here, after verification.
 *
 * Replies (always JSON):
 *   401 signature_missing          a webhook-* header is missing or the timestamp is not a number.
 *                                  Checked before the key, so an unsigned request is refused 401
 *                                  whether or not the key is configured (the STAGING-VERIFY probe).
 *   500 not_configured             signed, but GITLAB_WEBHOOK_SIGNING_TOKEN is unset or empty (fails closed).
 *   401 signature_invalid | timestamp_out_of_tolerance   bad signature, or more than 300 s off.
 *   200 { duplicate: true }        this webhook-id was already recorded by this gateway task.
 *   400 invalid_json               a verified body that is not JSON.
 *   202 { ignored: true, reason }  unknown event, unmapped action or status, or no VTID.
 *   200 { topic, vtid, event_id }  one OASIS event recorded.
 *   502 oasis_emit_failed          the OASIS write failed; the id stays open for GitLab's retry.
 *   413 payload_too_large / 400 invalid_body   from the raw body parser (gitlabWebhookBodyErrors).
 *
 * OASIS: services/gitlab-events/mapper.ts builds the event (five scm.gitlab.* topics, ids and refs
 * only, never a description, a user or a token); emitOasisEvent writes it. No rule of the VTID
 * lifecycle mapper lists these topics, so no GitLab event moves a VTID's state.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { headerValue, verifySvix } from '../connectors/runtime/webhook-signature';
import { emitOasisEvent } from '../services/oasis-event-service';
import { DeliveryDedupe } from '../services/gitlab-events/dedupe';
import { mapGitlabEvent } from '../services/gitlab-events/mapper';

/** The raw body parser's limit for this path (index.ts). */
export const GITLAB_WEBHOOK_BODY_LIMIT = '2mb';

interface VerifiedDelivery {
  id: string;
  raw: string;
}

function reply(res: Response, status: number, body: Record<string, unknown>): void {
  res.status(status).json(body);
}

function rawBodyOf(req: Request): string {
  // Only the raw parser's Buffer is trusted: a re-serialized object would not carry the signature.
  return Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
}

/** The signature gate: verifies the delivery or answers 401 / 500, before any handler runs. */
export function requireGitlabSignature(req: Request, res: Response, next: NextFunction): void {
  const headers = {
    id: headerValue(req.headers['webhook-id']),
    timestamp: headerValue(req.headers['webhook-timestamp']),
    signature: headerValue(req.headers['webhook-signature']),
  };
  if (!headers.id || !headers.timestamp || !headers.signature || !/^\d+$/.test(headers.timestamp)) {
    return reply(res, 401, { ok: false, error: 'signature_missing' });
  }
  const key = process.env.GITLAB_WEBHOOK_SIGNING_TOKEN;
  if (!key) return reply(res, 500, { ok: false, error: 'not_configured' });
  const raw = rawBodyOf(req);
  const verdict = verifySvix(raw, headers, key);
  if (!verdict.ok) {
    if (verdict.error === 'secret_not_configured') return reply(res, 500, { ok: false, error: 'not_configured' });
    return reply(res, 401, { ok: false, error: verdict.error });
  }
  res.locals.gitlabDelivery = { id: headers.id, raw } satisfies VerifiedDelivery;
  next();
}

/**
 * Errors of the raw body parser mounted for this path in index.ts (body too large, aborted, bad
 * encoding), answered as JSON instead of Express's default HTML error page.
 */
export function gitlabWebhookBodyErrors(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);
  const e = err as { status?: unknown; statusCode?: unknown };
  const status = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : 400;
  if (status === 413) return reply(res, 413, { ok: false, error: 'payload_too_large' });
  reply(res, status >= 400 && status < 500 ? status : 400, { ok: false, error: 'invalid_body' });
}

export interface GitlabWebhookRouterOptions {
  /** Delivery dedupe; one per router (per gateway task in production). */
  dedupe?: DeliveryDedupe;
}

export function createGitlabWebhookRouter(options: GitlabWebhookRouterOptions = {}): Router {
  const deliveries = options.dedupe ?? new DeliveryDedupe();
  const router = Router();

  router.post('/webhook', requireGitlabSignature, async (_req: Request, res: Response) => {
    try {
      const { id, raw } = res.locals.gitlabDelivery as VerifiedDelivery;
      if (deliveries.seen(id)) return reply(res, 200, { ok: true, duplicate: true });

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return reply(res, 400, { ok: false, error: 'invalid_json' });
      }

      const mapping = mapGitlabEvent(payload, id);
      if (mapping.kind === 'ignore') return reply(res, 202, { ok: true, ignored: true, reason: mapping.reason });

      let eventId: string | undefined;
      const outcome = await deliveries.once(id, async () => {
        const r = await emitOasisEvent(mapping.event);
        eventId = r.event_id;
        return r.ok;
      });
      if (outcome === 'duplicate') return reply(res, 200, { ok: true, duplicate: true });
      if (outcome === 'failed') {
        console.error(`[gitlab-webhook] OASIS write failed: ${mapping.event.type} ${mapping.event.vtid} (webhook-id ${id.slice(0, 64)})`);
        return reply(res, 502, { ok: false, error: 'oasis_emit_failed' });
      }
      return reply(res, 200, { ok: true, topic: mapping.event.type, vtid: mapping.event.vtid, event_id: eventId });
    } catch {
      // Never an unanswered request and never an exception text in the reply.
      if (!res.headersSent) reply(res, 500, { ok: false, error: 'internal_error' });
    }
  });

  return router;
}

export default createGitlabWebhookRouter();
