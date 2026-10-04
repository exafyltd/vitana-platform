/**
 * VTID-04875 — Overview Phase 1a: the Voice Supervisor overview builder,
 * extracted verbatim from the inline GET /api/v1/voice/supervisor/overview
 * handler (routes/voice-supervisor.ts) so the Command Hub Overview's
 * /ops/attention voice adapter (plan A, REVISION 2 F3) can call it in-process
 * without a req.
 *
 * Scope semantics are unchanged (VTID-04780):
 *   - `{ is_platform_admin: true }` → unscoped (all tenants); `filters.tenant_id`
 *     may narrow it, exactly like an exafy_admin passing `?tenant_id=`.
 *   - `{ is_platform_admin: false, tenant_id }` → a tenant admin; when the
 *     caller passes no `filters`, the reads are confined to that tenant.
 *     The route always passes `scopedFilters(scope, req.query)`, which forces
 *     the tenant whatever the query said.
 *
 * Errors are thrown unchanged — the route maps SupervisorDataError → 502 and
 * anything else → 500, as before. The route's response is pinned
 * byte-for-byte by test/vtid-04875-voice-overview-builder.test.ts.
 */

import {
  computeKpis,
  computeVerdicts,
  defaultLabel,
  isLive,
} from './voice-supervisor-analysis';
import {
  fetchFactRows,
  fetchOpenFactRows,
  fetchTenants,
  MAX_FACT_ROWS,
  type FactFilters,
} from './voice-supervisor-data';

/** Overview windows. Owned here; routes/voice-supervisor.ts re-uses them. */
export const VOICE_SUPERVISOR_WINDOWS: Record<string, number> = {
  '1h': 3600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VoiceOverviewScope {
  is_platform_admin: boolean;
  /** Tenant the caller is confined to (tenant admins), else null/omitted. */
  tenant_id?: string | null;
}

export interface VoiceWindow {
  key: string;
  ms: number;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** `window=1h|24h|7d|30d`; anything else (or nothing) → 24h. */
export function parseWindow(v: unknown): VoiceWindow {
  const k = str(v) ?? '24h';
  return VOICE_SUPERVISOR_WINDOWS[k]
    ? { key: k, ms: VOICE_SUPERVISOR_WINDOWS[k] }
    : { key: '24h', ms: VOICE_SUPERVISOR_WINDOWS['24h'] };
}

/** tenant_id → display name, for verdict labels. */
export async function tenantNameMap(ids: Array<string | null | undefined>): Promise<Record<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x && UUID_RE.test(x)))];
  if (!list.length) return {};
  const tenants = await fetchTenants(list);
  return Object.fromEntries(tenants.map((t) => [t.tenant_id, t.name]));
}

function defaultFilters(scope: VoiceOverviewScope): FactFilters {
  return {
    tenant_id: scope.is_platform_admin ? null : (scope.tenant_id ?? null),
    surface: null,
    role: null,
    provider: null,
    lang: null,
    assistant: null,
  };
}

export interface BuildVoiceOverviewInput {
  /** A window key ('1h' | '24h' | '7d' | '30d') or an already-parsed window. Default 24h. */
  window?: string | VoiceWindow;
  scope: VoiceOverviewScope;
  /** Already-scoped filters (the route passes scopedFilters(scope, req.query)). */
  filters?: FactFilters;
}

/**
 * Live counts, KPIs (+ previous window) and the verdict — the exact JSON body
 * GET /overview serves on success.
 */
export async function buildVoiceOverview(input: BuildVoiceOverviewInput) {
  const { scope } = input;
  const win = typeof input.window === 'object' && input.window !== null ? input.window : parseWindow(input.window);
  const filters = input.filters ?? defaultFilters(scope);
  const nowMs = Date.now();
  const sinceMs = nowMs - win.ms;
  const [both, open] = await Promise.all([
    fetchFactRows({ ...filters, since_iso: new Date(sinceMs - win.ms).toISOString() }),
    fetchOpenFactRows(filters, nowMs),
  ]);
  const current = both.rows.filter((r) => Date.parse(r.started_at) >= sinceMs);
  const previous = both.rows.filter((r) => Date.parse(r.started_at) < sinceMs);
  const live = open.filter((r) => isLive(r, nowMs));
  const bySurface: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  for (const r of live) {
    const s = r.surface || 'unknown';
    const p = r.provider || 'unknown';
    bySurface[s] = (bySurface[s] || 0) + 1;
    byProvider[p] = (byProvider[p] || 0) + 1;
  }
  const names = await tenantNameMap(current.map((r) => r.tenant_id));
  const { verdicts, verdict_summary } = computeVerdicts(current, nowMs, (d, k) => defaultLabel(d, k, names));
  const strip = ({ finished: _f, ...k }: ReturnType<typeof computeKpis>) => k;
  return {
    ok: true as const,
    window: win.key,
    generated_at: new Date(nowMs).toISOString(),
    scope: { is_platform_admin: scope.is_platform_admin, tenant_id: filters.tenant_id ?? null },
    live: {
      active_sessions: live.length,
      by_surface: bySurface,
      by_provider: byProvider,
      source: 'voice_session_facts' as const,
    },
    kpis: strip(computeKpis(current, nowMs)),
    previous_kpis: strip(computeKpis(previous, nowMs)),
    verdicts,
    verdict_summary,
    truncated: both.truncated,
    row_cap: MAX_FACT_ROWS,
  };
}

export type VoiceOverview = Awaited<ReturnType<typeof buildVoiceOverview>>;
