/**
 * VTID-03060 (B0d-real slice Xe) — Continuity promise-owed NextActionSource.
 *
 * Reads `decisionContext.continuity.promises_owed` + `recommended_follow_up`
 * (already compiled). When Vitana owes the user a follow-up (e.g. "I'll
 * check on your reminder tomorrow"), this source surfaces the oldest-due
 * promise as the next action.
 *
 * Priority bands:
 *   - recommended_follow_up === 'address_overdue_promise' → 88 (matches
 *     autopilot-high; an overdue promise is a trust-builder)
 *   - overdue but follow-up kind != 'address_overdue_promise'  → 78
 *   - non-overdue promise present                              → 60
 *
 * The "address overdue promise" band sits at 88 because keeping promises
 * (especially overdue ones) is psychologically high-stakes for the
 * trust relationship — higher than a generic Autopilot rec (78) but
 * below an imminent reminder firing in <30min (85+).
 *
 * Picks the FIRST promise (compiler sorts oldest-due first). Carries
 * promise_id in the CTA payload + decision_id when present so the
 * downstream surface can mark it kept/resolved.
 */

import type {
  NextActionSource,
  NextActionSourceContext,
  NextActionSourceResult,
  ScoredCandidate,
} from '../types';
import { extractContinuity } from './continuity-pending-thread';
import type { DecisionContinuity } from '../../../../../orb/context/types';

const KEY = 'continuity_promise_owed' as const;

export function makeContinuityPromiseOwedSource(): NextActionSource {
  return {
    key: KEY,
    serves: () => true,
    produce: produceContinuityPromiseOwed,
  };
}

export async function produceContinuityPromiseOwed(
  ctx: NextActionSourceContext,
): Promise<NextActionSourceResult> {
  const cont = extractContinuity(ctx.decisionContext);
  if (!cont) {
    return { source: KEY, candidate: null, skippedReason: 'no_data' };
  }
  if (!cont.promises_owed || cont.promises_owed.length === 0) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }
  const promise = cont.promises_owed[0];
  if (!promise.promise_text || !promise.promise_text.trim()) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }

  const { priority, confidence } = rankPromise(cont, promise.overdue);
  const userFacingLine = renderLine(
    promise.promise_text.trim(),
    promise.overdue,
    ctx.lang,
  );

  const candidate: ScoredCandidate = {
    source: KEY,
    priority,
    confidence,
    userFacingLine,
    reasons: [
      {
        kind: promise.overdue ? 'continuity_overdue_promise' : 'continuity_owed_promise',
        detail: `promise_id=${promise.promise_id} recommended=${cont.recommended_follow_up}`,
      },
    ],
    dedupeKey: `continuity_promise_owed:${promise.promise_id}`,
    cta: {
      type: 'ask_permission',
      payload: {
        promise_id: promise.promise_id,
        decision_id: promise.decision_id ?? null,
      },
    },
  };
  return { source: KEY, candidate };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

export function rankPromise(
  cont: DecisionContinuity,
  overdue: boolean,
): { priority: number; confidence: ScoredCandidate['confidence'] } {
  if (cont.recommended_follow_up === 'address_overdue_promise') {
    return { priority: 88, confidence: 'high' };
  }
  if (overdue) {
    return { priority: 78, confidence: 'high' };
  }
  return { priority: 60, confidence: 'medium' };
}

export function renderLine(
  promiseText: string,
  overdue: boolean,
  lang: string,
): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  if (isDe) {
    if (overdue) {
      return `Ich schulde dir noch einen Rückgriff: ${promiseText}. Sollen wir das jetzt nachholen?`;
    }
    return `Ich habe dir versprochen: ${promiseText}. Wollen wir das jetzt angehen?`;
  }
  if (overdue) {
    return `I still owe you a follow-up on ${promiseText}. Want to do it now?`;
  }
  return `I told you I'd circle back on ${promiseText}. Want to handle it now?`;
}
