/**
 * VTID-05070: the sidecar's two calls to this environment's gateway, both with the Kiro
 * session's gateway pass (the same pass the `vitana` read tools use):
 *
 *   GET  /api/v1/operator/kiro/media/quota   how many screenshots the current run has left
 *   POST /api/v1/operator/kiro/media         store one PNG; appends a `kiro.image` event to the run
 *
 * The gateway is the authority on the per-run cap (10); the quota call only avoids opening a
 * page whose screenshot could not be stored anyway.
 */
export const LIMIT_REACHED = 'screenshot limit reached for this run';

type FetchLike = typeof fetch;

export interface Quota { run_id: string; used: number; limit: number; remaining: number }
export interface Stored { media_id: string; run_id: string; url: string | null }

export class GatewayError extends Error {}

async function json(res: Response): Promise<any> { return res.json().catch(() => ({})); }

export class GatewayClient {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: FetchLike = fetch) {}

  private url(p: string): string { return `${this.baseUrl.replace(/\/+$/, '')}/api/v1/operator/kiro/media${p}`; }

  async quota(pass: string): Promise<Quota> {
    const res = await this.fetchImpl(this.url('/quota'), { headers: { Authorization: `Bearer ${pass}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    const b = await json(res);
    if (!res.ok || b?.ok !== true) throw new GatewayError(String(b?.error ?? `gateway answered ${res.status}`));
    return { run_id: String(b.run_id), used: Number(b.used), limit: Number(b.limit), remaining: Number(b.remaining) };
  }

  async store(pass: string, png: Buffer, meta: { viewport: string; page_url: string; width: number; height: number }): Promise<Stored> {
    const q = new URLSearchParams({ viewport: meta.viewport, page_url: meta.page_url, width: String(meta.width), height: String(meta.height) });
    const res = await this.fetchImpl(`${this.url('')}?${q.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pass}`, 'Content-Type': 'image/png', Accept: 'application/json' },
      body: new Uint8Array(png),
      signal: AbortSignal.timeout(30_000),
    });
    const b = await json(res);
    if (!res.ok || b?.ok !== true) throw new GatewayError(String(b?.error ?? `gateway answered ${res.status}`));
    return { media_id: String(b.media_id), run_id: String(b.run_id), url: typeof b.url === 'string' ? b.url : null };
  }
}
