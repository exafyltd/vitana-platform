/**
 * VTID-04544 — ORB greeting latency, stream B: the bounded payload reads that
 * feed the greeting decision, run concurrently instead of serially.
 *
 * Before this module, both greeting ladders in `routes/orb-live.ts` read their
 * inputs one after another:
 *
 *   safe-fast:  new-day gather (≤ORB_NEWDAY_OVERVIEW_WAIT_MS)
 *               → resume gather (≤ORB_RESUME_OVERVIEW_WAIT_MS, only when the
 *                 new-day payload has nothing to speak)
 *               → spoken-facts ledger (≤800 ms, only on a payload-bearing path)
 *   normal:     new-day gather (≤ORB_NEWDAY_OVERVIEW_WAIT_MS)
 *               → ledger (≤800 ms, only when the gather returned a payload)
 *
 * The ledger read does not depend on the gather's result — only the decision
 * of whether to USE it does. So it is now started together with the first
 * gather and consumed (or discarded) once that decision is known. The wait is
 * max(gather, ledger) instead of gather + ledger.
 *
 * What stays exactly as it was — the contract the tests pin:
 *   - every read keeps its own timeout, measured from its own start, and its
 *     own fail-open value (null for a gather, a fresh EMPTY ledger for the
 *     ledger); no budget gets longer;
 *   - the values handed to the decision are the ones the serial code would
 *     have handed it: the ledger is passed only on the paths that read it
 *     before, and EMPTY everywhere else;
 *   - no write the serial code would not have made: a speculative ledger read
 *     that turns out unused emits no `read_failed` event (see
 *     `startSpeculativeGreetingLedgerRead`); the gather is started only when
 *     the serial code would have started it.
 *
 * This module decides nothing about WHAT is said. It does no I/O of its own:
 * the caller injects the gather and the ledger read.
 */

import type { OverviewPayload } from '../assistant-continuation/providers/new-day-overview-payload';
import type { GreetingLedger, SpeculativeGreetingLedgerRead } from './greeting-facts-ledger';

/**
 * `Promise.race([read, timeout(ms → onTimeout())]).catch(→ onError())` — the
 * exact bound every greeting read used inline. The timer is cleared once the
 * read settles (the inline form left it running; nothing observed it).
 */
export function boundedRead<T, F>(
  start: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => F,
  onError: () => F,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let read: Promise<T>;
  try {
    read = start();
  } catch (e) {
    read = Promise.reject(e);
  }
  void read.then(
    () => timer !== undefined && clearTimeout(timer),
    () => timer !== undefined && clearTimeout(timer),
  );
  return Promise.race<T | F>([
    read,
    new Promise<F>((r) => {
      timer = setTimeout(() => r(onTimeout()), timeoutMs);
    }),
  ]).catch(() => onError());
}

export interface SafeFastGatherPlan {
  /** The serial code's rung-1 gather guard, already evaluated (and false when an overview-independent rung wins). */
  attemptNewday: boolean;
  /** The serial code's rung-3 guard (`shouldAttemptResumeOverview`), evaluated on the same base context. */
  resumeGuard: { attempt: boolean };
  /** `supa && uid` — the extra conjuncts on the serial resume gather. */
  resumeGatherEligible: boolean;
  /** `tenant && uid && supa` — the identity conjuncts on the serial ledger read. */
  ledgerEligible: boolean;
  /** "Will rung 1 fire?" — the serial code's `!!overview && newdayHasContent(overview)`. */
  newdayWillFire: (overview: OverviewPayload | null) => boolean;
  /** Starts one bounded, fail-open gather (null on timeout/error). */
  gather: (timeoutMs: number) => Promise<OverviewPayload | null>;
  /** Starts the ledger read (bounded by its own timeout from its own start). */
  startLedger: () => SpeculativeGreetingLedgerRead;
  emptyLedger: () => GreetingLedger;
  newdayTimeoutMs: number;
  resumeTimeoutMs: number;
}

export interface SafeFastGatherResult {
  newdayOverview: OverviewPayload | null;
  resumeOverview: OverviewPayload | null;
  newdayWillFire: boolean;
  resumeCheck: { attempt: boolean };
  ledger: GreetingLedger;
}

/**
 * The safe-fast ladder's three reads. The ledger is started with the first
 * gather whenever the serial code COULD reach its read (a new-day gather is
 * attempted, or the resume guard would attempt), and consumed only when the
 * serial code WOULD have read it (`newdayWillFire || resumeCheck.attempt`).
 */
export async function gatherSafeFastGreetingPayloads(plan: SafeFastGatherPlan): Promise<SafeFastGatherResult> {
  const ledgerRead =
    plan.ledgerEligible && (plan.attemptNewday || plan.resumeGuard.attempt) ? plan.startLedger() : null;

  const newdayOverview = plan.attemptNewday ? await plan.gather(plan.newdayTimeoutMs) : null;
  const newdayWillFire = plan.newdayWillFire(newdayOverview);

  const resumeCheck = newdayWillFire ? { attempt: false as boolean } : plan.resumeGuard;
  const resumeOverview =
    resumeCheck.attempt && plan.resumeGatherEligible ? await plan.gather(plan.resumeTimeoutMs) : null;

  const ledgerUsed = plan.ledgerEligible && (newdayWillFire || resumeCheck.attempt);
  const ledger = ledgerUsed && ledgerRead ? await ledgerRead.consume() : plan.emptyLedger();

  return { newdayOverview, resumeOverview, newdayWillFire, resumeCheck, ledger };
}

export interface NewdayGatherPlan {
  /** `tenant` present — the serial ledger read's extra conjunct (user/supabase are guaranteed on this path). */
  ledgerEligible: boolean;
  gather: (timeoutMs: number) => Promise<OverviewPayload | null>;
  startLedger: () => SpeculativeGreetingLedgerRead;
  emptyLedger: () => GreetingLedger;
  newdayTimeoutMs: number;
}

/**
 * The normal ladder's new-day read pair. Serially the ledger was read only
 * when the gather returned a payload; it is now started alongside the gather
 * and consumed under that same condition.
 */
export async function gatherNewdayGreetingPayload(
  plan: NewdayGatherPlan,
): Promise<{ overview: OverviewPayload | null; ledger: GreetingLedger }> {
  const ledgerRead = plan.ledgerEligible ? plan.startLedger() : null;
  const overview = await plan.gather(plan.newdayTimeoutMs);
  const ledger = overview && ledgerRead ? await ledgerRead.consume() : plan.emptyLedger();
  return { overview, ledger };
}
