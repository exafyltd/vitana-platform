/**
 * SMART on FHIR OAuth callback (VTID-03605, Track 3 of the merchant-
 * onboarding follow-up). PUBLIC route — the EHR's authorization server
 * redirects the merchant's own browser here after they approve access;
 * there is no bearer token to check, so this deliberately sits outside
 * vcaop-portal-my.ts's requireAuth router, same shape as
 * shopify-oauth-callback.ts. Everything this handler needs (manifest id,
 * FHIR base URL, client credentials, PKCE verifier, token endpoint) comes
 * from the encrypted `state` param minted by POST .../fhir/authorize, never
 * from the request itself — see services/smart-fhir-oauth.ts for why that
 * state is AES-256-GCM encrypted rather than merely signed.
 *
 * Dormant until FHIR_OAUTH_STATE_SECRET is configured — see that module's
 * header for why nothing can reach this in a real deployment yet.
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getSupabase } from '../lib/supabase';
import { canTransition } from './vcaop-portal';
import { isFhirOAuthConfigured, decodeAndVerifyState, exchangeCodeForToken } from '../services/smart-fhir-oauth';

async function emitOasisEvent(supabase: any, type: string, status: string, message: string, payload: Record<string, unknown>) {
  try {
    await supabase.from('oasis_events').insert({
      id: randomUUID(), service: 'vcaop', source: 'vcaop-fhir-oauth', type, topic: type, status, message,
      metadata: payload, created_at: new Date().toISOString(),
    });
  } catch { /* never block the request on the audit write */ }
}

const router = Router();

// The EHR authorization server's redirect carries no bearer token to check
// — the encrypted, authenticated `state` (see services/smart-fhir-oauth.ts)
// is this route's actual authentication.
router.get('/callback', async (req: Request, res: Response) => { // public-route
  if (!isFhirOAuthConfigured()) {
    return res.status(503).json({ ok: false, error: 'not_configured' });
  }

  const { code, state, error: authError } = req.query as Record<string, string | undefined>;
  if (authError) {
    return res.status(400).json({ ok: false, error: `authorization_denied: ${authError}` });
  }
  if (!code || !state) {
    return res.status(400).json({ ok: false, error: 'invalid_callback_request' });
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
  if (!rec || rec.connector_id !== 'smart_fhir') {
    return res.status(404).json({ ok: false, error: 'connection not found' });
  }

  const redirectUri = process.env.FHIR_OAUTH_REDIRECT_URI;
  if (!redirectUri) {
    return res.status(503).json({ ok: false, error: 'not_configured' });
  }

  const token = await exchangeCodeForToken({
    tokenEndpoint: decoded.tokenEndpoint,
    code,
    redirectUri,
    codeVerifier: decoded.codeVerifier,
    clientId: decoded.clientId,
    clientSecret: decoded.clientSecret,
  });
  if (!token.ok || !token.access_token) {
    return res.status(502).json({ ok: false, error: token.error ?? 'token_exchange_failed' });
  }

  const now = new Date().toISOString();
  await supabase.from('partner_oauth_credential').upsert(
    {
      id: randomUUID(),
      manifest_id: rec.id,
      provider: 'smart_fhir',
      endpoint_domain: new URL(decoded.fhirBaseUrl).hostname,
      access_token: token.access_token,
      token_type: token.token_type ?? null,
      scope: token.scope ?? null,
      updated_at: now,
    },
    { onConflict: 'manifest_id,provider' },
  );

  // A completed OAuth exchange is authorization; move the connection into
  // mapping the same way the Shopify connector does.
  const advanced = canTransition(rec.status, 'mapping');
  if (advanced) {
    await supabase.from('integration_manifest').update({ status: 'mapping', updated_at: now }).eq('id', rec.id);
  }

  await emitOasisEvent(supabase, 'vcaop.portal.connection.fhir_authorized', 'success',
    `connection ${rec.id}: SMART on FHIR OAuth completed for ${decoded.fhirBaseUrl}${advanced ? ` (${rec.status} -> mapping)` : ''}`, {
      connection_id: rec.id, fhir_base_url: decoded.fhirBaseUrl, from: rec.status, to: advanced ? 'mapping' : rec.status, surface: 'merchant_self_service',
    });

  res.json({ ok: true, data: { connection_id: rec.id, fhir_base_url: decoded.fhirBaseUrl } });
});

export default router;
