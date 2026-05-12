/**
 * VTID-02937 (B4) — compileJourneyStageContext tests.
 *
 * Pure function. Verifies:
 *   - stageFromTenure ladder boundaries (5 stages)
 *   - depthFromStage mapping (deep / standard / terse)
 *   - tierFromScore boundaries (5 tiers + unknown)
 *   - tenure_days computation from app_users.created_at
 *   - days_since_last_active uses UTC day boundary
 *   - tier_days_held walks history correctly
 *   - source_health passes through fetch results
 *   - !ok results treated as empty
 */

import {
  compileJourneyStageContext,
  depthFromStage,
  stageFromTenure,
  tierFromScore,
} from '../../../src/services/journey-stage/compile-journey-stage-context';

const NOW = Date.parse('2026-05-11T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function makeInputs(over: any = {}) {
  return {
    appUserResult: over.appUserResult ?? { ok: true, row: null },
    activeDaysResult: over.activeDaysResult ?? {
      ok: true,
      aggregate: { usage_days_count: 0, last_active_date: null },
    },
    indexHistoryResult: over.indexHistoryResult ?? { ok: true, rows: [] },
    nowMs: NOW,
  };
}

describe('B4 — compileJourneyStageContext', () => {
  describe('stageFromTenure', () => {
    it('null tenure → first_session (defensive)', () => {
      expect(stageFromTenure(null)).toBe('first_session');
    });

    it('0 days → first_session', () => {
      expect(stageFromTenure(0)).toBe('first_session');
    });

    it('1..6 days → first_days', () => {
      expect(stageFromTenure(1)).toBe('first_days');
      expect(stageFromTenure(6)).toBe('first_days');
    });

    it('7..13 days → first_week', () => {
      expect(stageFromTenure(7)).toBe('first_week');
      expect(stageFromTenure(13)).toBe('first_week');
    });

    it('14..59 days → first_month', () => {
      expect(stageFromTenure(14)).toBe('first_month');
      expect(stageFromTenure(59)).toBe('first_month');
    });

    it('60+ → established', () => {
      expect(stageFromTenure(60)).toBe('established');
      expect(stageFromTenure(365)).toBe('established');
    });
  });

  describe('depthFromStage', () => {
    it('first_session + first_days → deep', () => {
      expect(depthFromStage('first_session')).toBe('deep');
      expect(depthFromStage('first_days')).toBe('deep');
    });

    it('first_week + first_month → standard', () => {
      expect(depthFromStage('first_week')).toBe('standard');
      expect(depthFromStage('first_month')).toBe('standard');
    });

    it('established → terse', () => {
      expect(depthFromStage('established')).toBe('terse');
    });
  });

  describe('tierFromScore', () => {
    it('null → unknown', () => {
      expect(tierFromScore(null)).toBe('unknown');
    });

    it.each([
      [0,   'foundation'],
      [149, 'foundation'],
      [150, 'building'],
      [299, 'building'],
      [300, 'momentum'],
      [499, 'momentum'],
      [500, 'resonance'],
      [699, 'resonance'],
      [700, 'flourishing'],
      [999, 'flourishing'],
    ])('score %d → %s', (score, expected) => {
      expect(tierFromScore(score)).toBe(expected);
    });
  });

  describe('tenure_days computation', () => {
    it('produces the expected delta', () => {
      const ctx = compileJourneyStageContext(makeInputs({
        appUserResult: { ok: true, row: { user_id: 'u', created_at: new Date(NOW - 30 * DAY).toISOString() } },
      }));
      expect(ctx.tenure_days).toBe(30);
      expect(ctx.onboarding_stage).toBe('first_month');
      expect(ctx.explanation_depth_hint).toBe('standard');
    });

    it('clamps negative tenure (future created_at) to 0', () => {
      const ctx = compileJourneyStageContext(makeInputs({
        appUserResult: { ok: true, row: { user_id: 'u', created_at: new Date(NOW + 5 * DAY).toISOString() } },
      }));
      expect(ctx.tenure_days).toBe(0);
      expect(ctx.onboarding_stage).toBe('first_session');
    });

    it('returns null tenure when row missing → first_session', () => {
      const ctx = compileJourneyStageContext(makeInputs({
        appUserResult: { ok: true, row: null },
      }));
      expect(ctx.tenure_days).toBeNull();
      expect(ctx.onboarding_stage).toBe('first_session');
    });
  });

  describe('days_since_last_active', () => {
    it('uses UTC day boundary', () => {
      const ctx = compileJourneyStageContext(makeInputs({
        activeDaysResult: {
          ok: true,
          aggregate: { usage_days_count: 5, last_active_date: '2026-05-09' },
        },
      }));
      // 2026-05-11 (today) - 2026-05-09 = 2 days
      expect(ctx.days_since_last_active).toBe(2);
    });

    it('today → 0', () => {
      const ctx = compileJourneyStageContext(makeInputs({
        activeDaysResult: {
          ok: true,
          aggregate: { usage_days_count: 1, last_active_date: '2026-05-11' },
        },
      }));
      expect(ctx.days_since_last_active).toBe(0);
    });

    it('null when no last_active_date', () => {
      const ctx = compileJourneyStageContext(makeInputs());
      expect(ctx.days_since_last_active).toBeNull();
    });
  });

  describe('vitana_index surfacing', () => {
    it('picks head of history for score + tier', () => {
      const ctx = compileJourneyStageContext(makeInputs({
        indexHistoryResult: {
          ok: true,
          rows: [
            { date: '2026-05-11', score_total: 425 },
            { date: '2026-05-10', score_total: 400 },
          ],
        },
      }));
      expect(ctx.vitana_index.score_total).toBe(425);
      expect(ctx.vitana_index.tier).toBe('momentum');
    });

    it('returns unknown tier + null score when history empty', () => {
      const ctx = compileJourneyStageContext(makeInputs());
      expect(ctx.vitana_index.score_total).toBeNull();
      expect(ctx.vitana_index.tier).toBe('unknown');
      expect(ctx.vitana_index.tier_days_held).toBeNull();
    });

    it('returns null tier_days_held when only one observation', () => {
      const ctx = compileJourneyStageContext(makeInputs({
        indexHistoryResult: {
          ok: true,
          rows: [{ date: '2026-05-11', score_total: 425 }],
        },
      }));
      expect(ctx.vitana_index.tier_days_held).toBeNull();
    });

    it('walks history while tier stays the same', () => {
      // All 5 rows are in tier 'momentum' (300..499); oldest is 5 days ago.
      const ctx = compileJourneyStageContext(makeInputs({
        indexHistoryResult: {
          ok: true,
          rows: [
            { date: '2026-05-11', score_total: 425 },
            { date: '2026-05-10', score_total: 420 },
            { date: '2026-05-09', score_total: 410 },
            { date: '2026-05-08', score_total: 400 },
            { date: '2026-05-06', score_total: 380 },
          ],
        },
      }));
      // 2026-05-11 - 2026-05-06 = 5 days
      expect(ctx.vitana_index.tier_days_held).toBe(5);
    });

    it('stops walking at the first tier change', () => {
      const ctx = compileJourneyStageContext(makeInputs({
        indexHistoryResult: {
          ok: true,
          rows: [
            { date: '2026-05-11', score_total: 425 },   // momentum
            { date: '2026-05-10', score_total: 420 },   // momentum
            { date: '2026-05-09', score_total: 290 },   // building (different tier!)
            { date: '2026-05-08', score_total: 280 },   // building
          ],
        },
      }));
      // Walks: 2026-05-11 (momentum) → 2026-05-10 (momentum) → 2026-05-09 (DIFFERENT). Stops.
      // oldestSameTier = 2026-05-10 → 2026-05-11 - 2026-05-10 = 1 day
      expect(ctx.vitana_index.tier_days_held).toBe(1);
    });
  });

  describe('source_health', () => {
    it('passes through ok:true for all three sources', () => {
      const ctx = compileJourneyStageContext(makeInputs({
        appUserResult: { ok: true, row: { user_id: 'u', created_at: new Date(NOW - DAY).toISOString() } },
      }));
      expect(ctx.source_health.app_users.ok).toBe(true);
      expect(ctx.source_health.user_active_days.ok).toBe(true);
      expect(ctx.source_health.vitana_index_scores.ok).toBe(true);
    });

    it('reflects per-source failures', () => {
      const ctx = compileJourneyStageContext({
        appUserResult: { ok: false, row: null, reason: 'app_users_boom' },
        activeDaysResult: { ok: false, aggregate: { usage_days_count: 0, last_active_date: null }, reason: 'active_boom' },
        indexHistoryResult: { ok: false, rows: [], reason: 'index_boom' },
        nowMs: NOW,
      });
      expect(ctx.source_health.app_users).toEqual({ ok: false, reason: 'app_users_boom' });
      expect(ctx.source_health.user_active_days).toEqual({ ok: false, reason: 'active_boom' });
      expect(ctx.source_health.vitana_index_scores).toEqual({ ok: false, reason: 'index_boom' });
    });

    it('defaults reason to "unknown_failure" when an !ok result omits one', () => {
      const ctx = compileJourneyStageContext({
        appUserResult: { ok: false, row: null },
        activeDaysResult: { ok: false, aggregate: { usage_days_count: 0, last_active_date: null } },
        indexHistoryResult: { ok: false, rows: [] },
        nowMs: NOW,
      });
      expect(ctx.source_health.app_users.reason).toBe('unknown_failure');
      expect(ctx.source_health.user_active_days.reason).toBe('unknown_failure');
      expect(ctx.source_health.vitana_index_scores.reason).toBe('unknown_failure');
    });

    it('treats !ok inputs as empty for all surfaces', () => {
      const ctx = compileJourneyStageContext({
        appUserResult: { ok: false, row: { user_id: 'u', created_at: '2026-04-01T00:00:00Z' } },
        activeDaysResult: { ok: false, aggregate: { usage_days_count: 99, last_active_date: '2026-05-11' } },
        indexHistoryResult: { ok: false, rows: [{ date: '2026-05-11', score_total: 425 }] },
        nowMs: NOW,
      });
      expect(ctx.tenure_days).toBeNull();
      expect(ctx.usage_days_count).toBe(0);
      expect(ctx.last_active_date).toBeNull();
      expect(ctx.vitana_index.score_total).toBeNull();
      expect(ctx.vitana_index.tier).toBe('unknown');
    });
  });
});
