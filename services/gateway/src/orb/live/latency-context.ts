/**
 * VTID-04542 — ORB voice latency, measurement only (P0).
 *
 * Small, pure helpers that feed `voice.latency.measured` without touching
 * anything the model receives. Every helper here is telemetry: none of them
 * is awaited on the voice path and none of them may throw into it (the
 * session-facing ones swallow their own errors).
 *
 *   - deriveLatencyEntry          where the tap came from (mobile / desktop /
 *                                 command_hub), from Origin/Referer + UA.
 *   - resolveLatencyProviderLabel the provider/model string for the event —
 *                                 the old code labelled every non-Nova
 *                                 session `vertex/…`, cascade included.
 *   - SessionStartTimer           step timing of POST /live/session/start.
 *   - startWaitProbe              "did this bounded wait time out?" without
 *                                 rewriting the Promise.race it measures.
 *   - attachEstablishLatencyContext / prepareEstablishLatencyFinalize /
 *     markGreetingDispatched     the turn-0 tracker wiring, one place for
 *                                 both transports.
 */

import { NOVA_SONIC_MODEL_ID } from './upstream/nova-sonic-config';
import { VERTEX_LIVE_MODEL } from './protocol';
import { evaluateCascadeEligibility } from './upstream/cascaded-config';
import type { LatencyTracker, SessionStartTiming, SessionStartStep } from './latency-tracker';

// ---------------------------------------------------------------------------
// Entry derivation
// ---------------------------------------------------------------------------

export type LatencyEntry = 'mobile' | 'desktop' | 'command_hub';

/** Same families the frontend's own mobile checks recognise. */
const MOBILE_UA_RE = /Mobi|Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile/i;

/**
 * Where the voice session was opened from.
 *   - Origin (or Referer when Origin is absent) containing `gateway` → the
 *     Command Hub, which is served by the gateway host itself.
 *   - Otherwise a mobile User-Agent → `mobile`.
 *   - Otherwise `desktop`.
 * Pure; never throws.
 */
export function deriveLatencyEntry(input: {
  origin?: string | null;
  referer?: string | null;
  userAgent?: string | null;
}): LatencyEntry {
  const origin = String(input.origin || input.referer || '').toLowerCase();
  if (origin.includes('gateway')) return 'command_hub';
  const ua = String(input.userAgent || '');
  if (MOBILE_UA_RE.test(ua)) return 'mobile';
  return 'desktop';
}

// ---------------------------------------------------------------------------
// Provider label
// ---------------------------------------------------------------------------

/**
 * The `provider` string written on voice.latency.measured, from the
 * provider that actually carries the session:
 *   - nova_sonic → `nova_sonic/<model id>`
 *   - cascaded   → `cascade/<tts backend>` (polly | fish | unknown), from the
 *                  same eligibility rule that picked the cascade.
 *   - vertex     → `vertex/<live model>` — only when the session really is
 *                  on Vertex (the Serbian bridge).
 *   - livekit    → `livekit`
 *   - unset      → `unknown` (never a guessed `vertex/…`).
 */
export function resolveLatencyProviderLabel(input: {
  upstreamProvider?: string | null;
  lang?: string | null;
}): string {
  switch (input.upstreamProvider) {
    case 'nova_sonic':
      return `nova_sonic/${NOVA_SONIC_MODEL_ID}`;
    case 'cascaded': {
      let tts: string | null = null;
      try {
        tts = evaluateCascadeEligibility(input.lang ?? null).ttsProvider;
      } catch {
        tts = null;
      }
      return `cascade/${tts ?? 'unknown'}`;
    }
    case 'vertex':
      return `vertex/${VERTEX_LIVE_MODEL}`;
    case 'livekit':
      return 'livekit';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Session-start step timing
// ---------------------------------------------------------------------------

/**
 * Records the wall-clock cost of the major steps inside
 * handleLiveSessionStart. Usage:
 *
 *   const t = new SessionStartTimer();
 *   const q0 = Date.now(); await quotaGate(); t.step('quota_gate', q0);
 *   …
 *   session.sessionStartTiming = t.finish();
 */
export class SessionStartTimer {
  readonly startedAtMs: number;
  private readonly steps: SessionStartStep[] = [];

  constructor(private readonly now: () => number = Date.now) {
    this.startedAtMs = this.now();
  }

  /** Record a step that began at `sinceMs` and ends now. Never throws. */
  step(name: string, sinceMs: number): void {
    try {
      const end = this.now();
      this.steps.push({
        step: name,
        offset_ms: Math.max(0, sinceMs - this.startedAtMs),
        ms: Math.max(0, end - sinceMs),
      });
    } catch {
      /* telemetry never breaks session start */
    }
  }

  finish(): SessionStartTiming {
    return {
      started_at_ms: this.startedAtMs,
      total_ms: Math.max(0, this.now() - this.startedAtMs),
      steps: [...this.steps],
    };
  }
}

// ---------------------------------------------------------------------------
// Bounded-wait probe
// ---------------------------------------------------------------------------

export interface WaitProbeResult {
  ms: number;
  timed_out: boolean;
}

/**
 * Start measuring a bounded wait on `p`. Call the returned function right
 * after the `await Promise.race([...])` it measures.
 *
 * `timed_out` is true when `p` had not settled when the race finished.
 * The probe's own handlers are attached BEFORE the race's, so if `p`
 * settles first the probe sees it before the awaiting code resumes. The
 * race itself is not rewritten — its timing is byte-identical. An
 * absent/null `p` counts as already settled (the code races
 * `Promise.resolve()` in that case). The probe swallows a rejection only on
 * its own branch; the race still sees it.
 */
export function startWaitProbe(
  p: PromiseLike<unknown> | null | undefined,
  now: () => number = Date.now,
): () => WaitProbeResult {
  const t0 = now();
  let settled = !p;
  if (p) {
    try {
      p.then(
        () => { settled = true; },
        () => { settled = true; },
      );
    } catch {
      settled = true;
    }
  }
  return () => ({ ms: Math.max(0, now() - t0), timed_out: !settled });
}

// ---------------------------------------------------------------------------
// Turn-0 tracker wiring
// ---------------------------------------------------------------------------

/** Per-session latency context recorded at session start (see controller). */
export interface SessionLatencyContext {
  entry: LatencyEntry;
  surface: string | null;
  authenticated: boolean;
  /** Set when a Nova connect runs: true only when a prewarm was claimed. */
  prewarm_claimed?: boolean;
  /** The greeting rung (wake_opener) that was actually dispatched. */
  greeting_rung?: string | null;
}

/** The session fields these helpers read. Structural, so no import cycle. */
export interface LatencySessionLike {
  upstreamProvider?: string | null;
  lang?: string | null;
  active_role?: string | null;
  establishLatency?: LatencyTracker | null;
  sessionStartTiming?: SessionStartTiming | null;
  latencyContext?: SessionLatencyContext | null;
}

/**
 * Right after the turn-0 tracker is constructed: attach the session-start
 * block and the static context (entry / orb_surface / authenticated). No-op when
 * the tracker is absent or disabled; never throws.
 */
export function attachEstablishLatencyContext(session: LatencySessionLike): void {
  try {
    const t = session.establishLatency;
    if (!t) return;
    t.setSessionStart(session.sessionStartTiming ?? null);
    const ctx = session.latencyContext;
    // `orb_surface`, not `surface`: the tracker payload already carries
    // `surface: 'voice' | 'text'`, and core fields win a clash.
    t.setMeta({
      entry: ctx?.entry ?? null,
      orb_surface: ctx?.surface ?? null,
      authenticated: ctx?.authenticated ?? null,
    });
  } catch {
    /* telemetry never breaks the voice path */
  }
}

/**
 * Right before the turn-0 tracker is finalized on the first audio chunk:
 * correct the provider label and add the fields only known by then
 * (active_role resolves asynchronously; prewarm and rung during connect).
 */
export function prepareEstablishLatencyFinalize(session: LatencySessionLike): void {
  try {
    const t = session.establishLatency;
    if (!t) return;
    t.setProvider(resolveLatencyProviderLabel(session));
    const ctx = session.latencyContext;
    t.setMeta({
      active_role: session.active_role ?? null,
      prewarm_claimed: ctx?.prewarm_claimed === true,
      greeting_rung: ctx?.greeting_rung ?? null,
    });
  } catch {
    /* telemetry never breaks the voice path */
  }
}

/**
 * The greeting prompt has just been handed to the upstream. Marks
 * `greeting_dispatched` on the turn-0 tracker (no-op when absent) and
 * remembers the rung for the event metadata.
 */
export function markGreetingDispatched(
  session: LatencySessionLike,
  detail: { wake_opener?: string | null; directive_chars?: number | null; path: string },
): void {
  try {
    if (session.latencyContext) {
      session.latencyContext.greeting_rung = detail.wake_opener ?? null;
    }
    session.establishLatency?.mark('greeting_dispatched', {
      wake_opener: detail.wake_opener ?? null,
      directive_chars: detail.directive_chars ?? null,
      path: detail.path,
    });
  } catch {
    /* telemetry never breaks the voice path */
  }
}

// ---------------------------------------------------------------------------
// VTID-04542 × VTID-04544: wait marks for the concurrent greeting reads
// ---------------------------------------------------------------------------

/**
 * Times one bounded greeting gather (measurement only). `start` receives an
 * `onTimeout` hook to call from the read's own timeout branch; the mark is
 * written once the bounded read settles. The read's value is passed through
 * untouched and a throwing `mark` never reaches the caller.
 */
export function timeBoundedGreetingRead<T>(
  start: (onTimeout: () => void) => Promise<T>,
  mark: (r: WaitProbeResult) => void,
  now: () => number = Date.now,
): Promise<T> {
  const t0 = now();
  let timedOut = false;
  const p = start(() => { timedOut = true; });
  return p.then((v) => {
    try { mark({ ms: Math.max(0, now() - t0), timed_out: timedOut }); } catch { /* telemetry never surfaces */ }
    return v;
  });
}

/**
 * Wraps a speculative ledger read so that `consume()` records how long the
 * consumer waited and whether the read's own bound fired. Unused reads (never
 * consumed) record nothing — same as before, when they were never started.
 */
export function withLedgerWaitMark<L>(
  read: { consume(): Promise<L>; readSettled(): boolean },
  mark: (r: WaitProbeResult) => void,
  now: () => number = Date.now,
): { consume(): Promise<L>; readSettled(): boolean } {
  return {
    readSettled: () => read.readSettled(),
    consume() {
      const t0 = now();
      return read.consume().then((v) => {
        try { mark({ ms: Math.max(0, now() - t0), timed_out: !read.readSettled() }); } catch { /* telemetry never surfaces */ }
        return v;
      });
    },
  };
}
