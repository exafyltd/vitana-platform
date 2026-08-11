/**
 * Shopify OAuth callback (VTID-03603, Track 2 of the merchant-onboarding
 * follow-up). PUBLIC route — Shopify redirects the merchant's own browser
 * here after they approve the app; there is no bearer token to check, so
 * this deliberately sits outside vcaop-portal-my.ts's requireAuth router.
 * The manifest id (and therefore "who this belongs to") comes from the
 * signed `state` param minted by POST .../shopify/authorize, never from the
 * request itself — see services/shopify-oauth.ts for the HMAC/state design.
 *
 * Dormant until SHOPIFY_CLIENT_ID/SECRET are configured — see that module's
 * header for why nothing can reach this in a real deployment yet.
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase';
import { canTransition } from './vcaop-portal';
import {
  isShopifyOAuthConfigured,
  isValidShopDomain,
  verifyCallbackHmac,
  decodeAndVerifyState,
  exchangeCodeForToken,
} from '../services/shopify-oauth';

async function emitOasisEvent(supabase: any, type: string, status: string, message: string, payload: Record<string, unknown>) {
  try {
    await supabase.from('oasis_events').insert({
      id: randomUUID(), service: 'vcaop', source: 'vcaop-shopify-oauth', type, topic: type, status, message,
      metadata: payload, created_at: new Date().toISOString(),
    });
  } catch { /* never block the request on the audit write */ }
}

const router = Router();

router.get('/callback', async (req: Request, res: Response) => {
  if (!isShopifyOAuthConfigured()) {
    return res.status(503).json({ ok: false, error: 'not_configured' });
  }

  const { code, shop, state } = req.query as Record<string, string | undefined>;
  if (!code || !shop || !state || !isValidShopDomain(shop)) {
    return res.status(400).json({ ok: false, error: 'invalid_callback_request' });
  }

  // Verify BEFORE trusting anything else in the query string.
  if (!verifyCallbackHmac(req.query as Record<string, string | undefined>)) {
    return res.status(401).json({ ok: false, error: 'invalid_hmac' });
  }
  const decoded = decodeAndVerifyState(state);
  if (!decoded) {
    return res.status(401).json({ ok: false, error: 'invalid_or_expired_state' });
  }

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'database unavailable' });

  const { data: rec } = await supabase
    .from('integration_manifest')
    .select('id,connector_id,status')
    .eq('id', decoded.manifestId)
    .maybeSingle();
  if (!rec || rec.connector_id !== 'shopify') {
    return res.status(404).json({ ok: false, error: 'connection not found' });
  }

  const token = await exchangeCodeForToken(shop, code);
  if (!token.ok || !token.access_token) {
    return res.status(502).json({ ok: false, error: token.error ?? 'token_exchange_failed' });
  }

  const now = new Date().toISOString();
  await supabase.from('partner_oauth_credential').upsert(
    {
      id: randomUUID(),
      manifest_id: rec.id,
      provider: 'shopify',
      shop_domain: shop,
      access_token: token.access_token,
      scope: token.scope ?? null,
      updated_at: now,
    },
    { onConflict: 'manifest_id,provider' },
  );

  // A completed OAuth exchange is authorization; move the connection into
  // mapping the same way an OpenAPI-document connection does at creation.
  const advanced = canTransition(rec.status, 'mapping');
  if (advanced) {
    await supabase.from('integration_manifest').update({ status: 'mapping', updated_at: now }).eq('id', rec.id);
  }

  await emitOasisEvent(supabase, 'vcaop.portal.connection.shopify_authorized', 'success',
    `connection ${rec.id}: shopify OAuth completed for ${shop}${advanced ? ` (${rec.status} -> mapping)` : ''}`, {
      connection_id: rec.id, shop_domain: shop, from: rec.status, to: advanced ? 'mapping' : rec.status, surface: 'merchant_self_service',
    });

  res.json({ ok: true, data: { connection_id: rec.id, shop_domain: shop } });
});

export default router;
