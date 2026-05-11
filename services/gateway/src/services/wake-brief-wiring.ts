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
import { decideGreetingPolicy } from '../orb/live/instruction/greeting-policy';
import { defaultWakeTimelineRecorder } from './wake-timeline/wake-timeline-recorder';
import type { AssistantContinuationDecision } from './assistant-continuation/types';

// ---------------------------------------------------------------------------
// One-time provider registration. The default registry started empty in
// B0d.1 by design; B0d.2+ providers register here. Idempotent so
// re-imports during hot-reload don't throw the "duplicate key" error.
// ---------------------------------------------------------------------------

let _registered = false;
export function ensureWakeBriefProviderRegistered(): void {
  if (_registered) return;
  if (defaultProviderRegistry.get(VOICE_WAKE_BRIEF_PROVIDER_KEY)) {
    _registered = true;
    return;
  }
  defaultProviderRegistry.register(makeVoiceWakeBriefProvider());
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
  /** journeySurface from the ClientContextEnvelope, if any. */
  envelopeJourneySurface?: string;
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

  const greetingPolicy = decideGreetingPolicy({
    bucket: args.bucket,
    isReconnect: args.isReconnect,
    wasFailure: args.wasFailure ?? false,
  });

  const wakeBriefInputs: VoiceWakeBriefInputs = {
    greetingPolicy,
    lang: args.lang,
  };

  safeRecord(recorder, args.sessionId, 'continuation_decision_started', {
    surface: 'orb_wake',
    bucket: args.bucket,
    isReconnect: args.isReconnect,
    greetingPolicy,
    lang: args.lang,
  });

  const t0 = now();
  const decision = await decideContinuation({
    surface: 'orb_wake',
    context: {
      sessionId: args.sessionId,
      userId: args.userId ?? undefined,
      tenantId: args.tenantId ?? undefined,
      envelopeJourneySurface: args.envelopeJourneySurface,
      extra: { [VOICE_WAKE_BRIEF_EXTRA_KEY]: wakeBriefInputs },
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
