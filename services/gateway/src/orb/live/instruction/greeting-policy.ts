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

  // ─────────────────────────────────────────────────────────────────
  // B1 (VTID-02930): cadence + repetition signals (33–39).
  // All optional — when absent, the policy degrades to the A4 truth
  // table. None of these touch transport, audio, reconnect, or Live
  // API behavior. Pure read-side signals.
  // ─────────────────────────────────────────────────────────────────

  /** Signal #33: cross-device, cross-surface continuity. */
  seconds_since_last_turn_anywhere?: number;
  /** Signal #34: how many sessions the user has had today (UTC). */
  sessions_today_count?: number;
  /**
   * Signal #35: orthogonal to `isReconnect` but more precise. Set when
   * the gateway can prove the resume is server-side transparent (the
   * 5-min Vertex limit, an iOS visibility blip, etc.). Always collapses
   * to `skip`.
   */
  is_transparent_reconnect?: boolean;
  /** Signal #36: ms since the last greeting we emitted today. */
  time_since_last_greeting_today_ms?: number;
  /** Signal #37: last greeting style emitted (any value of `GreetingPolicy`). */
  greeting_style_last_used?: GreetingPolicy;
  /**
   * Signal #38: how this session was activated.
   *   `orb_tap`            — user pressed the orb button.
   *   `wake_word`          — wake-word triggered.
   *   `push_tap`           — notification deep-link.
   *   `proactive_opener`   — Vitana-initiated.
   *   `deep_link`          — landed on a route that auto-opens orb.
   *   `unknown`            — envelope didn't say.
   */
  wake_origin?:
    | 'orb_tap'
    | 'wake_word'
    | 'push_tap'
    | 'proactive_opener'
    | 'deep_link'
    | 'unknown';
  /**
   * Signal #39: device handoff signal — `true` when the gateway can
   * prove this session is the same user continuing on a new device
   * within a short window.
   */
  device_handoff_signal?: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// B1: typed decision carrier with reason + evidence + signals used.
// `decideGreetingPolicy()` stays backwards-compatible (returns the
// string union); `decideGreetingPolicyWithEvidence()` is the new
// caller-facing surface for richer consumers (the Command Hub panel
// + tests + future telemetry).
// ─────────────────────────────────────────────────────────────────────

export interface GreetingPolicyEvidence {
  signal: string;
  value: string | number | boolean | null;
  influence: 'forced' | 'dampened' | 'preferred' | 'ignored';
}

export interface GreetingPolicyDecision {
  /** The policy decision. */
  policy: GreetingPolicy;
  /** Short reason code — stable string for telemetry + tests. */
  reason: string;
  /** Per-signal evidence list (which signals participated in the decision). */
  evidence: GreetingPolicyEvidence[];
  /** Names of signals present in the input (source-health view). */
  signalsPresent: string[];
  /** Names of signals absent from the input (source-health view). */
  signalsMissing: string[];
  /** True when the decision falls back to the A4 bucket-only truth table. */
  fellBackToBucket: boolean;
}

/**
 * Thresholds for cadence decay. Pulled out as constants so future tuning
 * (R-track, evidence-backed) has one place to land.
 */
const TURN_CONTINUITY_WINDOW_MS = 5 * 60 * 1000;          // 5 min cross-surface continuation
const RECENT_GREETING_WINDOW_MS = 15 * 60 * 1000;         // 15 min greet-once cap
const HEAVY_DAY_THRESHOLD = 3;                             // sessions today before we soften
const ALL_SIGNAL_KEYS = [
  'seconds_since_last_turn_anywhere',
  'sessions_today_count',
  'is_transparent_reconnect',
  'time_since_last_greeting_today_ms',
  'greeting_style_last_used',
  'wake_origin',
  'device_handoff_signal',
] as const;

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
  return decideGreetingPolicyWithEvidence(input).policy;
}

/**
 * B1 (VTID-02930): full greeting-policy decision with evidence.
 *
 * Layered decision (top wins):
 *   1. `is_transparent_reconnect` or `isReconnect`      → skip (forced)
 *   2. `bucket === 'reconnect'`                          → skip (forced)
 *   3. `seconds_since_last_turn_anywhere` < 5min         → skip (cross-surface continuation)
 *   4. `time_since_last_greeting_today_ms` < 15min       → skip (greet-once-per-window cap)
 *   5. `device_handoff_signal === true`                  → brief_resume (cross-device pickup)
 *   6. A4 bucket-based default (unchanged)
 *   7. Decay layer on top of the bucket result:
 *      - same `greeting_style_last_used` twice in a row → downgrade one tier
 *      - `sessions_today_count >= 3`                    → cap intensity at brief_resume
 *      - `wake_origin === 'push_tap'`                   → prefer warm_return over fresh_intro
 *        (push-tap implies user just acted on a notification — fresh_intro feels strange)
 *
 * Pure function. No DB, no IO, no clock — everything is read from the
 * input. Out-of-range values (negative numbers, unknown strings) degrade
 * to "ignore this signal" rather than throwing.
 */
export function decideGreetingPolicyWithEvidence(
  input: GreetingPolicyInput,
): GreetingPolicyDecision {
  const evidence: GreetingPolicyEvidence[] = [];
  const signalsPresent = signalsPresentIn(input);
  const signalsMissing = ALL_SIGNAL_KEYS.filter((k) => !signalsPresent.includes(k));
  let fellBackToBucket = false;

  // ---- Forced skips (safety overrides) ----
  if (input.isReconnect === true) {
    return finalize('skip', 'isReconnect_forces_skip', evidenceFor(evidence, 'isReconnect', true, 'forced'), signalsPresent, signalsMissing, false);
  }
  if (input.is_transparent_reconnect === true) {
    return finalize('skip', 'transparent_reconnect_forces_skip',
      evidenceFor(evidence, 'is_transparent_reconnect', true, 'forced'),
      signalsPresent, signalsMissing, false);
  }
  if (input.bucket === 'reconnect') {
    return finalize('skip', 'bucket_reconnect_forces_skip',
      evidenceFor(evidence, 'bucket', input.bucket, 'forced'),
      signalsPresent, signalsMissing, false);
  }

  // ---- Cross-surface continuation (signal #33) ----
  if (
    typeof input.seconds_since_last_turn_anywhere === 'number' &&
    Number.isFinite(input.seconds_since_last_turn_anywhere) &&
    input.seconds_since_last_turn_anywhere >= 0 &&
    input.seconds_since_last_turn_anywhere * 1000 < TURN_CONTINUITY_WINDOW_MS
  ) {
    return finalize(
      'skip',
      'recent_turn_continues_thread',
      evidenceFor(evidence, 'seconds_since_last_turn_anywhere', input.seconds_since_last_turn_anywhere, 'forced'),
      signalsPresent,
      signalsMissing,
      false,
    );
  }

  // ---- Greet-once-per-window cap (signal #36) ----
  if (
    typeof input.time_since_last_greeting_today_ms === 'number' &&
    Number.isFinite(input.time_since_last_greeting_today_ms) &&
    input.time_since_last_greeting_today_ms >= 0 &&
    input.time_since_last_greeting_today_ms < RECENT_GREETING_WINDOW_MS
  ) {
    return finalize(
      'skip',
      'greeted_recently_within_window',
      evidenceFor(evidence, 'time_since_last_greeting_today_ms', input.time_since_last_greeting_today_ms, 'forced'),
      signalsPresent,
      signalsMissing,
      false,
    );
  }

  // ---- Device handoff (signal #39) ----
  if (input.device_handoff_signal === true) {
    return finalize(
      'brief_resume',
      'device_handoff_continues_thread',
      evidenceFor(evidence, 'device_handoff_signal', true, 'forced'),
      signalsPresent,
      signalsMissing,
      false,
    );
  }

  // ---- A4 bucket-based default ----
  let policy: GreetingPolicy = bucketDefault(input);
  fellBackToBucket = true;
  evidenceFor(evidence, 'bucket', input.bucket, 'preferred');
  if (input.wasFailure === true && input.bucket === 'recent') {
    evidenceFor(evidence, 'wasFailure', true, 'preferred');
  }

  // ---- Decay layer ----

  // wake_origin: push_tap → user JUST acted on a notification.
  // fresh_intro is too cold; nudge to warm_return.
  if (input.wake_origin === 'push_tap' && policy === 'fresh_intro') {
    policy = 'warm_return';
    evidenceFor(evidence, 'wake_origin', input.wake_origin, 'preferred');
  } else if (input.wake_origin) {
    evidenceFor(evidence, 'wake_origin', input.wake_origin, 'ignored');
  }

  // Heavy day: 3+ sessions today softens intensity.
  if (
    typeof input.sessions_today_count === 'number' &&
    Number.isFinite(input.sessions_today_count) &&
    input.sessions_today_count >= HEAVY_DAY_THRESHOLD
  ) {
    if (policy === 'fresh_intro' || policy === 'warm_return') {
      policy = 'brief_resume';
      evidenceFor(evidence, 'sessions_today_count', input.sessions_today_count, 'dampened');
    } else {
      evidenceFor(evidence, 'sessions_today_count', input.sessions_today_count, 'ignored');
    }
  } else if (typeof input.sessions_today_count === 'number') {
    evidenceFor(evidence, 'sessions_today_count', input.sessions_today_count, 'ignored');
  }

  // Style avoidance: same style twice in a row → downgrade one tier.
  if (input.greeting_style_last_used && input.greeting_style_last_used === policy) {
    const downgraded = downgradeTier(policy);
    if (downgraded !== policy) {
      policy = downgraded;
      evidenceFor(evidence, 'greeting_style_last_used', input.greeting_style_last_used, 'dampened');
    } else {
      evidenceFor(evidence, 'greeting_style_last_used', input.greeting_style_last_used, 'ignored');
    }
  } else if (input.greeting_style_last_used) {
    evidenceFor(evidence, 'greeting_style_last_used', input.greeting_style_last_used, 'ignored');
  }

  return finalize(policy, 'bucket_with_decay_layer', evidence, signalsPresent, signalsMissing, fellBackToBucket);
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function bucketDefault(input: GreetingPolicyInput): GreetingPolicy {
  switch (input.bucket) {
    case 'recent':
      return input.wasFailure === true ? 'warm_return' : 'brief_resume';
    case 'same_day':
      return 'brief_resume';
    case 'today':
    case 'yesterday':
    case 'week':
      return 'warm_return';
    case 'long':
    case 'first':
      return 'fresh_intro';
    default:
      return 'fresh_intro';
  }
}

/**
 * Downgrade one tier toward `skip` for style-decay. The tiers are:
 *   fresh_intro > warm_return > brief_resume > skip
 * `skip` cannot be downgraded further; we keep `skip` rather than
 * silently flip to a louder greeting.
 */
function downgradeTier(p: GreetingPolicy): GreetingPolicy {
  if (p === 'fresh_intro') return 'warm_return';
  if (p === 'warm_return') return 'brief_resume';
  if (p === 'brief_resume') return 'skip';
  return p; // skip
}

function signalsPresentIn(input: GreetingPolicyInput): string[] {
  const present: string[] = [];
  if (input.seconds_since_last_turn_anywhere !== undefined) present.push('seconds_since_last_turn_anywhere');
  if (input.sessions_today_count !== undefined) present.push('sessions_today_count');
  if (input.is_transparent_reconnect !== undefined) present.push('is_transparent_reconnect');
  if (input.time_since_last_greeting_today_ms !== undefined) present.push('time_since_last_greeting_today_ms');
  if (input.greeting_style_last_used !== undefined) present.push('greeting_style_last_used');
  if (input.wake_origin !== undefined) present.push('wake_origin');
  if (input.device_handoff_signal !== undefined) present.push('device_handoff_signal');
  return present;
}

function evidenceFor(
  evidence: GreetingPolicyEvidence[],
  signal: string,
  value: string | number | boolean | null,
  influence: GreetingPolicyEvidence['influence'],
): GreetingPolicyEvidence[] {
  evidence.push({ signal, value, influence });
  return evidence;
}

function finalize(
  policy: GreetingPolicy,
  reason: string,
  evidence: GreetingPolicyEvidence[],
  signalsPresent: string[],
  signalsMissing: string[],
  fellBackToBucket: boolean,
): GreetingPolicyDecision {
  return { policy, reason, evidence, signalsPresent, signalsMissing, fellBackToBucket };
}
