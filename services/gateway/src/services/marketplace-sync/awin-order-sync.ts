/**
 * VTID-02950: Awin order-conversion sync for the Discover marketplace.
 *
 * Distinct from the older services/awin-conversions.ts, which credits an
 * entirely separate, pre-existing feature (the VCAOP "shop" flow's
 * affiliate_program/subid_map/commission_event/rewards_ledger system, built
 * around POST /api/v1/vcaop/affiliate-link). That system has no connection to
 * the Discover marketplace catalog (products/merchants) built in
 * VTID-02000 — different tables, different attribution scheme. Do not
 * conflate the two; this file is the Discover-marketplace-specific one.
 *
 * Reverse-attributes Awin Transactions API conversions back to a Discover
 * click via `clickRef` (= the compact click_id click-redirect.ts stamps into
 * the outbound Awin URL as `clickref`, see routes/click-redirect.ts). Direct
 * `product_clicks.click_id` lookup — no separate subid-mapping table needed,
 * since product_clicks already carries user_id/tenant_id/product_id per click.
 *
 * Config (JSON in marketplace_sources_config.config for source_network='awin'):
 * reuses the existing 'awin' row (same one that configures the Darwin product
 * feed) with two additional fields:
 *   {
 *     "feeds": [...],                        // already present — Darwin product feed
 *     "api_token": "...",                    // Awin Publisher API OAuth2 token
 *     "publisher_id": "2938137"              // Awin publisher/account id
 *   }
 * api_token/publisher_id are only needed for THIS order sync, not the Darwin
 * feed fetch — treat as sensitive (same handling as every other credential in
 * this file: DB-only, never in git/code).
 *
 * Idempotent: upserts product_orders keyed on the existing
 * uniq_product_orders_external (merchant_id, external_order_id) constraint —
 * re-pulls (and later status changes: pending -> approved) upsert in place.
 */

import { getSupabase } from '../../lib/supabase';
import { creditRecommenderForOrder } from '../recommendation-commissions/credit-recommender';

const AWIN_API_BASE = 'https://api.awin.com';
/** Awin caps a single transactions query at a 31-day range. */
const MAX_LOOKBACK_DAYS = 31;

export interface AwinOrderSyncConfig {
  publisherId: string;
  apiToken: string;
}

export interface AwinTransaction {
  id: number | string;
  advertiserId?: number | string;
  commissionStatus?: string; // pending | approved | declined | deleted
  clickRef?: string; // our click_id, stamped as `clickref` at redirect time
  commissionAmount?: { amount?: number; currency?: string };
  saleAmount?: { amount?: number; currency?: string };
}

export interface AwinOrderSyncResult {
  ok: boolean;
  fetched: number;
  attributed: number;
  credited: number;
  unattributed: number;
  error?: string;
}

/** Map an Awin commissionStatus to our product_orders.state. */
function mapAwinStatus(raw: string): 'pending' | 'converted' | 'refunded' | 'cancelled' {
  const s = (raw || '').toLowerCase().trim();
  if (['approved', 'confirmed', 'paid'].includes(s)) return 'converted';
  if (['declined', 'rejected', 'deleted', 'cancelled', 'canceled'].includes(s)) return 'cancelled';
  return 'pending';
}

function dateParam(d: Date): string {
  return d.toISOString().slice(0, 19);
}

async function loadAwinOrderSyncConfig(): Promise<AwinOrderSyncConfig | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase
    .from('marketplace_sources_config')
    .select('config')
    .eq('source_network', 'awin')
    .eq('is_active', true)
    .maybeSingle();
  const config = data?.config as { api_token?: string; publisher_id?: string } | undefined;
  if (!config?.api_token || !config?.publisher_id) return null;
  return { publisherId: config.publisher_id, apiToken: config.api_token };
}

async function fetchTransactions(
  cfg: AwinOrderSyncConfig,
  dateType: 'transaction' | 'validation',
  startIso: string,
  endIso: string
): Promise<AwinTransaction[]> {
  const url =
    `${AWIN_API_BASE}/publishers/${cfg.publisherId}/transactions/` +
    `?startDate=${encodeURIComponent(startIso)}&endDate=${encodeURIComponent(endIso)}` +
    `&timezone=UTC&dateType=${dateType}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${cfg.apiToken}` } });
  if (!resp.ok) throw new Error(`Awin transactions (${dateType}) HTTP ${resp.status}`);
  const data = (await resp.json()) as AwinTransaction[] | { transactions?: AwinTransaction[] };
  return Array.isArray(data) ? data : (data.transactions ?? []);
}

async function pullUniqueTransactions(cfg: AwinOrderSyncConfig, lookbackDays: number): Promise<AwinTransaction[]> {
  const now = new Date();
  const start = dateParam(new Date(now.getTime() - lookbackDays * 86_400_000));
  const end = dateParam(now);
  const byTx = new Map<string, AwinTransaction>();
  for (const dateType of ['transaction', 'validation'] as const) {
    let list: AwinTransaction[] = [];
    try {
      list = await fetchTransactions(cfg, dateType, start, end);
    } catch (e) {
      console.warn(`[awin-order-sync] transactions pull (${dateType}) failed:`, e);
    }
    for (const tx of list) {
      if (tx?.id !== undefined && tx.id !== null) byTx.set(String(tx.id), tx);
    }
  }
  return [...byTx.values()];
}

/**
 * Pulls Awin transactions and upserts matching product_orders rows. Skips
 * (with a null return per-item, not an error) any transaction whose clickRef
 * doesn't resolve to a known Discover click — those are organic/other-surface
 * Awin sales, not ours to attribute.
 */
export async function runAwinOrderSync(lookbackDays = 30): Promise<AwinOrderSyncResult> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, fetched: 0, attributed: 0, credited: 0, unattributed: 0, error: 'DB_UNAVAILABLE' };

  const cfg = await loadAwinOrderSyncConfig();
  if (!cfg) {
    console.log('[awin-order-sync] no api_token/publisher_id configured — skipping');
    return { ok: true, fetched: 0, attributed: 0, credited: 0, unattributed: 0 };
  }

  const boundedLookback = Math.min(MAX_LOOKBACK_DAYS, Math.max(1, lookbackDays));
  const txns = await pullUniqueTransactions(cfg, boundedLookback);

  let attributed = 0;
  let credited = 0;
  let unattributed = 0;

  for (const tx of txns) {
    const clickId = String(tx.clickRef ?? '').trim();
    if (!clickId) {
      unattributed++;
      continue;
    }

    const { data: click } = await supabase
      .from('product_clicks')
      .select('click_id, user_id, tenant_id, product_id, merchant_id, attribution_surface, attribution_recommendation_id')
      .eq('click_id', clickId)
      .maybeSingle();
    if (!click) {
      unattributed++;
      continue;
    }
    attributed++;

    const commissionAmount = Number(tx.commissionAmount?.amount ?? 0) || 0;
    const saleAmount = Number(tx.saleAmount?.amount ?? 0) || 0;
    const currency = String(tx.commissionAmount?.currency ?? tx.saleAmount?.currency ?? 'EUR')
      .toUpperCase()
      .slice(0, 3);
    const state = mapAwinStatus(String(tx.commissionStatus ?? ''));

    const { data: upserted, error } = await supabase
      .from('product_orders')
      .upsert(
        {
          user_id: click.user_id,
          tenant_id: click.tenant_id,
          product_id: click.product_id,
          merchant_id: click.merchant_id,
          click_id: click.click_id,
          external_order_id: String(tx.id),
          checkout_mode: 'affiliate_link',
          state,
          amount_cents: Math.round(saleAmount * 100),
          currency,
          commission_cents: Math.round(commissionAmount * 100),
          raw: tx as unknown as Record<string, unknown>,
          attribution_surface: click.attribution_surface,
          attribution_recommendation_id: click.attribution_recommendation_id,
          purchased_at: state === 'converted' ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'merchant_id,external_order_id' }
      )
      .select('id')
      .single();
    if (error || !upserted) {
      console.error('[awin-order-sync] product_orders upsert failed:', error?.message);
      continue;
    }
    credited++;

    if (state === 'converted' && click.attribution_recommendation_id) {
      await creditRecommenderForOrder(upserted.id).catch((e) =>
        console.error('[awin-order-sync] creditRecommenderForOrder failed (non-fatal):', e)
      );
    }
  }

  console.log(
    `[awin-order-sync] done — fetched ${txns.length}, attributed ${attributed}, credited ${credited}, unattributed ${unattributed}`
  );
  return { ok: true, fetched: txns.length, attributed, credited, unattributed };
}
