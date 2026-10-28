/**
 * VTID-01955 — Redis turn buffer unit tests
 *
 * These tests run WITHOUT a real Redis (REDIS_URL unset in CI). The buffer
 * is designed to gracefully no-op when Redis is unavailable so the gateway
 * boots + serves traffic without infrastructure dependency. The "what did
 * I just say?" multi-instance verification happens in the integration smoke
 * test after Memorystore is provisioned and tier0_redis_enabled is flipped.
 */

import {
  addTurnRedis,
  getSessionContextRedis,
  formatRedisBufferForLLM,
  destroySessionBufferRedis,
  getRedisBufferStats,
  REDIS_BUFFER_CONFIG_FOR_TEST,
} from '../src/services/redis-turn-buffer';
import { getRedisClient, isRedisHealthy, disconnectRedis } from '../src/services/redis-client';

describe('redis-turn-buffer (no Redis available — graceful no-op)', () => {
  beforeAll(async () => {
    // Belt-and-suspenders: ensure no leftover client from another suite.
    delete process.env.REDIS_URL;
    await disconnectRedis();
  });

  afterAll(async () => {
    await disconnectRedis();
  });

  describe('redis-client', () => {
    it('returns null when REDIS_URL is unset', () => {
      const client = getRedisClient();
      expect(client).toBeNull();
    });

    it('isRedisHealthy returns false when client is unavailable', async () => {
      const healthy = await isRedisHealthy();
      expect(healthy).toBe(false);
    });
  });

  describe('addTurnRedis', () => {
    it('returns false (gracefully no-ops) when Redis is unavailable', async () => {
      const ok = await addTurnRedis(
        'test-session-1',
        'tenant-1',
        'user-1',
        'user',
        'hello vitana',
      );
      expect(ok).toBe(false);
    });

    it('does not throw on null Redis even with long content', async () => {
      const ok = await addTurnRedis(
        'test-session-2',
        'tenant-1',
        'user-1',
        'user',
        'x'.repeat(5000),
      );
      expect(ok).toBe(false);
    });
  });

  describe('getSessionContextRedis', () => {
    it('returns null when Redis is unavailable', async () => {
      const ctx = await getSessionContextRedis('test-session-3');
      expect(ctx).toBeNull();
    });
  });

  describe('formatRedisBufferForLLM', () => {
    it('returns empty string when Redis is unavailable', async () => {
      const formatted = await formatRedisBufferForLLM('test-session-4');
      expect(formatted).toBe('');
    });
  });

  describe('destroySessionBufferRedis', () => {
    it('does not throw when Redis is unavailable', async () => {
      await expect(destroySessionBufferRedis('test-session-5')).resolves.toBeUndefined();
    });
  });

  describe('getRedisBufferStats', () => {
    it('returns null when Redis is unavailable', async () => {
      const stats = await getRedisBufferStats('test-session-6');
      expect(stats).toBeNull();
    });
  });

  describe('configuration constants', () => {
    it('uses MAX_TURNS=10 (matches in-process session-memory-buffer for behavioral parity)', () => {
      expect(REDIS_BUFFER_CONFIG_FOR_TEST.MAX_TURNS).toBe(10);
    });

    it('uses 30-minute TTL (matches in-process buffer)', () => {
      expect(REDIS_BUFFER_CONFIG_FOR_TEST.SESSION_TTL_SEC).toBe(30 * 60);
    });

    it('truncates turns > 1000 chars (matches in-process buffer)', () => {
      expect(REDIS_BUFFER_CONFIG_FOR_TEST.MAX_TURN_CHARS).toBe(1000);
    });
  });
});

/*
 * Live Redis integration smoke (NOT auto-run in CI).
 *
 * To exercise against a real Memorystore instance after provisioning:
 *
 *   REDIS_URL=redis://<host>:<port> npx jest redis-turn-buffer-live
 *
 * (Live tests live in a separate file gated on REDIS_URL — left as a TODO
 * for the post-provisioning verification. The unit tests above prove the
 * graceful-degradation contract that ships in this PR.)
 */
