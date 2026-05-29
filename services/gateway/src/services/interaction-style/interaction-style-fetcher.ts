/**
 * VTID-02962 (B6) — Supabase-backed interaction-style fetcher.
 *
 * Reads ONE row of `user_assistant_state` for
 * `signal_name = 'interaction_style_v1'`. Read-only by design — writing
 * the preference is a UI concern that lands in a later phase. Adding an
 * `upsert*` here would violate the B6 wall.
 *
 * Failure policy: any Supabase error returns `row: null` + source-
 * health flagged. We never throw upward — interaction-style is an
 * enrichment layer, never a wake-blocker. A missing row (PGRST116 from
 * `.single()`) is NOT a failure; it just means the user has no recorded
 * preference yet.
 */

import { getSupabase } from '../../lib/supabase';
import type { InteractionStyleSignalRow, InteractionStyleSignalValue } from './types';

/** Canonical signal name for B6. Versioned so a future schema bump can
 *  coexist without overwriting. */
export const INTERACTION_STYLE_SIGNAL_NAME = 'interaction_style_v1';

export interface InteractionStyleFetcher {
  fetchInteractionStyleRow(args: {
    tenantId: string;
    userId: string;
  }): Promise<{
    ok: boolean;
    /** Null when no row exists (steady-state default for new users). */
    row: InteractionStyleSignalRow | null;
    reason?: string;
  }>;
}

export interface SupabaseInteractionStyleFetcherOptions {
  getDb?: typeof getSupabase;
}

export function createSupabaseInteractionStyleFetcher(
  opts: SupabaseInteractionStyleFetcherOptions = {},
): InteractionStyleFetcher {
  const getDb = opts.getDb ?? getSupabase;

  return {
    async fetchInteractionStyleRow(args) {
      const sb = getDb();
      if (!sb) return { ok: false, row: null, reason: 'supabase_unconfigured' };
      try {
        const { data, error } = await sb
          .from('user_assistant_state')
          .select('value, confidence, updated_at, last_seen_at')
          .eq('tenant_id', args.tenantId)
          .eq('user_id', args.userId)
          .eq('signal_name', INTERACTION_STYLE_SIGNAL_NAME)
          .maybeSingle();
        if (error) return { ok: false, row: null, reason: error.message };
        if (!data) return { ok: true, row: null };
        return { ok: true, row: mapRow(data as Record<string, unknown>) };
      } catch (e) {
        return { ok: false, row: null, reason: (e as Error).message };
      }
    },
  };
}

export const defaultInteractionStyleFetcher = createSupabaseInteractionStyleFetcher();

// ---------------------------------------------------------------------------
// Row mapping — exported for tests
// ---------------------------------------------------------------------------

export function mapRow(
  row: Record<string, unknown>,
): InteractionStyleSignalRow {
  const rawValue = row.value;
  const value: InteractionStyleSignalValue =
    rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
      ? (rawValue as InteractionStyleSignalValue)
      : {};
  const confidence = coerceConfidence(row.confidence);
  const updated_at = coerceIso(row.updated_at);
  const last_seen_at = coerceIso(row.last_seen_at);
  return { value, confidence, updated_at, last_seen_at };
}

function coerceConfidence(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string') n = Number.parseFloat(raw);
  else return null;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function coerceIso(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return raw;
}
