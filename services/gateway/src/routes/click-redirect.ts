/**
 * VTID-02000: Click redirect route — GET /r/:product_id
 *
 * The user-facing redirect endpoint for affiliate click-outs. Every product
 * card's "Buy" button points here. Responsibilities:
 *
 *   1. Resolve user + effective country (from session / CF-IPCountry header).
 *   2. Geo-guard: if the product doesn't ship to the user's country, serve a
 *      friendly HTML interstitial instead of redirecting, and emit
 *      `marketplace.offer.geo_mismatch` so product-sourcing gaps surface in
 *      the admin Coverage view.
 *   3. Log the click to `product_clicks` with a stable `click_id`.
 *   4. Stamp the affiliate URL with `click_id` + user hash sub-IDs.
 *   5. Emit `marketplace.click.outbound` for the reward system.
 *   6. 302 redirect to the stamped affiliate URL.
 *
 * Notes:
 *   - Mounted at the root ('/r/:product_id'), not '/api/v1/...', because this
 *     is a user-facing link that may be copied/pasted.
 *   - No auth required — anonymous clicks are allowed; user_id is set from
 *     Bearer token if present.
 *   - Safe to fail: if anything after the geo-guard errors, we still redirect
 *     (the user experience dominates over analytics).
 */

import { Router, Request, Response } from 'express';
import { randomUUID, createHash } from 'crypto';
import * as jose from 'jose';
import { getSupabase } from '../lib/supabase';
import { emitClickOutbound, emitGeoMismatch } from '../services/reward-events';
import type { AttributionSurface } from '../types/catalog-ingest';

const router = Router();

const ATTRIBUTION_SURFACES = new Set<AttributionSurface>([
  'feed',
  'search',
  'orb',
  'autopilot',
  'share_and_earn',
  'product_detail',
  'direct',
]);

function getAttributionSurface(value: string | undefined): AttributionSurface {
  if (value && ATTRIBUTION_SURFACES.has(value as AttributionSurface)) {
    return value as AttributionSurface;
  }
  return 'direct';
}

function getCountryHeader(req: Request): string | null {
  const cf = req.headers['cf-ipcountry'];
  if (typeof cf === 'string' && cf.length === 2) return cf.toUpperCase();
  return null;
}

function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex').slice(0, 24);
}

function hashUserAgent(ua: string | undefined): string | null {
  if (!ua) return null;
  return createHash('sha256').update(ua).digest('hex').slice(0, 24);
}

/**
 * Best-effort extraction of the user_id from a Bearer JWT.
 * Does NOT verify signature — purely for attribution; read-only.
 */
function extractUserIdOptimistic(req: Request): { user_id: string | null; tenant_id: string | null } {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return { user_id: null, tenant_id: null };
    const token = authHeader.slice(7);
    const claims = jose.decodeJwt(token);
    const user_id = typeof claims.sub === 'string' ? claims.sub : null;
    const app_metadata = (claims as { app_metadata?: { active_tenant_id?: string } }).app_metadata;
    const tenant_id =
      app_metadata && typeof app_metadata.active_tenant_id === 'string'
        ? app_metadata.active_tenant_id
        : null;
    return { user_id, tenant_id };
  } catch {
    return { user_id: null, tenant_id: null };
  }
}

function stampAffiliateUrl(baseUrl: string, clickId: string, userIdHash: string | null): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('sub1', userIdHash ?? 'anon');
    url.searchParams.set('sub2', clickId.slice(0, 16));
    url.searchParams.set('sub3', clickId);
    // Amazon-specific sub-id format
    if (url.hostname.endsWith('amazon.com') || url.hostname.endsWith('amazon.de') || url.hostname.includes('amazon.')) {
      url.searchParams.set('ascsubtag', clickId);
    }
    // CJ-specific sub-id format
    if (url.hostname.includes('cj.com') || url.hostname.includes('cj.dotomi.com')) {
      url.searchParams.set('sid', clickId);
    }
    return url.toString();
  } catch {
    // Malformed URL — return as-is
    return baseUrl;
  }
}

function renderGeoInterstitial(productTitle: string, userCountry: string | null, shipsToCountries: string[] | null, shipsToRegions: string[] | null): string {
  const targetsText = shipsToCountries?.length
    ? `ships to: ${shipsToCountries.join(', ')}`
    : shipsToRegions?.length
      ? `ships to regions: ${shipsToRegions.join(', ')}`
      : 'does not currently list shipping destinations';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Product not available for your region</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 540px; margin: 80px auto; padding: 24px; color: #222; line-height: 1.55; }
    h1 { font-size: 22px; margin: 0 0 16px; }
    .note { background: #f7f7f8; padding: 16px; border-radius: 10px; margin: 16px 0; font-size: 14px; }
    a.back { display: inline-block; margin-top: 20px; padding: 10px 18px; background: #111; color: #fff; text-decoration: none; border-radius: 999px; }
  </style>
</head>
<body>
  <h1>This product does not ship to your region</h1>
  <p><strong>${escapeHtml(productTitle)}</strong> ${escapeHtml(targetsText)}${userCountry ? ", and you are in " + escapeHtml(userCountry) : ""}.</p>
  <div class="note">
    We have logged this as a coverage gap so the team can source similar products that ship to you. Meanwhile, try widening your scope in Discover to <em>international</em> if you are happy to wait longer and handle customs.
  </div>
  <a class="back" href="javascript:history.back()">Back to Discover</a>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

// ==================== GET /r/:product_id ====================

router.get('/:product_id', async (req: Request, res: Response) => {
  const productId = req.params.product_id;
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).send('Marketplace redirect unavailable.');
    return;
  }

  // Resolve user + tenant from JWT if present; otherwise attribute anonymously.
  const { user_id, tenant_id: tokenTenantId } = extractUserIdOptimistic(req);

  // Resolve product
  const { data: product, error: productErr } = await supabase
    .from('products')
    .select(
      'id, title, merchant_id, affiliate_url, origin_country, ships_to_countries, ships_to_regions, is_active'
    )
    .eq('id', productId)
    .eq('is_active', true)
    .maybeSingle();
  if (productErr || !product) {
    res.status(404).send('Product not found or no longer available.');
    return;
  }

  // Resolve user geo context
  let userCountry: string | null = null;
  let userRegion: string | null = null;
  let tenantId: string | null = tokenTenantId;
  if (user_id) {
    const { data: userRow } = await supabase
      .from('app_users')
      .select('country_code, delivery_country_code, region_group')
      .eq('user_id', user_id)
      .maybeSingle();
    userCountry = userRow?.delivery_country_code ?? userRow?.country_code ?? null;
    userRegion = userRow?.region_group ?? null;
  }
  if (!userCountry) {
    userCountry = getCountryHeader(req);
    if (userCountry) {
      const { data } = await supabase.rpc('get_region_group', { p_country_code: userCountry });
      userRegion = typeof data === 'string' ? data : null;
    }
  }

  // Geo-guard: only enforce when we know the user's country.
  let shipsToUser = true;
  if (userCountry) {
    const countryMatch = (product.ships_to_countries ?? []).includes(userCountry);
    const regionMatch = userRegion ? (product.ships_to_regions ?? []).includes(userRegion) : false;
    shipsToUser = countryMatch || regionMatch;
  }

  // Capture attribution + request metadata
  const attribution_surface = getAttributionSurface(
    typeof req.query.surface === 'string' ? req.query.surface : undefined
  );
  const attribution_recommendation_id =
    typeof req.query.rec_id === 'string' && req.query.rec_id.length > 0 ? req.query.rec_id : null;
  const ipRaw = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip ?? null;
  const userAgent = req.headers['user-agent'];

  if (!shipsToUser) {
    await emitGeoMismatch({
      user_id,
      tenant_id: tenantId,
      product_id: product.id,
      user_country: userCountry,
      product_origin_country: product.origin_country,
      product_ships_to_regions: product.ships_to_regions,
    });
    res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(
      renderGeoInterstitial(
        product.title,
        userCountry,
        product.ships_to_countries,
        product.ships_to_regions
      )
    );
    return;
  }

  // Log click + generate stable click_id
  const clickId = randomUUID();
  const userIdHash = user_id ? createHash('sha256').update(user_id).digest('hex').slice(0, 16) : null;
  const stampedUrl = stampAffiliateUrl(product.affiliate_url, clickId, userIdHash);

  // Best-effort insert — don't block redirect on click log failure
  supabase
    .from('product_clicks')
    .insert({
      click_id: clickId,
      user_id,
      tenant_id: tenantId,
      product_id: product.id,
      merchant_id: product.merchant_id,
      attribution_surface,
      attribution_recommendation_id,
      user_country: userCountry,
      user_region: userRegion,
      product_origin_country: product.origin_country,
      product_ships_to_countries: product.ships_to_countries,
      target_url: stampedUrl,
      ip_hash: hashIp(ipRaw),
      user_agent_hash: hashUserAgent(userAgent),
    })
    .then(({ error }) => {
      if (error) console.error('[click-redirect] click log insert failed (non-fatal):', error);
    });

  // Emit outbound event for reward-system consumption (fire-and-forget)
  emitClickOutbound({
    user_id,
    tenant_id: tenantId,
    product_id: product.id,
    merchant_id: product.merchant_id,
    click_id: clickId,
    attribution_surface,
    attribution_recommendation_id,
    origin_country: product.origin_country,
    ships_to_countries: product.ships_to_countries,
    target_url: stampedUrl,
  }).catch(() => {});

  res.redirect(302, stampedUrl);
});

export default router;
