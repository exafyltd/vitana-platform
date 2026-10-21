/**
 * VTID-01955 — Tier 0 Redis turn buffer
 *
 * The shared, multi-instance-safe replacement for session-memory-buffer.ts's
 * in-process Map. Fixes "what did I just say?" failing across Cloud Run
 * cold starts and worker scale-out.
 *
 * Design (matches plan Part 6 Layer 4 Tier 0):
 * - One Redis LIST per session_id, capped to MAX_TURNS via LTRIM
 * - 30 minute TTL refreshed on every write
 * - Tenant + user IDs stored alongside each turn (audit + RLS-equivalent)
 * - O(1) writes (LPUSH+LTRIM), O(N) reads up to MAX_TURNS (LRANGE)
 *
 * Failure modes:
 * - Redis down → all functions return null/empty + log; callers fall back
 *   to the legacy in-process session-memory-buffer (dual-write makes this
 *   transparent — both buffers receive every write).
 * - REDIS_URL unset → no-op (lazy client returns null).
 *
 * The matching read flag is `tier0_redis_enabled` (system_controls).
 * Writes are unconditional (dual-write); only reads gate on the flag so
 * we can roll forward/back without losing turns.
 */

import { getRedisClient } from './redis-client';

// =============================================================================
// Configuration — kept identical to session-memory-buffer.ts so the two
// buffers behave the same when both are in play during the canary phase.
// =============================================================================

const REDIS_BUFFER_CONFIG = {
  /** Maximum turns to keep per session (matches in-process buffer). */
  MAX_TURNS: 10,
  /** Session TTL in seconds (30 minutes; matches in-process buffer). */
  SESSION_TTL_SEC: 30 * 60,
  /** Max characters per turn (truncate beyond). */
  MAX_TURN_CHARS: 1000,
} as const;

const KEY_PREFIX = 'turn-buffer:';

function turnsKey(session_id: string): string {
  return `${KEY_PREFIX}${session_id}:turns`;
}

function metaKey(session_id: string): string {
  return `${KEY_PREFIX}${session_id}:meta`;
}

// =============================================================================
// Types — exported, kept structurally compatible with session-memory-buffer
// =============================================================================

export interface RedisSessionTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  /** ISO timestamp when this turn was written, for client-side dedup. */
  written_at?: string;
}

export interface RedisSessionContext {
  recent_turns: RedisSessionTurn[];
  turn_count: number;
  is_continuation: boolean;
}

// =============================================================================
// Public API — mirrors session-memory-buffer.ts so the swap is invisible
// =============================================================================

/**
 * Append a turn to the Redis buffer. Trims to MAX_TURNS and refreshes TTL.
 * Returns true on success, false on Redis-not-available (legacy in-process
 * buffer remains the source of truth in that case).
 *
 * Safe to call without awaiting — failures don't propagate.
 */
export async function addTurnRedis(
  session_id: string,
  tenant_id: string,
  user_id: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  const truncatedContent =
    content.length > REDIS_BUFFER_CONFIG.MAX_TURN_CHARS
      ? content.substring(0, REDIS_BUFFER_CONFIG.MAX_TURN_CHARS) + '...'
      : content;

  const turn: RedisSessionTurn = {
    role,
    content: truncatedContent,
    timestamp: new Date().toISOString(),
    written_at: new Date().toISOString(),
  };

  try {
    const tk = turnsKey(session_id);
    const mk = metaKey(session_id);
    // Pipeline: LPUSH new turn, LTRIM to MAX_TURNS, set TTLs, set meta.
    // (LPUSH at HEAD = newest first, easier reverse-iteration on read.)
    const pipe = client.pipeline();
    pipe.lpush(tk, JSON.stringify(turn));
    pipe.ltrim(tk, 0, REDIS_BUFFER_CONFIG.MAX_TURNS - 1);
    pipe.expire(tk, REDIS_BUFFER_CONFIG.SESSION_TTL_SEC);
    pipe.hset(mk, { tenant_id, user_id, last_activity: new Date().toISOString() });
    pipe.expire(mk, REDIS_BUFFER_CONFIG.SESSION_TTL_SEC);
    await pipe.exec();
    return true;
  } catch (err) {
    console.warn('[VTID-01955] Redis addTurn failed (non-fatal):', (err as Error)?.message || err);
    return false;
  }
}

/**
 * Read the most-recent turns for a session, oldest → newest order.
 * Returns null if Redis is unavailable OR session has no turns.
 *
 * The reader (context-pack-builder) gates on `tier0_redis_enabled` flag
 * before calling this — so a null return during canary means the flag is
 * off and the legacy in-process buffer is being used.
 */
export async function getSessionContextRedis(
  session_id: string,
): Promise<RedisSessionContext | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    const tk = turnsKey(session_id);
    // Refresh TTL on read so active sessions don't expire mid-conversation.
    const pipe = client.pipeline();
    pipe.lrange(tk, 0, REDIS_BUFFER_CONFIG.MAX_TURNS - 1);
    pipe.expire(tk, REDIS_BUFFER_CONFIG.SESSION_TTL_SEC);
    pipe.expire(metaKey(session_id), REDIS_BUFFER_CONFIG.SESSION_TTL_SEC);
    const results = await pipe.exec();

    const lrangeResult = results?.[0];
    if (!lrangeResult || lrangeResult[0]) {
      // pipe.exec returns [[err, value], ...]; non-null first element = error
      return null;
    }
    const raw = (lrangeResult[1] as string[]) || [];
    if (raw.length === 0) return null;

    // LPUSH stores newest-first; reverse for oldest-first chronological order.
    const turns: RedisSessionTurn[] = [];
    for (let i = raw.length - 1; i >= 0; i--) {
      try {
        turns.push(JSON.parse(raw[i]) as RedisSessionTurn);
      } catch {
        /* skip malformed turn */
      }
    }

    return {
      recent_turns: turns,
      turn_count: turns.length,
      is_continuation: turns.length > 0,
    };
  } catch (err) {
    console.warn('[VTID-01955] Redis getSessionContext failed (non-fatal):', (err as Error)?.message || err);
    return null;
  }
}

/**
 * Format the Redis buffer as a system-instruction-friendly block, mirroring
 * session-memory-buffer.formatSessionBufferForLLM(). Returns empty string
 * if no turns or Redis unavailable.
 */
export async function formatRedisBufferForLLM(session_id: string): Promise<string> {
  const ctx = await getSessionContextRedis(session_id);
  if (!ctx || ctx.turn_count === 0) return '';

  const lines: string[] = [];
  lines.push('<recent_conversation source="tier0-redis">');
  for (const t of ctx.recent_turns) {
    const speaker = t.role === 'user' ? 'User' : t.role === 'assistant' ? 'Vitana' : 'System';
    lines.push(`  ${speaker}: ${t.content}`);
  }
  lines.push('</recent_conversation>');
  return lines.join('\n');
}

/**
 * Explicit teardown when a session ends. Safe to call without await.
 * Frees Redis memory immediately rather than waiting for TTL.
 */
export async function destroySessionBufferRedis(session_id: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  try {
    await client.del(turnsKey(session_id), metaKey(session_id));
  } catch (err) {
    console.warn('[VTID-01955] Redis destroySessionBuffer failed (non-fatal):', (err as Error)?.message || err);
  }
}

/**
 * Test/diagnostics helper.
 */
export async function getRedisBufferStats(session_id: string): Promise<{
  turn_count: number;
  ttl_seconds: number;
  tenant_id?: string;
  user_id?: string;
} | null> {
  const client = getRedisClient();
  if (!client) return null;
  try {
    const tk = turnsKey(session_id);
    const mk = metaKey(session_id);
    const [llen, ttl, meta] = await Promise.all([
      client.llen(tk),
      client.ttl(tk),
      client.hgetall(mk),
    ]);
    return {
      turn_count: typeof llen === 'number' ? llen : 0,
      ttl_seconds: typeof ttl === 'number' ? ttl : -1,
      tenant_id: meta?.tenant_id,
      user_id: meta?.user_id,
    };
  } catch {
    return null;
  }
}

export const REDIS_BUFFER_CONFIG_FOR_TEST = REDIS_BUFFER_CONFIG;
