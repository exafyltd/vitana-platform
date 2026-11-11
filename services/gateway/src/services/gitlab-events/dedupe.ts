/**
 * VTID-05541 (plan eng-gitlab-m2 §3.5 "Retries are dropped by webhook-id"): delivery dedupe.
 *
 * In memory, per gateway task (plan §8: a duplicate across tasks is possible; it adds one
 * informational OASIS row and moves no state). A Standard Webhooks retry keeps its webhook-id and
 * gets a new timestamp, so an id is kept for 24 hours, not only for the 300-second signature window.
 *
 *   - An id is remembered only after its event was recorded, so a delivery whose OASIS write failed
 *     can be recorded by GitLab's retry.
 *   - A duplicate that arrives while the first delivery is still being recorded waits for it and gets
 *     the same outcome ('duplicate' when it was recorded, 'failed' when it was not); it never records.
 *   - At most `maxIds` ids are kept; the oldest is dropped first. Ids are kept as their SHA-256, so
 *     memory stays bounded whatever length a webhook-id has.
 */
import { createHash } from 'crypto';

export const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEDUPE_MAX_IDS = 10_000;

export type DedupeOutcome = 'recorded' | 'duplicate' | 'failed';

export interface DeliveryDedupeOptions {
  ttlMs?: number;
  maxIds?: number;
  now?: () => number;
}

export class DeliveryDedupe {
  private readonly ttlMs: number;
  private readonly maxIds: number;
  private readonly now: () => number;
  /** SHA-256 of the id → when it was recorded; insertion order is recording order. */
  private readonly recorded = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(options: DeliveryDedupeOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEDUPE_TTL_MS;
    this.maxIds = Math.max(1, options.maxIds ?? DEDUPE_MAX_IDS);
    this.now = options.now ?? Date.now;
  }

  /** True when this id was recorded within the TTL. */
  seen(id: string): boolean {
    this.prune();
    return this.recorded.has(DeliveryDedupe.key(id));
  }

  /** Ids remembered right now. */
  size(): number {
    this.prune();
    return this.recorded.size;
  }

  /** Runs `record` at most once per id (see the file header for the rules). */
  async once(id: string, record: () => Promise<boolean>): Promise<DedupeOutcome> {
    if (this.seen(id)) return 'duplicate';
    const key = DeliveryDedupe.key(id);
    const pending = this.inFlight.get(key);
    if (pending) return (await pending) ? 'duplicate' : 'failed';

    const attempt = (async () => {
      try {
        return (await record()) === true;
      } catch {
        return false;
      }
    })();
    this.inFlight.set(key, attempt);
    let ok: boolean;
    try {
      ok = await attempt;
    } finally {
      this.inFlight.delete(key);
    }
    if (ok) this.remember(key);
    return ok ? 'recorded' : 'failed';
  }

  private static key(id: string): string {
    return createHash('sha256').update(id).digest('base64url');
  }

  private remember(key: string): void {
    this.recorded.delete(key);
    this.recorded.set(key, this.now());
    while (this.recorded.size > this.maxIds) {
      const oldest = this.recorded.keys().next().value as string;
      this.recorded.delete(oldest);
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, at] of this.recorded) {
      if (at > cutoff) break;
      this.recorded.delete(id);
    }
  }
}
