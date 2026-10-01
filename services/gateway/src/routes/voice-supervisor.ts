/**
 * VTID-04776 / VTID-04778 / VTID-04780 — Voice Supervisor API.
 *
 * Mounted at /api/v1/voice/supervisor. Answers, from voice_session_facts:
 * "is voice broken for everyone, or for one tenant / assistant / provider /
 * language — and did the fix we shipped help?"
 *
 *   GET /meta                      scope + filter vocabularies
 *   GET /overview                  live counts, KPIs (+ previous window), verdict
 *   GET /segments?row=&col=        tenant x assistant (etc.) health matrix
 *   GET /sessions                  drill-down list (cursor: before=started_at)
 *   GET /fixes?days=30             executed voice fixes from the healing tables
 *   GET /fixes/:fix_id/impact      before/after comparison (VTID-04778)
 *
 * Auth (VTID-04780):
 *   - exafy_admin (developer access, what the Command Hub sends): all
 *     tenants; may pass tenant_id to narrow.
 *   - tenant admin (user_tenants.active_role = 'admin' in the JWT's tenant):
 *     forced to their own tenant whatever tenant_id says; fixes are limited
 *     to platform-wide or their own tenant's, without VTID/PR links.
 *   - everyone else: 403. No token: 401.
 * Common query params: window=1h|24h|7d|30d (default 24h), tenant_id,
 * surface, role, provider, lang. Responses are `{ ok, ... }`, snake_case.
 * A failed read is a 502 with ok:false — never an empty "healthy" answer.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import {
  computeKpis,
  computeVerdicts,
  buildSegmentMatrix,
  compareImpact,
  targetFailureRate,
  kpiDelta,
  filterSegment,
  defaultLabel,
  isLive,
  effectiveOutcome,
  MIN_SAMPLE,
  type Dimension,
  type FactRow,
} from '../services/voice-supervisor-analysis';
import {
  fetchFactRows,
  fetchOpenFactRows,
  fetchSessionsPage,
  fetchTenants,
  fetchDistinctDims,
  fetchCallerTenantRole,
  fetchFixes,
  fetchFix,
  SupervisorDataError,
  MAX_FACT_ROWS,
  type FactFilters,
  type FixRecord,
} from '../services/voice-supervisor-data';

const router = Router();
const VTID = 'VTID-04776';

export const SURFACES = ['vitanaland', 'admin', 'backoffice', 'commerce', 'command-hub'] as const;
const WINDOWS: Record<string, number> = { '1h': 3600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
const DIMENSIONS: readonly Dimension[] = ['tenant', 'surface', 'role', 'provider', 'lang', 'assistant'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SupervisorScope {
  is_platform_admin: boolean;
  /** Tenant the caller is confined to (tenant admins), else null. */
  tenant_id: string | null;
}

type ScopedRequest = AuthenticatedRequest & { supervisorScope?: SupervisorScope };

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function requireSupervisorAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  await requireAuth(req as AuthenticatedRequest, res, async () => {
    const identity = (req as AuthenticatedRequest).identity;
    if (!identity) {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', vtid: VTID });
      return;
    }
    if (identity.exafy_admin === true) {
      (req as ScopedRequest).supervisorScope = { is_platform_admin: true, tenant_id: null };
      next();
      return;
    }
    const tenantId = identity.tenant_id || null;
    let role: string | null = null;
    if (tenantId) {
      try {
        role = await fetchCallerTenantRole(identity.user_id, tenantId);
      } catch (err) {
        console.error(`[VTID-04780] tenant role lookup failed for ${identity.user_id}: ${(err as Error).message}`);
        res.status(502).json({ ok: false, error: 'ROLE_LOOKUP_FAILED', vtid: 'VTID-04780' });
        return;
      }
    }
    if (tenantId && role === 'admin') {
      (req as ScopedRequest).supervisorScope = { is_platform_admin: false, tenant_id: tenantId };
      next();
      return;
    }
    console.warn(`[VTID-04780] voice supervisor denied: user ${identity.user_id} role=${role ?? 'none'} tenant=${tenantId ?? 'none'}`);
    res.status(403).json({
      ok: false,
      error: 'FORBIDDEN',
      message: 'Voice Supervisor requires developer access or the admin role in your tenant',
      vtid: 'VTID-04780',
    });
  });
}

router.use(requireSupervisorAccess);

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function parseWindow(v: unknown): { key: string; ms: number } {
  const k = str(v) ?? '24h';
  return WINDOWS[k] ? { key: k, ms: WINDOWS[k] } : { key: '24h', ms: WINDOWS['24h'] };
}

/**
 * The filters a request may use. A tenant admin's tenant is forced here, so
 * no handler can forget it (VTID-04780).
 */
export function scopedFilters(scope: SupervisorScope, query: Record<string, unknown>): FactFilters {
  const requested = str(query.tenant_id);
  return {
    tenant_id: scope.is_platform_admin ? (requested && UUID_RE.test(requested) ? requested : null) : scope.tenant_id,
    surface: str(query.surface),
    role: str(query.role),
    provider: str(query.provider),
    lang: str(query.lang),
    assistant: str(query.assistant),
  };
}

function scopeOf(req: Request): SupervisorScope {
  return (req as ScopedRequest).supervisorScope ?? { is_platform_admin: false, tenant_id: '__none__' };
}

async function tenantNameMap(ids: Array<string | null | undefined>): Promise<Record<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x && UUID_RE.test(x)))];
  if (!list.length) return {};
  const tenants = await fetchTenants(list);
  return Object.fromEntries(tenants.map((t) => [t.tenant_id, t.name]));
}

function fail(res: Response, err: unknown, what: string): Response {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[VTID-04776] voice supervisor ${what} failed: ${msg}`);
  const status = err instanceof SupervisorDataError ? 502 : 500;
  return res.status(status).json({ ok: false, error: msg, vtid: VTID });
}

// ---------------------------------------------------------------------------
// GET /meta
// ---------------------------------------------------------------------------

router.get('/meta', async (req: Request, res: Response) => {
  const scope = scopeOf(req);
  try {
    const nowMs = Date.now();
    const [tenants, dims] = await Promise.all([
      fetchTenants(scope.is_platform_admin ? null : [scope.tenant_id as string]),
      fetchDistinctDims(new Date(nowMs - 30 * 86_400_000).toISOString(), scope.is_platform_admin ? null : scope.tenant_id),
    ]);
    return res.json({
      ok: true,
      scope: { is_platform_admin: scope.is_platform_admin, tenant_id: scope.tenant_id },
      tenants: tenants.map((t) => ({ tenant_id: t.tenant_id, name: t.name, slug: t.slug ?? null })),
      surfaces: [...SURFACES],
      roles: dims.roles,
      providers: dims.providers,
      langs: dims.langs,
      windows: Object.keys(WINDOWS),
      min_sample: MIN_SAMPLE,
    });
  } catch (err) {
    return fail(res, err, 'meta');
  }
});

// ---------------------------------------------------------------------------
// GET /overview
// ---------------------------------------------------------------------------

router.get('/overview', async (req: Request, res: Response) => {
  const scope = scopeOf(req);
  const win = parseWindow(req.query.window);
  const filters = scopedFilters(scope, req.query as Record<string, unknown>);
  try {
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
    return res.json({
      ok: true,
      window: win.key,
      generated_at: new Date(nowMs).toISOString(),
      scope: { is_platform_admin: scope.is_platform_admin, tenant_id: filters.tenant_id ?? null },
      live: {
        active_sessions: live.length,
        by_surface: bySurface,
        by_provider: byProvider,
        source: 'voice_session_facts',
      },
      kpis: strip(computeKpis(current, nowMs)),
      previous_kpis: strip(computeKpis(previous, nowMs)),
      verdicts,
      verdict_summary,
      truncated: both.truncated,
      row_cap: MAX_FACT_ROWS,
    });
  } catch (err) {
    return fail(res, err, 'overview');
  }
});

// ---------------------------------------------------------------------------
// GET /segments
// ---------------------------------------------------------------------------

function parseDim(v: unknown, fallback: Dimension): Dimension {
  const s = str(v);
  return s && (DIMENSIONS as readonly string[]).includes(s) ? (s as Dimension) : fallback;
}

router.get('/segments', async (req: Request, res: Response) => {
  const scope = scopeOf(req);
  const win = parseWindow(req.query.window);
  const filters = scopedFilters(scope, req.query as Record<string, unknown>);
  const rowDim = parseDim(req.query.row, 'tenant');
  const colDim = parseDim(req.query.col, 'assistant');
  try {
    const nowMs = Date.now();
    const { rows, truncated } = await fetchFactRows({ ...filters, since_iso: new Date(nowMs - win.ms).toISOString() });
    const names = await tenantNameMap(rows.map((r) => r.tenant_id));
    const matrix = buildSegmentMatrix(rows, rowDim, colDim, nowMs, (d, k) => defaultLabel(d, k, names));
    return res.json({ ok: true, window: win.key, ...matrix, truncated, row_cap: MAX_FACT_ROWS });
  } catch (err) {
    return fail(res, err, 'segments');
  }
});

// ---------------------------------------------------------------------------
// GET /sessions
// ---------------------------------------------------------------------------

router.get('/sessions', async (req: Request, res: Response) => {
  const scope = scopeOf(req);
  const win = parseWindow(req.query.window);
  const filters = scopedFilters(scope, req.query as Record<string, unknown>);
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;
  const beforeRaw = str(req.query.before);
  const before = beforeRaw && Number.isFinite(Date.parse(beforeRaw)) ? new Date(Date.parse(beforeRaw)).toISOString() : null;
  try {
    const nowMs = Date.now();
    const rows = await fetchSessionsPage({
      ...filters,
      since_iso: new Date(nowMs - win.ms).toISOString(),
      outcome: str(req.query.outcome),
      failure_class: str(req.query.failure_class),
      q: str(req.query.q),
      limit,
      before,
    });
    const page = rows.slice(0, limit);
    const names = await tenantNameMap(page.map((r) => r.tenant_id as string | null));
    return res.json({
      ok: true,
      window: win.key,
      sessions: page.map((r) => ({
        ...r,
        // What the row counts as now: a lost end reads 'no_end', not the
        // stored 'abandoned'/'active' (same rule as every KPI).
        outcome: effectiveOutcome(r as unknown as FactRow, nowMs),
        stored_outcome: r.outcome ?? null,
        tenant_name: r.tenant_id ? names[r.tenant_id as string] ?? null : null,
      })),
      next_before: rows.length > limit && page.length ? (page[page.length - 1].started_at as string) : null,
    });
  } catch (err) {
    return fail(res, err, 'sessions');
  }
});

// ---------------------------------------------------------------------------
// GET /fixes
// ---------------------------------------------------------------------------

function parseDays(v: unknown, def: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.floor(n)) : def;
}

/** A tenant admin sees platform-wide fixes and their own tenant's, without VTID/PR links. */
export function scopeFix(fix: FixRecord, scope: SupervisorScope): FixRecord | null {
  if (scope.is_platform_admin) return fix;
  if (fix.segment.tenant_id && fix.segment.tenant_id !== scope.tenant_id) return null;
  return { ...fix, vtid: null, pr_url: null };
}

router.get('/fixes', async (req: Request, res: Response) => {
  const scope = scopeOf(req);
  const days = parseDays(req.query.days, 30, 90);
  try {
    const fixes = (await fetchFixes(days, Date.now()))
      .map((f) => scopeFix(f, scope))
      .filter((f): f is FixRecord => !!f);
    return res.json({ ok: true, days, fixes });
  } catch (err) {
    return fail(res, err, 'fixes');
  }
});

// ---------------------------------------------------------------------------
// GET /fixes/:fix_id/impact (VTID-04778)
// ---------------------------------------------------------------------------

router.get('/fixes/:fix_id/impact', async (req: Request, res: Response) => {
  const scope = scopeOf(req);
  const days = parseDays(req.query.days, 7, 30);
  try {
    const raw = await fetchFix(String(req.params.fix_id || ''));
    const fix = raw ? scopeFix(raw, scope) : null;
    if (!fix) return res.status(404).json({ ok: false, error: 'FIX_NOT_FOUND', vtid: 'VTID-04778' });
    const fixedMs = Date.parse(fix.fixed_at);
    if (!Number.isFinite(fixedMs)) {
      return res.status(422).json({ ok: false, error: 'FIX_HAS_NO_TIMESTAMP', vtid: 'VTID-04778' });
    }
    const nowMs = Date.now();
    const spanMs = days * 86_400_000;
    const beforeStart = fixedMs - spanMs;
    const afterEnd = Math.min(nowMs, fixedMs + spanMs);

    // The fix's segment, narrowed by the caller's scope (tenant admins stay
    // in their tenant) and by any explicit filters on the request.
    const reqFilters = scopedFilters(scope, req.query as Record<string, unknown>);
    const segment = {
      tenant_id: reqFilters.tenant_id ?? fix.segment.tenant_id ?? null,
      surface: reqFilters.surface ?? fix.segment.surface ?? null,
      role: reqFilters.role ?? fix.segment.role ?? null,
      provider: reqFilters.provider ?? fix.segment.provider ?? null,
      lang: reqFilters.lang ?? fix.segment.lang ?? null,
    };
    const { rows, truncated } = await fetchFactRows({
      ...segment,
      since_iso: new Date(beforeStart).toISOString(),
      until_iso: new Date(afterEnd).toISOString(),
    });
    const inSeg = filterSegment(rows, segment);
    const beforeRows: FactRow[] = inSeg.filter((r) => Date.parse(r.started_at) < fixedMs);
    const afterRows: FactRow[] = inSeg.filter((r) => Date.parse(r.started_at) >= fixedMs);
    const beforeK = computeKpis(beforeRows, nowMs);
    const afterK = computeKpis(afterRows, nowMs);
    const cmp = compareImpact({
      before_sessions: beforeK.finished,
      after_sessions: afterK.finished,
      before_rate: targetFailureRate(beforeRows, fix.failure_class, nowMs),
      after_rate: targetFailureRate(afterRows, fix.failure_class, nowMs),
      target_metric: fix.failure_class ? `failure_class:${fix.failure_class}` : 'failure_rate',
    });
    const strip = ({ finished: _f, ...k }: typeof beforeK) => k;
    return res.json({
      ok: true,
      fix,
      segment,
      days,
      before: { window_start: new Date(beforeStart).toISOString(), window_end: new Date(fixedMs).toISOString(), kpis: strip(beforeK) },
      after: { window_start: new Date(fixedMs).toISOString(), window_end: new Date(afterEnd).toISOString(), kpis: strip(afterK) },
      delta: kpiDelta(beforeK, afterK),
      target: { metric: cmp.target_metric, before_rate: cmp.before_rate, after_rate: cmp.after_rate },
      verdict: cmp.verdict,
      min_sample: MIN_SAMPLE,
      truncated,
    });
  } catch (err) {
    return fail(res, err, 'fix impact');
  }
});

export default router;
