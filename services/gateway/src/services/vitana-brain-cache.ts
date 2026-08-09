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
  /**
   * VTID-03504: false while the build is still running. Single-flight joins an
   * UNSETTLED entry unconditionally — TTL is about how stale a *finished*
   * build may be, and has nothing to say about a build that hasn't produced a
   * value yet. Without this an entry whose build outlives the TTL would be
   * "expired" while still in flight and a second identical build would start
   * on top of it, which is the stampede this module exists to prevent.
   */
  settled: boolean;
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
 * Cached wrapper around `buildBrainSystemInstruction`.
 *
 * Two independent behaviours, deliberately NOT gated together (VTID-03504):
 *
 *  - **Single-flight de-dupe is ALWAYS on.** Concurrent callers for the same
 *    key share one in-flight build, flag or no flag. This is a safety
 *    property, not an experiment: N identical builds racing each other is
 *    never the intended behaviour of any configuration.
 *  - **TTL reuse of a COMPLETED build is flag-gated** (`ORB_BRAIN_CACHE`).
 *    Flag off ⇒ the entry is dropped once it settles, so the next tap
 *    rebuilds — the original passthrough semantics.
 *
 * WHY the split (2026-08-05, VTID-03504): the flag was off in production, so
 * this whole module was a passthrough — including the de-dupe. Every ORB tap
 * and every widget reconnect started its own full brain build (~10 Supabase
 * round trips each). A user whose orb failed to connect retried; each retry
 * added a build; the builds starved each other and got slower; the client
 * timed out sooner and retried again. Measured on prod: bootstrap latency ran
 * 1.2s → 17s → 44s → 120s over eight minutes and degraded two uninvolved
 * users on the same task. Nothing in the loop damped anything. A stampede
 * guard that only works when an unrelated caching experiment is switched on
 * is not a guard, so it no longer depends on one.
 *
 * Failures are still never cached, under either setting.
 */
export function buildBrainSystemInstructionCached(
  input: BrainInput,
  opts: { now?: () => number } = {},
): Promise<BrainResult> {
  const now = opts.now ?? Date.now;
  const key = keyOf(input);
  const ttlReuseEnabled = isFeatureLive('ORB_BRAIN_CACHE');

  const hit = cache.get(key);
  if (hit) {
    // Single-flight: an in-flight build is joined regardless of the flag and
    // regardless of TTL. This is the branch that collapses a retry storm.
    if (!hit.settled) {
      console.log(`[ORB-BRAIN-CACHE] JOIN in-flight ${key} (started ${now() - hit.builtAt}ms ago)`);
      return hit.promise;
    }
    if (ttlReuseEnabled && now() - hit.builtAt < TTL_MS) {
      console.log(`[ORB-BRAIN-CACHE] HIT ${key} (age ${now() - hit.builtAt}ms)`);
      return hit.promise;
    }
  }

  const builtAt = now();
  const promise = buildBrainSystemInstruction(input);
  const entry: Entry = { promise, builtAt, settled: false };
  cache.set(key, entry);
  evictIfNeeded();
  console.log(`[ORB-BRAIN-CACHE] MISS ${key} — building`);

  // Mark settled, then decide whether the finished value is worth keeping.
  // Guard every mutation on entry identity so a newer build isn't clobbered.
  const onSettled = (keep: boolean) => {
    entry.settled = true;
    const cur = cache.get(key);
    if (!cur || cur !== entry) return;
    // Failures are never cached. Successes are kept only while TTL reuse is
    // enabled — with the flag off the entry existed purely to hold the
    // single-flight slot, and dropping it here preserves the documented
    // "flag OFF → each call rebuilds" contract.
    if (!keep || !isFeatureLive('ORB_BRAIN_CACHE')) cache.delete(key);
  };
  promise.then(() => onSettled(true), () => onSettled(false));

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
