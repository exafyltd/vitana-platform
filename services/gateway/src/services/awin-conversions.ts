/**
 * VCAOP Awin conversion crediting (Phase 2 — pull-based, no postback).
 *
 * Unlike Admitad (which calls our public postback), Awin reports conversions via
 * its Publisher Transactions API. This worker periodically pulls transactions,
 * reverse-attributes each by its `clickRef` (= the per-member SubID we minted at
 * affiliate-link time) back to a member via `subid_map`, and idempotently moves
 * the rewards_ledger entry through pending -> confirmed (approved) | reversed
 * (declined/deleted) — exactly mirroring the Admitad postback's ledger semantics.
 *
 * Idempotent: each credit gets a deterministic id keyed on the Awin transaction
 * id + SubID, so re-pulls upsert the same rows (no double-credit) and status
 * changes (pending -> approved, later reversed) just overwrite in place. The pull
 * runs over two date windows — `transaction` (catches new sales) and `validation`
 * (catches later status changes) — and dedupes by transaction id.
 */
import { createHash } from 'crypto';
import { getSupabase } from '../lib/supabase';
import { resolveAwinConfig } from './awin-sync';

/** Member share of the gross commission (mirrors the /shop + postback 50% split). */
const DEFAULT_MEMBER_SHARE = 0.5;
/** Awin caps a single transactions query at a 31-day range. */
const MAX_LOOKBACK_DAYS = 31;

export interface AwinTxConfig {
  publisherId: string;
  apiToken: string;
  apiBase: string;
  lookbackDays: number;
  memberShare: number;
}

export interface AwinTransaction {
  id: number | string;
  advertiserId?: number | string;
  commissionStatus?: string;          // pending | approved | declined | deleted
  clickRef?: string;                  // our per-member SubID (sub_...)
  commissionAmount?: { amount?: number; currency?: string };
  saleAmount?: { amount?: number; currency?: string };
}

export interface AwinConversionResult {
  ok: boolean;
  fetched: number;       // unique transactions pulled
  attributed: number;    // matched to a member via subid_map
  credited: number;      // rows whose state actually changed (upserted + emitted)
  unattributed: number;  // clickRefs not found in subid_map (organic / other)
}

/** A normalized credit intent derived from one Awin transaction. */
export interface AwinCredit {
  txId: string;
  subId: string;
  advertiserId: string;
  gross: number;
  currency: string;
  state: 'pending' | 'confirmed' | 'reversed';
}

/** Build the conversion-pull config from env, or null if Awin isn't configured. */
export function resolveAwinTxConfig(): AwinTxConfig | null {
  const base = resolveAwinConfig();
  if (!base) return null;
  const lookbackDays = Math.min(
    MAX_LOOKBACK_DAYS,
    Math.max(1, Number(process.env.AWIN_CONVERSIONS_LOOKBACK_DAYS) || 30),
  );
  const rawShare = Number(process.env.AWIN_MEMBER_SHARE);
  const memberShare = Number.isFinite(rawShare) && rawShare > 0 && rawShare <= 1 ? rawShare : DEFAULT_MEMBER_SHARE;
  return { ...base, lookbackDays, memberShare };
}

/** Map an Awin commissionStatus to our ledger state. */
export function mapAwinTxStatus(raw: string): 'pending' | 'confirmed' | 'reversed' {
  const s = (raw || '').toLowerCase().trim();
  if (['approved', 'confirmed', 'paid'].includes(s)) return 'confirmed';
  if (['declined', 'rejected', 'deleted', 'reversed', 'cancelled', 'canceled'].includes(s)) return 'reversed';
  return 'pending';
}

/** Awin transactions API date param: `YYYY-MM-DDTHH:mm:ss` (no milliseconds/Z). */
export function awinDateParam(d: Date): string {
  return d.toISOString().slice(0, 19);
}

/** Deterministic credit ids so re-pulls upsert in place (no double-credit). */
export function awinCreditIds(txId: string, subId: string): { commissionId: string; rewardId: string } {
  const fp = createHash('sha256').update(`awin:${txId}:${subId}`).digest('hex');
  return { commissionId: 'cm_' + fp.slice(0, 24), rewardId: 'rw_' + fp.slice(0, 24) };
}

/** Normalize one Awin transaction into a credit intent, or null if unusable. */
export function mapAwinTransaction(tx: AwinTransaction): AwinCredit | null {
  if (!tx || tx.id === undefined || tx.id === null) return null;
  const subId = String(tx.clickRef || '').trim();
  if (!subId) return null; // no SubID -> can't attribute to a member
  const gross = Number(tx.commissionAmount?.amount ?? 0) || 0;
  const currency = String(tx.commissionAmount?.currency || tx.saleAmount?.currency || 'EUR').toUpperCase().slice(0, 8);
  return {
    txId: String(tx.id),
    subId,
    advertiserId: String(tx.advertiserId ?? ''),
    gross: +gross.toFixed(4),
    currency,
    state: mapAwinTxStatus(String(tx.commissionStatus || '')),
  };
}

async function fetchTransactions(cfg: AwinTxConfig, dateType: 'transaction' | 'validation', startIso: string, endIso: string): Promise<AwinTransaction[]> {
  const url = `${cfg.apiBase}/publishers/${cfg.publisherId}/transactions/`
    + `?startDate=${encodeURIComponent(startIso)}&endDate=${encodeURIComponent(endIso)}`
    + `&timezone=UTC&dateType=${dateType}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.apiToken}` } });
  if (!res.ok) throw new Error(`awin transactions (${dateType}) HTTP ${res.status}`);
  const data = (await res.json()) as AwinTransaction[] | { transactions?: AwinTransaction[] };
  return Array.isArray(data) ? data : (data.transactions || []);
}

/** Pull both date windows and dedupe by transaction id (validation wins — freshest status). */
async function pullUniqueTransactions(cfg: AwinTxConfig, now: Date): Promise<AwinTransaction[]> {
  const start = awinDateParam(new Date(now.getTime() - cfg.lookbackDays * 86_400_000));
  const end = awinDateParam(now);
  const byTx = new Map<string, AwinTransaction>();
  for (const dateType of ['transaction', 'validation'] as const) {
    let list: AwinTransaction[] = [];
    try {
      list = await fetchTransactions(cfg, dateType, start, end);
    } catch (e) {
      // A failure on one window shouldn't drop the other; surface but continue.
      console.warn(`⚠️ Awin transactions pull (${dateType}) failed:`, e);
    }
    for (const tx of list) {
      if (tx && tx.id !== undefined && tx.id !== null) byTx.set(String(tx.id), tx);
    }
  }
  return [...byTx.values()];
}

async function emitOasis(supabase: any, topic: string, status: string, message: string, metadata: Record<string, unknown>): Promise<void> {
  // Uses only columns present on oasis_events (no `type`), so the audit row persists.
  try {
    await supabase.from('oasis_events').insert({
      id: createHash('sha256').update(`${topic}:${message}:${JSON.stringify(metadata)}`).digest('hex').replace(
        /^(.{8})(.{4})(.{3})(.{3})(.{12}).*$/, '$1-$2-4$3-8$4-$5',
      ),
      service: 'vcaop', source: 'vcaop', topic, status, message,
      metadata, created_at: new Date().toISOString(),
    });
  } catch { /* never block crediting on the audit write */ }
}

/**
 * Pull Awin transactions and credit attributed conversions into the ledger.
 * Only writes when a commission's state actually changes (quiet on steady state).
 */
export async function creditAwinConversions(supabase: any, cfg: AwinTxConfig): Promise<AwinConversionResult> {
  const now = new Date();
  const txns = await pullUniqueTransactions(cfg, now);

  // Preload Awin program merchant names (id `awin_<advertiserId>` -> merchant) so
  // commission rows carry a human merchant label without a per-tx query.
  const merchantById = new Map<string, string>();
  try {
    const { data: progs } = await supabase.from('affiliate_program').select('id,merchant').eq('network', 'awin');
    for (const p of progs || []) merchantById.set(String(p.id), String(p.merchant || ''));
  } catch { /* enrichment is best-effort */ }

  let attributed = 0, credited = 0, unattributed = 0;
  for (const tx of txns) {
    const credit = mapAwinTransaction(tx);
    if (!credit) continue;

    const { data: map } = await supabase
      .from('subid_map')
      .select('user_id, affiliate_program_id, network')
      .eq('sub_id', credit.subId)
      .maybeSingle();
    if (!map) { unattributed++; continue; }
    attributed++;

    const programId = String(map.affiliate_program_id || (credit.advertiserId ? `awin_${credit.advertiserId}` : 'awin'));
    const merchant = merchantById.get(programId) || `awin_${credit.advertiserId || 'unknown'}`;
    const { commissionId, rewardId } = awinCreditIds(credit.txId, credit.subId);
    const nowIso = now.toISOString();

    // Skip the write when nothing changed (idempotent, quiet re-pulls).
    const { data: existing } = await supabase
      .from('commission_event').select('status').eq('id', commissionId).maybeSingle();
    if (existing && existing.status === credit.state) continue;

    const reward = +(credit.gross * cfg.memberShare).toFixed(4);
    await supabase.from('commission_event').upsert({
      id: commissionId, affiliate_program_id: programId, sub_id: credit.subId, user_id: map.user_id,
      merchant, order_ref: credit.txId, gross_commission: credit.gross, currency: credit.currency,
      status: credit.state, postback_ref: credit.txId, updated_at: nowIso,
    }, { onConflict: 'id' });
    await supabase.from('rewards_ledger').upsert({
      id: rewardId, user_id: map.user_id, commission_event_id: commissionId,
      amount: reward, currency: credit.currency, state: credit.state, updated_at: nowIso,
    }, { onConflict: 'id' });
    await emitOasis(supabase, `vcaop.reward.${credit.state}`, credit.state === 'reversed' ? 'warning' : 'success',
      `awin conversion ${credit.state}`,
      { commissionId, txId: credit.txId, subId: credit.subId, userId: map.user_id, gross: credit.gross, reward, state: credit.state });
    credited++;
  }

  return { ok: true, fetched: txns.length, attributed, credited, unattributed };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Env-gated background worker: periodically pulls + credits Awin conversions. */
export function startAwinConversionWorker(): void {
  if (process.env.AWIN_CONVERSIONS_ENABLED !== 'true') {
    console.log('⏸️ Awin conversion worker disabled (set AWIN_CONVERSIONS_ENABLED=true to enable)');
    return;
  }
  const cfg = resolveAwinTxConfig();
  if (!cfg) {
    console.warn('⚠️ Awin conversions enabled but AWIN_PUBLISHER_ID / AWIN_API_TOKEN not set — skipping');
    return;
  }
  const intervalMs = Math.max(60_000, Number(process.env.AWIN_CONVERSIONS_INTERVAL_MS) || 3_600_000);
  const run = async () => {
    try {
      const supabase = getSupabase();
      if (!supabase) return;
      const r = await creditAwinConversions(supabase, cfg);
      console.log(`💸 Awin conversions: ${r.credited} credited / ${r.attributed} attributed / ${r.fetched} pulled (${r.unattributed} unattributed)`);
    } catch (e) {
      console.warn('⚠️ Awin conversion run failed (non-fatal):', e);
    }
  };
  if (timer) clearInterval(timer);
  void run();
  timer = setInterval(() => void run(), intervalMs);
  console.log(`💸 Awin conversion worker started (every ${Math.round(intervalMs / 60000)}m) for publisher ${cfg.publisherId}`);
}
