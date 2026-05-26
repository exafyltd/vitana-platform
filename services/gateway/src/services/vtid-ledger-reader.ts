/**
 * VTID-03158 (CPB-7): typed reader for the `vtid_ledger` table.
 *
 * Moves ContextPackBuilder's direct Supabase REST calls against the
 * vtid_ledger out into this module. CPB and any other consumer that
 * wants to surface "active VTIDs in the ledger" goes through these
 * typed accessors; raw `vtid_ledger` row shape stays here.
 *
 * Two readers exposed:
 *   - `getActiveVTIDs(tenantId, limit?)` — broadly active ledger rows
 *     (status in {in-progress, scheduled, planned}, ordered by
 *     created_at desc). Mirrors the legacy `fetchActiveVTIDs`
 *     CPB used to inline; `tenantId` is accepted for forward
 *     compatibility but is not yet pushed into the filter — the
 *     legacy query did not filter by tenant either, so behaviour
 *     is preserved byte-identical at rollout.
 *   - `getDeveloperActiveTasks({ limit? })` — narrower "active
 *     developer tasks" view (status in {in_progress, scheduled,
 *     allocated}, is_terminal=false, ordered by updated_at desc).
 *     This is the row set the developer/admin OASIS context
 *     block surfaces.
 *
 * Both readers are best-effort: env or tenant-config gaps return an
 * empty array rather than throwing; the timeout matches the rest of
 * the context-pack fetcher budget (2.5s).
 */

const VTID_LEDGER_FETCH_TIMEOUT_MS = 2500;

export interface ActiveVTID {
  vtid: string;
  title: string;
  status: string;
  priority?: string;
}

export interface DeveloperActiveTask {
  vtid: string;
  title: string;
  status: string;
}

function abortAfter(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId),
  };
}

function supabaseEnv():
  | { url: string; key: string }
  | null {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return { url, key };
}

/**
 * Active VTIDs — generic ledger view used by the global context pack.
 *
 * Status filter: `in-progress` | `scheduled` | `planned` (matches
 * the legacy CPB query at pre-VTID-03158 line 717). Ordered by
 * `created_at` desc. tenantId is reserved for future filtering;
 * today the SQL does not apply it (the legacy query did not either).
 */
export async function getActiveVTIDs(
  _tenantId: string | null | undefined,
  limit: number = 5,
): Promise<ActiveVTID[]> {
  const env = supabaseEnv();
  if (!env) return [];

  const url =
    `${env.url}/rest/v1/vtid_ledger` +
    `?status=in.(in-progress,scheduled,planned)` +
    `&order=created_at.desc` +
    `&limit=${limit}`;

  const timeout = abortAfter(VTID_LEDGER_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.key,
        Authorization: `Bearer ${env.key}`,
      },
      signal: timeout.signal,
    });
    if (!resp.ok) return [];
    const rows = (await resp.json()) as Array<{
      vtid: string;
      title?: string;
      status: string;
      priority?: string;
    }>;
    return rows.map((r) => ({
      vtid: r.vtid,
      title: r.title || r.vtid,
      status: r.status,
      priority: r.priority,
    }));
  } catch {
    return [];
  } finally {
    timeout.clear();
  }
}

/**
 * Active developer / admin tasks view.
 *
 * Status filter: `in_progress` | `scheduled` | `allocated`
 * with `is_terminal IS FALSE`. Ordered by `updated_at` desc.
 * Limit defaults to 5. Mirrors the legacy `Promise.all` head
 * inside CPB's developer OASIS context block.
 */
export async function getDeveloperActiveTasks(
  options?: { limit?: number },
): Promise<DeveloperActiveTask[]> {
  const env = supabaseEnv();
  if (!env) return [];
  const limit = options?.limit ?? 5;

  const url =
    `${env.url}/rest/v1/vtid_ledger` +
    `?select=vtid,title,status` +
    `&status=in.(in_progress,scheduled,allocated)` +
    `&is_terminal=is.false` +
    `&order=updated_at.desc` +
    `&limit=${limit}`;

  const timeout = abortAfter(VTID_LEDGER_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.key,
        Authorization: `Bearer ${env.key}`,
      },
      signal: timeout.signal,
    });
    if (!resp.ok) return [];
    const rows = (await resp.json()) as Array<{
      vtid: string;
      title?: string;
      status: string;
    }>;
    return rows.map((r) => ({
      vtid: r.vtid,
      title: r.title || r.vtid,
      status: r.status,
    }));
  } catch {
    return [];
  } finally {
    timeout.clear();
  }
}
