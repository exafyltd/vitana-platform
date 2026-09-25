/**
 * VTID-04545 — a request-scoped memo for ONE `/live/session/start`.
 *
 * Session start reads the same rows from more than one place (the heavy
 * context bootstrap, the fast greeting-facts pre-fetch, the wake-brief name
 * resolution). With this memo the second caller receives the first caller's
 * promise instead of issuing the identical read again.
 *
 * Rules for callers:
 *   - The key must encode EVERY parameter of the read. Two call sites share a
 *     result only when they would have issued the identical query.
 *   - The memo lives for one request and is never stored anywhere global, so
 *     nothing leaks between sessions or users.
 *   - A rejected promise is shared as-is: every consumer sees the same
 *     rejection its own call would have produced, and keeps its own
 *     `.catch` / `allSettled` handling.
 */

export interface RequestMemo {
  getOnce<T>(key: string, fn: () => PromiseLike<T> | T): Promise<T>;
  /** Number of loader invocations per key — observability / tests. */
  readonly loads: ReadonlyMap<string, number>;
}

export function createRequestMemo(): RequestMemo {
  const values = new Map<string, Promise<unknown>>();
  const loads = new Map<string, number>();
  return {
    getOnce<T>(key: string, fn: () => PromiseLike<T> | T): Promise<T> {
      const existing = values.get(key);
      if (existing) return existing as Promise<T>;
      loads.set(key, (loads.get(key) ?? 0) + 1);
      let p: Promise<T>;
      try {
        p = Promise.resolve(fn());
      } catch (err) {
        p = Promise.reject(err);
      }
      values.set(key, p);
      return p;
    },
    loads,
  };
}
