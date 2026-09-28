/**
 * VTID-04668 / VTID-04669: minimal PostgREST helper for the recommendation
 * quality services. Deliberately self-contained (no import of
 * dev-autopilot-execute, which registers these services' ticks).
 */
export interface QualityRestResult<T> { ok: boolean; data?: T; status: number; error?: string }

export type QualityQuery = <T>(path: string) => Promise<{ ok: boolean; data?: T }>;
export type QualityPatch = (path: string, body: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;

export function qualitySupabaseConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE);
}

export async function qualityRest<T>(path: string, init: RequestInit = {}): Promise<QualityRestResult<T>> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return { ok: false, status: 0, error: 'Supabase not configured' };
  try {
    const res = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (!res.ok) return { ok: false, status: res.status, error: `${res.status}: ${await res.text()}` };
    const text = await res.text();
    if (!text) return { ok: true, status: res.status };
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T };
    } catch {
      return { ok: true, status: res.status };
    }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export const defaultQualityQuery: QualityQuery = <T>(path: string) => qualityRest<T>(path);

export const defaultQualityPatch: QualityPatch = async (path, body) => {
  const r = await qualityRest(path, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, error: r.error };
};
