/**
 * VTID-05541 (plan eng-gitlab-m2 §3.5, lane scm-webhook): signed GitLab webhook events → OASIS events.
 *
 * POST /api/v1/internal/gitlab/webhook
 *
 * No user auth: the GitLab project webhook signs every delivery (Standard Webhooks: headers `webhook-id`,
 * `webhook-timestamp`, `webhook-signature`; HMAC-SHA256 over `${id}.${timestamp}.${raw}` with the base64 key of
 * `GITLAB_WEBHOOK_SIGNING_TOKEN`, `whsec_<base64>`). The signature is the gate, checked by the shared `verifySvix`
 * (connectors/runtime/webhook-signature.ts), which never reads a header name: this route maps the `webhook-*` headers
 * itself, as the Vital connector maps `svix-*`. The shared verifier is not edited.
 *
 * Replies are always JSON:
 *   401 signature headers missing (also a request that carries only `svix-*` headers), bad, or stale
 *   500 not_configured: a signed delivery while no signing key is set (fails closed)
 *   413 body larger than 1 MB; 400 malformed JSON (after the signature)
 *   200 a mapped event was recorded once; 200 duplicate: the same `webhook-id` was already handled by this task
 *   202 verified but not mapped (other events, other actions, no VTID): acknowledged, nothing recorded
 *   503 OASIS could not record the event: GitLab may resend it, and the resend is processed
 *
 * The raw parser for this path is mounted by mountGitlabWebhookParsers() BEFORE express.json() (index.ts), because the
 * signature covers the exact bytes sent.
 */
import express, { Application, NextFunction, Request, Response, Router } from 'express';
import { headerValue, verifySvix } from '../connectors/runtime/webhook-signature';
import { emitOasisEvent } from '../services/oasis-event-service';
import { mapGitlabEvent } from '../services/gitlab-events/map';
import { createDeliveryIdStore, DeliveryIdStore } from '../services/gitlab-events/delivery-ids';
import type { CicdOasisEvent } from '../types/cicd';

export const GITLAB_WEBHOOK_PATH = '/api/v1/internal/gitlab/webhook';
export const GITLAB_WEBHOOK_BODY_LIMIT = '1mb';

/**
 * Raw body for the webhook path, with JSON errors for a body that is too large or unreadable (Express's default
 * error page is HTML). Must run before app.use(express.json()).
 */
export function mountGitlabWebhookParsers(app: Application): void {
  app.use(GITLAB_WEBHOOK_PATH, express.raw({ type: '*/*', limit: GITLAB_WEBHOOK_BODY_LIMIT }));
  app.use(GITLAB_WEBHOOK_PATH, (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    const e = err as { type?: string; status?: number };
    if (e.type === 'entity.too.large' || e.status === 413) {
      return res.status(413).json({ ok: false, error: 'payload_too_large', limit: GITLAB_WEBHOOK_BODY_LIMIT });
    }
    return res.status(400).json({ ok: false, error: 'unreadable_body' });
  });
}

export interface GitlabWebhookDeps {
  emit: (event: CicdOasisEvent) => Promise<{ ok: boolean; event_id?: string; error?: string }>;
  deliveries: DeliveryIdStore;
  signingKey: () => string | undefined;
  now: () => number;
}

/** The exact bytes of the body, or null when they are not available (the raw parser did not run). */
function rawBodyOf(body: unknown): string | null {
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  // body-parser leaves `{}` when a request has no body at all; anything else was parsed by another parser and cannot
  // be verified against a signature over the original bytes.
  if (body === undefined || (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0)) return '';
  return null;
}

export function createGitlabWebhookRouter(deps: GitlabWebhookDeps): Router {
  const router = Router();

  router.post('/webhook', async (req: Request, res: Response) => {
    const id = headerValue(req.headers['webhook-id']);
    const timestamp = headerValue(req.headers['webhook-timestamp']);
    const signature = headerValue(req.headers['webhook-signature']);
    // Unsigned first: an unsigned caller learns nothing about configuration (and the staging probe gets 401 either way).
    if (!id || !timestamp || !signature) return res.status(401).json({ ok: false, error: 'signature_missing' });

    const key = deps.signingKey();
    if (!key) return res.status(500).json({ ok: false, error: 'not_configured' });

    const raw = rawBodyOf(req.body);
    if (raw === null) return res.status(500).json({ ok: false, error: 'raw_body_unavailable' });

    const verdict = verifySvix(raw, { id, timestamp, signature }, key, deps.now());
    if (!verdict.ok) {
      if (verdict.error === 'secret_not_configured') return res.status(500).json({ ok: false, error: 'not_configured' });
      return res.status(401).json({ ok: false, error: verdict.error });
    }

    if (deps.deliveries.has(id)) return res.status(200).json({ ok: true, duplicate: true });

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }

    const mapping = mapGitlabEvent(body);
    if (mapping.kind === 'ignore') {
      deps.deliveries.remember(id);
      return res.status(202).json({ ok: true, ignored: true, reason: mapping.reason });
    }

    let result: { ok: boolean; event_id?: string; error?: string };
    try {
      result = await deps.emit({
        vtid: mapping.vtid,
        type: mapping.topic,
        source: 'gitlab-webhook',
        status: mapping.status,
        message: mapping.message,
        actor_role: 'system',
        surface: 'cicd',
        payload: { ...mapping.payload, webhook_id: id, gitlab_event: headerValue(req.headers['x-gitlab-event']) ?? null },
      });
    } catch {
      result = { ok: false, error: 'emit_threw' };
    }
    if (!result.ok) return res.status(503).json({ ok: false, error: 'oasis_unavailable' });

    deps.deliveries.remember(id);
    return res.status(200).json({ ok: true, topic: mapping.topic, vtid: mapping.vtid, event_id: result.event_id ?? null });
  });

  return router;
}

const router = createGitlabWebhookRouter({
  emit: emitOasisEvent,
  deliveries: createDeliveryIdStore(),
  signingKey: () => process.env.GITLAB_WEBHOOK_SIGNING_TOKEN || undefined,
  now: () => Date.now(),
});

export default router;
