/**
 * BOOTSTRAP-MATCHMAKING-INDEX — thin match-journey fetcher.
 *
 * Read-only. Reduces authoritative rows to the distilled shapes the
 * pure derivation (`match-journey-derivation.ts`) consumes. NO raw
 * rows / chat text / profile payloads escape this module.
 *
 * Sources (all already populated by other code paths):
 *   profiles            — user_id → vitana_id (same join the matchmaker uses)
 *   intent_matches      — latest match lifecycle state (vitana_id_a side)
 *   vitana_index_scores — latest Index total (via the B4 fetcher)
 *
 * Failure policy: every read degrades to a null/empty result with a
 * reason rather than throwing — the provider can still produce a
 * useful context (or fall back to the stub) from partial data.
 */

import { getSupabase } from '../../../lib/supabase';
import {
  defaultJourneyStageFetcher,
  type JourneyStageFetcher,
} from '../../../services/journey-stage/journey-stage-fetcher';
import {
  normaliseMatchState,
  type LatestMatchObservation,
} from './match-journey-derivation';

export interface MatchJourneyFetchResult {
  latestMatch: LatestMatchObservation | null;
  indexScoreTotal: number | null;
  sourceHealth: {
    profiles: { ok: boolean; reason?: string };
    intent_matches: { ok: boolean; reason?: string };
    vitana_index_scores: { ok: boolean; reason?: string };
  };
}

export interface MatchJourneyFetcher {
  fetch(args: {
    userId: string;
    tenantId: string;
  }): Promise<MatchJourneyFetchResult>;
}

export interface SupabaseMatchJourneyFetcherOptions {
  getDb?: typeof getSupabase;
  /** Reused for the Index history read; defaults to the B4 fetcher. */
  journeyStageFetcher?: JourneyStageFetcher;
}

export function createSupabaseMatchJourneyFetcher(
  opts: SupabaseMatchJourneyFetcherOptions = {},
): MatchJourneyFetcher {
  const getDb = opts.getDb ?? getSupabase;
  const indexFetcher = opts.journeyStageFetcher ?? defaultJourneyStageFetcher;

  return {
    async fetch(args) {
      const sb = getDb();
      const health: MatchJourneyFetchResult['sourceHealth'] = {
        profiles: { ok: false, reason: 'supabase_unconfigured' },
        intent_matches: { ok: false, reason: 'supabase_unconfigured' },
        vitana_index_scores: { ok: false, reason: 'supabase_unconfigured' },
      };

      // ----- Vitana Index (reuse B4 fetcher) -----
      let indexScoreTotal: number | null = null;
      try {
        const idx = await indexFetcher.fetchVitanaIndexHistory({
          tenantId: args.tenantId,
          userId: args.userId,
          limit: 1,
        });
        if (idx.ok) {
          health.vitana_index_scores = { ok: true };
          indexScoreTotal = idx.rows.length > 0 ? idx.rows[0].score_total : null;
        } else {
          health.vitana_index_scores = { ok: false, reason: idx.reason ?? 'unknown_failure' };
        }
      } catch (e) {
        health.vitana_index_scores = { ok: false, reason: (e as Error).message };
      }

      if (!sb) {
        return { latestMatch: null, indexScoreTotal, sourceHealth: health };
      }

      // ----- user_id → vitana_id (same join the matchmaker uses) -----
      let vitanaId: string | null = null;
      try {
        const { data, error } = await sb
          .from('profiles')
          .select('vitana_id')
          .eq('user_id', args.userId)
          .maybeSingle();
        if (error) {
          health.profiles = { ok: false, reason: error.message };
        } else {
          health.profiles = { ok: true };
          vitanaId = (data as { vitana_id?: string } | null)?.vitana_id ?? null;
        }
      } catch (e) {
        health.profiles = { ok: false, reason: (e as Error).message };
      }

      // ----- Latest match row (distilled) -----
      let latestMatch: LatestMatchObservation | null = null;
      if (!vitanaId) {
        // No vitana_id → user is not in the match pool yet; treat as
        // "no matches" but mark the source healthy (it's not a failure).
        health.intent_matches = { ok: true };
      } else {
        try {
          const { data, error } = await sb
            .from('intent_matches')
            .select('match_id, intent_a_id, state, state_changed_at, created_at')
            .eq('vitana_id_a', vitanaId)
            .order('state_changed_at', { ascending: false, nullsFirst: false })
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (error) {
            health.intent_matches = { ok: false, reason: error.message };
          } else {
            health.intent_matches = { ok: true };
            if (data) {
              const row = data as Record<string, unknown>;
              latestMatch = {
                matchId: row.match_id ? String(row.match_id) : null,
                intentId: row.intent_a_id ? String(row.intent_a_id) : null,
                state: normaliseMatchState(row.state),
                stateChangedAt:
                  (row.state_changed_at ? String(row.state_changed_at) : null) ??
                  (row.created_at ? String(row.created_at) : null),
              };
            }
          }
        } catch (e) {
          health.intent_matches = { ok: false, reason: (e as Error).message };
        }
      }

      return { latestMatch, indexScoreTotal, sourceHealth: health };
    },
  };
}

export const defaultMatchJourneyFetcher = createSupabaseMatchJourneyFetcher();
