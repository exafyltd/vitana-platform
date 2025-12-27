/**
 * VTID-01033: CICD Lock Manager - Controlled Parallel Execution
 *
 * Implements deterministic concurrency control for autonomous VTID execution:
 * - Global max parallel merges (default 2)
 * - Service-level collision detection
 * - Critical path collision detection
 * - Lock timeout with automatic release
 * - OASIS event tracing for full auditability
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  CicdLockEntry,
  LockAcquisitionRequest,
  LockAcquisitionResult,
  CicdConcurrencyConfig,
  LockKeyType,
} from '../types/cicd';
import { emitOasisEvent } from './oasis-event-service';

// ==================== Configuration ====================

const CONFIG_PATH = join(__dirname, '../../../../config/cicd-concurrency.json');

const DEFAULT_CONFIG: CicdConcurrencyConfig = {
  concurrency: {
    maxParallelMerges: 2,
    lockTimeoutMinutes: 15,
  },
  criticalPaths: [
    'services/gateway/src/routes/',
    '.github/workflows/',
    'scripts/deploy/',
    'scripts/ci/',
  ],
  strictPaths: [
    'config/',
  ],
  lockKeyPrefixes: {
    global: 'global',
    service: 'service:',
    path: 'path:',
  },
};

function loadConfig(): CicdConcurrencyConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        concurrency: {
          maxParallelMerges: parsed.concurrency?.maxParallelMerges ?? DEFAULT_CONFIG.concurrency.maxParallelMerges,
          lockTimeoutMinutes: parsed.concurrency?.lockTimeoutMinutes ?? DEFAULT_CONFIG.concurrency.lockTimeoutMinutes,
        },
        criticalPaths: parsed.criticalPaths ?? DEFAULT_CONFIG.criticalPaths,
        strictPaths: parsed.strictPaths ?? DEFAULT_CONFIG.strictPaths,
        lockKeyPrefixes: parsed.lockKeyPrefixes ?? DEFAULT_CONFIG.lockKeyPrefixes,
      };
    }
  } catch (error) {
    console.warn(`[VTID-01033] Failed to load config from ${CONFIG_PATH}, using defaults:`, error);
  }
  return DEFAULT_CONFIG;
}

// ==================== In-Memory Lock State ====================

/**
 * In-memory lock table
 * Key format: "service:gateway", "path:.github/workflows/", etc.
 */
const lockTable: Map<string, CicdLockEntry> = new Map();

/**
 * Track active merges for global concurrency limit
 */
const activeMerges: Set<string> = new Set();

// ==================== Lock Helper Functions ====================

/**
 * Get current config (reloads on each call for hot-reload support)
 */
function getConfig(): CicdConcurrencyConfig {
  return loadConfig();
}

/**
 * Generate lock key for a service
 */
function serviceKey(service: string): string {
  return `${getConfig().lockKeyPrefixes.service}${service}`;
}

/**
 * Generate lock key for a critical path group
 */
function pathKey(pathGroup: string): string {
  return `${getConfig().lockKeyPrefixes.path}${pathGroup}`;
}

/**
 * Check if a file path matches any critical path
 */
function matchesCriticalPath(filePath: string, criticalPaths: string[]): string | null {
  for (const critical of criticalPaths) {
    if (filePath.startsWith(critical)) {
      return critical;
    }
  }
  return null;
}

/**
 * Extract all critical path groups that a set of changed files touches
 */
function extractCriticalPathGroups(changedPaths: string[]): string[] {
  const config = getConfig();
  const allCriticalPaths = [...config.criticalPaths, ...(config.strictPaths || [])];
  const groups = new Set<string>();

  for (const path of changedPaths) {
    const matched = matchesCriticalPath(path, allCriticalPaths);
    if (matched) {
      groups.add(matched);
    }
  }

  return Array.from(groups);
}

/**
 * Clean up expired locks
 */
function cleanupExpiredLocks(): string[] {
  const now = new Date().toISOString();
  const expired: string[] = [];

  for (const [key, entry] of lockTable.entries()) {
    if (entry.expires_at < now) {
      lockTable.delete(key);
      activeMerges.delete(entry.held_by);
      expired.push(key);
      console.log(`[VTID-01033] Lock expired: ${key} (held by ${entry.held_by})`);
    }
  }

  return expired;
}

// ==================== OASIS Lock Events ====================

async function emitLockEvent(
  type: 'cicd.lock.acquire.requested' | 'cicd.lock.acquire.succeeded' | 'cicd.lock.acquire.blocked' | 'cicd.lock.released' | 'cicd.lock.expired',
  vtid: string,
  payload: Record<string, unknown>
): Promise<void> {
  const statusMap: Record<string, 'info' | 'success' | 'warning' | 'error'> = {
    'cicd.lock.acquire.requested': 'info',
    'cicd.lock.acquire.succeeded': 'success',
    'cicd.lock.acquire.blocked': 'warning',
    'cicd.lock.released': 'info',
    'cicd.lock.expired': 'warning',
  };

  const messageMap: Record<string, string> = {
    'cicd.lock.acquire.requested': `Lock acquisition requested`,
    'cicd.lock.acquire.succeeded': `Locks acquired successfully`,
    'cicd.lock.acquire.blocked': `Lock acquisition blocked`,
    'cicd.lock.released': `Locks released`,
    'cicd.lock.expired': `Lock expired (timeout)`,
  };

  await emitOasisEvent({
    vtid,
    type,
    source: 'cicd-lock-manager',
    status: statusMap[type],
    message: messageMap[type],
    payload: {
      ...payload,
      timestamp: new Date().toISOString(),
    },
  });
}

// ==================== Lock Manager API ====================

/**
 * Attempt to acquire all required locks for a VTID merge operation
 *
 * Lock acquisition is atomic: either all locks are acquired or none are.
 * This prevents partial lock states.
 */
export async function acquireLocks(request: LockAcquisitionRequest): Promise<LockAcquisitionResult> {
  const config = getConfig();
  const { vtid, pr_number, services, changed_paths } = request;

  // First, clean up any expired locks
  const expiredKeys = cleanupExpiredLocks();
  for (const key of expiredKeys) {
    await emitLockEvent('cicd.lock.expired', vtid, { expired_key: key });
  }

  // Emit lock acquisition requested event
  await emitLockEvent('cicd.lock.acquire.requested', vtid, {
    services,
    changed_paths_count: changed_paths.length,
    pr_number,
  });

  // Check global concurrency limit
  if (activeMerges.size >= config.concurrency.maxParallelMerges) {
    // Check if this VTID already has an active merge (re-entrant)
    if (!activeMerges.has(vtid)) {
      const activeList = Array.from(activeMerges);
      await emitLockEvent('cicd.lock.acquire.blocked', vtid, {
        reason: 'global_concurrency_limit',
        max_parallel: config.concurrency.maxParallelMerges,
        active_vtids: activeList,
      });

      return {
        ok: false,
        vtid,
        blocked_by_key: 'global',
        blocked_by_vtid: activeList[0],
        error: `Global concurrency limit reached (max ${config.concurrency.maxParallelMerges}). Active: ${activeList.join(', ')}`,
      };
    }
  }

  // Build list of keys to acquire
  const keysToAcquire: Array<{ key: string; type: LockKeyType }> = [];

  // Add service locks
  for (const service of services) {
    keysToAcquire.push({ key: serviceKey(service), type: 'service' });
  }

  // Add critical path locks
  const criticalGroups = extractCriticalPathGroups(changed_paths);
  for (const group of criticalGroups) {
    keysToAcquire.push({ key: pathKey(group), type: 'path' });
  }

  // Check for collisions before acquiring
  for (const { key } of keysToAcquire) {
    const existing = lockTable.get(key);
    if (existing && existing.held_by !== vtid) {
      // Collision detected
      await emitLockEvent('cicd.lock.acquire.blocked', vtid, {
        blocked_key: key,
        held_by: existing.held_by,
        held_since: existing.acquired_at,
        expires_at: existing.expires_at,
        pr_number: existing.pr_number,
      });

      return {
        ok: false,
        vtid,
        blocked_by_key: key,
        blocked_by_vtid: existing.held_by,
        error: `Lock held for ${key} by ${existing.held_by}`,
      };
    }
  }

  // All clear - acquire all locks atomically
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.concurrency.lockTimeoutMinutes * 60 * 1000);
  const acquiredKeys: string[] = [];

  for (const { key, type } of keysToAcquire) {
    const entry: CicdLockEntry = {
      key,
      type,
      held_by: vtid,
      pr_number,
      acquired_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };
    lockTable.set(key, entry);
    acquiredKeys.push(key);
  }

  // Track this VTID as actively merging
  activeMerges.add(vtid);

  // Emit success event
  await emitLockEvent('cicd.lock.acquire.succeeded', vtid, {
    acquired_keys: acquiredKeys,
    expires_at: expiresAt.toISOString(),
    pr_number,
    active_merges: activeMerges.size,
  });

  console.log(`[VTID-01033] Locks acquired for ${vtid}: ${acquiredKeys.join(', ')}`);

  return {
    ok: true,
    vtid,
    acquired_keys: acquiredKeys,
  };
}

/**
 * Release all locks held by a VTID
 *
 * Called on:
 * - Successful merge completion
 * - Merge failure
 * - Explicit release request
 */
export async function releaseLocks(vtid: string, reason: 'success' | 'failure' | 'timeout' | 'explicit' = 'explicit'): Promise<string[]> {
  const releasedKeys: string[] = [];

  // Find and remove all locks held by this VTID
  for (const [key, entry] of lockTable.entries()) {
    if (entry.held_by === vtid) {
      lockTable.delete(key);
      releasedKeys.push(key);
    }
  }

  // Remove from active merges
  activeMerges.delete(vtid);

  if (releasedKeys.length > 0) {
    await emitLockEvent('cicd.lock.released', vtid, {
      released_keys: releasedKeys,
      reason,
      active_merges_remaining: activeMerges.size,
    });

    console.log(`[VTID-01033] Locks released for ${vtid} (${reason}): ${releasedKeys.join(', ')}`);
  }

  return releasedKeys;
}

/**
 * Get current lock status for debugging/monitoring
 */
export function getLockStatus(): {
  active_merges: string[];
  locks: CicdLockEntry[];
  config: CicdConcurrencyConfig;
} {
  // Clean up expired before reporting
  cleanupExpiredLocks();

  return {
    active_merges: Array.from(activeMerges),
    locks: Array.from(lockTable.values()),
    config: getConfig(),
  };
}

/**
 * Check if a VTID currently holds any locks
 */
export function hasActiveLocks(vtid: string): boolean {
  for (const entry of lockTable.values()) {
    if (entry.held_by === vtid) {
      return true;
    }
  }
  return false;
}

/**
 * Force release all locks (for admin/emergency use)
 */
export async function forceReleaseAllLocks(reason: string): Promise<number> {
  const count = lockTable.size;
  const vtids = new Set<string>();

  for (const entry of lockTable.values()) {
    vtids.add(entry.held_by);
  }

  lockTable.clear();
  activeMerges.clear();

  for (const vtid of vtids) {
    await emitLockEvent('cicd.lock.released', vtid, {
      released_keys: ['*'],
      reason: `force_release: ${reason}`,
      force: true,
    });
  }

  console.log(`[VTID-01033] Force released ${count} locks for reason: ${reason}`);
  return count;
}

export const cicdLockManager = {
  acquireLocks,
  releaseLocks,
  getLockStatus,
  hasActiveLocks,
  forceReleaseAllLocks,
};

export default cicdLockManager;
