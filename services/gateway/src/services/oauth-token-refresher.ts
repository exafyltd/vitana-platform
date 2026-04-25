/**
 * Background OAuth token refresher.
 *
 * Periodically scans `social_connections` for rows whose access_token will
 * expire in the next hour and refreshes them ahead of time. Without this
 * service, tokens only get refreshed when a user manually opens the
 * Manage dialog (`/google/verify`) or when the capability dispatcher
 * happens to invoke the connector — both of which can lag behind a
 * 60-minute access-token lifetime, leading to silent 401s on the user's
 * next ORB query / Autopilot run.
 *
 * On unrecoverable refresh failure (refresh_token revoked, secret
 * rotated, scopes withdrawn) we mark `is_active=false` and emit
 * `oauth.token.refresh.failed` so a Command Hub surface can prompt the
 * user to reconnect.
 *
 * Modeled on self-healing-reconciler.ts — same supabase REST + setInterval
 * pattern, same module-level `running` guard.
 */

import { emitOasisEvent } from './oasis-event-service';

const LOG_PREFIX = '[oauth-token-refresher]';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// Default cadence (15min) and how far ahead we look for expiries (60min).
// At 60-minute Google access-token lifetimes this gives every user 4
// refresh attempts before their token actually expires.
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_LOOKAHEAD_MS = 60 * 60 * 1000;
const BATCH_LIMIT = 100;

let timer: NodeJS.Timeout | null = null;
let running = false;
let cycleInFlight = false;

interface ExpiringRow {
  id: string;
  user_id: string;
  provider: string;
  refresh_token: string | null;
  token_expires_at: string | null;
}

function supabaseHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
  };
}

async function fetchExpiringRows(lookaheadMs: number): Promise<ExpiringRow[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return [];
  const cutoff = new Date(Date.now() + lookaheadMs).toISOString();
  const url =
    `${SUPABASE_URL}/rest/v1/social_connections` +
    `?select=id,user_id,provider,refresh_token,token_expires_at` +
    `&is_active=eq.true` +
    `&refresh_token=not.is.null` +
    `&provider=in.(google,youtube)` +
    `&token_expires_at=lt.${encodeURIComponent(cutoff)}` +
    `&order=token_expires_at.asc&limit=${BATCH_LIMIT}`;

  try {
    const resp = await fetch(url, { headers: supabaseHeaders() });
    if (!resp.ok) {
      console.warn(`${LOG_PREFIX} fetchExpiringRows ${resp.status}`);
      return [];
    }
    return (await resp.json()) as ExpiringRow[];
  } catch (err) {
    console.warn(`${LOG_PREFIX} fetchExpiringRows error: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

interface GoogleRefreshResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function refreshGoogleAccessToken(refreshToken: string): Promise<{
  ok: boolean;
  access_token?: string;
  expires_in?: number;
  error?: string;
  permanent?: boolean;
}> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { ok: false, error: 'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not configured' };
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const json = (await resp.json().catch(() => ({}))) as GoogleRefreshResponse;
  if (resp.ok && json.access_token) {
    return { ok: true, access_token: json.access_token, expires_in: json.expires_in };
  }
  // invalid_grant means the refresh token has been revoked, expired, or
  // belongs to a now-deleted account. We tombstone these instead of
  // retrying forever.
  const permanent = json.error === 'invalid_grant';
  return {
    ok: false,
    error: json.error_description || json.error || `HTTP ${resp.status}`,
    permanent,
  };
}

async function persistRefresh(rowId: string, accessToken: string, expiresIn: number): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return;
  const newExpiry = new Date(Date.now() + expiresIn * 1000).toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/social_connections?id=eq.${rowId}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      access_token: accessToken,
      token_expires_at: newExpiry,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function tombstoneRow(rowId: string, reason: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return;
  await fetch(`${SUPABASE_URL}/rest/v1/social_connections?id=eq.${rowId}`, {
    method: 'PATCH',
    headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      is_active: false,
      updated_at: new Date().toISOString(),
    }),
  });
  console.warn(`${LOG_PREFIX} Tombstoned row ${rowId}: ${reason}`);
}

async function refreshOne(row: ExpiringRow): Promise<void> {
  if (!row.refresh_token) return;
  // Both google and youtube share Google's OAuth client.
  const result = await refreshGoogleAccessToken(row.refresh_token);

  if (result.ok && result.access_token && result.expires_in) {
    await persistRefresh(row.id, result.access_token, result.expires_in);
    console.log(`${LOG_PREFIX} Refreshed ${row.provider} for user ${row.user_id.slice(0, 8)}…`);
    void emitOasisEvent({
      vtid: 'VTID-01928',
      type: 'oauth.token.refresh.succeeded',
      source: 'oauth-token-refresher',
      status: 'success',
      message: `Refreshed ${row.provider} access_token for user ${row.user_id.slice(0, 8)}`,
      payload: { provider: row.provider, user_id: row.user_id, row_id: row.id },
    });
    return;
  }

  console.warn(
    `${LOG_PREFIX} Refresh failed for ${row.provider} user ${row.user_id.slice(0, 8)}: ${result.error}`,
  );
  if (result.permanent) {
    await tombstoneRow(row.id, result.error || 'invalid_grant');
    void emitOasisEvent({
      vtid: 'VTID-01928',
      type: 'oauth.token.refresh.tombstoned',
      source: 'oauth-token-refresher',
      status: 'warning',
      message: `${row.provider} refresh_token revoked for user ${row.user_id.slice(0, 8)} — connection deactivated`,
      payload: { provider: row.provider, user_id: row.user_id, row_id: row.id, error: result.error },
    });
  } else {
    void emitOasisEvent({
      vtid: 'VTID-01928',
      type: 'oauth.token.refresh.failed',
      source: 'oauth-token-refresher',
      status: 'error',
      message: `${row.provider} refresh failed for user ${row.user_id.slice(0, 8)}: ${result.error}`,
      payload: { provider: row.provider, user_id: row.user_id, row_id: row.id, error: result.error },
    });
  }
}

async function runCycle(lookaheadMs: number): Promise<void> {
  if (cycleInFlight) {
    console.log(`${LOG_PREFIX} Previous cycle still in flight, skipping`);
    return;
  }
  cycleInFlight = true;
  try {
    const rows = await fetchExpiringRows(lookaheadMs);
    if (rows.length === 0) return;
    console.log(`${LOG_PREFIX} Refreshing ${rows.length} expiring connections`);
    for (const row of rows) {
      try {
        await refreshOne(row);
      } catch (err) {
        console.warn(`${LOG_PREFIX} refreshOne threw for ${row.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    cycleInFlight = false;
  }
}

export function startOAuthTokenRefresher(): void {
  if (running) {
    console.log(`${LOG_PREFIX} Already running`);
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn(`${LOG_PREFIX} Supabase credentials missing, refresher not started`);
    return;
  }
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    console.warn(`${LOG_PREFIX} GOOGLE_OAUTH_* not configured, refresher not started`);
    return;
  }
  const intervalMs = parseInt(
    process.env.OAUTH_REFRESHER_INTERVAL_MS || String(DEFAULT_INTERVAL_MS),
    10,
  );
  const lookaheadMs = parseInt(
    process.env.OAUTH_REFRESHER_LOOKAHEAD_MS || String(DEFAULT_LOOKAHEAD_MS),
    10,
  );
  running = true;
  // Stagger first run by 60s so we don't hammer Google during boot.
  setTimeout(() => void runCycle(lookaheadMs), 60_000);
  timer = setInterval(() => void runCycle(lookaheadMs), intervalMs);
  console.log(`🔁 OAuth token refresher started (interval=${intervalMs}ms, lookahead=${lookaheadMs}ms)`);
}

export function stopOAuthTokenRefresher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  running = false;
  console.log(`${LOG_PREFIX} Stopped`);
}
