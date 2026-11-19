/**
 * Delivery loop: the topics and idempotency keys, in one place. A key says "this fact, once": the ledger writes it one time however
 * often it is asked to (two gateway tasks, a retry after a crash, a cycle that runs again over the same fact).
 *
 * The life of a unit of work:
 *
 *   intake     a GitLab issue with the intake label            -> delivery.intake.accepted | rejected      (the decision)
 *   intent     the work to do about it, recorded BEFORE doing it -> delivery.dispatch.requested             (always, at L1 and up)
 *   outcome    what happened when the intent was driven         -> delivery.dispatch.started | failed       (only at L3 and armed)
 *   heal       a failed pipeline, its attempts and its end      -> delivery.heal.detected | attempt | verified | exhausted
 *   review     a green merge request, its verdict, its rework    -> delivery.review.requested | verdict | rework
 *   learn      what the outcome taught                          -> delivery.learn.recorded
 *   improve    a failure that keeps coming back                 -> delivery.improve.proposed
 *   note       what the loop says on GitLab                     -> delivery.note.requested (always) | posted (L2 and up)
 *   cycle      the loop's own bookkeeping                        -> delivery.loop.claim | cycle
 *
 * An intent is the seam between deciding and acting: the decision is recorded at L1, the action is taken only when the level allows
 * it, so raising the level later acts on what was already decided and nothing is decided twice.
 */
import type { CicdEventType } from '../../types/cicd';

export const T = {
  issueOpened: 'scm.gitlab.issue.opened',
  issueLabeled: 'scm.gitlab.issue.labeled',
  intakeAccepted: 'delivery.intake.accepted',
  intakeRejected: 'delivery.intake.rejected',
  requested: 'delivery.dispatch.requested',
  started: 'delivery.dispatch.started',
  failed: 'delivery.dispatch.failed',
  healDetected: 'delivery.heal.detected',
  healAttempt: 'delivery.heal.attempt',
  healVerified: 'delivery.heal.verified',
  healExhausted: 'delivery.heal.exhausted',
  reviewRequested: 'delivery.review.requested',
  reviewVerdict: 'delivery.review.verdict',
  reviewRework: 'delivery.review.rework',
  learned: 'delivery.learn.recorded',
  improve: 'delivery.improve.proposed',
  cycle: 'delivery.loop.cycle',
  claim: 'delivery.loop.claim',
  noteRequested: 'delivery.note.requested',
  note: 'delivery.note.posted',
  blocked: 'delivery.blocked',
} as const satisfies Record<string, CicdEventType>;

/** How an intent is carried out. */
export type IntentAction = 'run_task' | 'retry_pipeline';

/** Everything the loop keeps that is older than this is no longer acted on: an intent that old has lost its context. */
export const INTENT_TTL_MS = 24 * 60 * 60 * 1000;
/** An intent whose execution failed is tried at most this many times, this far apart. */
export const MAX_DISPATCH_TRIES = 3;
export const RETRY_SPACING_MS = 5 * 60 * 1000;
/** A retried pipeline whose end was never seen as an event is looked at after this long. */
export const RETRY_VERIFY_AFTER_MS = 10 * 60 * 1000;

export const K = {
  accepted: (project: string, iid: number) => `intake:accepted:${project}:${iid}`,
  /** One rejection per VERSION of the issue and reason: the same issue seen by a webhook and by the poller is one decision. */
  rejected: (project: string, iid: number, reason: string, version: string) => `intake:rejected:${project}:${iid}:${reason}:${version}`,

  workIntake: (project: string, iid: number) => `intake:${project}:${iid}`,
  workRepair: (healKey: string) => `repair:${healKey}`,
  workRetry: (healKey: string) => `retry:${healKey}`,
  workRework: (project: string, mrIid: number) => `rework:${project}:${mrIid}`,

  intent: (workKey: string, attempt: number) => `intent:${workKey}:${attempt}`,
  outcomeStarted: (intentKey: string) => `${intentKey}:started`,
  outcomeFailed: (intentKey: string, attempt: number) => `${intentKey}:failed:${attempt}`,

  healDetected: (project: string, pipelineId: number) => `heal:detected:${project}:${pipelineId}`,
  healAttempt: (intentKey: string) => `heal:attempt:${intentKey}`,
  healVerified: (healKey: string) => `heal:verified:${healKey}`,
  healExhausted: (healKey: string) => `heal:exhausted:${healKey}`,

  reviewRequested: (project: string, mrIid: number, head: string) => `review:requested:${project}:${mrIid}:${head}`,
  reviewVerdict: (project: string, mrIid: number, head: string) => `review:verdict:${project}:${mrIid}:${head}`,
  reviewRework: (project: string, mrIid: number, round: number) => `review:rework:${project}:${mrIid}:${round}`,

  learned: (kind: string, ref: string) => `learn:${kind}:${ref}`,
  improve: (project: string, fingerprint: string, week: string) => `improve:${project}:${fingerprint}:${week}`,
  note: (scope: string) => `note:${scope}`,
  noteRequested: (scope: string) => `note:requested:${scope}`,
  blocked: (scope: string) => `blocked:${scope}`,

  claim: (window: number) => `claim:${window}`,
  cycle: (window: number) => `cycle:${window}`,
};

/** `2026-W47`: the week an improvement proposal belongs to, so one failure is proposed at most once a week. */
export function isoWeek(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
