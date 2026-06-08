/**
 * VTID-03060 (B0d-real slice Xe) — Continuity pending-thread NextActionSource.
 *
 * Reads `decisionContext.continuity.open_threads` (already compiled by
 * the AssistantDecisionContext compiler — see services/continuity/* +
 * orb/context/providers/continuity-decision-provider.ts). No DB queries.
 *
 * The source produces a candidate when:
 *   - decisionContext.continuity is present
 *   - open_threads has at least one entry
 *   - recommended_follow_up is 'mention_open_thread' (high signal) OR
 *     open_threads is non-empty (medium signal)
 *
 * Priority bands:
 *   - recommended_follow_up === 'mention_open_thread'  → 75
 *   - non-empty open_threads, other follow-up kinds     → 55
 *
 * Below reminders/calendar/autopilot/diary urgency bands so those win.
 * Above CROSS_SOURCE_THRESHOLD=50 so the thread mention fires when
 * nothing more urgent qualifies.
 *
 * Picks the FIRST open_thread (compiler already sorted by recency).
 * Carries thread_id in the CTA so a future ticket can link back to the
 * thread state.
 *
 * Strict rule (from the existing decision-contract boundary memory):
 * NEVER include the original message text. The compiler only forwards
 * the topic + an optional summary — both already truncated.
 */

import type {
  NextActionSource,
  NextActionSourceContext,
  NextActionSourceResult,
  ScoredCandidate,
} from '../types';
import type { DecisionContinuity } from '../../../../../orb/context/types';

const KEY = 'continuity_pending_thread' as const;

export function makeContinuityPendingThreadSource(): NextActionSource {
  return {
    key: KEY,
    serves: () => true,
    produce: produceContinuityPendingThread,
  };
}

export async function produceContinuityPendingThread(
  ctx: NextActionSourceContext,
): Promise<NextActionSourceResult> {
  const cont = extractContinuity(ctx.decisionContext);
  if (!cont) {
    return { source: KEY, candidate: null, skippedReason: 'no_data' };
  }
  if (!cont.open_threads || cont.open_threads.length === 0) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }
  const thread = cont.open_threads[0];
  if (!thread.topic || !thread.topic.trim()) {
    return { source: KEY, candidate: null, skippedReason: 'no_eligible_record' };
  }

  const isRecommended = cont.recommended_follow_up === 'mention_open_thread';
  const priority = isRecommended ? 75 : 55;
  const confidence: ScoredCandidate['confidence'] = isRecommended ? 'high' : 'medium';

  const userFacingLine = renderLine(
    thread.topic.trim(),
    thread.summary?.trim() ?? null,
    thread.days_since_last_mention,
    ctx.lang,
  );

  const candidate: ScoredCandidate = {
    source: KEY,
    priority,
    confidence,
    userFacingLine,
    reasons: [
      {
        kind: 'continuity_open_thread',
        detail: `topic="${thread.topic}" recommended=${isRecommended}`,
      },
      {
        kind: 'continuity_thread_age',
        detail:
          thread.days_since_last_mention === null
            ? 'days_since_last_mention=null'
            : `${thread.days_since_last_mention} days since last mention`,
      },
    ],
    dedupeKey: `continuity_pending_thread:${thread.thread_id}`,
    cta: {
      type: 'ask_permission',
      payload: { thread_id: thread.thread_id },
    },
  };
  return { source: KEY, candidate };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

export function extractContinuity(
  decisionContext: unknown,
): DecisionContinuity | null {
  if (!decisionContext || typeof decisionContext !== 'object') return null;
  const cont = (decisionContext as Record<string, unknown>).continuity;
  if (!cont || typeof cont !== 'object') return null;
  return cont as DecisionContinuity;
}

export function renderLine(
  topic: string,
  summary: string | null,
  daysSinceLastMention: number | null,
  lang: string,
): string {
  const isDe = (lang || 'en').toLowerCase().startsWith('de');
  const ago =
    daysSinceLastMention == null
      ? isDe ? 'kürzlich' : 'a while back'
      : daysSinceLastMention <= 1
        ? isDe ? 'gestern' : 'yesterday'
        : isDe ? `vor ${daysSinceLastMention} Tagen` : `${daysSinceLastMention} days ago`;
  if (isDe) {
    return summary
      ? `Wir haben ${ago} über "${topic}" gesprochen — Stichwort: ${summary}. Wollen wir das weiterführen?`
      : `Wir haben ${ago} über "${topic}" gesprochen. Wollen wir das weiterführen?`;
  }
  return summary
    ? `We talked ${ago} about "${topic}" — gist: ${summary}. Want to pick that thread back up?`
    : `We talked ${ago} about "${topic}". Want to pick that thread back up?`;
}
