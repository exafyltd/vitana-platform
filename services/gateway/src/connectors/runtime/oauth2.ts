/**
 * VTID-02100: Generic OAuth2 authorization-code flow helpers.
 * Shared by wearable and (future-refactored) social connectors.
 */

import { randomBytes } from 'crypto';
import type { OAuthConfig, TokenPair } from '../types';

export function generateState(): string {
  return randomBytes(32).toString('base64url');
}

export function buildAuthorizeUrl(
  cfg: OAuthConfig,
  clientId: string,
  redirectUri: string,
  state: string,
  scopesOverride?: string[]
): string {
  const url = new URL(cfg.authorize_url);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  const scopes = scopesOverride ?? cfg.scopes;
  if (scopes.length) url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  if (cfg.extra_authorize_params) {
    for (const [k, v] of Object.entries(cfg.extra_authorize_params)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

export interface ExchangeCodeOptions {
  config: OAuthConfig;
  code: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  extra_body?: Record<string, string>;
}

export async function exchangeCodeForTokens(
  opts: ExchangeCodeOptions
): Promise<TokenPair> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirect_uri,
    client_id: opts.client_id,
    client_secret: opts.client_secret,
    ...(opts.extra_body ?? {}),
  });

  const resp = await fetch(opts.config.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '(no body)');
    throw new Error(`OAuth token exchange failed: ${resp.status} ${errText}`);
  }
  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  const expires_at =
    typeof data.expires_in === 'number'
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : undefined;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at,
    scopes_granted: data.scope ? data.scope.split(/[\s,]+/).filter(Boolean) : undefined,
  };
}

export async function refreshOAuth2Token(opts: {
  config: OAuthConfig;
  refresh_token: string;
  client_id: string;
  client_secret: string;
}): Promise<TokenPair> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refresh_token,
    client_id: opts.client_id,
    client_secret: opts.client_secret,
  });
  const resp = await fetch(opts.config.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '(no body)');
    throw new Error(`OAuth token refresh failed: ${resp.status} ${errText}`);
  }
  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  const expires_at =
    typeof data.expires_in === 'number'
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : undefined;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? opts.refresh_token,
    expires_at,
    scopes_granted: data.scope ? data.scope.split(/[\s,]+/).filter(Boolean) : undefined,
  };
}
