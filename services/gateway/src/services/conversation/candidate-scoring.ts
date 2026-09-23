/**
 * VTID-04422 (Plan v1 WS-2.2) — relevance scoring of continuation candidates,
 * run in SHADOW mode.
 *
 * Today `decideContinuation` ranks candidates by a fixed provider priority
 * (minus a rotation penalty for recently served openers). This module scores
 * the same candidates with a transparent weighted formula whose weights live
 * in `conversation_scoring_weights` (editable, versioned), and records both
 * rankings side by side. It never changes what Vitana says: the shadow ranking
 * is compared, not used, until the comparison justifies a switch.
 *
 * score = Σ weight_f × feature_f / Σ weight_f, every feature in [0, 1]:
 *
 *   urgency     the provider's own priority / 100 (the fixed ranker's signal)
 *   freshness   1 when the candidate was not served recently, rising from 0
 *               for the one served last to 1 past the rotation window
 *   screen      how the candidate relates to the screen the user is on:
 *               0.2 when it navigates to the screen they are already on,
 *               0.8 when it navigates within the same section, else 0.5
 *   time_of_day the kind's fit for the user's local part of day, from the
 *               weights row's table; 0.5 when the table has no entry
 *   outcome     the user's smoothed acceptance rate for this provider,
 *               (accepted + 1) / (settled + 2), from conversation_offer_outcomes
 *   profile     reserved for the structured profile (WS-4.1); always null
 *               today, so it is left out of the sum rather than invented
 *
 * A feature that is null is dropped from both sums, so a missing signal never
 * pulls a score toward an arbitrary value.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type ScoringFeature = 'urgency' | 'freshness' | 'screen' | 'time_of_day' | 'outcome' | 'profile';
export type PartOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

export interface ScoringWeights {
  version: number;
  weights: Record<ScoringFeature, number>;
  /** kind → part of day → fit in [0, 1]. Missing entries are neutral (0.5). */
  time_of_day_fit: Record<string, Partial<Record<PartOfDay, number>>>;
}

/** Used when the table cannot be read. Mirrors the seeded version 1 row. */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  version: 0,
  weights: { urgency: 0.4, freshness: 0.25, screen: 0.1, time_of_day: 0.05, outcome: 0.2, profile: 0 },
  time_of_day_fit: {},
};

export interface ScorableCandidate {
  provider: string;
  kind: string;
  dedupeKey: string | null;
  priority: number;
  ctaRoute: string | null;
}

export interface ScoringContext {
  /** Most recently served dedupe keys, most recent first. */
  recentlyServed: string[];
  recentWindow: number;
  currentRoute: string | null;
  partOfDay: PartOfDay | null;
  /** provider → { accepted, settled } for this user (declined / ignored when known, VTID-04435). */
  outcomes: Record<string, { accepted: number; settled: number; declined?: number; ignored?: number }>;
}

export interface ScoredCandidate {
  provider: string;
  dedupe_key: string | null;
  priority: number;
  score: number;
  features: Record<ScoringFeature, number | null>;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const round3 = (x: number) => Math.round(x * 1000) / 1000;

function section(route: string): string {
  return route.split('?')[0].split('/').filter(Boolean)[0] ?? '';
}

export function partOfDayForHour(hour: number | null | undefined): PartOfDay | null {
  if (typeof hour !== 'number' || !Number.isFinite(hour)) return null;
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

/** The user's local hour from an IANA timezone; null when unknown. */
export function localHourIn(timezone: string | null | undefined, now: Date = new Date()): number | null {
  if (!timezone) return null;
  try {
    const h = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: timezone }).format(now);
    const n = Number(h);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function candidateFeatures(
  c: ScorableCandidate,
  ctx: ScoringContext,
  w: ScoringWeights,
): Record<ScoringFeature, number | null> {
  const idx = c.dedupeKey ? ctx.recentlyServed.indexOf(c.dedupeKey) : -1;
  const window = Math.max(1, ctx.recentWindow);
  const freshness = idx < 0 ? 1 : clamp01(idx / window);

  let screen = 0.5;
  if (c.ctaRoute && ctx.currentRoute) {
    const same = c.ctaRoute.split('?')[0].replace(/\/+$/, '') === ctx.currentRoute.split('?')[0].replace(/\/+$/, '');
    if (same) screen = 0.2;
    else if (section(c.ctaRoute) && section(c.ctaRoute) === section(ctx.currentRoute)) screen = 0.8;
  }

  const fit = ctx.partOfDay ? w.time_of_day_fit[c.kind]?.[ctx.partOfDay] : undefined;
  const timeOfDay = typeof fit === 'number' ? clamp01(fit) : 0.5;

  const o = ctx.outcomes[c.provider];
  const outcome = o ? clamp01((o.accepted + 1) / (o.settled + 2)) : 0.5;

  return {
    urgency: clamp01(c.priority / 100),
    freshness,
    screen,
    time_of_day: timeOfDay,
    outcome,
    profile: null,
  };
}

export function scoreCandidate(c: ScorableCandidate, ctx: ScoringContext, w: ScoringWeights): ScoredCandidate {
  const features = candidateFeatures(c, ctx, w);
  let num = 0;
  let den = 0;
  for (const f of Object.keys(features) as ScoringFeature[]) {
    const v = features[f];
    const wt = w.weights[f] ?? 0;
    if (v === null || wt <= 0) continue;
    num += wt * v;
    den += wt;
  }
  return {
    provider: c.provider,
    dedupe_key: c.dedupeKey,
    priority: c.priority,
    score: den > 0 ? round3(num / den) : 0,
    features: Object.fromEntries(
      Object.entries(features).map(([k, v]) => [k, v === null ? null : round3(v)]),
    ) as Record<ScoringFeature, number | null>,
  };
}

export interface ShadowRanking {
  weights_version: number;
  live_winner: string | null;
  shadow_winner: string | null;
  agree: boolean;
  candidates: ScoredCandidate[];
}

/**
 * Score every returned candidate and compare the top one with the live
 * winner. Ties keep the live order (stable sort), so equal scores never
 * manufacture a disagreement.
 */
export function rankInShadow(
  candidates: ScorableCandidate[],
  liveWinnerProvider: string | null,
  ctx: ScoringContext,
  w: ScoringWeights,
): ShadowRanking {
  const scored = candidates
    .map((c, i) => ({ s: scoreCandidate(c, ctx, w), i }))
    .sort((a, b) => (b.s.score - a.s.score) || (a.i - b.i))
    .map((x) => x.s);
  const shadowWinner = scored[0]?.provider ?? null;
  return {
    weights_version: w.version,
    live_winner: liveWinnerProvider,
    shadow_winner: shadowWinner,
    agree: shadowWinner === liveWinnerProvider,
    candidates: scored.slice(0, 15),
  };
}

// ---------------------------------------------------------------------------
// Weights (DB, cached) and outcomes (per user)
// ---------------------------------------------------------------------------

const WEIGHTS_TTL_MS = 5 * 60_000;
let weightsCache: { at: number; value: ScoringWeights } | null = null;

export function normalizeWeightsRow(row: { version?: unknown; weights?: unknown; time_of_day_fit?: unknown } | null): ScoringWeights {
  if (!row) return DEFAULT_SCORING_WEIGHTS;
  const src = (row.weights && typeof row.weights === 'object' ? row.weights : {}) as Record<string, unknown>;
  const weights = { ...DEFAULT_SCORING_WEIGHTS.weights };
  for (const k of Object.keys(weights) as ScoringFeature[]) {
    const v = Number(src[k]);
    if (Number.isFinite(v) && v >= 0) weights[k] = v;
  }
  const fit = row.time_of_day_fit && typeof row.time_of_day_fit === 'object'
    ? (row.time_of_day_fit as ScoringWeights['time_of_day_fit'])
    : {};
  const version = Number(row.version);
  return { version: Number.isFinite(version) ? version : 0, weights, time_of_day_fit: fit };
}

export async function loadScoringWeights(sb: SupabaseClient | null | undefined, nowMs: number = Date.now()): Promise<ScoringWeights> {
  if (weightsCache && nowMs - weightsCache.at < WEIGHTS_TTL_MS) return weightsCache.value;
  if (!sb) return DEFAULT_SCORING_WEIGHTS;
  try {
    const { data, error } = await sb
      .from('conversation_scoring_weights')
      .select('version, weights, time_of_day_fit')
      .eq('active', true)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    const value = error ? DEFAULT_SCORING_WEIGHTS : normalizeWeightsRow(data as any);
    weightsCache = { at: nowMs, value };
    return value;
  } catch {
    return DEFAULT_SCORING_WEIGHTS;
  }
}

export function __resetScoringWeightsCacheForTest(): void {
  weightsCache = null;
}

/** Per-provider accepted/settled counts for one user (90 days). */
export async function loadUserOutcomes(
  sb: SupabaseClient,
  userId: string,
): Promise<Record<string, { accepted: number; settled: number; declined: number; ignored: number }>> {
  const { readOfferOutcomeStats } = await import('./offer-outcome-stats');
  const { rows } = await readOfferOutcomeStats(sb, { days: 90, userId });
  const out: Record<string, { accepted: number; settled: number; declined: number; ignored: number }> = {};
  for (const r of rows) {
    out[r.provider] = { accepted: r.accepted, settled: r.accepted + r.declined + r.ignored, declined: r.declined, ignored: r.ignored };
  }
  return out;
}
