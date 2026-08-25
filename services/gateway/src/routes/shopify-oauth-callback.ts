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
import * as repo from './shopify-oauth-callback-repository';

async function emitOasisEvent(supabase: any, type: string, status: string, message: string, payload: Record<string, unknown>) {
  try {
    await repo.insertOasisEvent(supabase, {
      id: randomUUID(), service: 'vcaop', source: 'vcaop-shopify-oauth', type, topic: type, status, message,
      metadata: payload, created_at: new Date().toISOString(),
    });
  } catch { /* never block the request on the audit write */ }
}

const router = Router();

// Shopify's own server-to-browser redirect carries no bearer token to
// check — HMAC + signed state (see services/shopify-oauth.ts) are this
// route's actual authentication.
router.get('/callback', async (req: Request, res: Response) => { // public-route
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

  const { data: rec } = await repo.fetchIntegrationManifestById(supabase, decoded.manifestId);
  if (!rec || rec.connector_id !== 'shopify') {
    return res.status(404).json({ ok: false, error: 'connection not found' });
  }

  const token = await exchangeCodeForToken(shop, code);
  if (!token.ok || !token.access_token) {
    return res.status(502).json({ ok: false, error: token.error ?? 'token_exchange_failed' });
  }

  const now = new Date().toISOString();
  const { error: upsertError } = await repo.upsertPartnerOauthCredential(supabase, {
    id: randomUUID(),
    manifest_id: rec.id,
    provider: 'shopify',
    endpoint_domain: shop,
    access_token: token.access_token,
    scope: token.scope ?? null,
    updated_at: now,
  });
  if (upsertError) {
    await emitOasisEvent(supabase, 'vcaop.portal.connection.shopify_credential_persist_failed', 'error',
      `connection ${rec.id}: shopify OAuth code exchanged but credential write failed: ${upsertError.message ?? 'unknown error'}`, {
        connection_id: rec.id, shop_domain: shop, surface: 'merchant_self_service',
      });
    return res.status(502).json({ ok: false, error: 'credential_persist_failed' });
  }

  // A completed OAuth exchange is authorization; move the connection into
  // mapping the same way an OpenAPI-document connection does at creation.
  const advanced = canTransition(rec.status, 'mapping');
  if (advanced) {
    await repo.updateIntegrationManifestStatus(supabase, rec.id, 'mapping', now);
  }

  await emitOasisEvent(supabase, 'vcaop.portal.connection.shopify_authorized', 'success',
    `connection ${rec.id}: shopify OAuth completed for ${shop}${advanced ? ` (${rec.status} -> mapping)` : ''}`, {
      connection_id: rec.id, shop_domain: shop, from: rec.status, to: advanced ? 'mapping' : rec.status, surface: 'merchant_self_service',
    });

  res.json({ ok: true, data: { connection_id: rec.id, shop_domain: shop } });
});

export default router;
