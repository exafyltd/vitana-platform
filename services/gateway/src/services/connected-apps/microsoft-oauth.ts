/**
 * VTID-04403: Microsoft identity platform token refresh, shared by the
 * background refresher and the connector dispatcher.
 *
 * Microsoft rotates refresh tokens: every refresh can return a new one, and
 * the caller must store it. The old one keeps working for a while, but a
 * member who is only ever refreshed from the stale token eventually signs
 * out without having done anything.
 */

export interface MicrosoftRefreshResult {
  ok: boolean;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scopes_granted?: string[];
  error?: string;
  /** invalid_grant: the grant was revoked or expired — stop retrying. */
  permanent?: boolean;
}

export function microsoftTokenUrl(env: NodeJS.ProcessEnv = process.env): string {
  const t = (env.MICROSOFT_OAUTH_TENANT || 'common').trim();
  const tenant = /^[A-Za-z0-9.-]+$/.test(t) ? t : 'common';
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

export async function refreshMicrosoftAccessToken(
  refreshToken: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MicrosoftRefreshResult> {
  const clientId = env.MICROSOFT_OAUTH_CLIENT_ID;
  const clientSecret = env.MICROSOFT_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { ok: false, error: 'MICROSOFT_OAUTH_CLIENT_ID / MICROSOFT_OAUTH_CLIENT_SECRET not configured' };
  }
  const resp = await fetch(microsoftTokenUrl(env), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const json = (await resp.json().catch(() => ({}))) as Record<string, any>;
  if (resp.ok && json.access_token) {
    return {
      ok: true,
      access_token: json.access_token,
      refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
      expires_in: Number(json.expires_in) || 3600,
      scopes_granted: typeof json.scope === 'string' ? json.scope.split(/\s+/).filter(Boolean) : undefined,
    };
  }
  return {
    ok: false,
    error: json.error_description || json.error || `HTTP ${resp.status}`,
    permanent: json.error === 'invalid_grant',
  };
}
