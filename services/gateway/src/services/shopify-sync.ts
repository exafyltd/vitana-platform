/**
 * VCAOP Shopify catalog sync (own-store products -> /discover).
 *
 * Pulls a Shopify store's public products feed (products.json) and upserts the
 * products into the consumer catalog (public.products) under a dedicated
 * own-store merchant, so they surface in /discover. Prices are converted to EUR
 * (the catalog currency); BAM (the "KM" mark) uses the fixed euro peg.
 *
 * Own-store products: full margin; affiliate_url points to the Shopify product
 * page; rewards are funded by margin (no affiliate commission). Idempotent: each
 * product gets a deterministic id so re-syncs upsert in place rather than dupe.
 */
import { createHash } from 'crypto';
import { getSupabase } from '../lib/supabase';

export interface ShopifySyncConfig {
  domain: string;              // e.g. 54n0fa-ir.myshopify.com
  storefrontPassword?: string; // only needed if the storefront is password-gated
  sourceCurrency: string;      // store currency (prices in products.json), e.g. BAM
  merchantId: string;          // catalog merchant uuid for this store
  merchantName: string;
}

export interface ShopifySyncResult {
  ok: boolean;
  merchantId: string;
  fetched: number;
  upserted: number;
}

// Fixed euro pegs (no FX drift). BAM = Bosnian convertible mark, pegged to EUR.
const FIXED_PEG_TO_EUR: Record<string, number> = { EUR: 1, BAM: 1.95583 };

export const SHOPIFY_MERCHANT_ID = 'a7e3c1d0-0000-4000-8000-000000000001';

/** Convert a store-currency price to EUR cents at the fixed peg. */
export function toEurCents(price: number, sourceCurrency: string): number | null {
  if (!Number.isFinite(price)) return null;
  const rate = FIXED_PEG_TO_EUR[(sourceCurrency || 'EUR').toUpperCase()] ?? 1;
  return Math.round((price / rate) * 100);
}

/** Deterministic uuid (v4-shaped) from a stable key, for idempotent upserts. */
export function deterministicUuid(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface ShopifyVariant { price?: string; available?: boolean }
interface ShopifyImage { src?: string }
export interface ShopifyProduct {
  id: number; title: string; handle: string; vendor?: string; product_type?: string;
  body_html?: string; variants?: ShopifyVariant[]; images?: ShopifyImage[];
}

/** Map a Shopify products.json product onto a public.products row. */
export function mapShopifyProduct(p: ShopifyProduct, cfg: ShopifySyncConfig): Record<string, unknown> | null {
  if (!p || !p.id || !p.title) return null;
  const v0 = (p.variants || [])[0];
  const sourceProductId = String(p.id);
  return {
    id: deterministicUuid(`shopify:${cfg.domain}:${sourceProductId}`),
    merchant_id: cfg.merchantId,
    source_network: 'shopify',
    source_product_id: sourceProductId,
    title: p.title,
    description: (p.body_html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000) || null,
    brand: p.vendor || cfg.merchantName,
    category: p.product_type || 'supplements',
    price_cents: v0 ? toEurCents(Number(v0.price), cfg.sourceCurrency) : null,
    currency: 'EUR',
    affiliate_url: `https://${cfg.domain}/products/${p.handle}`,
    images: (p.images || []).map((i) => i.src).filter((s): s is string => Boolean(s)),
    availability: v0 && v0.available ? 'in_stock' : 'out_of_stock',
    ships_to_countries: ['DE', 'AT', 'CH', 'ES', 'BA', 'AE'],
    ships_to_regions: ['EU', 'MENA', 'GLOBAL'],
    origin_country: 'DE',
    origin_region: 'EU',
    is_active: true,
    updated_at: new Date().toISOString(),
  };
}

/** Read all Set-Cookie headers off a response (array form when available). */
function getSetCookies(res: Response): string[] {
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}

/** Fold Set-Cookie strings into a name->value jar (first `name=value` pair only). */
export function mergeSetCookies(jar: Record<string, string>, setCookies: string[]): Record<string, string> {
  for (const sc of setCookies) {
    const first = (sc.split(';')[0] || '').trim();
    const eq = first.indexOf('=');
    if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return jar;
}

/** Serialize a cookie jar into a Cookie request header. */
export function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchProductsJson(cfg: ShopifySyncConfig): Promise<ShopifyProduct[]> {
  const base = `https://${cfg.domain}`;
  let res = await fetch(`${base}/products.json?limit=250`);
  // Password-protected storefronts return 401 — do the storefront-password handshake.
  // Shopify needs BOTH the `_shopify_essential` cookie set by GET /password AND the
  // `storefront_digest` cookie set by the POST, so we accumulate a single cookie jar
  // across the whole exchange (mirrors a browser / curl cookie jar). The
  // authenticity_token is optional here — the cookie jar is what authorizes access.
  if (res.status === 401 && cfg.storefrontPassword) {
    const jar: Record<string, string> = {};
    const page = await fetch(`${base}/password`);
    mergeSetCookies(jar, getSetCookies(page));
    const html = await page.text();
    const m = /name="authenticity_token"[^>]*value="([^"]+)"/.exec(html);
    const body = new URLSearchParams({
      form_type: 'storefront_password',
      utf8: '✓',
      authenticity_token: m ? m[1] : '',
      password: cfg.storefrontPassword,
    });
    const login = await fetch(`${base}/password`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) }, body,
    });
    mergeSetCookies(jar, getSetCookies(login));
    res = await fetch(`${base}/products.json?limit=250`, { headers: { cookie: cookieHeader(jar) } });
  }
  if (!res.ok) throw new Error(`products.json HTTP ${res.status}`);
  const data = (await res.json()) as { products?: ShopifyProduct[] };
  return data.products || [];
}

/** Build the sync config from env, or null if no store domain is configured. */
export function resolveShopifyConfig(): ShopifySyncConfig | null {
  const domain = process.env.SHOPIFY_STORE_DOMAIN || '';
  if (!domain) return null;
  return {
    domain,
    storefrontPassword: process.env.SHOPIFY_STOREFRONT_PASSWORD || undefined,
    sourceCurrency: process.env.SHOPIFY_SOURCE_CURRENCY || 'BAM',
    merchantId: SHOPIFY_MERCHANT_ID,
    merchantName: process.env.SHOPIFY_MERCHANT_NAME || 'Vitanaland (Shopify)',
  };
}

/** Fetch the Shopify feed and upsert merchant + products into the catalog. */
export async function syncShopifyCatalog(supabase: any, cfg: ShopifySyncConfig): Promise<ShopifySyncResult> {
  await supabase.from('merchants').upsert({
    id: cfg.merchantId, name: cfg.merchantName, source_network: 'shopify',
    currencies: ['EUR'], is_active: true, updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });

  const products = await fetchProductsJson(cfg);
  const rows = products
    .map((p) => mapShopifyProduct(p, cfg))
    .filter((r): r is Record<string, unknown> => r !== null);

  let upserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error } = await supabase.from('products').upsert(chunk, { onConflict: 'id' });
    if (error) throw new Error(error.message);
    upserted += chunk.length;
  }
  return { ok: true, merchantId: cfg.merchantId, fetched: products.length, upserted };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Env-gated background worker: periodically re-syncs the Shopify catalog. */
export function startShopifySyncWorker(): void {
  if (process.env.SHOPIFY_SYNC_ENABLED !== 'true') {
    console.log('⏸️ Shopify sync worker disabled (set SHOPIFY_SYNC_ENABLED=true to enable)');
    return;
  }
  const cfg = resolveShopifyConfig();
  if (!cfg) {
    console.warn('⚠️ Shopify sync enabled but SHOPIFY_STORE_DOMAIN not set — skipping');
    return;
  }
  const intervalMs = Math.max(60_000, Number(process.env.SHOPIFY_SYNC_INTERVAL_MS) || 3_600_000);
  const run = async () => {
    try {
      const supabase = getSupabase();
      if (!supabase) return;
      const r = await syncShopifyCatalog(supabase, cfg);
      console.log(`🛍️ Shopify sync: ${r.upserted}/${r.fetched} products from ${cfg.domain}`);
    } catch (e) {
      console.warn('⚠️ Shopify sync run failed (non-fatal):', e);
    }
  };
  if (timer) clearInterval(timer);
  void run(); // initial run on boot
  timer = setInterval(() => void run(), intervalMs);
  console.log(`🛍️ Shopify sync worker started (every ${Math.round(intervalMs / 60000)}m) for ${cfg.domain}`);
}
