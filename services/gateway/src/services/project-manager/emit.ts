/**
 * VTID-05216 — Project Manager: the `pm.decision` emit seam (dry_run).
 *
 * In dry_run the PM reports its decisions as OASIS `pm.decision` events and
 * does NOTHING else — no GitHub writes, no merges, no deploys (plan §6, P3).
 *
 * Scope note (why this is a seam, not a direct `emitOasisEvent` call): the
 * OASIS event type union `CicdEventType` (services/gateway/src/types/cicd.ts)
 * is a closed union, and `pm.*` is not a member of it yet. That file is OUTSIDE
 * this lane's path scope (P3 may only touch
 * services/gateway/src/services/project-manager/**, routes/project-manager.ts,
 * index.ts and test/**). Adding the `pm.decision` topic to the union is done
 * where the union lives, by the lane that owns it. So P3 defines a typed
 * emitter interface and a default that logs each decision (the dry_run report
 * surface is the status route's decision list); the live OASIS wiring is a
 * one-line swap behind this interface when the topic is registered.
 */

import { PmDecision } from './types';

/** The seam decisions are reported through. */
export interface PmDecisionEmitter {
  emit(decision: PmDecision): Promise<void>;
}

/**
 * Default dry_run emitter: logs each decision as a `pm.decision` line. It makes
 * NO network/DB call, so it is safe in any environment and in tests.
 */
export class LoggingDecisionEmitter implements PmDecisionEmitter {
  async emit(decision: PmDecision): Promise<void> {
    console.log(`[pm.decision] ${summarizeDecision(decision)}`);
  }
}

/** One-line summary of a decision (log + status). */
export function summarizeDecision(decision: PmDecision): string {
  switch (decision.kind) {
    case 'merge':
      return `merge ${decision.slug}/${decision.lane} (${decision.vtid}) @ ${decision.head_sha}`;
    case 'reassign':
      return `reassign ${decision.slug}/${decision.lane} ${decision.target} ${decision.from_seat}→${decision.to_actor} (${decision.reason}${decision.fallback ? ', fallback' : ''})`;
    case 'park':
      return `park ${decision.slug}/${decision.lane} (${decision.reason}) → ${decision.to_actor ?? 'claude'}`;
    case 'gate2':
      return `gate2 ${decision.slug} [${decision.vtids.join(', ')}] (${decision.reason})`;
    // VTID-05274
    case 'verify':
      return `verify ${decision.slug}/${decision.lane} (${decision.vtid}) @ ${decision.head_sha}`;
    case 'update_branch':
      return `update_branch ${decision.slug}/${decision.lane} (${decision.behind_by} behind) @ ${decision.head_sha}`;
    case 'merge_plan':
      return `merge_plan ${decision.slug} (${decision.vtid}) @ ${decision.head_sha}`;
    case 'merge_bookkeeping':
      return `merge_bookkeeping ${decision.slug} (${decision.vtid}) @ ${decision.head_sha}`;
    case 'ledger':
      return `ledger ${decision.vtid} → ${decision.set.status}/${decision.set.spec_status}`;
  }
}

export function defaultEmitter(): PmDecisionEmitter {
  return new LoggingDecisionEmitter();
}
