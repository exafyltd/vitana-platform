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
}

/**
 * Runs primary and (if enabled) candidate. Returns primary result.
 * Candidate execution is fire-and-forget.
 */
export async function runWithShadow<TInput, TOutput>(
  inv: ShadowInvocation<TInput, TOutput>,
): Promise<TOutput> {
  const enabled = isFeatureLive(FEATURE_NAME);

  if (!enabled) {
    return inv.primary();
  }

  const primaryStart = Date.now();
  const primaryResult = await inv.primary();
  const primaryMs = Date.now() - primaryStart;

  // Kick off candidate after primary returns so we never extend user-visible
  // latency by waiting on the candidate to start.
  void (async () => {
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
          feature: inv.feature,
          session_id: inv.context?.session_id,
          primary_key: primaryKey,
          candidate_key: candidateKey,
          agreement,
          primary_ms: primaryMs,
          candidate_ms: candidateMs,
          candidate_error: candidateError,
        },
      });
    } catch {
      // Never let shadow telemetry break anything.
    }
  })();

  return primaryResult;
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
