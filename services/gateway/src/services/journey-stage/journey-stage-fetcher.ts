/**
 * VTID-02937 (B4) — Supabase-backed journey-stage fetcher.
 *
 * Read-only by design. NO write/mutator methods on the interface —
 * none of B4's signals require persistence: they read from
 * authoritative sources already populated by other code paths:
 *
 *   app_users           — created by user-provisioning trigger
 *   user_active_days    — upserted by JWT auth middleware
 *   vitana_index_scores — written by the Index compute pipeline
 *
 * Adding an `upsert*` here would violate the B4 wall.
 *
 * Failure policy: every per-table read returns `{ ok, value, reason? }`.
 * Errors degrade the source rather than failing the whole context —
 * the compiler can still produce a useful JourneyStageContext from
 * partial data.
 */

import { getSupabase } from '../../lib/supabase';
import type {
  AppUserRow,
  UserActiveDaysAggregate,
  VitanaIndexLatestRow,
} from './types';

export interface JourneyStageFetcher {
  fetchAppUser(args: { userId: string }): Promise<{
    ok: boolean;
    row: AppUserRow | null;
    reason?: string;
  }>;
  fetchUserActiveDaysAggregate(args: { userId: string }): Promise<{
    ok: boolean;
    aggregate: UserActiveDaysAggregate;
    reason?: string;
  }>;
  fetchVitanaIndexHistory(args: {
    tenantId: string;
    userId: string;
    /** Default 30. Capped at 365. */
    limit?: number;
  }): Promise<{
    ok: boolean;
    rows: VitanaIndexLatestRow[];
    reason?: string;
  }>;
}

export interface SupabaseJourneyStageFetcherOptions {
  getDb?: typeof getSupabase;
}

export function createSupabaseJourneyStageFetcher(
  opts: SupabaseJourneyStageFetcherOptions = {},
): JourneyStageFetcher {
  const getDb = opts.getDb ?? getSupabase;

  return {
    async fetchAppUser(args) {
      const sb = getDb();
      if (!sb) return { ok: false, row: null, reason: 'supabase_unconfigured' };
      try {
        const { data, error } = await sb
          .from('app_users')
          .select('user_id, created_at')
          .eq('user_id', args.userId)
          .maybeSingle();
        if (error) return { ok: false, row: null, reason: error.message };
        if (!data) return { ok: true, row: null };
        return { ok: true, row: mapAppUserRow(data) };
      } catch (e) {
        return { ok: false, row: null, reason: (e as Error).message };
      }
    },

    async fetchUserActiveDaysAggregate(args) {
      const sb = getDb();
      if (!sb) {
        return {
          ok: false,
          aggregate: { usage_days_count: 0, last_active_date: null },
          reason: 'supabase_unconfigured',
        };
      }
      try {
        // Pull all active_date rows in date-desc order, cap at 1000.
        // Aggregation lives in JS — Supabase JS client doesn't expose
        // a uniform COUNT(*) helper without an RPC, and we already need
        // last_active_date which is the head of the sorted set.
        const { data, error } = await sb
          .from('user_active_days')
          .select('active_date')
          .eq('user_id', args.userId)
          .order('active_date', { ascending: false })
          .limit(1000);
        if (error) {
          return {
            ok: false,
            aggregate: { usage_days_count: 0, last_active_date: null },
            reason: error.message,
          };
        }
        const rows = Array.isArray(data) ? data : [];
        const last_active_date = rows.length > 0
          ? String((rows[0] as { active_date?: unknown }).active_date ?? '')
          : null;
        return {
          ok: true,
          aggregate: {
            usage_days_count: rows.length,
            last_active_date: last_active_date || null,
          },
        };
      } catch (e) {
        return {
          ok: false,
          aggregate: { usage_days_count: 0, last_active_date: null },
          reason: (e as Error).message,
        };
      }
    },

    async fetchVitanaIndexHistory(args) {
      const limit = clampHistoryLimit(args.limit);
      const sb = getDb();
      if (!sb) return { ok: false, rows: [], reason: 'supabase_unconfigured' };
      try {
        const { data, error } = await sb
          .from('vitana_index_scores')
          .select('date, score_total')
          .eq('tenant_id', args.tenantId)
          .eq('user_id', args.userId)
          .order('date', { ascending: false })
          .limit(limit);
        if (error) return { ok: false, rows: [], reason: error.message };
        const rows = Array.isArray(data) ? data : [];
        return { ok: true, rows: rows.map(mapVitanaIndexRow) };
      } catch (e) {
        return { ok: false, rows: [], reason: (e as Error).message };
      }
    },
  };
}

export const defaultJourneyStageFetcher = createSupabaseJourneyStageFetcher();

// ---------------------------------------------------------------------------
// Row mappers — exported for tests
// ---------------------------------------------------------------------------

function clampHistoryLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 30;
  return Math.max(1, Math.min(365, Math.trunc(raw)));
}

export function mapAppUserRow(row: Record<string, unknown>): AppUserRow {
  return {
    user_id: String(row.user_id ?? ''),
    created_at: String(row.created_at ?? ''),
  };
}

export function mapVitanaIndexRow(row: Record<string, unknown>): VitanaIndexLatestRow {
  const scoreRaw = row.score_total;
  let score_total = 0;
  if (typeof scoreRaw === 'number' && Number.isFinite(scoreRaw)) {
    score_total = Math.max(0, Math.min(999, Math.trunc(scoreRaw)));
  } else if (typeof scoreRaw === 'string') {
    const parsed = Number.parseInt(scoreRaw, 10);
    if (Number.isFinite(parsed)) score_total = Math.max(0, Math.min(999, parsed));
  }
  return {
    date: String(row.date ?? ''),
    score_total,
  };
}
