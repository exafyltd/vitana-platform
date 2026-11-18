/**
 * VTID-05547 (plan agentic-delivery §3.12): the Delivery screen's read routes.
 *
 *   GET /api/v1/delivery/summary   merge queue per project, pipelines, releases (staging commit, latest STAGING-VERIFY)
 *   GET /api/v1/delivery/metrics   lead and wait times, landings, verify pass rate; a figure with no source is null
 *
 * Caller: the Command Hub Delivery module (Bearer exafy_admin JWT) and the gateway's own callers (service
 * token): requireServiceOrAdmin. No token answers 401 JSON.
 *
 * Read-path lock (VTID-01170): status from vtid_ledger, the timeline from oasis_events, nothing else is
 * read. Both are read through PostgREST with the service role, as board-adapter.ts reads them. A GitLab
 * fact is one OASIS row per dedupe_key (readers keep the first); shadow rows are left out unless
 * ?include_shadow=1. The two hosts block is configuration (DELIVERY_HOST_<REPO>), not data: it tells the
 * screen whether a repository has been cut over.
 *
 * Query: hours (1 to 720, default 168), include_shadow (1 or true).
 * Replies are JSON: 200 { ok, ... }, 502 { ok: false, error: 'delivery_source_unavailable' } when the ledger or
 * OASIS cannot be read (no error text).
 */
import { Router, Request, Response } from 'express';
import { requireServiceOrAdmin } from '../middleware/require-service-or-admin';
import { DELIVERY_REPOS } from '../services/gitlab-events/delivery-mapper';
import { deliveryHostFor } from '../services/delivery-host';
import {
  DELIVERY_READ_TOPICS,
  buildMergeQueue,
  buildMetrics,
  buildPipelines,
  buildReleases,
  indexLedger,
  prepareRows,
  vtidsOf,
  type EventRow,
  type LedgerRow,
  type RepoPipelines,
  type RepoQueue,
} from '../services/gitlab-events/delivery-summary';

export const EVENT_READ_LIMIT = 3000;
export const DEFAULT_WINDOW_HOURS = 168;
export const MAX_WINDOW_HOURS = 720;

export interface DeliveryReaders {
  readEvents(q: { topics: readonly string[]; sinceIso: string; limit: number }): Promise<EventRow[]>;
  readLedger(vtids: string[]): Promise<LedgerRow[]>;
}

export interface DeliveryRouterDeps {
  readers?: DeliveryReaders;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

async function rest<T>(path: string, env: NodeJS.ProcessEnv): Promise<T> {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('not_configured');
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`upstream_${r.status}`);
  return (await r.json()) as T;
}

export function postgrestReaders(env: NodeJS.ProcessEnv = process.env): DeliveryReaders {
  return {
    readEvents: ({ topics, sinceIso, limit }) =>
      rest<EventRow[]>(
        `oasis_events?select=id,created_at,vtid,topic,status,message,service,metadata&topic=in.(${topics.join(',')})` +
          `&created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.desc&limit=${limit}`,
        env,
      ),
    readLedger: (vtids) =>
      vtids.length === 0
        ? Promise.resolve([])
        : rest<LedgerRow[]>(`vtid_ledger?select=vtid,title,status,is_terminal,terminal_outcome&vtid=in.(${vtids.join(',')})&limit=200`, env),
  };
}

function windowHours(req: Request): number {
  const h = parseInt(String(req.query.hours ?? ''), 10);
  return Number.isFinite(h) ? Math.min(MAX_WINDOW_HOURS, Math.max(1, h)) : DEFAULT_WINDOW_HOURS;
}

const flag = (v: unknown): boolean => v === '1' || v === 'true';

export function createDeliveryRouter(deps: DeliveryRouterDeps = {}): Router {
  const router = Router();
  const env = deps.env ?? process.env;
  const readers = deps.readers ?? postgrestReaders(env);
  const nowMs = deps.now ?? Date.now;

  async function loadRows(hours: number, now: number): Promise<{ rows: EventRow[]; truncated: boolean }> {
    const sinceIso = new Date(now - hours * 3600 * 1000).toISOString();
    const rows = await readers.readEvents({ topics: DELIVERY_READ_TOPICS, sinceIso, limit: EVENT_READ_LIMIT });
    return { rows: Array.isArray(rows) ? rows : [], truncated: Array.isArray(rows) && rows.length >= EVENT_READ_LIMIT };
  }

  function unavailable(res: Response): void {
    res.status(502).json({ ok: false, error: 'delivery_source_unavailable' });
  }

  router.get('/summary', requireServiceOrAdmin, async (req: Request, res: Response) => {
    try {
      const hours = windowHours(req);
      const includeShadow = flag(req.query.include_shadow);
      const now = nowMs();
      const { rows: raw, truncated } = await loadRows(hours, now);
      const rows = prepareRows(raw, includeShadow);

      const merge_queue: Record<string, RepoQueue> = buildMergeQueue(rows, now);
      const pipelines: Record<string, RepoPipelines> = buildPipelines(rows);
      for (const repo of DELIVERY_REPOS) {
        merge_queue[repo] ??= { paused: false, items: [] };
        pipelines[repo] ??= { main: { state: 'unknown', pipeline_id: null, sha: null, since: null, url: null }, items: [] };
      }
      const ledger = indexLedger(await readers.readLedger(vtidsOf({ queue: merge_queue, pipelines })));
      const refused = rows.filter((r) => r.topic === 'delivery.merge.refused');

      res.json({
        ok: true,
        generated_at: new Date(now).toISOString(),
        window_hours: hours,
        include_shadow: includeShadow,
        truncated,
        hosts: Object.fromEntries(DELIVERY_REPOS.map((repo) => [repo, deliveryHostFor(repo, env)])),
        merge_queue,
        pipelines,
        releases: buildReleases(rows),
        refused_merges: { count: refused.length, last_at: refused.length > 0 ? refused[refused.length - 1].created_at : null },
        ledger,
        sources: ['vtid_ledger', 'oasis_events'],
      });
    } catch (err) {
      console.error(`[delivery] summary failed: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`);
      unavailable(res);
    }
  });

  router.get('/metrics', requireServiceOrAdmin, async (req: Request, res: Response) => {
    try {
      const hours = windowHours(req);
      const now = nowMs();
      const { rows: raw, truncated } = await loadRows(hours, now);
      res.json({
        ok: true,
        generated_at: new Date(now).toISOString(),
        truncated,
        // Live rows only: a shadow run is never part of a figure.
        metrics: buildMetrics(prepareRows(raw, false), now, hours),
        sources: ['oasis_events'],
      });
    } catch (err) {
      console.error(`[delivery] metrics failed: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`);
      unavailable(res);
    }
  });

  return router;
}

export default createDeliveryRouter();
