/**
 * VTID-05164 (Health Hub Phase 1 / C1) — Health Sync ingest, contract v1.
 *
 * Mounted at /api/v1/health/ingest (claimed by `^health` in the developer
 * domain atlas). The one external entry point for the native app's Health Sync
 * module (Apple Health / Health Connect) and, from Phase 2, aggregator
 * adapters. Contract: services/health-sync/contract-v1.ts (S1), prose in
 * docs/programs/health-hub/HEALTH-SYNC-CONTRACT-v1.md.
 *
 *   GET  /contract      no auth, read-only: version, catalogue, limits, error codes
 *   POST /              one batch. Order: ingest gate (409, nothing read) ->
 *                       per-IP limit (before any JWT work) -> requireAuthWithTenant ->
 *                       per-member limit (user_id) -> body read + gunzip (512 KB /
 *                       4 MB) -> strict schema -> processHealthSyncBatch (source via
 *                       B's S6, consent per category, hand-off to A's S3)
 *   GET  /status        auth, read-only: source state, sync_* consent per category on
 *                       that source, ingest_enabled, A's store state
 *   POST /source-state  "OS permission revoked -> source paused" (same gate, 409 on staging)
 *
 * Dark: the write routes answer 409 INGEST_DISABLED unless
 * HEALTH_SYNC_INGEST_ENABLED is exactly 'true', VITANA_ENV is not 'staging'
 * (staging shares the production database) AND A's store is enabled
 * (HEALTH_STORE_ENABLED + HEALTH_RAW_BUCKET). No task definition sets the flag
 * in this package; turning it on is its own Gate 2.
 *
 * Identity comes only from the JWT; the batch has no user or tenant field.
 * AI-delegated OAuth tokens are refused before this router by
 * delegatedTokenGuard() (index.ts). Every error body is
 * { ok:false, error, retryable, ... } — never a database or vendor message.
 *
 * Consent enforcement point for sync_activity / sync_sleep / sync_heart /
 * sync_body (HEALTH_SYNC_CONSENT_KEYS, via processHealthSyncBatch).
 */

import { gunzipSync } from 'zlib';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthWithTenant, type AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { HEALTH_SYNC_CATEGORIES, HEALTH_SYNC_CONSENT_KEYS, type HealthSyncCategory } from '../services/consent/health-consent';
import { getHealthStoreStatus, type HealthStoreStatus } from '../services/health-store/flags';
import { healthSourceStateFromSync, setHealthSourceState } from '../services/health-sources/health-sources';
import {
  CONTRACT_VERSION,
  HEALTH_SYNC_LIMITS,
  HEALTH_SYNC_VTID,
  SourceStateV1,
  contractDocument,
  parseHealthSyncBatch,
  validationDetails,
} from '../services/health-sync/contract-v1';
import {
  batchError,
  defaultHealthSyncDeps,
  processHealthSyncBatch,
  type HealthSyncDeps,
  type HealthSyncIdentity,
} from '../services/health-sync/adapter';

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export type HealthIngestGate = { open: true } | { open: false; reason: 'staging' | 'flag_off' };

/** Exact 'true' AND not staging (F8: isFeatureLive('staging-only') would turn a write path ON for staging) AND A's store on. */
export function healthIngestGate(env: NodeJS.ProcessEnv = process.env): HealthIngestGate {
  if (env.VITANA_ENV === 'staging') return { open: false, reason: 'staging' };
  if (env.HEALTH_SYNC_INGEST_ENABLED !== 'true') return { open: false, reason: 'flag_off' };
  if (!getHealthStoreStatus(env).enabled) return { open: false, reason: 'flag_off' };
  return { open: true };
}

// ---------------------------------------------------------------------------
// Body handling
// ---------------------------------------------------------------------------

/**
 * Mounted at /api/v1/health/ingest BEFORE the global express.json() (index.ts).
 * It reads nothing: it only marks POST / as "body handled" so the global JSON
 * parser (which would inflate gzip itself, with its own 2 MB limit) skips it.
 * The router reads the raw bytes itself, after the gate, the per-IP limit and
 * auth, with the 512 KB compressed / 4 MB inflated limits.
 */
export function healthIngestBodyGuard(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.method === 'POST' && (req.path === '/' || req.path === '')) {
      (req as Request & { _body?: boolean })._body = true;
    }
    next();
  };
}

type RawBody = { ok: true; buf: Buffer } | { ok: false; code: 'BATCH_TOO_LARGE' | 'INVALID_BATCH' };

/** Reads at most `limit` bytes as sent (no decoding). Stops reading at the limit. */
export function readRawBody(req: Request, limit: number): Promise<RawBody> {
  if (Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body.length > limit ? { ok: false, code: 'BATCH_TOO_LARGE' } : { ok: true, buf: req.body });
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) return Promise.resolve({ ok: false, code: 'BATCH_TOO_LARGE' });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (out: RawBody) => {
      if (done) return;
      done = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      resolve(out);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        finish({ ok: false, code: 'BATCH_TOO_LARGE' });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish({ ok: true, buf: Buffer.concat(chunks, size) });
    const onError = () => finish({ ok: false, code: 'INVALID_BATCH' });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

type Decoded = { ok: true; json: unknown } | { ok: false; code: 'BATCH_TOO_LARGE' | 'INVALID_BATCH' | 'UNSUPPORTED_ENCODING' };

/** identity or gzip only; gunzip bounded by maxOutputLength (zip-bomb safe); then JSON.parse. */
export function decodeBody(buf: Buffer, contentEncoding: string | undefined): Decoded {
  const enc = (contentEncoding ?? 'identity').trim().toLowerCase();
  let bytes: Buffer;
  if (enc === 'identity' || enc === '') {
    bytes = buf;
  } else if (enc === 'gzip') {
    try {
      bytes = gunzipSync(buf, { maxOutputLength: HEALTH_SYNC_LIMITS.maxInflatedBytes });
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) return { ok: false, code: 'BATCH_TOO_LARGE' };
      return { ok: false, code: 'INVALID_BATCH' };
    }
  } else {
    return { ok: false, code: 'UNSUPPORTED_ENCODING' };
  }
  if (bytes.length > HEALTH_SYNC_LIMITS.maxInflatedBytes) return { ok: false, code: 'BATCH_TOO_LARGE' };
  try {
    return { ok: true, json: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return { ok: false, code: 'INVALID_BATCH' };
  }
}

function isJsonContentType(req: Request): boolean {
  const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return ct === 'application/json';
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface HealthIngestRouterOptions {
  env?: NodeJS.ProcessEnv;
  supabase?: () => SupabaseClient | null;
  deps?: (sb: SupabaseClient) => HealthSyncDeps;
  storeStatus?: () => HealthStoreStatus;
  setSourceState?: typeof setHealthSourceState;
  ipLimitPerMinute?: number;
  memberBatchesPerHour?: number;
  memberConcurrency?: number;
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function send(res: Response, out: { status: number; body: unknown }) {
  return res.status(out.status).json(out.body);
}

function identityOf(req: Request): HealthSyncIdentity | null {
  const id = (req as AuthenticatedRequest).identity;
  return id?.user_id && id?.tenant_id ? { user_id: id.user_id, tenant_id: id.tenant_id } : null;
}

export function createHealthIngestRouter(opts: HealthIngestRouterOptions = {}): Router {
  const env = opts.env ?? process.env;
  const getSb = opts.supabase ?? (() => getSupabase());
  const depsFor = opts.deps ?? defaultHealthSyncDeps;
  const storeStatus = opts.storeStatus ?? (() => getHealthStoreStatus(env));
  const setState = opts.setSourceState ?? setHealthSourceState;
  const router = Router();

  const rateLimited = (req: Request, res: Response) => {
    const ra = Number(res.getHeader('Retry-After'));
    const retryAfter = Number.isFinite(ra) && ra > 0 ? ra : 60;
    res.setHeader('Retry-After', String(retryAfter));
    return send(res, batchError('RATE_LIMITED', { retry_after_s: retryAfter }));
  };

  // Per-IP backstop BEFORE auth: sheds unauthenticated load before any JWT verification or DB lookup.
  const ipLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: opts.ipLimitPerMinute ?? positiveInt(env.HEALTH_SYNC_IP_LIMIT_PER_MINUTE, 600),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: rateLimited,
  });

  // Per-member limit AFTER auth, keyed by the JWT user_id (approximate: in memory per task, F9).
  const memberLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: opts.memberBatchesPerHour ?? positiveInt(env.HEALTH_SYNC_MEMBER_BATCHES_PER_HOUR, 120),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: Request) => `member:${(req as AuthenticatedRequest).identity?.user_id ?? 'unknown'}`,
    handler: rateLimited,
  });

  const maxConcurrent = opts.memberConcurrency ?? positiveInt(env.HEALTH_SYNC_MEMBER_CONCURRENCY, 10);
  const inFlight = new Map<string, number>();
  const memberConcurrency: RequestHandler = (req, res, next) => {
    const user = (req as AuthenticatedRequest).identity?.user_id ?? 'unknown';
    const current = inFlight.get(user) ?? 0;
    if (current >= maxConcurrent) {
      res.setHeader('Retry-After', '5');
      return send(res, batchError('RATE_LIMITED', { retry_after_s: 5 }));
    }
    inFlight.set(user, current + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (inFlight.get(user) ?? 1) - 1;
      if (n <= 0) inFlight.delete(user);
      else inFlight.set(user, n);
    };
    res.on('finish', release);
    res.on('close', release);
    next();
  };

  const gate: RequestHandler = (_req, res, next) => {
    const g = healthIngestGate(env);
    if (!g.open) return send(res, batchError('INGEST_DISABLED', { reason: g.reason }));
    next();
  };

  // ---- GET /contract ---------------------------------------------------------
  // public-route
  router.get('/contract', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(contractDocument());
  });

  // ---- POST / ------------------------------------------------------------------
  router.post('/', gate, ipLimiter, requireAuthWithTenant, memberLimiter, memberConcurrency, async (req: Request, res: Response) => {
    // impact-allow-no-oasis — processHealthSyncBatch emits health.sync.batch.processed / .rejected.
    const identity = identityOf(req);
    if (!identity) return send(res, batchError('UNAUTHENTICATED'));
    if (!isJsonContentType(req)) return send(res, batchError('UNSUPPORTED_ENCODING', { details: [{ path: 'content-type', code: 'unsupported' }] }));
    const enc = String(req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (enc !== 'identity' && enc !== 'gzip' && enc !== '') {
      return send(res, batchError('UNSUPPORTED_ENCODING', { details: [{ path: 'content-encoding', code: 'unsupported' }] }));
    }

    const raw = await readRawBody(req, HEALTH_SYNC_LIMITS.maxCompressedBytes);
    if (!raw.ok) return send(res, batchError(raw.code));
    const decoded = decodeBody(raw.buf, enc);
    if (!decoded.ok) {
      return send(res, batchError(decoded.code, decoded.code === 'INVALID_BATCH' ? { details: [{ path: '', code: 'invalid_json' }] } : {}));
    }
    const parsed = parseHealthSyncBatch(decoded.json);
    if (!parsed.ok) {
      return send(
        res,
        parsed.code === 'UNSUPPORTED_CONTRACT_VERSION'
          ? batchError('UNSUPPORTED_CONTRACT_VERSION', { details: { supported_majors: [1], contract_version: CONTRACT_VERSION } })
          : batchError('INVALID_BATCH', parsed.details ? { details: parsed.details } : {}),
      );
    }

    const sb = getSb();
    if (!sb) return send(res, batchError('STORE_UNAVAILABLE'));
    const out = await processHealthSyncBatch(identity, parsed.batch, { channel: 'native' }, depsFor(sb));
    if (out.status === 429 && !out.body.ok && out.body.retry_after_s) res.setHeader('Retry-After', String(out.body.retry_after_s));
    return send(res, out);
  });

  // ---- GET /status -------------------------------------------------------------
  router.get('/status', requireAuthWithTenant, async (req: Request, res: Response) => {
    const identity = identityOf(req);
    if (!identity) return send(res, batchError('UNAUTHENTICATED'));
    const sourceKind = typeof req.query.source_kind === 'string' ? req.query.source_kind : '';
    const installId = typeof req.query.install_id === 'string' ? req.query.install_id : '';
    const q = SourceStateV1.pick({ source_kind: true, install_id: true }).safeParse({ source_kind: sourceKind, install_id: installId });
    if (!q.success) return res.status(400).json({ ok: false, error: 'INVALID_REQUEST', retryable: false, details: validationDetails(q.error) });

    const gateState = healthIngestGate(env);
    const store = storeStatus();
    const base = {
      ok: true as const,
      contract_version: CONTRACT_VERSION,
      ingest_enabled: gateState.open,
      ingest_disabled_reason: gateState.open ? null : gateState.reason,
      store: { enabled: store.enabled, reason: store.reason },
    };
    const sb = getSb();
    if (!sb) return res.json({ ...base, store_pending: false, source_state: 'unknown', consent: null });
    const deps = depsFor(sb);

    const src = await deps.resolveSource(identity, { kind: 'phone_store', connector_id: q.data.source_kind, provider_user_id: q.data.install_id });
    const storePending = !src.ok && src.code === 'STORE_PENDING';
    const sourceState = src.ok ? src.status : src.code === 'SOURCE_NOT_CONNECTED' ? 'not_connected' : storePending ? 'store_pending' : 'unknown';

    const consent: Record<HealthSyncCategory, 'granted' | 'not_granted'> = { activity: 'not_granted', sleep: 'not_granted', heart: 'not_granted', body: 'not_granted' };
    await Promise.all(
      HEALTH_SYNC_CATEGORIES.map(async (category) => {
        let id: string | null = null;
        try {
          id = await deps.findConsentId(identity, HEALTH_SYNC_CONSENT_KEYS[category], q.data.source_kind);
        } catch {
          id = null;
        }
        consent[category] = typeof id === 'string' && id.length > 0 ? 'granted' : 'not_granted';
      }),
    );
    return res.json({ ...base, store_pending: storePending, source_state: sourceState, consent });
  });

  // ---- POST /source-state ----------------------------------------------------------
  router.post('/source-state', gate, ipLimiter, requireAuthWithTenant, memberLimiter, async (req: Request, res: Response) => {
    // impact-allow-no-oasis — emits health.sync.source.paused / .resumed through deps.emit on a real change.
    const identity = identityOf(req);
    if (!identity) return send(res, batchError('UNAUTHENTICATED'));
    const parsed = SourceStateV1.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'INVALID_REQUEST', retryable: false, details: validationDetails(parsed.error) });
    const body = parsed.data;

    const sb = getSb();
    if (!sb) return send(res, batchError('STORE_UNAVAILABLE'));
    const deps = depsFor(sb);
    const src = await deps.resolveSource(identity, { kind: 'phone_store', connector_id: body.source_kind, provider_user_id: body.install_id });
    if (!src.ok) {
      if (src.code === 'SOURCE_NOT_CONNECTED') return res.json({ ok: true, changed: false, source_state: 'not_connected' });
      return send(res, batchError(src.code === 'STORE_PENDING' ? 'STORE_PENDING' : 'STORE_UNAVAILABLE'));
    }

    const target = healthSourceStateFromSync(body.state);
    if (!target) return res.status(400).json({ ok: false, error: 'INVALID_REQUEST', retryable: false });
    // 'active' resumes only a source paused for OS permission; a source the member
    // disconnected stays disconnected until they reconnect it themselves.
    const unchanged = src.status === target.status || (body.state === 'active' && src.status !== 'paused');
    if (unchanged) return res.json({ ok: true, changed: false, source_state: src.status });

    const set = await setState(sb, identity, { source_id: src.source_id, status: target.status, reason_code: target.reason_code ?? null });
    if (!set.ok) {
      return send(res, batchError(set.code === 'STORE_PENDING' ? 'STORE_PENDING' : 'STORE_UNAVAILABLE'));
    }
    const paused = target.status === 'paused';
    try {
      await deps.emit({
        vtid: HEALTH_SYNC_VTID,
        type: paused ? 'health.sync.source.paused' : 'health.sync.source.resumed',
        source: 'health-sync',
        status: 'info',
        message: paused ? 'Health Sync source paused: OS permission revoked.' : 'Health Sync source resumed.',
        payload: { source_kind: body.source_kind, reason_code: target.reason_code ?? null, permitted_categories: body.permitted_categories },
        actor_id: identity.user_id,
        actor_role: 'user',
        surface: 'api',
      });
    } catch {
      deps.log({ event: 'health_sync_oasis_emit_failed', vtid: HEALTH_SYNC_VTID, type: paused ? 'health.sync.source.paused' : 'health.sync.source.resumed' });
    }
    return res.json({ ok: true, changed: true, source_state: target.status });
  });

  return router;
}

export default createHealthIngestRouter();
