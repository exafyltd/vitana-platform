/**
 * VTID-04402: service-role PostgREST access for the Connected Apps tables.
 * Same shape as calendar-google-sync.ts's db(): throws on a non-2xx so a
 * failed write is never mistaken for success.
 */

export function dbConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE);
}

export async function db(path: string, init: RequestInit = {}): Promise<any> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('supabase_config_missing');
  const r = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  if (!r.ok) throw new Error(`db ${init.method ?? 'GET'} ${path.split('?')[0]} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

export const enc = encodeURIComponent;
