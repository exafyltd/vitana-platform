/**
 * Merchant storefront platform detection (VTID-03601, Track 4 of the
 * merchant-onboarding follow-up — CLAUDE.md §13c). A merchant pastes their
 * store URL instead of typing `connector_id`/`provider_id` by hand; this
 * fetches the page server-side and looks for known platform fingerprints
 * (Shopify, WooCommerce, Magento, BigCommerce) to pre-fill the connect form.
 *
 * SSRF guard: the URL is merchant-supplied free text reachable from an
 * authenticated portal endpoint, so it gets the same treatment as any
 * server-side fetch of an untrusted URL — protocol pinned to http/https,
 * every hop's hostname resolved and checked against private/reserved IP
 * ranges before the request is made, redirects followed manually (each hop
 * re-validated) and capped, response body capped in size, and a hard
 * timeout. This is NOT rebinding-proof: fetch() re-resolves DNS internally
 * for the actual connection after our own lookup() already validated it, so
 * a DNS answer that changes between our check and fetch's own resolution
 * (classic TOCTOU) is not caught. Closing that fully needs a fetch dispatcher
 * pinned to the validated IP (e.g. undici's `Agent` with a custom `lookup`),
 * which isn't wired here — acceptable for now because the caller must be an
 * authenticated merchant probing what is meant to be their OWN storefront,
 * not an anonymous internet-facing oracle. Flagging the gap rather than
 * silently shipping past it.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

export interface PlatformDetectionResult {
  ok: boolean;
  error?: string;
  connector_id?: string | null;
  provider_id?: string | null;
  name_hint?: string | null;
  confidence?: 'high' | 'low' | 'none';
  signals?: string[];
}

const MAX_HOPS = 3;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 1_500_000; // 1.5MB — enough to see <head>/theme markers, not enough to be a DoS vector

function isDisallowedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isDisallowedIP(ip: string): boolean {
  if (net.isIPv4(ip)) return isDisallowedIPv4(ip);
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique local
    if (low.startsWith('fe80')) return true; // link-local
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isDisallowedIPv4(mapped[1]);
    return false;
  }
  return true; // unknown address family — fail closed
}

async function assertPublicHost(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isDisallowedIP(hostname)) throw new Error('blocked_private_address');
    return;
  }
  const records = await dnsLookup(hostname, { all: true });
  if (records.length === 0) throw new Error('dns_no_records');
  for (const r of records) {
    if (isDisallowedIP(r.address)) throw new Error('blocked_private_address');
  }
}

async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      chunks.push(value);
      if (total >= maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).slice(0, maxBytes).toString('utf8');
}

/**
 * SSRF-guarded fetch, exported for reuse by any other module that needs to
 * fetch a merchant/user-supplied URL server-side (e.g. the SMART on FHIR
 * connector's `.well-known/smart-configuration` discovery, VTID-03605) —
 * see the module header for exactly what this does and does not protect
 * against (not rebinding-proof; acceptable for an authenticated caller
 * probing their own endpoint, not an anonymous oracle).
 */
export async function ssrfGuardedFetch(startUrl: string): Promise<{ headers: Headers; body: string }> {
  return guardedFetch(startUrl);
}

async function guardedFetch(startUrl: string): Promise<{ headers: Headers; body: string }> {
  let current = new URL(startUrl);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error('unsupported_protocol');
    }
    await assertPublicHost(current.hostname);
    const res = await fetch(current.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'VitanalandCommerceBot/1.0 (+https://vitanaland.com/commerce; storefront detection)',
        Accept: 'text/html,*/*',
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('redirect_without_location');
      current = new URL(loc, current);
      continue;
    }
    const body = await readBounded(res, MAX_BODY_BYTES);
    return { headers: res.headers, body };
  }
  throw new Error('too_many_redirects');
}

interface Fingerprint {
  connector_id: string;
  provider_id: string;
  name_hint: string;
  match: (body: string, headers: Headers) => boolean;
}

const FINGERPRINTS: Fingerprint[] = [
  {
    connector_id: 'shopify',
    provider_id: 'shopify_storefront',
    name_hint: 'Shopify',
    match: (body, headers) =>
      headers.has('x-shopid') ||
      headers.has('x-sorting-hat-podid') ||
      /cdn\.shopify\.com|Shopify\.shop\s*=|shopify-analytics|\/cdn\/shop\//i.test(body),
  },
  {
    connector_id: 'woocommerce',
    provider_id: 'woocommerce_rest',
    name_hint: 'WooCommerce',
    // Woo-specific markers only — plain WordPress (no Woo) must not match here.
    match: (body) => /woocommerce|wc-ajax|wc_add_to_cart_params|\/wp-json\/wc\//i.test(body),
  },
  {
    connector_id: 'magento',
    provider_id: 'magento_rest',
    name_hint: 'Magento',
    match: (body) => /Mage\.Cookies|\/static\/version\d+\/frontend\/|data-mage-init/i.test(body),
  },
  {
    connector_id: 'bigcommerce',
    provider_id: 'bigcommerce_storefront',
    name_hint: 'BigCommerce',
    match: (body) => /cdn\d*\.bigcommerce\.com|bigcommerce\.com\/s\//i.test(body),
  },
];

export async function detectPlatform(rawUrl: string): Promise<PlatformDetectionResult> {
  let url: URL;
  try {
    url = new URL(String(rawUrl ?? '').trim());
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'unsupported_protocol' };
  }

  let fetched: { headers: Headers; body: string };
  try {
    fetched = await guardedFetch(url.toString());
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'fetch_failed' };
  }

  const signals: string[] = [];
  for (const fp of FINGERPRINTS) {
    if (fp.match(fetched.body, fetched.headers)) {
      signals.push(fp.connector_id);
      return {
        ok: true,
        connector_id: fp.connector_id,
        provider_id: fp.provider_id,
        name_hint: fp.name_hint,
        confidence: 'high',
        signals,
      };
    }
  }

  // Generic WordPress (no Woo signal) — worth surfacing as a low-confidence
  // hint even though it isn't one of the connectors above.
  if (/\/wp-json\/|wp-content\//i.test(fetched.body)) {
    return {
      ok: true,
      connector_id: null,
      provider_id: null,
      name_hint: 'WordPress (no commerce plugin detected)',
      confidence: 'low',
      signals: ['wordpress'],
    };
  }

  return { ok: true, connector_id: null, provider_id: null, name_hint: null, confidence: 'none', signals: [] };
}
