/**
 * VTID-05030 (Health Hub D1): shared HTTP leg for vendor-side revokes on
 * disconnect. Turns a fetch into a RevokeAccessResult and never throws; the
 * caller (routes/wearables.ts) bounds the total time.
 */
import type { RevokeAccessResult } from '../types';

export async function revokeRequest(
  url: string,
  init: RequestInit,
  okStatuses: number[] = [],
): Promise<RevokeAccessResult> {
  try {
    const resp = await fetch(url, init);
    if (resp.ok || okStatuses.includes(resp.status)) {
      return { status: 'ok', http_status: resp.status };
    }
    return { status: 'failed', http_status: resp.status };
  } catch (err: unknown) {
    return { status: 'failed', detail: err instanceof Error ? err.name : 'request_error' };
  }
}
