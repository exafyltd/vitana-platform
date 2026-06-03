/**
 * BOOTSTRAP-MEMORY-BROKER — Composing Memory Broker (sibling, additive).
 *
 * A thin COMPOSITION layer that wires together three existing, already-merged
 * building blocks into a single entry point so callers stop hand-rolling the
 * "route → fetch → rank → cap" sequence:
 *
 *   1. retrieval-router  (`computeRetrievalRouterDecision`)  — which sources +
 *                                                              per-source limits
 *   2. memory-ranker     (`rankMemory` / `compareSelections`) — relevance top-K
 *   3. budget            (this file)                          — a hard char cap
 *                                                              applied after rank
 *
 * Design constraints (deliberate):
 *   - NEW file only. Does NOT modify retrieval-router.ts, memory-ranker.ts,
 *     the memory-hit-ranking shadow, context-pack-builder.ts, or the existing
 *     `memory-broker.ts` (a separate VTID-02026 semantic-API concern that
 *     happens to share the "broker" word — different surface, untouched here).
 *   - Gated behind `FEATURE_MEMORY_BROKER` (default OFF). When OFF, callers see
 *     `enabled: false` and a NAIVE selection identical to today's behavior, so
 *     adopting this composer is a no-op until the flag is flipped.
 *   - Pure + dependency-injected: candidates are passed IN (the caller still
 *     owns the Supabase fetch). No fetch, no clock except injected `now`, no
 *     I/O on the hot path beyond the optional shadow log. Exhaustively testable.
 *   - Shadow comparison: even with the flag OFF we can emit a NAIVE-vs-RANKED
 *     comparison (via the ranker's `compareSelections`) so the ranked path can
 *     be validated against production traffic before flipping the flag.
 */

import {
  computeRetrievalRouterDecision,
} from './retrieval-router';
import {
  rankMemory,
  compareSelections,
  type MemoryCandidate,
  type ShadowComparison,
} from './memory-ranker';
import type {
  RetrievalSource,
  RetrievalRouterDecision,
  ConversationChannel,
} from '../types/conversation';

const MARKER = 'BOOTSTRAP-MEMORY-BROKER';

// =============================================================================
// Feature flag — default OFF
// =============================================================================

/**
 * `FEATURE_MEMORY_BROKER` gates whether the composed RANKED selection is
 * returned to the caller. Default OFF: any value other than a recognized
 * truthy string yields the NAIVE selection (today's behavior).
 *
 * Recognized truthy: "1", "true", "on", "enabled" (case-insensitive).
 * Exported for tests; reads `process.env` lazily so flips are picked up
 * without a module reload in long-lived processes.
 */
export function isMemoryBrokerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.FEATURE_MEMORY_BROKER ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'enabled';
}

// =============================================================================
// Budget
// =============================================================================

/**
 * Default character budget for the memory block emitted to the LLM. The ranker
 * already caps by COUNT (topK); the budget caps by SIZE so a few very long
 * memories can't blow the context window. Applied AFTER ranking so the most
 * relevant memories are the ones that survive the cap.
 */
export const DEFAULT_MEMORY_CHAR_BUDGET = 6000;

/**
 * Greedily keep candidates (in the order given — assumed already ranked) while
 * their cumulative `content.length` stays within `charBudget`. A single
 * oversized candidate at position 0 is still kept (so we never return empty
 * when at least one candidate exists and the budget is positive); subsequent
 * oversized candidates are skipped. Pure.
 */
export function applyCharBudget<T extends MemoryCandidate>(
  candidates: T[],
  charBudget: number,
): T[] {
  if (charBudget <= 0) return [];
  const kept: T[] = [];
  let used = 0;
  for (const c of candidates) {
    const len = c.content?.length ?? 0;
    if (kept.length === 0) {
      // Always keep the first (most relevant) item, even if oversized.
      kept.push(c);
      used += len;
      continue;
    }
    if (used + len <= charBudget) {
      kept.push(c);
      used += len;
    }
  }
  return kept;
}

// =============================================================================
// Public contract
// =============================================================================

export interface BrokerMemoryInput<T extends MemoryCandidate = MemoryCandidate> {
  /** The user query/turn text — drives the retrieval-router decision. */
  query: string;
  /**
   * Candidate memories already fetched by the caller (the broker does NOT
   * fetch). Ordering of the input is treated as the NAIVE selection order
   * (i.e. "first N rows" — today's behavior).
   */
  candidates: T[];
  /** Optional intent embedding for the ranker's similarity term. */
  intentEmbedding?: number[];
  /** Injected clock for deterministic recency scoring. */
  now: Date;
  /** Conversation channel (passed through to the router for logging parity). */
  channel?: ConversationChannel;
  /** Force the router to a fixed set of sources (passthrough). */
  forceSources?: RetrievalSource[];
  /** Per-source limit overrides (passthrough to the router). */
  limitOverrides?: Partial<Record<RetrievalSource, number>>;
  /**
   * Hard char budget for the returned memory block. Defaults to
   * `DEFAULT_MEMORY_CHAR_BUDGET`.
   */
  charBudget?: number;
  /**
   * When true, compute + return (and log) the NAIVE-vs-RANKED shadow
   * comparison even while the flag is OFF. Defaults to true so the ranked
   * path accrues comparison data before the flag flip.
   */
  shadow?: boolean;
  /** Override the feature flag read (tests). */
  env?: NodeJS.ProcessEnv;
  /** Optional sink for the shadow log line; defaults to console.log. */
  logger?: (line: string, comparison: ShadowComparison) => void;
}

export interface BrokerMemoryResult<T extends MemoryCandidate = MemoryCandidate> {
  /** Whether `FEATURE_MEMORY_BROKER` was on (i.e. `selected` is the RANKED set). */
  enabled: boolean;
  /** The router decision used to size the memory budget. */
  routerDecision: RetrievalRouterDecision;
  /** Effective top-K used for ranking, derived from the router's memory limit. */
  topK: number;
  /** Effective char budget applied after ranking. */
  charBudget: number;
  /** The selection the caller should use: RANKED+budgeted when enabled, else NAIVE+budgeted. */
  selected: T[];
  /** The naive selection (input order, count-capped at topK, budgeted) — for audit. */
  naive: T[];
  /** The ranked selection (relevance-ranked, budgeted) — for audit. */
  ranked: T[];
  /** NAIVE-vs-RANKED comparison when shadow requested, else undefined. */
  shadow?: ShadowComparison;
}

// =============================================================================
// brokerMemory — the one composed entry point
// =============================================================================

/**
 * Compose retrieval-router + memory-ranker + budget into a single decision.
 *
 * Flow:
 *   1. Ask the router for the memory_garden limit → this becomes `topK`.
 *   2. NAIVE  = input order, sliced to topK, then char-budgeted.
 *   3. RANKED = `rankMemory` to topK, then char-budgeted.
 *   4. `selected` = RANKED when the flag is ON, else NAIVE.
 *   5. Optionally emit a shadow comparison (works regardless of flag state).
 *
 * Returns both branches so callers/tests can audit without re-running.
 */
export function brokerMemory<T extends MemoryCandidate = MemoryCandidate>(
  input: BrokerMemoryInput<T>,
): BrokerMemoryResult<T> {
  const {
    query,
    candidates,
    intentEmbedding,
    now,
    channel,
    forceSources,
    limitOverrides,
    charBudget = DEFAULT_MEMORY_CHAR_BUDGET,
    shadow = true,
    env,
    logger,
  } = input;

  const enabled = isMemoryBrokerEnabled(env);

  // 1. Router decides sources + limits. memory_garden limit → top-K.
  const routerDecision = computeRetrievalRouterDecision(query, {
    channel,
    force_sources: forceSources,
    limit_overrides: limitOverrides,
  });
  const topK = Math.max(0, routerDecision.limits.memory_garden ?? 0);

  // 2. NAIVE: today's "first N rows" behavior, then budget.
  const naiveTopK = candidates.slice(0, topK);
  const naive = applyCharBudget(naiveTopK, charBudget);

  // 3. RANKED: relevance-ranked top-K, then budget.
  const rankedTopK = rankMemory<T>({ candidates, intentEmbedding, now, topK });
  const ranked = applyCharBudget(rankedTopK, charBudget);

  // 4. The selection callers should use.
  const selected = enabled ? ranked : naive;

  // 5. Shadow comparison (independent of the flag — that's the whole point).
  let shadowComparison: ShadowComparison | undefined;
  if (shadow) {
    shadowComparison = compareSelections(naive, ranked);
    const line =
      `[${MARKER}] shadow rule=${routerDecision.matched_rule} ` +
      `enabled=${enabled} topK=${topK} budget=${charBudget} ` +
      `naive=${shadowComparison.naive_selection_ids.length}/${shadowComparison.naive_chars}c ` +
      `ranked=${shadowComparison.ranked_selection_ids.length}/${shadowComparison.ranked_chars}c ` +
      `overlap=${shadowComparison.overlap_pct}%`;
    if (logger) {
      logger(line, shadowComparison);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }

  return {
    enabled,
    routerDecision,
    topK,
    charBudget,
    selected,
    naive,
    ranked,
    shadow: shadowComparison,
  };
}
