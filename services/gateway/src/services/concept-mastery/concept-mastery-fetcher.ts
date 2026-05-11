/**
 * VTID-02936 (B3) — Supabase-backed concept-mastery fetcher.
 *
 * Read-only by design. NO write/mutator methods on the interface —
 * state advancement (incrementing concept_explained_count, marking
 * mastery, recording dyk_card_seen) lives in a follow-up slice
 * behind dedicated event paths. Even adding an `upsert*` method here
 * would violate the B3 wall.
 *
 * Failure policy: any Supabase error returns empty arrays + source-
 * health flagged. We never throw upward — the concept-mastery
 * context is an enrichment layer, never a wake-blocker.
 *
 * Data shape on disk: each row in `user_assistant_state` has
 *   - tenant_id, user_id        (composite scope)
 *   - signal_name TEXT          (the family + key, e.g. 'concept_explained:vitana_index')
 *   - value JSONB               (free-form payload; we read minimally)
 *   - count INT                 (per-family counter)
 *   - confidence NUMERIC(4,3)   (used for mastery)
 *   - source TEXT               (optional provenance)
 *   - last_seen_at TIMESTAMPTZ  (recency)
 *
 * We pull all rows once and split by signal_name prefix in JS — a
 * single round-trip beats three filtered queries.
 */

import { getSupabase } from '../../lib/supabase';
import type {
  ConceptExplainedRow,
  ConceptMasteryRow,
  DykCardSeenRow,
} from './types';

export interface ConceptMasteryFetcher {
  listConceptState(args: {
    tenantId: string;
    userId: string;
    /** Default 200. Capped at 500. */
    limit?: number;
  }): Promise<{
    ok: boolean;
    concepts_explained: ConceptExplainedRow[];
    concepts_mastered: ConceptMasteryRow[];
    dyk_cards_seen: DykCardSeenRow[];
    reason?: string;
  }>;
}

export interface SupabaseConceptMasteryFetcherOptions {
  getDb?: typeof getSupabase;
}

export function createSupabaseConceptMasteryFetcher(
  opts: SupabaseConceptMasteryFetcherOptions = {},
): ConceptMasteryFetcher {
  const getDb = opts.getDb ?? getSupabase;

  return {
    async listConceptState(args) {
      const limit = clampLimit(args.limit);
      const sb = getDb();
      if (!sb) {
        return {
          ok: false,
          concepts_explained: [],
          concepts_mastered: [],
          dyk_cards_seen: [],
          reason: 'supabase_unconfigured',
        };
      }
      try {
        const { data, error } = await sb
          .from('user_assistant_state')
          .select(
            'signal_name, value, count, confidence, source, last_seen_at',
          )
          .eq('tenant_id', args.tenantId)
          .eq('user_id', args.userId)
          .or(
            "signal_name.like.concept_explained:%,signal_name.like.concept_mastery:%,signal_name.like.dyk_card_seen:%",
          )
          .order('last_seen_at', { ascending: false })
          .limit(limit);
        if (error) {
          return {
            ok: false,
            concepts_explained: [],
            concepts_mastered: [],
            dyk_cards_seen: [],
            reason: error.message,
          };
        }
        const rows = Array.isArray(data) ? data : [];
        const split = splitByFamily(rows);
        return { ok: true, ...split };
      } catch (e) {
        return {
          ok: false,
          concepts_explained: [],
          concepts_mastered: [],
          dyk_cards_seen: [],
          reason: (e as Error).message,
        };
      }
    },
  };
}

export const defaultConceptMasteryFetcher = createSupabaseConceptMasteryFetcher();

// ---------------------------------------------------------------------------
// Row mappers — exported for tests
// ---------------------------------------------------------------------------

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 200;
  return Math.max(1, Math.min(500, Math.trunc(raw)));
}

export function splitByFamily(rows: Array<Record<string, unknown>>): {
  concepts_explained: ConceptExplainedRow[];
  concepts_mastered: ConceptMasteryRow[];
  dyk_cards_seen: DykCardSeenRow[];
} {
  const concepts_explained: ConceptExplainedRow[] = [];
  const concepts_mastered: ConceptMasteryRow[] = [];
  const dyk_cards_seen: DykCardSeenRow[] = [];

  for (const row of rows) {
    const sig = typeof row.signal_name === 'string' ? row.signal_name : '';
    const colon = sig.indexOf(':');
    if (colon <= 0) continue;
    const family = sig.slice(0, colon);
    const key = sig.slice(colon + 1);
    if (!key) continue;

    if (family === 'concept_explained') {
      concepts_explained.push(mapConceptExplainedRow(row, key));
    } else if (family === 'concept_mastery') {
      concepts_mastered.push(mapConceptMasteryRow(row, key));
    } else if (family === 'dyk_card_seen') {
      dyk_cards_seen.push(mapDykCardSeenRow(row, key));
    }
  }

  return { concepts_explained, concepts_mastered, dyk_cards_seen };
}

export function mapConceptExplainedRow(
  row: Record<string, unknown>,
  concept_key: string,
): ConceptExplainedRow {
  return {
    concept_key,
    count: typeof row.count === 'number' && Number.isFinite(row.count)
      ? Math.max(0, Math.trunc(row.count))
      : 0,
    last_explained_at: String(row.last_seen_at ?? ''),
    source: typeof row.source === 'string' ? row.source : null,
  };
}

export function mapConceptMasteryRow(
  row: Record<string, unknown>,
  concept_key: string,
): ConceptMasteryRow {
  let confidence: number | null = null;
  if (typeof row.confidence === 'number' && Number.isFinite(row.confidence)) {
    confidence = Math.max(0, Math.min(1, row.confidence));
  } else if (typeof row.confidence === 'string') {
    const parsed = Number.parseFloat(row.confidence);
    if (Number.isFinite(parsed)) confidence = Math.max(0, Math.min(1, parsed));
  }
  return {
    concept_key,
    confidence,
    last_observed_at: String(row.last_seen_at ?? ''),
    source: typeof row.source === 'string' ? row.source : null,
  };
}

export function mapDykCardSeenRow(
  row: Record<string, unknown>,
  card_key: string,
): DykCardSeenRow {
  return {
    card_key,
    count: typeof row.count === 'number' && Number.isFinite(row.count)
      ? Math.max(0, Math.trunc(row.count))
      : 0,
    last_seen_at: String(row.last_seen_at ?? ''),
  };
}
