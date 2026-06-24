/**
 * VCAOP Awin programme sync (affiliate rewards network).
 *
 * Uses the Awin Publisher API to list the programmes this publisher has JOINED
 * and upserts each as an affiliate_program row (cashback=true) with an Awin
 * cread.php deeplink base + `clickref` SubID — which plugs straight into the
 * existing /affiliate-link endpoint. As advertiser approvals land, they auto-wire.
 *
 * Conversion crediting (Awin transactions -> rewards) is a separate pull-based
 * worker (Phase 2) — Awin reports conversions via its API, not a postback.
 */
import { getSupabase } from '../lib/supabase';

export interface AwinSyncConfig {
  publisherId: string;
  apiToken: string;
  apiBase: string;
}

export interface AwinSyncResult { ok: boolean; fetched: number; upserted: number }

export interface AwinProgramme {
  id: number;
  name: string;
  primarySector?: string;
  currencyCode?: string;
  status?: string;
  primaryRegion?: { countryCode?: string };
}

/** Build the sync config from env, or null if not configured. */
export function resolveAwinConfig(): AwinSyncConfig | null {
  const publisherId = process.env.AWIN_PUBLISHER_ID || '';
  const apiToken = process.env.AWIN_API_TOKEN || '';
  if (!publisherId || !apiToken) return null;
  return { publisherId, apiToken, apiBase: process.env.AWIN_API_BASE || 'https://api.awin.com' };
}

/** Map an Awin joined-programme onto an affiliate_program row. */
export function mapAwinProgramme(p: AwinProgramme, cfg: AwinSyncConfig): Record<string, unknown> | null {
  if (!p || !p.id || !p.name) return null;
  return {
    id: `awin_${p.id}`,
    network: 'awin',
    merchant: p.name,
    commission_terms: {
      market: p.primaryRegion?.countryCode ?? null,
      sector: p.primarySector ?? null,
      currency: p.currencyCode ?? null,
      awin_mid: String(p.id),
    },
    affiliate_cashback_allowed: true,
    policy: {
      affiliate_cashback_allowed: true,
      gotolink: `https://www.awin1.com/cread.php?awinmid=${p.id}&awinaffid=${cfg.publisherId}`,
      subid_param: 'clickref',
      deeplink_param: 'ued',
      notes: `Awin publisher ${cfg.publisherId}. ${p.primarySector ?? 'general'} / ${p.primaryRegion?.countryCode ?? 'XX'}.`,
    },
    source: 'aggregator',
    updated_at: new Date().toISOString(),
  };
}

async function fetchJoinedProgrammes(cfg: AwinSyncConfig): Promise<AwinProgramme[]> {
  const url = `${cfg.apiBase}/publishers/${cfg.publisherId}/programmes?relationship=joined`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.apiToken}` } });
  if (!res.ok) throw new Error(`awin programmes HTTP ${res.status}`);
  const data = (await res.json()) as AwinProgramme[] | { programmes?: AwinProgramme[] };
  return Array.isArray(data) ? data : (data.programmes || []);
}

/** Harvest joined programmes and upsert them as affiliate_program rows. */
export async function syncAwinProgrammes(supabase: any, cfg: AwinSyncConfig): Promise<AwinSyncResult> {
  const programmes = await fetchJoinedProgrammes(cfg);
  const rows = programmes
    .map((p) => mapAwinProgramme(p, cfg))
    .filter((r): r is Record<string, unknown> => r !== null);

  let upserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error } = await supabase.from('affiliate_program').upsert(chunk, { onConflict: 'id' });
    if (error) throw new Error(error.message);
    upserted += chunk.length;
  }
  return { ok: true, fetched: programmes.length, upserted };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Env-gated background worker: periodically harvests joined Awin programmes. */
export function startAwinSyncWorker(): void {
  if (process.env.AWIN_SYNC_ENABLED !== 'true') {
    console.log('⏸️ Awin sync worker disabled (set AWIN_SYNC_ENABLED=true to enable)');
    return;
  }
  const cfg = resolveAwinConfig();
  if (!cfg) {
    console.warn('⚠️ Awin sync enabled but AWIN_PUBLISHER_ID / AWIN_API_TOKEN not set — skipping');
    return;
  }
  const intervalMs = Math.max(60_000, Number(process.env.AWIN_SYNC_INTERVAL_MS) || 3_600_000);
  const run = async () => {
    try {
      const supabase = getSupabase();
      if (!supabase) return;
      const r = await syncAwinProgrammes(supabase, cfg);
      console.log(`🔗 Awin sync: ${r.upserted}/${r.fetched} joined programmes (publisher ${cfg.publisherId})`);
    } catch (e) {
      console.warn('⚠️ Awin sync run failed (non-fatal):', e);
    }
  };
  if (timer) clearInterval(timer);
  void run();
  timer = setInterval(() => void run(), intervalMs);
  console.log(`🔗 Awin sync worker started (every ${Math.round(intervalMs / 60000)}m) for publisher ${cfg.publisherId}`);
}
