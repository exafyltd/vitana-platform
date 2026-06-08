/**
 * VTID-02941 (B0b-min) — Continuity → AssistantDecisionContext adapter.
 *
 * The B2 read-only inspection slice already produced `ContinuityContext`,
 * a richer shape designed for the Command Hub operator. The assistant
 * decision layer reads a NARROWER shape (`DecisionContinuity`) that
 * strips:
 *   - raw timestamps (kept as boolean `overdue` or `null`)
 *   - raw last_mentioned_at strings (kept as `days_since_last_mention`)
 *   - raw kept_at strings (dropped entirely; the LLM only cares the
 *     promise was kept recently)
 *
 * Truncation happens here, NOT in the renderer. By the time data
 * crosses the adapter boundary, every string is short enough to render
 * directly into a prompt section.
 *
 * Pure function. No IO. The caller is responsible for invoking the
 * continuity compiler + passing its output here.
 */

import type { ContinuityContext } from '../../../services/continuity/types';
import type { DecisionContinuity } from '../types';

const TOPIC_MAX_CHARS = 60;
const SUMMARY_MAX_CHARS = 120;
const PROMISE_TEXT_MAX_CHARS = 120;

export interface DistillContinuityInputs {
  /**
   * Output of `compileContinuityContext` from B2. Read-only.
   */
  continuity: ContinuityContext;
}

/**
 * Distills `ContinuityContext` into the decision-grade `DecisionContinuity`.
 *
 * Always returns a typed shape (never undefined). The caller decides
 * whether to attach it to `AssistantDecisionContext.continuity` or set
 * the field to `null` based on source health.
 */
export function distillContinuityForDecision(
  input: DistillContinuityInputs,
): DecisionContinuity {
  const { continuity } = input;

  const open_threads = continuity.open_threads.map((t) => ({
    thread_id: t.thread_id,
    topic: truncate(t.topic, TOPIC_MAX_CHARS),
    summary: t.summary ? truncate(t.summary, SUMMARY_MAX_CHARS) : null,
    days_since_last_mention: t.days_since_last_mention,
  }));

  const promises_owed = continuity.promises_owed.map((p) => ({
    promise_id: p.promise_id,
    promise_text: truncate(p.promise_text, PROMISE_TEXT_MAX_CHARS),
    overdue: typeof p.days_overdue === 'number' && p.days_overdue > 0,
    decision_id: p.decision_id,
  }));

  const promises_kept_recently = continuity.promises_kept_recently.map((p) => ({
    promise_id: p.promise_id,
    promise_text: truncate(p.promise_text, PROMISE_TEXT_MAX_CHARS),
  }));

  const counts = {
    open_threads_total: continuity.counts.open_threads_total,
    promises_owed_total: continuity.counts.promises_owed_total,
    promises_overdue: continuity.counts.promises_overdue,
    threads_mentioned_today: continuity.counts.threads_mentioned_today,
  };

  const recommended_follow_up = pickRecommendedFollowUp({
    overdue: counts.promises_overdue,
    owed: counts.promises_owed_total,
    keptRecently: promises_kept_recently.length,
    openThreads: counts.open_threads_total,
  });

  return {
    open_threads,
    promises_owed,
    promises_kept_recently,
    counts,
    recommended_follow_up,
  };
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------------

export function truncate(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export function pickRecommendedFollowUp(args: {
  overdue: number;
  owed: number;
  keptRecently: number;
  openThreads: number;
}): DecisionContinuity['recommended_follow_up'] {
  // Priority: overdue debt > recent credit > open thread mention > nothing.
  if (args.overdue > 0) return 'address_overdue_promise';
  if (args.keptRecently > 0) return 'acknowledge_kept_promise';
  if (args.openThreads > 0) return 'mention_open_thread';
  return 'none';
}
