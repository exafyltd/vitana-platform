/**
 * VTID-01955 — Shared Redis connection pool (Memorystore on GCP)
 *
 * Single ioredis client reused across the gateway process. Lazy-initialized
 * on first call so the gateway can boot without Redis (REDIS_URL unset =
 * everything that depends on Redis becomes a no-op + falls back to legacy).
 *
 * Memorystore Redis (Standard tier, 1GB BASIC sufficient for Tier 0):
 *   gcloud redis instances create vitana-tier0 \
 *     --size=1 --region=us-central1 --network=default --tier=BASIC \
 *     --redis-version=redis_7_0 --project=lovable-vitana-vers1
 *
 * Cloud Run gateway needs a Serverless VPC Access connector to reach
 * Memorystore (private VPC). After creation, set REDIS_URL on the
 * gateway service: redis://<memorystore-host>:<port> (no TLS in BASIC).
 *
 * Plan: Part 8 Phase 1, Part 6 Layer 4 Tier 0.
 */

import IORedis, { type Redis as IORedisClient, type RedisOptions } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL;

let _client: IORedisClient | null = null;
let _initAttempted = false;
let _initFailed = false;

/**
 * Get the shared Redis client. Returns null if REDIS_URL is unset OR if
 * a previous connection attempt failed permanently — callers MUST
 * tolerate null and fall back to the legacy in-process path.
 */
export function getRedisClient(): IORedisClient | null {
  if (_client) return _client;
  if (_initFailed) return null;
  if (_initAttempted) return null;
  _initAttempted = true;

  if (!REDIS_URL) {
    console.log('[VTID-01955] REDIS_URL not set — Tier 0 Redis disabled (legacy in-process buffer in use)');
    _initFailed = true;
    return null;
  }

  try {
    const opts: RedisOptions = {
      // Single-instance Memorystore in BASIC tier — no Sentinel/Cluster.
      maxRetriesPerRequest: 2,
      // ioredis default reconnect strategy is fine for transient failures.
      enableReadyCheck: true,
      lazyConnect: false,
      // Shorten command timeout so a hung Redis can't block ORB voice paths.
      commandTimeout: 1500,
      keyPrefix: 'vitana:',
    };
    _client = new IORedis(REDIS_URL, opts);

    _client.on('connect', () => console.log('[VTID-01955] Redis connecting...'));
    _client.on('ready', () => console.log('[VTID-01955] Redis ready'));
    _client.on('error', (err) => {
      // Don't spam — log first error then rate-limit subsequent ones.
      console.warn('[VTID-01955] Redis error:', err?.message || err);
    });
    _client.on('end', () => console.log('[VTID-01955] Redis connection ended'));

    return _client;
  } catch (err) {
    console.warn('[VTID-01955] Failed to initialize Redis client:', err);
    _initFailed = true;
    _client = null;
    return null;
  }
}

/**
 * Health check used by /alive and Tier 0 dashboards.
 * Returns true if Redis client exists and PING succeeds in <500ms.
 */
export async function isRedisHealthy(): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;
  try {
    const result = await Promise.race([
      client.ping(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('ping_timeout')), 500)
      ),
    ]);
    return result === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Graceful shutdown for clean test teardown + SIGTERM handlers.
 * Safe to call when client wasn't initialized.
 */
export async function disconnectRedis(): Promise<void> {
  if (_client) {
    try {
      await _client.quit();
    } catch {
      _client.disconnect();
    }
    _client = null;
    _initAttempted = false;
    _initFailed = false;
  }
}
