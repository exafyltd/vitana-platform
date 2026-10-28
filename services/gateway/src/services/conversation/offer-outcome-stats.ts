/**
 * VTID-04421 (Plan v1 WS-2.4) — reads over conversation_offer_outcomes.
 *
 * One row per offered action, settled by its first outcome (offer-outcomes.ts
 * writes it). The per-provider counts come from the service-role-only
 * `conversation_offer_outcome_stats` function, so the Command Hub view and the
 * WS-2.2 scorer read an indexed table, never `oasis_events`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface OfferOutcomeStatRow {
  provider: string;
  made: number;
  accepted: number;
  declined: number;
  ignored: number;
  open: number;
  /** accepted / (accepted + declined + ignored); null until one offer settled. */
  acceptance_rate: number | null;
}

export const OFFER_STATS_MAX_DAYS = 90;

function n(v: unknown): number {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

export function toOfferOutcomeStatRow(raw: Record<string, unknown>): OfferOutcomeStatRow {
  const accepted = n(raw.accepted);
  const declined = n(raw.declined);
  const ignored = n(raw.ignored);
  const settled = accepted + declined + ignored;
  return {
    provider: String(raw.provider ?? 'unknown'),
    made: n(raw.made),
    accepted,
    declined,
    ignored,
    open: n(raw.open),
    acceptance_rate: settled > 0 ? Math.round((accepted / settled) * 1000) / 1000 : null,
  };
}

export async function readOfferOutcomeStats(
  sb: SupabaseClient,
  opts: { days: number; userId?: string | null; nowMs?: number },
): Promise<{ rows: OfferOutcomeStatRow[]; error: string | null }> {
  const days = Math.min(Math.max(Math.round(opts.days) || 7, 1), OFFER_STATS_MAX_DAYS);
  const since = new Date((opts.nowMs ?? Date.now()) - days * 86_400_000).toISOString();
  const { data, error } = await sb.rpc('conversation_offer_outcome_stats', {
    p_since: since,
    ...(opts.userId ? { p_user_id: opts.userId } : {}),
  });
  if (error) return { rows: [], error: error.message };
  return { rows: ((data || []) as Array<Record<string, unknown>>).map(toOfferOutcomeStatRow), error: null };
}
