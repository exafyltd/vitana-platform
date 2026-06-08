/**
 * VTID-02913 (B0d.1) — decide-continuation orchestrator.
 *
 * Single entry point for picking a continuation. Every assistant turn
 * that wants one calls this and receives an `AssistantContinuationDecision`
 * — never a raw null, never a thrown exception masking a no-fire path.
 *
 * Flow:
 *   1. Capture `decisionStartedAt`.
 *   2. Find every provider for the requested surface.
 *   3. Invoke each provider. Tolerate throws → record as `errored`.
 *   4. Collect ProviderResult rows (one per provider, even on no-fire).
 *   5. Rank the `returned` candidates by priority (descending), stable.
 *   6. If at least one candidate exists → that's the selected continuation.
 *   7. Otherwise → build `selectedContinuation = null` with a derived
 *      `suppressionReason`, AND emit the rolled-up reason as a
 *      `kind: 'none_with_reason'` continuation that callers can render
 *      uniformly (B0d.3 logs both forms; B0d.4 renders the rolled-up
 *      reason on the wake timeline panel).
 *   8. Capture `decisionFinishedAt` and return the carrier.
 *
 * Design notes (load-bearing):
 *   - `none_with_reason` is FIRST-CLASS: when no provider returns a
 *     candidate, the rolled-up suppression is itself a continuation
 *     (kind=`none_with_reason`) AND the decision's `selectedContinuation`
 *     is null. Both views are populated so:
 *       (a) renderers that ALWAYS expect a continuation can use
 *           `materializedNone()` to get one;
 *       (b) renderers that gate on selection can read `null` directly.
 *     Either way, the Continuation Inspector sees the full provider
 *     evidence in `sourceProviderResults`.
 *   - `sourceProviderResults` is ALWAYS populated when providers ran —
 *     including on no-fire paths. This is review-checklist item #3.
 *   - The contract carrier (`AssistantContinuationDecision`) ALREADY has
 *     timing + provider evidence in B0d.1. B0d.3 only populates / surfaces.
 */

import { randomUUID } from 'crypto';
import type {
  AssistantContinuation,
  AssistantContinuationDecision,
  ContinuationDecisionContext,
  ContinuationProvider,
  ContinuationSurface,
  ProviderResult,
  DecisionTelemetryContext,
} from './types';
import {
  makeNoneWithReason,
  validateContinuationCandidate,
} from './types';
import {
  defaultProviderRegistry,
  type ContinuationProviderRegistry,
} from './provider-registry';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DecideContinuationOptions {
  /** Surface that needs a continuation. */
  surface: ContinuationSurface;
  /** Decision context forwarded verbatim to each provider. */
  context: Omit<ContinuationDecisionContext, 'surface'>;
  /** Override the registry. Tests pass a fresh one; production uses default. */
  registry?: ContinuationProviderRegistry;
  /** Injected for testability. Defaults to `Date.now`. */
  now?: () => Date;
  /** Injected for testability. Defaults to `randomUUID`. */
  newId?: () => string;
}

/**
 * Pick a continuation for the given surface. Always returns a decision
 * — never throws on a missing provider, never returns raw null.
 */
export async function decideContinuation(
  opts: DecideContinuationOptions,
): Promise<AssistantContinuationDecision> {
  const registry = opts.registry ?? defaultProviderRegistry;
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? (() => randomUUID());

  const decisionId = newId();
  const startedAt = now();
  const decisionStartedAt = startedAt.toISOString();

  const fullContext: ContinuationDecisionContext = {
    ...opts.context,
    surface: opts.surface,
  };

  const providers = registry.forSurface(opts.surface);
  const results: ProviderResult[] = [];

  for (const provider of providers) {
    results.push(await invokeProviderSafely(provider, fullContext, now));
  }

  // Rank: only `returned` candidates are eligible. Stable sort by
  // descending priority. Ties keep registration order (which providers.
  // forSurface returns in deterministic Map-iteration order).
  const candidates = results
    .filter((r): r is ProviderResult & { candidate: AssistantContinuation } =>
      r.status === 'returned' && r.candidate !== undefined,
    )
    .map((r, idx) => ({ result: r, idx }))
    .sort((a, b) => {
      const dp = b.result.candidate.priority - a.result.candidate.priority;
      return dp !== 0 ? dp : a.idx - b.idx;
    });

  let selectedContinuation: AssistantContinuation | null = null;
  let suppressionReason: string | undefined;

  if (candidates.length > 0) {
    selectedContinuation = candidates[0].result.candidate;
  } else {
    suppressionReason = rollUpSuppressionReason(results, providers.length);
  }

  const finishedAt = now();
  const decisionFinishedAt = finishedAt.toISOString();

  const telemetryContext: DecisionTelemetryContext = {
    sessionId: opts.context.sessionId,
    userId: opts.context.userId,
    tenantId: opts.context.tenantId,
    surface: opts.surface,
    envelopeJourneySurface: opts.context.envelopeJourneySurface,
  };

  const decision: AssistantContinuationDecision = {
    decisionId,
    selectedContinuation,
    decisionStartedAt,
    decisionFinishedAt,
    sourceProviderResults: results,
    telemetryContext,
  };
  if (suppressionReason !== undefined) {
    decision.suppressionReason = suppressionReason;
  }
  return decision;
}

// ---------------------------------------------------------------------------
// Helpers — internal but exported for tests.
// ---------------------------------------------------------------------------

/**
 * If no provider returned a candidate, derive a single concise reason
 * that names WHY (e.g. "no_providers_registered" / "all_providers_suppressed" /
 * "all_providers_errored"). The full per-provider story lives in
 * `sourceProviderResults`; this string is just the headline.
 */
export function rollUpSuppressionReason(
  results: ReadonlyArray<ProviderResult>,
  providerCount: number,
): string {
  if (providerCount === 0) return 'no_providers_registered';
  const counts = {
    returned: 0,
    skipped: 0,
    suppressed: 0,
    errored: 0,
  };
  for (const r of results) counts[r.status] += 1;
  if (counts.returned > 0) {
    // Should never happen if caller filtered correctly, but be defensive.
    return 'unknown_selected_continuation_should_exist';
  }
  if (counts.errored === providerCount) return 'all_providers_errored';
  if (counts.suppressed === providerCount) return 'all_providers_suppressed';
  if (counts.skipped === providerCount) return 'all_providers_skipped';
  // Mixed no-fire outcome.
  return 'no_provider_returned_a_candidate';
}

/**
 * Build a materialized `none_with_reason` continuation for a decision
 * where `selectedContinuation` is null. Renderers that always need a
 * continuation can call this; renderers that gate on `selectedContinuation`
 * can ignore it.
 *
 * Kept as a small helper (not embedded inside `decideContinuation`)
 * because some callers prefer the null form and we don't want to pay
 * the allocation when they don't.
 */
export function materializedNone(
  decision: AssistantContinuationDecision,
): AssistantContinuation {
  if (decision.selectedContinuation) {
    throw new Error(
      'materializedNone: called on a decision that already has a selected continuation',
    );
  }
  return makeNoneWithReason({
    surface: decision.telemetryContext.surface,
    reason: decision.suppressionReason ?? 'unknown_with_context',
    dedupeKey: `decision-${decision.decisionId}`,
  });
}

async function invokeProviderSafely(
  provider: ContinuationProvider,
  ctx: ContinuationDecisionContext,
  now: () => Date,
): Promise<ProviderResult> {
  const t0 = now().getTime();
  try {
    const result = await provider.produce(ctx);
    // Latency policy: provider-supplied wins ONLY when it's a strictly
    // positive number. Otherwise (absent, zero, negative, non-finite)
    // we use the orchestrator's wall-clock measurement. A zero from a
    // provider is treated as missing — B0d.3 relies on this evidence
    // to diagnose wake delay; a silent 0 would lie.
    const measuredLatencyMs = now().getTime() - t0;
    const reportedLatencyMs =
      typeof result.latencyMs === 'number' &&
      Number.isFinite(result.latencyMs) &&
      result.latencyMs > 0
        ? result.latencyMs
        : measuredLatencyMs;

    // Invariant validation for returned candidates. A malformed
    // candidate (missing/extra `suppressReason`, unknown kind, non-
    // object) is downgraded to `status: 'errored'` with the validator's
    // specific reason. The bad candidate NEVER reaches the ranker.
    if (result.status === 'returned' && result.candidate !== undefined) {
      const guard = validateContinuationCandidate(result.candidate);
      if (!guard.ok) {
        return {
          providerKey: provider.key,
          status: 'errored',
          latencyMs: reportedLatencyMs,
          reason: guard.reason,
        };
      }
    }

    return { ...result, latencyMs: reportedLatencyMs };
  } catch (err) {
    return {
      providerKey: provider.key,
      status: 'errored',
      latencyMs: now().getTime() - t0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
