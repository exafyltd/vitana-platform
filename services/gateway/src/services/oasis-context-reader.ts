/**
 * VTID-03158 (CPB-8 + CPB-9): typed reader for the OASIS context
 * block surfaced in the context pack.
 *
 * Moves ContextPackBuilder's direct Supabase REST calls against
 * `oasis_events` (recent deploys, pending approvals, self-healing
 * alerts) and `autopilot_recommendations` (community recent
 * recommendations) out into this module. CPB now asks for the
 * already-shaped `oasis_context` block; the table names + URL
 * construction live here.
 *
 * Two role-shaped readers:
 *   - `getDeveloperOasisContext({ tenantId?, limit? })` — used for
 *     developer / admin / DEV / infra / super_admin roles. Fans out
 *     to `vtid-ledger-reader.getDeveloperActiveTasks` plus three
 *     `oasis_events` queries in parallel. Empty `recent_recommendations`
 *     because the developer block doesn't surface autopilot recs.
 *   - `getCommunityOasisContext(userId)` — used for community role.
 *     Reads recent activated/completed autopilot_recommendations.
 *     Other fields zeroed.
 *
 * Both readers are best-effort: env/lens gaps return null (so the
 * caller can omit `oasis_context` entirely) and individual stream
 * failures degrade to empty arrays / zero counts. 2.5s abort budget
 * to keep the broker pipeline under the 3s tool timeout.
 *
 * `autopilot_recommendations` lives inside this module rather than
 * a dedicated reader file because the context pack is currently
 * its only "read for prompt assembly" consumer (existing
 * autopilot_recommendations consumers are all write/mutate paths
 * inside route handlers + lifecycle services).
 */

import {
  getDeveloperActiveTasks,
  type DeveloperActiveTask,
} from './vtid-ledger-reader';

const OASIS_FETCH_TIMEOUT_MS = 2500;

export interface OasisRecentDeploy {
  service: string;
  status: string;
  created_at: string;
}

export interface OasisRecentRecommendation {
  title: string;
  status: string;
}

/**
 * Shape mirrors `ContextPack['oasis_context']` (services/gateway/
 * src/types/conversation.ts). Kept self-contained here so the reader
 * can be unit-tested without touching the wider ContextPack types.
 */
export interface OasisContextBlock {
  active_tasks: DeveloperActiveTask[];
  recent_deploys: OasisRecentDeploy[];
  pending_approvals_count: number;
  self_healing_alerts: number;
  recent_recommendations: OasisRecentRecommendation[];
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

async function safeJsonGet(
  url: string,
  env: { url: string; key: string },
  timeout: { signal: AbortSignal; clear: () => void },
): Promise<unknown[] | null> {
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
    if (!resp.ok) return null;
    const data = await resp.json();
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Developer-shaped OASIS context block.
 *
 * Returns null when Supabase is unreachable (CPB then omits the
 * `oasis_context` field entirely — matches the legacy `if (!URL ||
 * !KEY) return` short-circuit).
 *
 * Otherwise fans out 4 reads in parallel:
 *   - active developer tasks (vtid_ledger_reader)
 *   - last 3 cicd.deploy.service.* events (oasis_events)
 *   - up to 20 cicd.github.safe_merge.evaluated info events (count)
 *   - 24h self-healing.* error events (count)
 *
 * Individual stream failures degrade to empty / zero — matches the
 * pre-VTID-03158 inline behaviour.
 */
export async function getDeveloperOasisContext(
  options?: { tenantId?: string | null; activeTasksLimit?: number },
): Promise<OasisContextBlock | null> {
  const env = supabaseEnv();
  if (!env) return null;

  const timeout = abortAfter(OASIS_FETCH_TIMEOUT_MS);
  try {
    const since24h = new Date(Date.now() - 86_400_000).toISOString();
    const deploysUrl =
      `${env.url}/rest/v1/oasis_events` +
      `?select=service,status,created_at` +
      `&topic=like.cicd.deploy.service.*` +
      `&order=created_at.desc&limit=3`;
    const approvalsUrl =
      `${env.url}/rest/v1/oasis_events` +
      `?select=id` +
      `&topic=eq.cicd.github.safe_merge.evaluated` +
      `&status=eq.info` +
      `&order=created_at.desc&limit=20`;
    const healingUrl =
      `${env.url}/rest/v1/oasis_events` +
      `?select=id` +
      `&topic=like.self-healing.*` +
      `&status=eq.error` +
      `&created_at=gte.${since24h}` +
      `&limit=50`;

    const [tasks, deploysRaw, approvalsRaw, healingRaw] = await Promise.all([
      getDeveloperActiveTasks({ limit: options?.activeTasksLimit ?? 5 }),
      safeJsonGet(deploysUrl, env, timeout),
      safeJsonGet(approvalsUrl, env, timeout),
      safeJsonGet(healingUrl, env, timeout),
    ]);

    const recent_deploys: OasisRecentDeploy[] = (deploysRaw ?? []).map(
      (d: any) => ({
        service: d.service || 'unknown',
        status: d.status,
        created_at: d.created_at,
      }),
    );
    return {
      active_tasks: tasks,
      recent_deploys,
      pending_approvals_count: (approvalsRaw ?? []).length,
      self_healing_alerts: (healingRaw ?? []).length,
      recent_recommendations: [],
    };
  } finally {
    timeout.clear();
  }
}

/**
 * Community-shaped OASIS context block.
 *
 * Surfaces the user's recent activated/completed autopilot recs as
 * `recent_recommendations`. Returns null when env or user_id is
 * missing, or when no recs were found (the pre-VTID-03158 inline
 * code only set `oasis_context` when recs.length > 0 — preserved
 * to keep CPB's output identical).
 */
export async function getCommunityOasisContext(
  userId: string | null | undefined,
  options?: { limit?: number },
): Promise<OasisContextBlock | null> {
  if (!userId) return null;
  const env = supabaseEnv();
  if (!env) return null;
  const limit = options?.limit ?? 3;

  const url =
    `${env.url}/rest/v1/autopilot_recommendations` +
    `?select=title,status` +
    `&user_id=eq.${userId}` +
    `&status=in.(activated,completed)` +
    `&order=updated_at.desc` +
    `&limit=${limit}`;

  const timeout = abortAfter(OASIS_FETCH_TIMEOUT_MS);
  try {
    const rows = await safeJsonGet(url, env, timeout);
    if (!rows || rows.length === 0) return null;
    const recs: OasisRecentRecommendation[] = rows.map((r: any) => ({
      title: r.title,
      status: r.status,
    }));
    return {
      active_tasks: [],
      recent_deploys: [],
      pending_approvals_count: 0,
      self_healing_alerts: 0,
      recent_recommendations: recs,
    };
  } finally {
    timeout.clear();
  }
}
