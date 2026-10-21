/**
 * VTID-05216 — Project Manager: the OBSERVE step (read-only data gathering).
 *
 * P3 defines the typed reader seam the pure `decide` step consumes. The real
 * data sources depend on lanes that are NOT yet merged:
 *   - p1 (VTID-05214) lands the plan-spar migration, `pm_lease`/`pm_digests`
 *     and the policy-approval columns;
 *   - p2 (VTID-05215) lands the programme registry content.
 * Until those land, the live readers cannot run. So P3 ships a clean
 * `PmObserver` interface plus a `StubObserver` that returns an empty world.
 * P4 and the live wiring implement `PmObserver` against the GitHub API, the
 * queue state and the ledger WITHOUT reworking the decide step or the route.
 *
 * The observer is read-only by contract: it never writes to GitHub, Supabase
 * or AWS. P3 adds no live reader — only the seam and the stub — because the
 * sources it would read are not merged yet (see the lane Handoff).
 */

import { ObservedState, PmMode } from './types';

/** The read-only seam the PM observes the world through. */
export interface PmObserver {
  /**
   * Gather the whole observed world for a tick. `mode` is passed through so a
   * decision list always reports the mode it was computed under.
   */
  observe(mode: PmMode): Promise<ObservedState>;
}

/**
 * The P3 stub: an empty, well-formed world. It depends on nothing (no DB, no
 * GitHub, no p1/p2 artefacts), so the route and the dry_run tick are exercisable
 * today and the live reader slots in behind the same interface later.
 */
export class StubObserver implements PmObserver {
  async observe(mode: PmMode): Promise<ObservedState> {
    return { mode, lanes: [], rotations: [] };
  }
}

/** The observer the gateway uses until the live reader lands (p1/p2 dependency). */
export function defaultObserver(): PmObserver {
  return new StubObserver();
}
