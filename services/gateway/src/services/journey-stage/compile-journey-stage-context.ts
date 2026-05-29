/**
 * VTID-02937 (B4) — compileJourneyStageContext.
 *
 * Pure function over fetcher results. Produces the distilled
 * JourneyStageContext the assistant decision layer reads from.
 *
 * Tenure ladder (UTC days since app_users.created_at):
 *   0     → first_session   (depth: deep)
 *   1..6  → first_days      (depth: deep)
 *   7..13 → first_week      (depth: standard)
 *   14..59 → first_month    (depth: standard)
 *   60+   → established     (depth: terse)
 *
 * Vitana Index tier mapping (5-tier canonical, post-Phase E):
 *   0..149   → foundation
 *   150..299 → building
 *   300..499 → momentum
 *   500..699 → resonance
 *   700+     → flourishing
 *   null     → unknown      (no Index history yet)
 *
 * No IO. No mutation. No clock side-effects (now is injected).
 */

import type {
  AppUserRow,
  ExplanationDepthHint,
  JourneyStageContext,
  OnboardingStage,
  UserActiveDaysAggregate,
  VitanaIndexLatestRow,
  VitanaIndexTier,
} from './types';

export interface CompileJourneyStageContextInputs {
  appUserResult: { ok: boolean; row: AppUserRow | null; reason?: string };
  activeDaysResult: { ok: boolean; aggregate: UserActiveDaysAggregate; reason?: string };
  indexHistoryResult: { ok: boolean; rows: VitanaIndexLatestRow[]; reason?: string };
  /** Injected for testability. Production passes Date.now(). */
  nowMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function compileJourneyStageContext(
  input: CompileJourneyStageContextInputs,
): JourneyStageContext {
  const now = input.nowMs ?? Date.now();

  // ----- Tenure -----
  const appUserOk = input.appUserResult.ok;
  const appUserRow = appUserOk ? input.appUserResult.row : null;
  const tenure_days = appUserRow ? tenureDays(now, appUserRow.created_at) : null;
  const onboarding_stage = stageFromTenure(tenure_days);
  const explanation_depth_hint = depthFromStage(onboarding_stage);

  // ----- Active days -----
  const activeDaysOk = input.activeDaysResult.ok;
  const usage_days_count = activeDaysOk
    ? input.activeDaysResult.aggregate.usage_days_count
    : 0;
  const last_active_date = activeDaysOk
    ? input.activeDaysResult.aggregate.last_active_date
    : null;
  const days_since_last_active = daysSinceUtcDate(now, last_active_date);

  // ----- Vitana Index tier -----
  const indexOk = input.indexHistoryResult.ok;
  const indexRows = indexOk ? input.indexHistoryResult.rows : [];
  const latest = indexRows.length > 0 ? indexRows[0] : null;
  const score_total = latest ? latest.score_total : null;
  const tier = tierFromScore(score_total);
  const tier_days_held = computeTierDaysHeld(indexRows, tier, now);

  return {
    onboarding_stage,
    tenure_days,
    usage_days_count,
    last_active_date,
    days_since_last_active,
    vitana_index: {
      score_total,
      tier,
      tier_days_held,
    },
    explanation_depth_hint,
    source_health: {
      app_users: appUserOk
        ? { ok: true }
        : { ok: false, reason: input.appUserResult.reason ?? 'unknown_failure' },
      user_active_days: activeDaysOk
        ? { ok: true }
        : { ok: false, reason: input.activeDaysResult.reason ?? 'unknown_failure' },
      vitana_index_scores: indexOk
        ? { ok: true }
        : { ok: false, reason: input.indexHistoryResult.reason ?? 'unknown_failure' },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------------

export function stageFromTenure(days: number | null): OnboardingStage {
  if (days === null) return 'first_session';
  if (days <= 0) return 'first_session';
  if (days < 7) return 'first_days';
  if (days < 14) return 'first_week';
  if (days < 60) return 'first_month';
  return 'established';
}

export function depthFromStage(stage: OnboardingStage): ExplanationDepthHint {
  switch (stage) {
    case 'first_session':
    case 'first_days':
      return 'deep';
    case 'first_week':
    case 'first_month':
      return 'standard';
    case 'established':
      return 'terse';
  }
}

export function tierFromScore(score: number | null): VitanaIndexTier {
  if (score === null || !Number.isFinite(score)) return 'unknown';
  if (score < 150) return 'foundation';
  if (score < 300) return 'building';
  if (score < 500) return 'momentum';
  if (score < 700) return 'resonance';
  return 'flourishing';
}

function tenureDays(nowMs: number, createdAtIso: string): number | null {
  const t = Date.parse(createdAtIso);
  if (!Number.isFinite(t)) return null;
  const diff = nowMs - t;
  if (diff < 0) return 0;
  return Math.floor(diff / DAY_MS);
}

function daysSinceUtcDate(nowMs: number, isoDate: string | null): number | null {
  if (!isoDate) return null;
  // Parse 'YYYY-MM-DD' as start-of-UTC-day.
  const t = Date.parse(isoDate + 'T00:00:00Z');
  if (!Number.isFinite(t)) return null;
  const todayStart = startOfUtcDay(nowMs);
  const diff = todayStart - t;
  if (diff < 0) return 0;
  return Math.floor(diff / DAY_MS);
}

function startOfUtcDay(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Counts how many days the user has stayed in the same tier as the
 * latest observation. Walks the history (already sorted DESC by date)
 * and stops at the first date whose tier differs.
 *
 * Returns null when:
 *   - tier is 'unknown' (no history)
 *   - history has only one observation
 *   - any date in the head-run cannot be parsed
 */
function computeTierDaysHeld(
  history: VitanaIndexLatestRow[],
  currentTier: VitanaIndexTier,
  nowMs: number,
): number | null {
  if (currentTier === 'unknown') return null;
  if (history.length === 0) return null;
  if (history.length === 1) return null;

  const oldestSameTierIso = (() => {
    let prev: string | null = null;
    for (const r of history) {
      if (tierFromScore(r.score_total) !== currentTier) break;
      prev = r.date;
    }
    return prev;
  })();
  if (!oldestSameTierIso) return null;
  const t = Date.parse(oldestSameTierIso + 'T00:00:00Z');
  if (!Number.isFinite(t)) return null;
  const todayStart = startOfUtcDay(nowMs);
  const diff = todayStart - t;
  if (diff < 0) return 0;
  return Math.floor(diff / DAY_MS);
}
