/**
 * VTID-05159 (Health Hub Phase 1 / A2) — S8: the store's change hook.
 *
 * B2 registers `rederiveMemberFeatures` at startup; A never imports B. The
 * store calls every registered hook:
 *   - after the withdrawal primitives suppressHealthData / unsuppressHealthData
 *     have committed (S9), and
 *   - after a writeHealthSamples call that deleted rows (with the affected
 *     local dates).
 * Hooks run after the commit, fire-and-forget: a hook error (or a throw) is
 * logged with a code and never fails the primitive. Account erasure needs no
 * hook (erase_user_data() removes B's tables in the same pass).
 */

import type { HealthDataCategory } from './catalogue';

export interface HealthStoreIdentity {
  tenant_id: string;
  user_id: string;
}

export interface HealthStoreChange {
  dates?: string[];
  categories?: HealthDataCategory[];
  source_id?: string;
}

export type HealthStoreChangeHook = (identity: HealthStoreIdentity, change: HealthStoreChange) => Promise<void>;

export interface HealthStoreHookRegistry {
  register(fn: HealthStoreChangeHook): () => void;
  /** Starts every hook without waiting for it; returns at once. */
  fire(identity: HealthStoreIdentity, change: HealthStoreChange): void;
  /** Resolves when every hook started so far has settled (tests, graceful shutdown). */
  flush(): Promise<void>;
  clear(): void;
  size(): number;
}

export const HEALTH_STORE_HOOK_FAILED = 'HEALTH_STORE_HOOK_FAILED';

export function createHealthStoreHookRegistry(): HealthStoreHookRegistry {
  const hooks = new Set<HealthStoreChangeHook>();
  const pending = new Set<Promise<void>>();

  return {
    register(fn) {
      if (typeof fn !== 'function') return () => undefined;
      hooks.add(fn);
      return () => {
        hooks.delete(fn);
      };
    },
    fire(identity, change) {
      for (const fn of Array.from(hooks)) {
        const p = Promise.resolve()
          .then(() => fn(identity, change))
          .then(
            () => undefined,
            (err) => {
              console.error(
                JSON.stringify({
                  event: 'health_store_change_hook_failed',
                  code: HEALTH_STORE_HOOK_FAILED,
                  error: err instanceof Error ? err.name : typeof err,
                }),
              );
            },
          );
        pending.add(p);
        void p.finally(() => pending.delete(p));
      }
    },
    async flush() {
      while (pending.size > 0) await Promise.all(Array.from(pending));
    },
    clear() {
      hooks.clear();
    },
    size() {
      return hooks.size;
    },
  };
}

/** The process-wide registry the real store fires into. */
export const healthStoreHooks: HealthStoreHookRegistry = createHealthStoreHookRegistry();

/** S8. Returns an unregister function. */
export function registerHealthStoreChangeHook(fn: HealthStoreChangeHook): () => void {
  return healthStoreHooks.register(fn);
}
