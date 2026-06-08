/**
 * LLM router shadow harness — Phase 1 W1 (VTID-03179 FINETUNES).
 *
 * Wraps the existing llm-router so that on any selected call site, the
 * primary model serves the user AND a candidate (fine-tuned) model is
 * invoked in parallel with the same input. Both results are recorded as an
 * `eval.shadow.compared` OASIS event for the auto-promoter to read.
 *
 * Wire-up rules:
 *   - Primary result is what's returned to the caller. Candidate never
 *     affects the response shape, even on error.
 *   - Candidate runs in the background — caller does NOT await it.
 *   - Gated by FEATURE_SHADOW_TOOL_ROUTER_ENV (off | staging-only |
 *     staging+prod), default off. When off, candidate is not invoked at all
 *     — zero overhead.
 *
 * Auto-promoter (scripts/auto-promoter.ts) reads the resulting events,
 * computes rolling 24h agreement / latency, and decides 5% → 50% → 100% of
 * staging traffic flips. Promotion to prod is human-gated via canary
 * PUBLISH (graduation-recommender FCM digest).
 */

import { emitOasisEvent } from './oasis-event-service';
import { isFeatureLive } from './feature-flags';
import { scoreGroundTruth } from './shadow-accuracy';

const FEATURE_NAME = 'SHADOW_TOOL_ROUTER';

export interface ShadowInvocation<TInput, TOutput> {
  feature: string;             // human-readable target ('voice-tool-router' | 'intent-kind' | 'pillar-classifier')
  input: TInput;
  primary: () => Promise<TOutput>;
  candidate: () => Promise<TOutput>;
  /** Optional: extract a comparable key from output (e.g. tool name) for shadow agreement metric. */
  extractKey?: (out: TOutput) => string | null;
  /** Optional context to attach to the OASIS event (user id, session id). */
  context?: { actor_id?: string; session_id?: string };
  /**
   * Optional ground-truth key for accuracy scoring (e.g. the labeled
   * `expected_tool` of a golden-corpus turn). When set, the emitted event
   * additionally carries `expected_key` + `primary_correct` + `candidate_correct`,
   * letting the aggregator compute accuracy-vs-truth, not just primary↔candidate
   * agreement. Unset (the common case) leaves the event shape unchanged.
   */
  groundTruthKey?: string | null;
  /**
   * Optional extra labels passed straight through to the event payload
   * (e.g. `fixture_id`, `turn`, `corpus_grounded`). Reserved keys in the
   * payload always win.
   */
  labels?: Record<string, unknown>;
}

/**
 * Result of {@link runWithShadowAwaitable}: the primary result the caller
 * serves to the user, plus a handle to the shadow comparison work.
 *
 * `shadowDone` resolves once the candidate has run and the
 * `eval.shadow.compared` OASIS event has been emitted (or skipped because the
 * feature flag is off). It NEVER rejects — shadow telemetry must not be able to
 * break a caller that awaits it.
 */
export interface ShadowRunResult<TOutput> {
  result: TOutput;
  shadowDone: Promise<void>;
}

/**
 * Runs the candidate model and emits the `eval.shadow.compared` event for one
 * shadow invocation. Pulled out of {@link runWithShadow} so the chain can be
 * either detached (fire-and-forget, voice path) or awaited (HTTP request
 * handlers on Cloud Run, where a detached promise is dropped when the instance
 * scales in before the response flushes — the W3-B0 root cause).
 *
 * Never throws.
 */
async function compareAndEmit<TInput, TOutput>(
  inv: ShadowInvocation<TInput, TOutput>,
  primaryResult: TOutput,
  primaryMs: number,
): Promise<void> {
  const candidateStart = Date.now();
  let candidateResult: TOutput | undefined;
  let candidateError: string | undefined;
  try {
    candidateResult = await inv.candidate();
  } catch (err) {
    candidateError = err instanceof Error ? err.message : String(err);
  }
  const candidateMs = Date.now() - candidateStart;

  const primaryKey = inv.extractKey ? safe(() => inv.extractKey!(primaryResult)) : null;
  const candidateKey = candidateResult && inv.extractKey
    ? safe(() => inv.extractKey!(candidateResult!))
    : null;
  const agreement = primaryKey != null && candidateKey != null
    ? primaryKey === candidateKey
    : null;

  // Ground-truth accuracy: only present when the caller supplied a labeled
  // expected key (golden-corpus turns). Unlabeled traffic → all-null, event
  // shape unchanged.
  const score = scoreGroundTruth(inv.groundTruthKey, primaryKey, candidateKey);

  try {
    await emitOasisEvent({
      vtid: 'VTID-03179',
      type: 'eval.shadow.compared',
      source: 'gateway/llm-router-shadow',
      status: candidateError ? 'warning' : 'success',
      message: candidateError
        ? `shadow ${inv.feature}: candidate errored (${candidateError.slice(0, 80)})`
        : `shadow ${inv.feature}: primary=${primaryKey} candidate=${candidateKey} agree=${agreement}`,
      actor_id: inv.context?.actor_id,
      payload: {
        ...(inv.labels ?? {}),
        feature: inv.feature,
        session_id: inv.context?.session_id,
        primary_key: primaryKey,
        candidate_key: candidateKey,
        agreement,
        expected_key: score.expected_key,
        primary_correct: score.primary_correct,
        candidate_correct: score.candidate_correct,
        primary_ms: primaryMs,
        candidate_ms: candidateMs,
        candidate_error: candidateError,
      },
    });
  } catch {
    // Never let shadow telemetry break anything.
  }
}

/**
 * Runs primary and (if enabled) candidate, returning both the primary result
 * AND an awaitable handle to the shadow comparison work.
 *
 * This is the reliable-on-Cloud-Run variant. The candidate + `emitOasisEvent`
 * chain is NOT detached — the caller gets a `shadowDone` promise it can await
 * before the request handler returns the HTTP response. On Cloud Run with
 * `--min-instances=0`, awaiting `shadowDone` guarantees the
 * `eval.shadow.compared` emit completes while the container still has CPU
 * allocated (the instance is torn down / CPU-throttled after the response is
 * sent, which silently drops any still-pending detached promise — the W3-B0
 * starvation root cause).
 *
 * Primary path is unaffected: `result` is the primary output, computed and
 * available before the candidate even starts. Callers that don't care about
 * flushing can ignore `shadowDone`. Callers on a request/response boundary
 * should `await shadowDone` (or hand it to a `waitUntil`-style hook) so the
 * emit isn't dropped.
 *
 * When the feature flag is off, the candidate is never invoked and
 * `shadowDone` is an already-resolved promise (zero overhead).
 */
export async function runWithShadowAwaitable<TInput, TOutput>(
  inv: ShadowInvocation<TInput, TOutput>,
): Promise<ShadowRunResult<TOutput>> {
  const enabled = isFeatureLive(FEATURE_NAME);

  if (!enabled) {
    return { result: await inv.primary(), shadowDone: Promise.resolve() };
  }

  const primaryStart = Date.now();
  const primaryResult = await inv.primary();
  const primaryMs = Date.now() - primaryStart;

  // Start the candidate AFTER primary returns so we never extend user-visible
  // latency by waiting on the candidate to start. Returning the promise lets
  // the caller flush it reliably; compareAndEmit never throws so awaiting it
  // (or detaching it) is always safe.
  const shadowDone = compareAndEmit(inv, primaryResult, primaryMs);

  return { result: primaryResult, shadowDone };
}

/**
 * Runs primary and (if enabled) candidate. Returns primary result.
 * Candidate execution is fire-and-forget.
 *
 * Use this on the voice hot path, where an active WebSocket/SSE session keeps
 * the container's CPU allocated long enough for the detached emit to flush. For
 * short-lived HTTP request handlers (e.g. the staging exerciser), prefer
 * {@link runWithShadowAwaitable} and await `shadowDone` so the emit isn't
 * dropped when the Cloud Run instance scales in after the response.
 */
export async function runWithShadow<TInput, TOutput>(
  inv: ShadowInvocation<TInput, TOutput>,
): Promise<TOutput> {
  const { result, shadowDone } = await runWithShadowAwaitable(inv);
  // Detached on purpose for the hot path. `shadowDone` never rejects, but
  // attach a catch anyway so an unhandled rejection can never surface here.
  void shadowDone.catch(() => {});
  return result;
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
