/**
 * VTID-05217 — Project Manager: the per-tick Postgres lease (plan §6, §6.3).
 *
 * A single `pm_lease` row is claimed per tick with
 *   UPDATE pm_lease SET holder=$1, expires_at=now()+interval '9 minutes'
 *     WHERE expires_at < now() RETURNING ...
 * so that when several ECS tasks run the PM, only one holds the lease and ACTS
 * in a given window — the others skip the tick. Merges additionally go through
 * safe-merge, which refuses an already-merged PR, so a lost lease never double
 * merges (plan Risks).
 *
 * IMPORTANT (plan §6.3): the `pm_lease` table is created by P1's migration
 * (VTID-05214), which is NOT merged yet. Until it lands, the lease acquirer MUST
 * NOT crash and MUST NOT let the act layer run without a lease: a `table_absent`
 * (or any acquisition failure) result makes the tick a safe no-op. This file
 * therefore ships a seam (`LeaseManager`) and a default that acquires NOTHING
 * (`NoLeaseManager`) — the live Postgres-backed lease is wired behind the same
 * interface once P1 is merged, with no change to the act layer or the route.
 */

/** The outcome of trying to take the per-tick lease. */
export type LeaseOutcome =
  | { acquired: true; holder: string; expires_at: string }
  /** The lease could not be taken: another task holds it this window. */
  | { acquired: false; reason: 'held_by_other' }
  /** The pm_lease table does not exist yet (P1 not merged) — tick no-ops. */
  | { acquired: false; reason: 'table_absent' }
  /** Any acquisition error — treated like no lease: the tick no-ops. */
  | { acquired: false; reason: 'error'; error: string };

/** The seam the act layer takes its per-tick lease through. */
export interface LeaseManager {
  /** Try to take the lease for this tick. Never throws. */
  acquire(holder: string): Promise<LeaseOutcome>;
}

/**
 * The default, used until P1's `pm_lease` migration is merged: it acquires
 * nothing and reports `table_absent`, so a `live` tick safely no-ops rather
 * than acting without a lease. This is deliberate — it is the fail-safe the
 * plan requires, not a stub to be removed before merge.
 */
export class NoLeaseManager implements LeaseManager {
  async acquire(): Promise<LeaseOutcome> {
    return { acquired: false, reason: 'table_absent' };
  }
}

export function defaultLeaseManager(): LeaseManager {
  return new NoLeaseManager();
}
