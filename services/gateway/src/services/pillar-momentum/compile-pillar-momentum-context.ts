/**
 * VTID-02955 (B5) — compilePillarMomentumContext.
 *
 * Pure function over raw vitana_index_scores rows. Produces the
 * distilled PillarMomentumContext the Command Hub preview consumes
 * (and the decision adapter narrows further).
 *
 * Momentum policy (per pillar):
 *   - Build two 7-day windows: latest 7 dates, then prior 7 dates.
 *   - If recent window has ≥ MIN_WINDOW_DAYS observations AND prior
 *     window has ≥ MIN_WINDOW_DAYS observations:
 *       delta = avg(recent) - avg(prior)
 *       improving  if delta >  +5
 *       slipping   if delta <  -5
 *       steady     otherwise
 *   - else → 'unknown'
 *
 * No IO. No mutation. No clock side-effects (rows arrive already
 * sorted DESC by date from the fetcher).
 */

import type {
  PillarKey,
  PillarMomentum,
  PillarMomentumContext,
  PillarMomentumEntry,
  VitanaIndexScoreRow,
} from './types';

export interface CompilePillarMomentumContextInputs {
  fetchResult: {
    ok: boolean;
    rows: VitanaIndexScoreRow[];
    reason?: string;
  };
}

const PILLARS: ReadonlyArray<PillarKey> = [
  'sleep',
  'nutrition',
  'exercise',
  'hydration',
  'mental',
];

/** Minimum non-null observations per 7-day window to compute a delta. */
const MIN_WINDOW_DAYS = 3;
/** Delta threshold (in 0..200 score units) for improving/slipping vs steady. */
const DELTA_THRESHOLD = 5;
/** Minimum well-covered pillars for 'high' confidence. */
const HIGH_CONFIDENCE_PILLAR_COUNT = 4;
/** Minimum well-covered pillars for 'medium' confidence. */
const MEDIUM_CONFIDENCE_PILLAR_COUNT = 2;

export function compilePillarMomentumContext(
  input: CompilePillarMomentumContextInputs,
): PillarMomentumContext {
  const fetchOk = input.fetchResult.ok;
  const rows = fetchOk ? input.fetchResult.rows : [];

  // Rows arrive DESC by date. Split into two 7-day windows.
  const recent = rows.slice(0, 7);
  const prior = rows.slice(7, 14);

  const per_pillar: PillarMomentumEntry[] = PILLARS.map((pillar) =>
    computePillarEntry(pillar, rows, recent, prior),
  );

  // Latest scores — from the most-recent row's pillar columns.
  const latestRow = rows[0] ?? null;
  let weakest_pillar: PillarKey | null = null;
  let strongest_pillar: PillarKey | null = null;
  if (latestRow) {
    weakest_pillar = pickWeakest(latestRow);
    strongest_pillar = pickStrongest(latestRow);
  }

  // Suggested focus: the weakest pillar, with a tie-break preference
  // for pillars whose momentum is 'slipping' or 'unknown'.
  let suggested_focus: PillarKey | null = weakest_pillar;
  if (suggested_focus) {
    const weakestEntry = per_pillar.find((p) => p.pillar === suggested_focus);
    // If the weakest pillar is already 'improving', prefer the worst
    // 'slipping' pillar instead (if any).
    if (weakestEntry && weakestEntry.momentum === 'improving') {
      const slipping = per_pillar.find((p) => p.momentum === 'slipping');
      if (slipping) suggested_focus = slipping.pillar;
    }
  }

  const well_covered = per_pillar.filter((p) => p.momentum !== 'unknown').length;
  const confidence: 'low' | 'medium' | 'high' =
    well_covered >= HIGH_CONFIDENCE_PILLAR_COUNT
      ? 'high'
      : well_covered >= MEDIUM_CONFIDENCE_PILLAR_COUNT
        ? 'medium'
        : 'low';

  return {
    per_pillar,
    weakest_pillar,
    strongest_pillar,
    suggested_focus,
    confidence,
    history_days_sampled: rows.length,
    source_health: {
      vitana_index_scores: fetchOk
        ? { ok: true }
        : { ok: false, reason: input.fetchResult.reason ?? 'unknown_failure' },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------------

function pillarColumn(pillar: PillarKey): keyof VitanaIndexScoreRow {
  switch (pillar) {
    case 'sleep':     return 'score_sleep';
    case 'nutrition': return 'score_nutrition';
    case 'exercise':  return 'score_exercise';
    case 'hydration': return 'score_hydration';
    case 'mental':    return 'score_mental';
  }
}

export function computePillarEntry(
  pillar: PillarKey,
  allRows: VitanaIndexScoreRow[],
  recent: VitanaIndexScoreRow[],
  prior: VitanaIndexScoreRow[],
): PillarMomentumEntry {
  const col = pillarColumn(pillar);

  const recentScores = recent
    .map((r) => r[col] as number | null)
    .filter((x): x is number => x !== null && Number.isFinite(x));
  const priorScores = prior
    .map((r) => r[col] as number | null)
    .filter((x): x is number => x !== null && Number.isFinite(x));

  const momentum = computeMomentum(recentScores, priorScores);

  const latestScore = allRows.length > 0
    ? ((allRows[0][col] as number | null) ?? null)
    : null;

  return {
    pillar,
    momentum,
    latest_score: latestScore,
    recent_window_days: recentScores.length,
  };
}

export function computeMomentum(
  recentScores: number[],
  priorScores: number[],
): PillarMomentum {
  if (recentScores.length < MIN_WINDOW_DAYS || priorScores.length < MIN_WINDOW_DAYS) {
    return 'unknown';
  }
  const recentAvg = avg(recentScores);
  const priorAvg = avg(priorScores);
  const delta = recentAvg - priorAvg;
  if (delta > DELTA_THRESHOLD) return 'improving';
  if (delta < -DELTA_THRESHOLD) return 'slipping';
  return 'steady';
}

function avg(xs: ReadonlyArray<number>): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function pickWeakest(row: VitanaIndexScoreRow): PillarKey | null {
  return pickByScore(row, (best, candidate) => candidate < best);
}

export function pickStrongest(row: VitanaIndexScoreRow): PillarKey | null {
  return pickByScore(row, (best, candidate) => candidate > best);
}

function pickByScore(
  row: VitanaIndexScoreRow,
  cmp: (best: number, candidate: number) => boolean,
): PillarKey | null {
  let pick: PillarKey | null = null;
  let bestScore = 0;
  for (const pillar of PILLARS) {
    const score = row[pillarColumn(pillar)] as number | null;
    if (score === null || !Number.isFinite(score)) continue;
    if (pick === null || cmp(bestScore, score)) {
      pick = pillar;
      bestScore = score;
    }
  }
  return pick;
}
