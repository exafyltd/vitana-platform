/**
 * ORB-BRAIN-CACHE (DEV-COMHU-0513) — per-identity cache for the ORB greeting
 * system instruction.
 *
 * WHY: `buildBrainSystemInstruction` (vitana-brain.ts) runs the memory garden
 * + calendar + OASIS context pack, the Life Compass block, the proactive-guide
 * block, and the identity guardrail — measured at ~4.4s on the authenticated
 * community ORB path (`[VITANA-BRAIN] System instruction built in 4395ms`).
 * That whole build GATES the Gemini setup message — `connectToLiveAPI` awaits
 * `session.contextReadyPromise` before sending setup (orb-live.ts ~6178) — so
 * it is the dominant chunk of the ~7s click-to-first-audio.
 *
 * The existing prewarm (`POST /live/session/prewarm`) warms
 * `buildBootstrapContextPack` — the LEGACY path — NOT this brain path, so a
 * prewarmed tap still paid the full ~4.4s (`Context bootstrap complete … cached=false`).
 *
 * This module caches the brain build per (tenant, user, role, channel) with a
 * short TTL, and exposes `warmBrainCache()` for the prewarm endpoint to call,
 * so the user's first tap is a cache hit (~tens of ms instead of ~4.4s).
 *
 * SAFETY:
 *  - Flag-gated `FEATURE_ORB_BRAIN_CACHE_ENV`; default OFF → direct passthrough
 *    to `buildBrainSystemInstruction` (behavior identical to today).
 *  - Success-only (failures are not cached — the entry is dropped on reject).
 *  - 5-min TTL (same staleness rationale as the existing bootstrap cache: a
 *    greeting bootstrap tolerates minute-scale staleness; memory rarely changes
 *    mid-session).
 *  - Concurrent-build de-dupe: the in-flight Promise is cached, so prewarm + the
 *    tap (or repeated prewarms) share ONE build instead of stampeding.
 *  - Keyed by tenant+user → no cross-tenant / cross-user leakage.
 */
import { buildBrainSystemInstruction } from './vitana-brain';
import { isFeatureLive } from './feature-flags';

type BrainInput = Parameters<typeof buildBrainSystemInstruction>[0];
type BrainResult = Awaited<ReturnType<typeof buildBrainSystemInstruction>>;

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;

interface Entry {
  promise: Promise<BrainResult>;
  builtAt: number;
}

const cache = new Map<string, Entry>();

function keyOf(input: BrainInput): string {
  // role + channel are baked into the produced instruction, so they MUST be in
  // the key. tenant + user scope the personalization (no cross-user leakage).
  return [input.tenant_id, input.user_id, input.role, input.channel].join('|');
}

function evictIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return;
  // Map preserves insertion order → drop oldest first until under cap.
  for (const k of cache.keys()) {
    cache.delete(k);
    if (cache.size <= MAX_ENTRIES) break;
  }
}

/** Test helpers. */
export function _resetBrainCacheForTests(): void {
  cache.clear();
}
export function brainCacheSize(): number {
  return cache.size;
}

/**
 * Cached wrapper around `buildBrainSystemInstruction`. When the flag is OFF,
 * this is a transparent passthrough (no caching). When ON, it serves a fresh
 * (< TTL) cached build, de-dupes concurrent builds, and never caches failures.
 */
export function buildBrainSystemInstructionCached(
  input: BrainInput,
  opts: { now?: () => number } = {},
): Promise<BrainResult> {
  if (!isFeatureLive('ORB_BRAIN_CACHE')) {
    return buildBrainSystemInstruction(input);
  }
  const now = opts.now ?? Date.now;
  const key = keyOf(input);

  const hit = cache.get(key);
  if (hit && now() - hit.builtAt < TTL_MS) {
    console.log(`[ORB-BRAIN-CACHE] HIT ${key} (age ${now() - hit.builtAt}ms)`);
    return hit.promise;
  }

  const builtAt = now();
  const promise = buildBrainSystemInstruction(input);
  cache.set(key, { promise, builtAt });
  evictIfNeeded();
  console.log(`[ORB-BRAIN-CACHE] MISS ${key} — building`);

  // Never cache a failure: if the build rejects, drop the entry so the next
  // call rebuilds. Guard on identity so a newer build isn't clobbered.
  promise.catch(() => {
    const cur = cache.get(key);
    if (cur && cur.promise === promise) cache.delete(key);
  });

  return promise;
}

/**
 * Fire-and-forget warm for the prewarm endpoint. Builds (and caches) the brain
 * instruction for the common authenticated community ORB path so the user's
 * first tap is a cache hit. No-op when the flag is off; never throws.
 */
export function warmBrainCache(input: BrainInput): void {
  if (!isFeatureLive('ORB_BRAIN_CACHE')) return;
  void buildBrainSystemInstructionCached(input).catch(() => {
    /* best-effort warm */
  });
}
