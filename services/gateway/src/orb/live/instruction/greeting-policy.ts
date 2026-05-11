/**
 * A4 (orb-live-refactor): greeting decision policy seam.
 *
 * Stub policy module — establishes the typed contract that B1 (Session
 * Cadence & Greeting Decay) will fill in with real signals, and that B0d
 * (Continuation Contract) will wrap as the wake-brief provider.
 *
 * Today's greeting logic lives inline inside
 * `services/gateway/src/orb/live/instruction/live-system-instruction.ts`
 * via `buildTemporalJourneyContextSection`'s bucket switch
 * (reconnect / recent / same_day / today / yesterday / week / long / first).
 *
 * This file does NOT yet replace that inline logic — A4 is a stub seam:
 *   - Defines `GreetingPolicy` (the typed return value).
 *   - Defines `GreetingPolicyInput` (the typed input shape).
 *   - Exports `decideGreetingPolicy()` that maps the current bucket to a
 *     conservative default policy.
 *
 * **Why it lives here before B1:** the plan requires every greeting
 * decision to flow through ONE chokepoint (`greeting-policy.ts`) — without
 * this seam, B1's signal-rich inputs would have to plumb through the
 * 600-line `buildLiveSystemInstruction`. A4 establishes the boundary;
 * B1 wires its signals in; B0d wraps the output as a wake-brief candidate.
 *
 * Wire-up plan:
 *   - B1 — replace the inline bucket switch in
 *     `buildTemporalJourneyContextSection` with a call to this function
 *     and render the policy choice as the appropriate prompt section.
 *   - B0d — call this function from `decide-continuation.ts` to pick the
 *     wake-brief greeting style.
 */

/**
 * The four greeting decisions Vitana can take at session start.
 *
 *   skip          — say nothing (transparent reconnect within 5 min,
 *                   visibility blip, sister-tab handoff).
 *   brief_resume  — ONE short phrase, no name, no introduction.
 *                   (recent: 2–15 min since last session.)
 *   warm_return   — short greeting + optional one-line follow-up.
 *                   (same_day, today: 15min–24h since last session.)
 *   fresh_intro   — full new-day greeting "Good <part>, [Name]." +
 *                   optionally one follow-up question.
 *                   (yesterday/week/long, or first ever session.)
 */
export type GreetingPolicy = 'skip' | 'brief_resume' | 'warm_return' | 'fresh_intro';

/**
 * Inputs to the greeting decision.
 *
 * Today (A4 stub) only `bucket` and `isReconnect` are consumed — they
 * map directly to the current inline logic in
 * `buildTemporalJourneyContextSection`.
 *
 * B1 will extend this shape with the session-cadence signals (signals
 * 33–39 in the plan: `seconds_since_last_turn_anywhere`,
 * `sessions_today_count`, `is_transparent_reconnect`,
 * `time_since_last_greeting_today`, `greeting_style_last_used`,
 * `wake_origin`, `device_handoff_signal`). The shape is intentionally
 * open here so B1 can add fields without breaking callers.
 */
export interface GreetingPolicyInput {
  /**
   * The temporal bucket as computed today by `describeTimeSince()` —
   * one of `'reconnect' | 'recent' | 'same_day' | 'today' | 'yesterday'
   * | 'week' | 'long' | 'first'`.
   */
  bucket: string;

  /**
   * Whether the current session-start is a transparent server-side
   * reconnect (Vertex 5-min Live API limit, network blip, stall
   * recovery). When `true`, the user did NOT perceive any pause — the
   * policy must collapse to `'skip'` to avoid the apology-loop bug
   * (VTID-02637).
   */
  isReconnect?: boolean;

  /**
   * Whether the previous session ended with `wasFailure=true` (no audio
   * delivered, turn_count=0, etc.). Affects the `'recent'` bucket: a
   * recent retry after a failed session deserves a warm acknowledgement
   * instead of a silent brief-resume.
   */
  wasFailure?: boolean;
}

/**
 * Map the temporal bucket + reconnect flag to a greeting policy.
 *
 * This is the **stub** version — it preserves today's inline behavior
 * exactly. B1 (Slice — Session Cadence & Greeting Decay) replaces it
 * with the signal-driven decision that respects:
 *   - `seconds_since_last_turn_anywhere` (cross-device, cross-surface)
 *   - `is_transparent_reconnect` (the iOS-visibility-blip case)
 *   - `greeting_style_last_used` (avoid same opener twice in a row)
 *   - daily proactive cap (presence-pacer accounting)
 *
 * Today's truth table (mirrors `buildTemporalJourneyContextSection`):
 *
 *   isReconnect=true              → skip            (VTID-02637)
 *   bucket=reconnect              → skip
 *   bucket=recent + wasFailure    → warm_return     (apology override)
 *   bucket=recent                 → brief_resume
 *   bucket=same_day               → brief_resume
 *   bucket=today                  → warm_return
 *   bucket=yesterday | week       → warm_return
 *   bucket=long                   → fresh_intro
 *   bucket=first                  → fresh_intro     (no telemetry)
 *   any other                     → fresh_intro     (conservative default)
 */
export function decideGreetingPolicy(input: GreetingPolicyInput): GreetingPolicy {
  // Reconnect overrides everything — the user did not perceive any pause.
  if (input.isReconnect === true) {
    return 'skip';
  }

  switch (input.bucket) {
    case 'reconnect':
      return 'skip';

    case 'recent':
      // VTID-02637: a true new session 2-15min after a FAILED session
      // deserves an apology-warm-return, not a silent brief-resume.
      return input.wasFailure === true ? 'warm_return' : 'brief_resume';

    case 'same_day':
      return 'brief_resume';

    case 'today':
    case 'yesterday':
    case 'week':
      return 'warm_return';

    case 'long':
    case 'first':
      // 'first' here is "no telemetry found", treated as returning user
      // with unknown recency. The new-day greeting is the safe default.
      return 'fresh_intro';

    default:
      // Unknown bucket — conservative default is the full intro shape.
      return 'fresh_intro';
  }
}
