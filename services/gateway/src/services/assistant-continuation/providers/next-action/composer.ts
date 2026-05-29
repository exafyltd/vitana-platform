/**
 * VTID-03056 (B0d-real slice Xa) — Next Action composer.
 *
 * Iterates the registered NextActionSources in parallel, normalizes
 * their `NextActionSourceResult`s, and picks the highest-priority
 * candidate. Ties are broken by registration order so the result is
 * deterministic.
 *
 * Empty-sources-registry / all-sources-skipped / all-sources-errored
 * paths all return a `chosen: null` result with a typed `suppressReason`
 * — never throws upward. The framework's decideContinuation orchestrator
 * also tolerates throws, but B0d-real never relies on that — the
 * composer is the source of truth for "why nothing fired".
 *
 * Subsequent slices (Xb-Xe) ADD sources to the registry without
 * touching this file. Acceptance criteria #1-#6 from the B0d-real spec
 * are all about which source can win — that's the composer's job here.
 */

import type {
  NextActionComposer,
  NextActionComposeResult,
  NextActionSource,
  NextActionSourceContext,
  NextActionSourceKey,
  NextActionSourceResult,
  ScoredCandidate,
} from './types';
// VTID-03068 (B0d-real Xk) — cross-session dedupe via user_assistant_state.
import {
  isSeenRecently,
  recordDedupeSighting,
  DEFAULT_DEDUPE_WINDOW_MS,
} from './dedupe-store';

class CompositeNextActionComposer implements NextActionComposer {
  /**
   * Insertion-ordered map. JS Maps preserve insertion order, which is
   * exactly the tie-breaker we want — the registration order of the
   * production wiring determines which source wins on equal priority.
   */
  private readonly sources = new Map<NextActionSourceKey, NextActionSource>();

  register(source: NextActionSource): void {
    this.sources.set(source.key, source);
  }

  reset(): void {
    this.sources.clear();
  }

  registeredKeys(): readonly NextActionSourceKey[] {
    return Array.from(this.sources.keys());
  }

  async compose(
    surface: 'orb_wake' | 'orb_turn_end',
    ctx: NextActionSourceContext,
  ): Promise<NextActionComposeResult> {
    const composeStartedAt = new Date().toISOString();

    if (this.sources.size === 0) {
      return {
        chosen: null,
        candidates: [],
        suppressReason: 'no_sources_registered',
        composeStartedAt,
        composeFinishedAt: new Date().toISOString(),
      };
    }

    const eligible: NextActionSource[] = [];
    for (const source of this.sources.values()) {
      if (source.serves(surface)) eligible.push(source);
    }

    const t0 = Date.now();
    const rawResults = await Promise.all(
      eligible.map((source) => invokeSourceSafely(source, ctx, t0)),
    );

    // VTID-03068: cross-session dedupe gate. For every candidate that
    // came back, check whether its dedupe_key was already shown to this
    // user within the last 4 hours. If yes, downgrade the result to
    // skippedReason='dedup_window' BEFORE ranking, so a fresh sibling
    // candidate (different source, different dedupe_key) can still win.
    //
    // The check runs in parallel with itself; each check NEVER throws —
    // failures default to "not seen" so a DB outage cannot silence the
    // orb. Best-effort: composer continues even if every check errors.
    const results = await applyDedupeGate(rawResults, ctx);
    const composeFinishedAt = new Date().toISOString();

    const ranked = rank(results);

    // VTID-03068: record the winner's dedupe_key sighting (fire-and-
    // forget). When the orb actually speaks the line, recording here
    // captures it as "shown" — subsequent wakes within the window will
    // see it via isSeenRecently and skip.
    if (ranked.chosen && ranked.chosen.dedupeKey) {
      void recordDedupeSighting({
        supabase: ctx.supabase,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        dedupeKey: ranked.chosen.dedupeKey,
        source: ranked.chosen.source,
        surface,
      });
    }

    return {
      ...ranked,
      candidates: results,
      composeStartedAt,
      composeFinishedAt,
    };
  }
}

/**
 * For each result that has a candidate, check the dedupe store. When the
 * dedupe_key was seen within the default window, downgrade the row to
 * skippedReason='dedup_window'. Never throws upward — fail-open by
 * design (DB outage MUST NOT silence the orb).
 */
async function applyDedupeGate(
  rawResults: ReadonlyArray<NextActionSourceResult>,
  ctx: NextActionSourceContext,
): Promise<NextActionSourceResult[]> {
  const checks = rawResults.map(async (row) => {
    if (!row.candidate) return row;
    try {
      const seen = await isSeenRecently({
        supabase: ctx.supabase,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        dedupeKey: row.candidate.dedupeKey,
        nowIso: ctx.nowIso,
        windowMs: DEFAULT_DEDUPE_WINDOW_MS,
      });
      if (seen) {
        return {
          source: row.source,
          candidate: null,
          skippedReason: 'dedup_window' as const,
          latencyMs: row.latencyMs,
        };
      }
      return row;
    } catch {
      // Fail-open — never let the dedupe gate silence the orb.
      return row;
    }
  });
  return Promise.all(checks);
}

async function invokeSourceSafely(
  source: NextActionSource,
  ctx: NextActionSourceContext,
  startMs: number,
): Promise<NextActionSourceResult> {
  try {
    const result = await source.produce(ctx);
    const latencyMs = Math.max(0, Date.now() - startMs);
    // Defensive: collapse mutual-exclusion violation (candidate AND
    // skippedReason) to an errored row. Sources should never do this, but
    // a buggy source MUST NOT propagate inconsistent state into the
    // ranker.
    if (result.candidate && result.skippedReason) {
      return {
        source: source.key,
        candidate: null,
        skippedReason: 'errored',
        latencyMs,
      };
    }
    return { ...result, latencyMs };
  } catch (err) {
    return {
      source: source.key,
      candidate: null,
      skippedReason: 'errored',
      latencyMs: Math.max(0, Date.now() - startMs),
    };
  }
}

/**
 * Pick the winning candidate across all sources.
 *
 * Rules:
 *   1. Drop results without a candidate.
 *   2. Sort by priority descending. Stable sort preserves registration
 *      order, which is the deterministic tie-breaker.
 *   3. Apply the cross-source threshold (50). Below that, the composer
 *      reports `tied_below_threshold` so the wake-brief fallback can
 *      still fire its generic line.
 *   4. Return chosen + suppress reason (when null).
 */
export function rank(
  results: ReadonlyArray<NextActionSourceResult>,
): Pick<NextActionComposeResult, 'chosen' | 'suppressReason'> {
  const withCandidates = results.filter(
    (r): r is NextActionSourceResult & { candidate: ScoredCandidate } =>
      r.candidate !== null && r.candidate !== undefined,
  );

  if (withCandidates.length === 0) {
    // Distinguish "every source errored" from "all skipped"; both
    // matter for the Command Hub Inspector but only the former is a
    // health signal.
    const erroredAll =
      results.length > 0 && results.every((r) => r.skippedReason === 'errored');
    return {
      chosen: null,
      suppressReason: erroredAll ? 'all_sources_errored' : 'all_sources_skipped',
    };
  }

  // Stable sort: JS Array.prototype.sort is spec'd stable since ES2019.
  const sorted = [...withCandidates].sort(
    (a, b) => b.candidate.priority - a.candidate.priority,
  );
  const top = sorted[0].candidate;

  if (top.priority < CROSS_SOURCE_THRESHOLD) {
    return { chosen: null, suppressReason: 'tied_below_threshold' };
  }

  return { chosen: top };
}

/**
 * Below this priority, the composer suppresses and the framework's
 * fallback voice-wake-brief provider (the B0d-mini hardcoded path)
 * gets to fire instead. Above it, B0d-real has something real to say.
 *
 * Keep this constant exported so the per-source rankers can tune
 * against a single known threshold.
 */
export const CROSS_SOURCE_THRESHOLD = 50;

/**
 * Module-level composer used by the production provider. Tests build
 * their own instances; production wiring registers sources here once
 * at import time (in the source files themselves).
 */
export const defaultNextActionComposer: NextActionComposer =
  new CompositeNextActionComposer();
