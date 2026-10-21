/**
 * VTID-05159 (Health Hub Phase 1 / A2) — the health store's internal routes,
 * mounted at /api/v1/health/internal. There is no public ingest route here:
 * the Health Sync wire contract and POST /api/v1/health/ingest are C1's (S1).
 *
 *   GET  /store-status  member JWT (requireAuthWithTenant) -> { ok, enabled, reason }
 *                       Answers whether the store is on and, if not, why
 *                       ('staging' | 'flag_off' | 'bucket_missing'). Reads nothing else.
 *   POST /maintenance   X-Gateway-Internal (EventBridge -> vitana-cron-dispatch)
 *                       ensure partitions -> purge (+ daily partition check)
 *   POST /reprocess     GATEWAY_SERVICE_TOKEN or exafy_admin JWT; { batch_id }
 *                       re-runs a stored raw batch with the CURRENT consent
 *   POST /erase-raw     GATEWAY_SERVICE_TOKEN or exafy_admin JWT; { user_id, source_id? }
 *                       deletes the member's raw batches, then lists again ->
 *                       { deleted, residual } (A3: account deletion)
 *
 * Auth runs first and fails closed. Then, with the store off, /maintenance
 * and /reprocess answer 404 {error:'HEALTH_STORE_DISABLED'} without reading
 * the body. /erase-raw answers that 404 only when no raw bucket is
 * configured (or on staging): erasure must reach raw batches left behind by
 * a rollback that unset the flag. Errors are codes, never database messages.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuthWithTenant } from '../middleware/auth-supabase-jwt';
import { requireServiceOrAdmin } from '../middleware/require-service-or-admin';
import { INTERNAL_TOKEN_HEADER, tokensMatch } from '../middleware/scheduled-notifications-auth';
import { getSupabase } from '../lib/supabase';
import { getHealthStoreStatus, isHealthRawErasureAvailable } from '../services/health-store/flags';
import { runHealthStoreMaintenance } from '../services/health-store/maintenance';
import { reprocessHealthBatch } from '../services/health-store/ingest';
import { defaultRawBatchStore, rawBatchPrefix } from '../services/health-store/raw-batch-store';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DISABLED = { ok: false, error: 'HEALTH_STORE_DISABLED' } as const;

/** X-Gateway-Internal == GATEWAY_INTERNAL_TOKEN, timing-safe, always enforced (503 when the token is unset). */
export function requireGatewayInternal(req: Request, res: Response, next: NextFunction): void {
  const expected = (process.env.GATEWAY_INTERNAL_TOKEN ?? '').trim();
  if (!expected) {
    res.status(503).json({ ok: false, error: 'INTERNAL_TOKEN_NOT_CONFIGURED' });
    return;
  }
  const presented = String(req.get(INTERNAL_TOKEN_HEADER) ?? '').trim();
  if (!presented) {
    res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    return;
  }
  if (!tokensMatch(presented, expected)) {
    res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    return;
  }
  next();
}

router.get('/store-status', requireAuthWithTenant, (_req: Request, res: Response) => {
  const s = getHealthStoreStatus();
  res.status(200).json({ ok: true, enabled: s.enabled, reason: s.reason });
});

router.post('/maintenance', requireGatewayInternal, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: runHealthStoreMaintenance emits health.store.maintenance.completed|failed itself.
  if (!getHealthStoreStatus().enabled) {
    res.status(404).json(DISABLED);
    return;
  }
  const sb = getSupabase();
  if (!sb) {
    res.status(503).json({ ok: false, error: 'STORE_UNAVAILABLE' });
    return;
  }
  const partitionCheck = !!req.body && typeof req.body === 'object' && (req.body as { partition_check?: unknown }).partition_check === true;
  const summary = await runHealthStoreMaintenance(sb, { partitionCheck });
  res.status(summary.ok ? 200 : 500).json({ ...summary, ...(summary.ok ? {} : { error: 'MAINTENANCE_FAILED' }) });
});

const REPROCESS_STATUS: Record<string, number> = {
  STORE_DISABLED: 404,
  INVALID_INPUT: 400,
  BATCH_NOT_FOUND: 404,
  RAW_BATCH_MISSING: 409,
  SOURCE_NOT_CONNECTED: 409,
  BATCH_ID_REUSED: 409,
  QUOTA_EXCEEDED: 429,
  STORE_PENDING: 503,
  STORE_UNAVAILABLE: 503,
};

router.post('/reprocess', requireServiceOrAdmin, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: a reprocess is a replace-idempotent re-run of a stored batch; its counts live in
  // health_ingest_batches and the structured ingest log, and writeHealthSamples emits the state transitions.
  if (!getHealthStoreStatus().enabled) {
    res.status(404).json(DISABLED);
    return;
  }
  const batchId = (req.body as { batch_id?: unknown } | undefined)?.batch_id;
  if (typeof batchId !== 'string' || !UUID_RE.test(batchId)) {
    res.status(400).json({ ok: false, error: 'INVALID_REQUEST' });
    return;
  }
  const sb = getSupabase();
  if (!sb) {
    res.status(503).json({ ok: false, error: 'STORE_UNAVAILABLE' });
    return;
  }
  const result = await reprocessHealthBatch(sb, batchId);
  if (!result.ok) {
    res.status(REPROCESS_STATUS[result.code] ?? 500).json({ ok: false, error: result.code });
    return;
  }
  const counts: Record<string, number> = {};
  for (const r of result.results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  res.status(200).json({ ok: true, batch_id: result.batch_id, counts });
});

router.post('/erase-raw', requireServiceOrAdmin, async (req: Request, res: Response) => {
  // impact-allow-no-oasis: erasure is recorded by its caller (account deletion / withdrawal); the event
  // would otherwise carry a member id for every erased account.
  if (!isHealthRawErasureAvailable()) {
    res.status(404).json(DISABLED);
    return;
  }
  const body = (req.body ?? {}) as { user_id?: unknown; source_id?: unknown };
  const userId = typeof body.user_id === 'string' ? body.user_id : '';
  const sourceId = body.source_id === undefined || body.source_id === null ? null : body.source_id;
  if (!UUID_RE.test(userId) || (sourceId !== null && (typeof sourceId !== 'string' || !UUID_RE.test(sourceId)))) {
    res.status(400).json({ ok: false, error: 'INVALID_REQUEST' });
    return;
  }
  const store = defaultRawBatchStore();
  const prefix = rawBatchPrefix(userId, sourceId as string | null);
  if (!store || !prefix) {
    res.status(404).json(DISABLED);
    return;
  }
  const erased = await store.erasePrefix(prefix);
  if (!erased.ok) {
    res.status(503).json({ ok: false, error: 'STORE_UNAVAILABLE' });
    return;
  }
  res.status(200).json({ ok: true, deleted: erased.deleted, residual: erased.residual });
});

export default router;
