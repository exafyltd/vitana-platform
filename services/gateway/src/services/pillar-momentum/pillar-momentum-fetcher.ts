/**
 * VTID-02955 (B5) — Supabase-backed pillar-momentum fetcher.
 *
 * Read-only by design. NO write/mutator methods on the interface —
 * pillar-momentum is a derivation OVER the existing
 * `vitana_index_scores` table which is itself written by the Index
 * compute pipeline. Adding an `upsert*` here would violate the B5
 * wall.
 *
 * Failure policy: any Supabase error returns empty rows + source-
 * health flagged. We never throw upward — pillar-momentum is an
 * enrichment layer, never a wake-blocker.
 */

import { getSupabase } from '../../lib/supabase';
import type { VitanaIndexScoreRow } from './types';

export interface PillarMomentumFetcher {
  fetchVitanaIndexHistory(args: {
    tenantId: string;
    userId: string;
    /** Default 21. Capped at 90. */
    limit?: number;
  }): Promise<{
    ok: boolean;
    rows: VitanaIndexScoreRow[];
    reason?: string;
  }>;
}

export interface SupabasePillarMomentumFetcherOptions {
  getDb?: typeof getSupabase;
}

export function createSupabasePillarMomentumFetcher(
  opts: SupabasePillarMomentumFetcherOptions = {},
): PillarMomentumFetcher {
  const getDb = opts.getDb ?? getSupabase;

  return {
    async fetchVitanaIndexHistory(args) {
      const limit = clampLimit(args.limit);
      const sb = getDb();
      if (!sb) return { ok: false, rows: [], reason: 'supabase_unconfigured' };
      try {
        const { data, error } = await sb
          .from('vitana_index_scores')
          .select(
            'date, score_total, score_sleep, score_nutrition, score_exercise, score_hydration, score_mental',
          )
          .eq('tenant_id', args.tenantId)
          .eq('user_id', args.userId)
          .order('date', { ascending: false })
          .limit(limit);
        if (error) return { ok: false, rows: [], reason: error.message };
        const rows = Array.isArray(data) ? data : [];
        return { ok: true, rows: rows.map(mapRow) };
      } catch (e) {
        return { ok: false, rows: [], reason: (e as Error).message };
      }
    },
  };
}

export const defaultPillarMomentumFetcher = createSupabasePillarMomentumFetcher();

// ---------------------------------------------------------------------------
// Row mapping — exported for tests
// ---------------------------------------------------------------------------

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 21;
  return Math.max(1, Math.min(90, Math.trunc(raw)));
}

export function mapRow(row: Record<string, unknown>): VitanaIndexScoreRow {
  return {
    date: String(row.date ?? ''),
    score_total: coerceScore(row.score_total, 0, 999) ?? 0,
    score_sleep: coerceScore(row.score_sleep, 0, 200),
    score_nutrition: coerceScore(row.score_nutrition, 0, 200),
    score_exercise: coerceScore(row.score_exercise, 0, 200),
    score_hydration: coerceScore(row.score_hydration, 0, 200),
    score_mental: coerceScore(row.score_mental, 0, 200),
  };
}

function coerceScore(raw: unknown, lo: number, hi: number): number | null {
  if (raw === null || raw === undefined) return null;
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string') n = Number.parseFloat(raw);
  else return null;
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}
