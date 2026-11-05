/**
 * VTID-05541 (plan eng-gitlab-m2 §3.5): remember which GitLab deliveries this gateway task has processed, so a
 * resend with the same `webhook-id` is acknowledged without a second OASIS row.
 *
 * Per task and in memory, as the plan says: a duplicate across two gateway tasks can still add one informational row,
 * and no GitLab topic moves a VTID's state in this milestone, so that is harmless. Bounded in size and age so a flood of
 * distinct ids cannot grow the process. An id is remembered only after its delivery was handled (emitted or ignored),
 * so a delivery that failed to reach OASIS can be resent and processed.
 */
export interface DeliveryIdStore {
  has(id: string): boolean;
  remember(id: string): void;
  size(): number;
}

export function createDeliveryIdStore(
  { maxEntries = 10_000, ttlMs = 24 * 60 * 60 * 1000, now = () => Date.now() }:
    { maxEntries?: number; ttlMs?: number; now?: () => number } = {},
): DeliveryIdStore {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive integer');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be a positive number');
  const seen = new Map<string, number>(); // id → time remembered; insertion order = age order

  const prune = () => {
    const cutoff = now() - ttlMs;
    for (const [id, at] of seen) {
      if (at > cutoff) break;
      seen.delete(id);
    }
    while (seen.size > maxEntries) {
      const oldest = seen.keys().next().value as string;
      seen.delete(oldest);
    }
  };

  return {
    has(id) {
      prune();
      return seen.has(id);
    },
    remember(id) {
      seen.delete(id);
      seen.set(id, now());
      prune();
    },
    size() {
      prune();
      return seen.size;
    },
  };
}
