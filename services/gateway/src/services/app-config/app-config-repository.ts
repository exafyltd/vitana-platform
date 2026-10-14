/**
 * VTID-05177 — reads the native app kill switches from system_controls.
 *
 * Keys start with `native_app.kill.` (for example
 * `native_app.kill.ios.push_enabled`, `native_app.kill.all.orb_native_enabled`).
 * Same service-role REST pattern and 3 s timeout as
 * services/system-controls-service.ts, but unlike getSystemControl() this
 * returns `{ rows } | { error }`, so "no kill rows" and "could not read" stay
 * apart: the route answers 503 rather than serve flags it could not check.
 *
 * Read-only. Arming a kill uses the existing governance controls API (reason,
 * audit, OASIS event); there is no write path here.
 */

export const NATIVE_APP_KILL_PREFIX = 'native_app.kill.';

const FETCH_TIMEOUT_MS = 3000;

export interface KillControlRow {
  key: string;
  enabled: boolean;
  expires_at: string | null;
}

export type KillRowsResult = { rows: KillControlRow[] } | { error: string };

export type FetchKillRows = () => Promise<KillRowsResult>;

export const fetchNativeAppKillRows: FetchKillRows = async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return { error: 'supabase_not_configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${url}/rest/v1/system_controls?select=key,enabled,expires_at&key=like.${encodeURIComponent(NATIVE_APP_KILL_PREFIX)}*`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) return { error: `http_${res.status}` };
    const body = await res.json();
    if (!Array.isArray(body)) return { error: 'unexpected_body' };
    return { rows: body as KillControlRow[] };
  } catch (err: any) {
    return { error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
};
