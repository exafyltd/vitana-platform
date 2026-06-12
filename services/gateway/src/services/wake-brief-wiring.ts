/**
 * VTID-02918 (B0d.4) — Wake-brief wiring.
 *
 * Glue between the B0a session-cadence inputs already computed inside
 * orb-live.ts's `/live/session/start` handler and the B0d.1 continuation
 * orchestrator. Producing the wake-brief decision in a tiny dedicated
 * module (instead of inlining 60 more lines into orb-live.ts) keeps
 * the route file's diff small and makes the wiring unit-testable.
 *
 * Wiring rule (measure-before-optimize):
 *   - Compute greetingPolicy from existing decideGreetingPolicy().
 *   - Call decideContinuation() on the orb_wake surface.
 *   - Emit the 3 continuation_decision_* timeline events.
 *   - RETURN the decision so the caller can attach it to the session +
 *     response payload.
 *
 * **No prompt rewiring in B0d.4.** The selected continuation is
 * observable (timeline events, response payload, session state) but it
 * does NOT yet drive the spoken greeting — that change waits for the
 * vitana-v1 frontend integration AFTER a week of timeline data confirms
 * the path is healthy. Premature swap-in would hide the failure mode
 * the way instantGreeting.ts did for 6 months (see
 * orb_ios_greeting_silent_root_cause.md).
 */

import { decideContinuation } from './assistant-continuation/decide-continuation';
import {
  defaultProviderRegistry,
} from './assistant-continuation/provider-registry';
import {
  makeVoiceWakeBriefProvider,
  VOICE_WAKE_BRIEF_EXTRA_KEY,
  VOICE_WAKE_BRIEF_PROVIDER_KEY,
  type VoiceWakeBriefInputs,
} from './assistant-continuation/providers/voice-wake-brief';
// VTID-03057 (B0d-real slice Xb): import the Contextual Next Action
// provider + its default-source registration side-effect. The side-effect
// import registers reminder_due + autopilot_recommendation with the
// composer; the named import lets us register the provider itself with
// the framework's defaultProviderRegistry.
import {
  makeNextActionProvider,
  NEXT_ACTION_EXTRA_KEY,
  NEXT_ACTION_PROVIDER_KEY,
} from './assistant-continuation/providers/next-action';
import './assistant-continuation/providers/next-action/register-default-sources';
// VTID-03093 (Teacher PR 3): the Feature Discovery Coach. Sits at
// priority 75 — beats the bare wake-brief fallback when the user has
// unexplored capabilities, loses to next-action candidates above 50.
import {
  makeFeatureDiscoveryTeacherProvider,
  TEACHER_EXTRA_KEY,
  TEACHER_PROVIDER_KEY,
} from './assistant-continuation/providers/teacher/feature-discovery-teacher';
// VTID-03164: new-day-return provider — fires first session of a new
// calendar day in user's local TZ. Priority 90 so it beats Teacher (85)
// and wake-brief (80). Suppresses cleanly when same-day repeat or when
// the user is brand-new (is_first_session=true). Owns the rude-jump-to-
// Teacher bug fix: a returning user's morning is no longer a capability
// pitch.
import {
  makeNewDayReturnProvider,
  NEW_DAY_RETURN_EXTRA_KEY,
  NEW_DAY_RETURN_PROVIDER_KEY,
} from './assistant-continuation/providers/new-day-return';
// R6 (BOOTSTRAP-ORB-R6R7-PROVIDERS): first-time-welcome provider — fires
// once on the user's first-ever session (is_first_session=true). Priority
// 95, above every other turn-1 producer. Suppresses cleanly otherwise so
// it never blocks the daily/Teacher/wake-brief path.
import {
  makeFirstTimeWelcomeProvider,
  FIRST_TIME_WELCOME_EXTRA_KEY,
  FIRST_TIME_WELCOME_PROVIDER_KEY,
} from './assistant-continuation/providers/first-time-welcome';
// R7 (BOOTSTRAP-ORB-R6R7-PROVIDERS): goal-completion-inquiry provider —
// fires when the active life_compass goal's target_date is in the past
// (end-of-day UTC). Priority 92, above new-day-return (90). Suppresses
// cleanly when no active goal / no target_date / target not yet past.
import {
  makeGoalCompletionInquiryProvider,
  GOAL_COMPLETION_EXTRA_KEY,
  GOAL_COMPLETION_PROVIDER_KEY,
} from './assistant-continuation/providers/goal-completion-inquiry';
// VTID-03257 (Fix-1): journey-guide — for non-graduated users the Foundation
// checklist LEADS turn-1 (priority 91, above new-day-return + Teacher).
import {
  makeJourneyGuideProvider,
  JOURNEY_GUIDE_EXTRA_KEY,
  JOURNEY_GUIDE_PROVIDER_KEY,
} from './assistant-continuation/providers/journey-guide';
// VTID-03290: guided-topic-narration — when a user taps a session/topic in the
// Guided Journey catalog, Vitana opens and TEACHES that topic from the published
// KB. Priority 96 (above first_time_welcome 95) so an explicit tap leads turn-1.
// Fires ONLY when a topicId was tapped; otherwise skips, so it never blocks the
// normal ladder.
import {
  makeGuidedTopicNarrationProvider,
  GUIDED_TOPIC_NARRATION_EXTRA_KEY,
  GUIDED_TOPIC_NARRATION_PROVIDER_KEY,
} from './assistant-continuation/providers/guided-topic-narration';
// VTID-03061 (B0d-real Xf.1): auto-emit OASIS next_action.suggested/
// .suppressed events when a wake-brief decision lands. Fire-and-forget;
// never blocks the voice path.
import { emitNextActionDecisionTelemetry } from './assistant-continuation/providers/next-action/emit-telemetry';
import {
  decideGreetingPolicyWithEvidence,
  type GreetingPolicyInput,
} from '../orb/live/instruction/greeting-policy';
import { defaultWakeTimelineRecorder } from './wake-timeline/wake-timeline-recorder';
import type { AssistantContinuationDecision } from './assistant-continuation/types';
import type { SupabaseClient } from '@supabase/supabase-js';
// VTID-03081 (B1 wiring): cadence signal store. Fire-and-forget write
// after the wake-brief fires so the next session can apply the 15-min
// skip rule + same-style downgrade. Read happens upstream in the
// caller (live-session-controller / orb-livekit) so we can keep this
// module pure on the read side.
import { recordWakeBriefEmitted } from './wake-cadence-signals';
// VTID-03301 — cross-session opener rotation.
import { readOrbSessionState } from './orb/orb-session-state';

/** How many recent openers to remember per user (the rotation window). */
const RECENT_OPENERS_WINDOW = 6;
/** TTL for the rotation memory (48h) — long enough to vary day-to-day. */
const RECENT_OPENERS_TTL_MIN = 48 * 60;

// ---------------------------------------------------------------------------
// One-time provider registration. The default registry started empty in
// B0d.1 by design; B0d.2+ providers register here. Idempotent so
// re-imports during hot-reload don't throw the "duplicate key" error.
// ---------------------------------------------------------------------------

let _registered = false;
export function ensureWakeBriefProviderRegistered(): void {
  if (_registered) return;
  // voice-wake-brief — the B0d-mini fallback (pillar-momentum-only line
  // when nothing else fires). Priority 80.
  if (!defaultProviderRegistry.get(VOICE_WAKE_BRIEF_PROVIDER_KEY)) {
    defaultProviderRegistry.register(makeVoiceWakeBriefProvider());
  }
  // VTID-03057 (B0d-real): the Contextual Next Action provider —
  // priority 90, so when ANY registered source produces a candidate
  // above CROSS_SOURCE_THRESHOLD (50), this one beats the fallback.
  // When nothing fires, this provider returns `suppressed` and the
  // framework's decideContinuation picks voice-wake-brief instead.
  if (!defaultProviderRegistry.get(NEXT_ACTION_PROVIDER_KEY)) {
    defaultProviderRegistry.register(makeNextActionProvider());
  }
  // VTID-03093: Teacher (Feature Discovery Coach). Priority 75 — wins
  // when next-action has nothing and the user has an unexplored
  // capability. Requires the system_capabilities + user_capability_awareness
  // tables; degrades to `suppressed:empty_catalog` when missing.
  if (!defaultProviderRegistry.get(TEACHER_PROVIDER_KEY)) {
    defaultProviderRegistry.register(makeFeatureDiscoveryTeacherProvider());
  }
  // VTID-03164: new-day-return at priority 90. Suppresses cleanly when
  // same-day repeat OR is_first_session=true OR no timezone, so it
  // never blocks the other providers when the trigger does not apply.
  if (!defaultProviderRegistry.get(NEW_DAY_RETURN_PROVIDER_KEY)) {
    defaultProviderRegistry.register(makeNewDayReturnProvider());
  }
  // R6 (BOOTSTRAP-ORB-R6R7-PROVIDERS): first-time-welcome at priority 95.
  // Suppresses unless user_journey.is_first_session=true, so it only wins
  // the ranker on the user's first-ever session and never blocks the
  // returning-user providers otherwise.
  if (!defaultProviderRegistry.get(FIRST_TIME_WELCOME_PROVIDER_KEY)) {
    defaultProviderRegistry.register(makeFirstTimeWelcomeProvider());
  }
  // R7 (BOOTSTRAP-ORB-R6R7-PROVIDERS): goal-completion-inquiry at priority
  // 92. Suppresses unless the active life_compass goal's target_date is in
  // the past (end-of-day UTC), so it only wins when a goal has actually
  // completed and otherwise yields to new-day-return / Teacher / wake-brief.
  if (!defaultProviderRegistry.get(GOAL_COMPLETION_PROVIDER_KEY)) {
    defaultProviderRegistry.register(makeGoalCompletionInquiryProvider());
  }
  // VTID-03257 (Fix-1): journey-guide at priority 91 — for users still on the
  // Journey Foundation (not graduated), the checklist LEADS the conversation
  // (above new_day_return 90 + Teacher 85). Suppresses cleanly when graduated
  // or no next step, so it never blocks the returning-user providers.
  if (!defaultProviderRegistry.get(JOURNEY_GUIDE_PROVIDER_KEY)) {
    defaultProviderRegistry.register(makeJourneyGuideProvider());
  }
  // VTID-03290: guided-topic-narration at priority 96 — leads turn-1 when a
  // catalog topic was tapped. Skips cleanly when no topic was tapped, so it
  // never blocks journey-guide / new-day-return / Teacher on a normal open.
  if (!defaultProviderRegistry.get(GUIDED_TOPIC_NARRATION_PROVIDER_KEY)) {
    defaultProviderRegistry.register(makeGuidedTopicNarrationProvider());
  }
  _registered = true;
}

// Register on import so the orb-live.ts caller doesn't need to remember.
ensureWakeBriefProviderRegistered();

// ---------------------------------------------------------------------------
// Inputs from orb-live.ts session-start. Kept narrow on purpose: these
// are the variables already computed at the wiring point. Adding more
// inputs is a future-slice concern (B1 cadence signals will extend
// GreetingPolicyInput, which flows through here naturally).
// ---------------------------------------------------------------------------

export interface DecideWakeBriefArgs {
  sessionId: string;
  tenantId: string | null;
  userId: string | null;
  /** From `describeTimeSince(session.lastSessionInfo).bucket`. */
  bucket: string;
  /** From describeTimeSince's wasFailure (or `false` for anonymous sessions). */
  wasFailure?: boolean;
  /** From orb-live.ts isReconnectStart (transparent reconnect = skip). */
  isReconnect: boolean;
  /** Resolved language for the session (post-anonymous browser-lang resolve). */
  lang: string;
  /**
   * VTID-03300: the "My Journey" Foundation step the user tapped to open the
   * orb (from the session-start body's `journey_focus_step`). When set and the
   * step is not already done, the journey-guide provider leads with this step
   * instead of the sequentially-computed `current_next_step`.
   */
  journeyFocusStep?: string | null;
  /**
   * VTID-03290: the Guided Journey catalog topic the user tapped to open the orb
   * (from the session-start body's `guided_topic_id`). When set, the
   * guided-topic-narration provider LEADS turn-1 — Vitana teaches that topic from
   * the published KB. Undefined for normal opens.
   */
  guidedTopicId?: string | null;
  /** journeySurface from the ClientContextEnvelope, if any. */
  envelopeJourneySurface?: string;
  /**
   * VTID-03057 (B0d-real slice Xb): supabase service-role client for
   * the Contextual Next Action provider's source queries (reminders,
   * autopilot_recommendations, etc.). When omitted, the next-action
   * provider returns `skipped:no_next_action_inputs` and the framework
   * falls back to voice-wake-brief.
   *
   * Required for B0d-real candidates to fire. Optional in this slice
   * so existing Vertex wiring (which doesn't yet pass it) keeps working
   * with no change.
   */
  supabase?: SupabaseClient;
  /**
   * VTID-03057 (B0d-real slice Xb): full AssistantDecisionContext for
   * sources that read continuity / journey_stage / pillar_momentum
   * (Xd+ sources) without re-querying. Optional — sources gate on
   * presence.
   */
  decisionContext?: unknown;
  /**
   * VTID-03053 — Distilled pillar-momentum view from the compiled
   * AssistantDecisionContext. When passed, the wake-brief renderer may
   * fold it into a proactive observation (one short sentence + one
   * question) for slipping pillars. Enum-only by contract; no raw scores
   * or medical interpretation cross into this arg.
   *
   * Both pipelines have access to this on the bootstrap path — Vertex
   * via session.contextInstruction's compiler run, LiveKit via
   * `/orb/context-bootstrap`'s `compileAssistantDecisionContext` call.
   * Wiring sites pass it; the field stays optional so anonymous sessions
   * (no spine) and provider-disabled tests don't need to mock it.
   */
  pillarMomentum?: import('../orb/context/types').DecisionPillarMomentum | null;
  /**
   * VTID-03081 (B1 wiring): cadence signals from
   * `wake-cadence-signals.fetchWakeCadenceSignals(...)`. When passed
   * through, `decideGreetingPolicy` runs the full B1 layered decision
   * (skip on transparent reconnect, 5-min cross-surface continuation,
   * 15-min greet-once cap, heavy-day dampening, same-style downgrade).
   * When omitted, the policy degrades to the bucket-only truth table
   * (same behavior as before this wiring).
   */
  cadenceSignals?: Partial<GreetingPolicyInput>;
  /**
   * VTID-03081 (B1 wiring): wake_origin (signal #38) from the
   * ClientContextEnvelope. Forwarded into the policy decision so a
   * push_tap nudges fresh_intro → warm_return.
   */
  wakeOrigin?: GreetingPolicyInput['wake_origin'];
  /**
   * VTID-03081 (B1 wiring): when true AND the policy returns a
   * non-skip style, record `last_greeting_at` + `last_greeting_style`
   * to user_assistant_state so the next session can dampen. Fire-and-
   * forget — write failure does NOT block the voice path. Default off
   * for tests; production callers set it true.
   */
  recordEmission?: boolean;
  /**
   * VTID-03093 (Teacher PR 3): user's first name (when known) so the
   * Teacher greeting clause can address them by name. Pulled from
   * identity_facts at the caller side. Anonymous sessions pass null /
   * absent and the Teacher's pool falls back to no-name phrases.
   */
  firstName?: string | null;
  /**
   * VTID-03164: IANA timezone string (e.g. 'Europe/Berlin') from the
   * session's clientContext.timezone. Required for the new-day-return
   * provider to detect "first session of a new calendar day in user TZ"
   * — without it the provider suppresses. Missing for anonymous /
   * legacy sessions; those just lose the new-day-return greeting and
   * fall back to wake-brief, same as before this slice.
   */
  timezone?: string | null;
}

// ---------------------------------------------------------------------------
// Main wiring entry point.
// ---------------------------------------------------------------------------

export interface DecideWakeBriefOptions {
  /** Injected for tests. Production uses module-level singletons. */
  recorder?: typeof defaultWakeTimelineRecorder;
  /** Injected for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Run the wake-brief decision for the given session-start. Returns the
 * full `AssistantContinuationDecision` carrier so the caller can attach
 * it to the response + session for downstream observability.
 *
 * The 3 wake-timeline events fire from inside this function:
 *   - continuation_decision_started (carries surface + lang + bucket)
 *   - wake_brief_selected           (carries the chosen kind OR none_with_reason)
 *   - continuation_decision_finished (carries decisionId + duration)
 *
 * Best-effort: timeline emission never throws upward. The decision
 * itself always succeeds — providers errors flow through as
 * `status: 'errored'` rows on the decision carrier.
 */
export async function decideWakeBriefForSession(
  args: DecideWakeBriefArgs,
  opts: DecideWakeBriefOptions = {},
): Promise<AssistantContinuationDecision> {
  const recorder = opts.recorder ?? defaultWakeTimelineRecorder;
  const now = opts.now ?? (() => Date.now());

  // VTID-03081 (B1 wiring): merge cadence signals into the input. Order
  // matters — the caller-supplied `cadenceSignals` (fetched from
  // user_assistant_state) cannot override the safety fields below.
  const greetingPolicyInput: GreetingPolicyInput = {
    ...(args.cadenceSignals ?? {}),
    bucket: args.bucket,
    isReconnect: args.isReconnect,
    wasFailure: args.wasFailure ?? false,
    wake_origin: args.wakeOrigin ?? args.cadenceSignals?.wake_origin,
    is_transparent_reconnect:
      args.cadenceSignals?.is_transparent_reconnect ?? args.isReconnect,
  };
  const greetingDecision = decideGreetingPolicyWithEvidence(greetingPolicyInput);
  const greetingPolicy = greetingDecision.policy;

  const wakeBriefInputs: VoiceWakeBriefInputs = {
    greetingPolicy,
    lang: args.lang,
    // VTID-03053: forward pillar momentum for proactive opener variants.
    // When null/missing the renderer falls back to the generic
    // policy-keyed line — same behavior as before this slice.
    pillarMomentum: args.pillarMomentum ?? null,
  };

  safeRecord(recorder, args.sessionId, 'continuation_decision_started', {
    surface: 'orb_wake',
    bucket: args.bucket,
    isReconnect: args.isReconnect,
    greetingPolicy,
    lang: args.lang,
    // VTID-03081: which B1 signals participated in the decision +
    // which were missing. Lands on the wake-timeline so the Command
    // Hub Inspector can show "policy=skip because greeted_recently"
    // instead of just "policy=skip".
    greeting_policy_reason: greetingDecision.reason,
    greeting_policy_signals_present: greetingDecision.signalsPresent,
    greeting_policy_signals_missing: greetingDecision.signalsMissing,
    greeting_policy_evidence: greetingDecision.evidence,
    greeting_policy_fell_back_to_bucket: greetingDecision.fellBackToBucket,
  });

  // VTID-03057 (B0d-real Xb): build the next-action extras when the
  // caller supplied a Supabase client. Without it the Contextual Next
  // Action provider returns skipped:no_next_action_inputs and the
  // framework falls back to voice-wake-brief — same as before this slice.
  const extra: Record<string, unknown> = {
    [VOICE_WAKE_BRIEF_EXTRA_KEY]: wakeBriefInputs,
  };
  if (args.supabase) {
    // VTID-03073: forward `lang` so next-action sources render in the
    // user's language. Before this fix the next-action provider always
    // received the default 'en' — every source rendered English to
    // German users since slice Xb. The bug was invisible until the
    // match source's fallback label collided with its own sentence
    // template ("fresh match match"), making the English line stick
    // out next to an otherwise German conversation.
    extra[NEXT_ACTION_EXTRA_KEY] = {
      supabase: args.supabase,
      decisionContext: args.decisionContext ?? null,
      lang: args.lang,
    };
    // VTID-03093 (Teacher PR 3): forward Teacher inputs when identity is
    // known. Anonymous sessions are skipped at the provider level.
    if (args.tenantId && args.userId) {
      extra[TEACHER_EXTRA_KEY] = {
        supabase: args.supabase,
        tenantId: args.tenantId,
        userId: args.userId,
        lang: args.lang,
        firstName: args.firstName ?? null,
        greetingPolicy,
        // VTID-03108 (Item 2): forward the explicit skip reason so the
        // Teacher can distinguish isReconnect-class forced skips
        // (suppress) from cadence-class skips (still fire — different
        // capability via per-capability dedupe).
        skipReason: greetingDecision.reason,
      };
      // VTID-03164: forward new-day-return inputs. Provider suppresses
      // unless trigger conditions hold (new calendar day in user TZ AND
      // is_first_session=false AND timezone present), so passing the
      // extra always is safe.
      extra[NEW_DAY_RETURN_EXTRA_KEY] = {
        supabase: args.supabase,
        tenantId: args.tenantId,
        userId: args.userId,
        lang: args.lang,
        firstName: args.firstName ?? null,
        timezone: args.timezone ?? null,
      };
      // R6 (BOOTSTRAP-ORB-R6R7-PROVIDERS): first-time-welcome inputs.
      // Provider suppresses unless is_first_session=true, so passing the
      // extra always is safe.
      extra[FIRST_TIME_WELCOME_EXTRA_KEY] = {
        supabase: args.supabase,
        tenantId: args.tenantId,
        userId: args.userId,
        lang: args.lang,
        firstName: args.firstName ?? null,
      };
      // R7 (BOOTSTRAP-ORB-R6R7-PROVIDERS): goal-completion-inquiry inputs.
      // Provider suppresses unless the active goal's target_date is past,
      // so passing the extra always is safe.
      extra[GOAL_COMPLETION_EXTRA_KEY] = {
        supabase: args.supabase,
        tenantId: args.tenantId,
        userId: args.userId,
        lang: args.lang,
        firstName: args.firstName ?? null,
      };
      // VTID-03257 (Fix-1): journey-guide inputs. Provider suppresses when the
      // user has graduated the Foundation or has no next step, so passing the
      // extra always is safe — when active it LEADS (priority 91).
      extra[JOURNEY_GUIDE_EXTRA_KEY] = {
        supabase: args.supabase,
        userId: args.userId,
        isReconnect: args.isReconnect,
        lang: args.lang,
        // VTID-03300: when the user tapped a specific Foundation step in "My
        // Journey", lead with THAT step instead of the computed next step.
        focusStep: args.journeyFocusStep ?? null,
        // VTID-03300 (follow-up): greet by name in the journey opener.
        firstName: args.firstName ?? null,
      };
      // VTID-03290: guided-topic-narration inputs. The provider skips unless a
      // catalog topic was tapped (guidedTopicId set), so passing the extra always
      // is safe — when active it LEADS turn-1 (priority 96) and teaches the topic.
      extra[GUIDED_TOPIC_NARRATION_EXTRA_KEY] = {
        supabase: args.supabase,
        userId: args.userId,
        isReconnect: args.isReconnect,
        lang: args.lang,
        topicId: args.guidedTopicId ?? null,
        firstName: args.firstName ?? null,
      };
    }
  }

  // VTID-03301 — load the openers this user was recently served so the ranker
  // can rotate. Most-recent first. Best-effort: a read failure just means no
  // penalty (old behaviour). Authenticated users only (anonymous have no state).
  //
  // Codex review fix: rotation applies ONLY to PASSIVE/ambient opens. When the
  // user EXPLICITLY tapped a Guided Journey topic (`guidedTopicId`) or a
  // Foundation focus step (`journeyFocusStep`), that is a direct user action
  // that MUST lead turn 1 — demoting it would open the wrong conversation than
  // the one the user just asked for. So we skip rotation entirely on explicit
  // opens and honor the tapped candidate at its true priority.
  const isExplicitSelection = !!(args.guidedTopicId || args.journeyFocusStep);
  let storedRecentOpeners: string[] = [];
  if (args.supabase && args.userId) {
    try {
      const rec = await readOrbSessionState<string[]>(args.supabase, args.userId, 'recent_openers');
      if (rec && Array.isArray(rec.value)) {
        storedRecentOpeners = rec.value.filter((k) => typeof k === 'string').slice(0, RECENT_OPENERS_WINDOW);
      }
    } catch { /* best-effort — no penalty on read failure */ }
  }
  // Withhold the rotation penalty from the ranker on explicit opens (the tapped
  // candidate must lead), but keep `storedRecentOpeners` so the write below
  // still merges onto the real history instead of wiping it.
  const recentlyServedDedupeKeys: string[] = isExplicitSelection ? [] : storedRecentOpeners;

  const t0 = now();
  const decision = await decideContinuation({
    surface: 'orb_wake',
    recentlyServedDedupeKeys,
    context: {
      sessionId: args.sessionId,
      userId: args.userId ?? undefined,
      tenantId: args.tenantId ?? undefined,
      envelopeJourneySurface: args.envelopeJourneySurface,
      extra,
    },
  });

  // wake_brief_selected — fires once per wake. Carries either the
  // selected kind OR none_with_reason. B0d.3's aggregator reads
  // `selected_continuation_kind` + `none_with_reason` from this event.
  const selectedKind = decision.selectedContinuation?.kind ?? 'none_with_reason';
  const noneWithReason =
    decision.selectedContinuation === null ? decision.suppressionReason : undefined;
  safeRecord(recorder, args.sessionId, 'wake_brief_selected', {
    decisionId: decision.decisionId,
    selected_continuation_kind: selectedKind,
    ...(noneWithReason ? { none_with_reason: noneWithReason } : {}),
  });

  safeRecord(recorder, args.sessionId, 'continuation_decision_finished', {
    decisionId: decision.decisionId,
    durationMs: Math.max(0, now() - t0),
    providerResults: decision.sourceProviderResults.map((r) => ({
      key: r.providerKey,
      status: r.status,
      latencyMs: r.latencyMs,
      reason: r.reason,
    })),
  });

  // VTID-03061 (B0d-real Xf.1): fire-and-forget OASIS emit for the
  // Contextual Next Action lifecycle. Only emits when the decision
  // actually involved a B0d-real candidate (suggested) OR the
  // contextual_next_action provider returned a non-`returned` status
  // (suppressed). Wake-brief-only decisions don't emit here — those
  // are tracked by the existing wake_brief_selected timeline event.
  emitNextActionDecisionTelemetry({
    decision,
    userId: args.userId,
    tenantId: args.tenantId,
    surface: 'orb_wake',
  });

  // VTID-03301 — persist the opener we just served so the NEXT session rotates
  // away from it. Most-recent first, capped to the window. Only on a real
  // emission (recordEmission) with an authenticated user + a selected opener.
  if (args.recordEmission && args.supabase && args.userId && decision.selectedContinuation?.dedupeKey) {
    const servedKey = decision.selectedContinuation.dedupeKey;
    const nextList = [servedKey, ...storedRecentOpeners.filter((k) => k !== servedKey)]
      .slice(0, RECENT_OPENERS_WINDOW);
    void import('./orb/orb-session-state')
      .then(({ writeOrbSessionState }) =>
        writeOrbSessionState(args.supabase!, args.userId!, 'recent_openers', nextList, RECENT_OPENERS_TTL_MIN),
      )
      .catch(() => { /* best-effort — rotation degrades gracefully */ });
  }

  // VTID-03081 (B1 wiring): record greeting style + timestamp so the
  // next session can dampen. Fire-and-forget — write failure is
  // logged but never propagates. Only records when:
  //   - the policy decided a non-skip greeting will actually emit
  //   - tenant + user are known (anonymous sessions don't persist)
  //   - a supabase client is available
  //   - the caller explicitly asked for recording (production yes,
  //     tests no by default)
  if (
    args.recordEmission &&
    args.supabase &&
    args.tenantId &&
    args.userId &&
    greetingPolicy !== 'skip'
  ) {
    void recordWakeBriefEmitted({
      supabase: args.supabase,
      tenantId: args.tenantId,
      userId: args.userId,
      style: greetingPolicy,
    }).then((res) => {
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.warn(
          `[VTID-03081] recordWakeBriefEmitted failed (non-fatal): ${res.reason}`,
        );
      }
    });
  }

  // DEV-COMHU-0505 (review fix): persist the selected continuation's executable
  // pending CTA so a later "yes" resolves deterministically. The wake path only
  // injects userFacingLine into the model prompt, dropping CTA metadata — so on
  // its own onYesTool would never reach a runtime consumer. Writing it to
  // orb_session_state ('pending_cta', 5-min TTL) lets the turn handler / tool
  // layer read the exact tool + payload when the user accepts, instead of the
  // model guessing. Fire-and-forget; authed sessions only.
  {
    const sel = decision.selectedContinuation;
    const selCta = sel?.cta;
    if (
      args.supabase &&
      args.userId &&
      selCta &&
      selCta.type === 'ask_permission' &&
      typeof (selCta as { onYesTool?: unknown }).onYesTool === 'string'
    ) {
      const onYesTool = (selCta as { onYesTool: string }).onYesTool;
      const ctaPayload = (selCta as { payload?: Record<string, unknown> }).payload ?? {};
      void import('./orb/orb-session-state')
        .then(({ writeOrbSessionState }) =>
          writeOrbSessionState(
            args.supabase!,
            args.userId!,
            'pending_cta',
            { tool: onYesTool, payload: ctaPayload, offered_at: new Date().toISOString() },
            5, // minutes — the offer is only live for the immediate follow-up
          ),
        )
        .catch(() => { /* pending-CTA persistence is best-effort */ });
    }
  }

  return decision;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeRecord(
  recorder: typeof defaultWakeTimelineRecorder,
  sessionId: string,
  name: Parameters<typeof defaultWakeTimelineRecorder.recordEvent>[0]['name'],
  metadata: Record<string, unknown>,
): void {
  try {
    recorder.recordEvent({ sessionId, name, metadata });
  } catch {
    // never block the wake path on telemetry
  }
}
