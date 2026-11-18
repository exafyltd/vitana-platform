/**
 * VTID-05547 (plan agentic-delivery §3.11): the GitLab delivery stage of POST /api/v1/internal/gitlab/webhook.
 *
 * routes/internal-gitlab-webhook.ts (VTID-05541, plan eng-gitlab-m2 §3.5) answers a delivery with ONE
 * OASIS event. The cut needs several per delivery (a push: the push, its review entries and its lane-file
 * changes; a pipeline on main: the pipeline, the landing and the staging deploy) and the delivery fields on
 * every event, so this stage runs in front of that router and answers the delivery itself. index.ts mounts
 * it with app.use on the same path just before the router; the router stays mounted unchanged (its mount
 * line and its tests are pinned by VTID-05541, and the route guard allows one handler per endpoint).
 *
 *   - The signature is checked by requireGitlabSignature of the M2 route, unchanged: the same 401
 *     signature_missing / signature_invalid / timestamp_out_of_tolerance and 500 not_configured, before
 *     anything is read from the body. An unsigned request is refused whether or not the key is configured.
 *   - Only POST on the exact path is taken; anything else falls through (to the router, then to Express).
 *   - Dedupe: by webhook-id (a GitLab retry keeps it) after every event of the delivery was recorded, and by
 *     each event's dedupe_key, so a delivery whose second event failed can be retried without writing the
 *     first again, and the same fact from two deliveries (or a re-run) is written once per gateway task.
 *     A duplicate across gateway tasks adds one informational row; readers keep the first row per key.
 *
 * Replies (always JSON), as the route's, plus `events` when a delivery recorded events:
 *   200 { ok, duplicate: true }                         nothing new was recorded
 *   200 { ok, topic, vtid, event_id, events: [...] }    the first event, then every event recorded
 *   202 { ok, ignored: true, reason }                   unknown event, unmapped action, status or ref, or no VTID
 *   400 invalid_json    502 oasis_emit_failed (the delivery stays open for GitLab's retry)    500 internal_error
 */
import type { Request, RequestHandler, Response } from 'express';
import { requireGitlabSignature } from '../../routes/internal-gitlab-webhook';
import { emitOasisEvent } from '../oasis-event-service';
import type { CicdOasisEvent } from '../../types/cicd';
import { DeliveryDedupe } from './dedupe';
import { mapGitlabDelivery, type BranchVtidLookup, type DeliveryMapOptions } from './delivery-mapper';

export type OasisEmit = (event: CicdOasisEvent) => Promise<{ ok: boolean; event_id?: string; error?: string }>;

export interface GitlabDeliveryStageOptions {
  /** One entry per webhook-id (a retry keeps its id). */
  deliveries?: DeliveryDedupe;
  /** One entry per event dedupe_key. */
  facts?: DeliveryDedupe;
  emit?: OasisEmit;
  map?: DeliveryMapOptions;
}

function reply(res: Response, status: number, body: Record<string, unknown>): void {
  res.status(status).json(body);
}

export function createGitlabDeliveryStage(options: GitlabDeliveryStageOptions = {}): RequestHandler {
  const deliveries = options.deliveries ?? new DeliveryDedupe();
  const facts = options.facts ?? new DeliveryDedupe();
  const emit: OasisEmit = options.emit ?? emitOasisEvent;

  async function handle(res: Response): Promise<void> {
    try {
      const { id, raw } = res.locals.gitlabDelivery as { id: string; raw: string };
      if (deliveries.seen(id)) return reply(res, 200, { ok: true, duplicate: true });

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return reply(res, 400, { ok: false, error: 'invalid_json' });
      }

      const mapping = await mapGitlabDelivery(payload, id, options.map);
      if (mapping.kind === 'ignore') return reply(res, 202, { ok: true, ignored: true, reason: mapping.reason });

      const recorded: Array<{ topic: string; vtid: string; event_id?: string }> = [];
      for (const event of mapping.events) {
        let eventId: string | undefined;
        const outcome = await facts.once(event.payload.dedupe_key, async () => {
          const r = await emit(event);
          eventId = r.event_id;
          return r.ok;
        });
        if (outcome === 'failed') {
          console.error(`[gitlab-delivery] OASIS write failed: ${event.type} ${event.vtid} (webhook-id ${id.slice(0, 64)})`);
          return reply(res, 502, { ok: false, error: 'oasis_emit_failed' });
        }
        if (outcome === 'recorded') recorded.push({ topic: event.type, vtid: event.vtid, event_id: eventId });
      }

      await deliveries.once(id, async () => true);
      if (recorded.length === 0) return reply(res, 200, { ok: true, duplicate: true });
      return reply(res, 200, { ok: true, topic: recorded[0].topic, vtid: recorded[0].vtid, event_id: recorded[0].event_id, events: recorded });
    } catch {
      // Never an unanswered request and never an exception text in the reply.
      if (!res.headersSent) reply(res, 500, { ok: false, error: 'internal_error' });
    }
  }

  return (req: Request, res: Response, next) => {
    if (req.method !== 'POST' || (req.path !== '/' && req.path !== '')) return next();
    requireGitlabSignature(req, res, () => {
      void handle(res);
    });
  };
}

const MR_TOPICS = [
  'scm.gitlab.merge_request.opened',
  'scm.gitlab.merge_request.updated',
  'scm.gitlab.merge_request.merged',
  'scm.gitlab.merge_request.closed',
].join(',');

/**
 * Looks up a branch's VTID in the OASIS rows of its merge request, for a push handled by a gateway task that
 * has not seen the merge request event. Read only; any failure answers null.
 */
export function oasisBranchVtidLookup(opts: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): BranchVtidLookup {
  return async (project, branch) => {
    const env = opts.env ?? process.env;
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE;
    if (!url || !key || !project) return null;
    const query =
      `select=vtid&topic=in.(${MR_TOPICS})` +
      `&metadata->>project_path=eq.${encodeURIComponent(project)}&metadata->>source_branch=eq.${encodeURIComponent(branch)}` +
      `&order=created_at.desc&limit=1`;
    try {
      const r = await (opts.fetch ?? fetch)(`${url}/rest/v1/oasis_events?${query}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (!r.ok) return null;
      const rows = (await r.json()) as Array<{ vtid?: unknown }>;
      const vtid = Array.isArray(rows) ? rows[0]?.vtid : undefined;
      return typeof vtid === 'string' && /^VTID-\d{5}$/.test(vtid) ? vtid : null;
    } catch {
      return null;
    }
  };
}
