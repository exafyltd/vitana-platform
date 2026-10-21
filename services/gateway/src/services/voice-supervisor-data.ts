/**
 * VTID-04776 / VTID-04778 / VTID-04780 — Voice Supervisor data access.
 *
 * The only I/O behind routes/voice-supervisor.ts: PostgREST reads with the
 * service role, every one bounded. Aggregation happens in the pure module
 * (voice-supervisor-analysis.ts) over rows fetched here.
 *
 * Bounds (documented contract):
 *   - Facts reads select only the columns the analysis needs, are limited to
 *     the requested window, and are paged 1000 rows at a time (Supabase's
 *     PostgREST max-rows) up to MAX_FACT_ROWS = 50,000 rows per request.
 *     When the cap is hit the response says so (`truncated: true`).
 *   - /meta's distinct values read the hourly rollup view (one row per
 *     hour x tenant x surface x role x provider x lang), capped the same way.
 *   - Fix lists read at most 200 rows per source table.
 * Every failure throws a SupervisorDataError the router turns into a 502
 * (never an empty "healthy" answer — a failed read must not look like calm).
 */

import { ACTIVE_WINDOW_MS, type FactRow } from './voice-supervisor-analysis';

export const MAX_FACT_ROWS = 50_000;
const PAGE = 1000;
const FIX_LIMIT = 200;

export class SupervisorDataError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'SupervisorDataError';
  }
}

function cfg(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new SupervisorDataError('Supabase not configured');
  return { url, key };
}

async function get<T>(pathAndQuery: string): Promise<T> {
  const c = cfg();
  const res = await fetch(`${c.url}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: c.key, Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res || !res.ok) {
    const text = res ? await res.text().catch(() => '') : 'no response';
    throw new SupervisorDataError(`${pathAndQuery.split('?')[0]} read failed: ${res?.status ?? 'n/a'} ${String(text).slice(0, 200)}`, res?.status);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export interface FactFilters {
  tenant_id?: string | null;
  surface?: string | null;
  role?: string | null;
  provider?: string | null;
  lang?: string | null;
  /** Assistant profile key (assistantKey): community|admin|backoffice|commerce|developer|anonymous. */
  assistant?: string | null;
}

/**
 * The `assistant` dimension is derived (surface + is_anonymous), so the
 * Tenants & Roles click-through needs it as a filter of its own — passing the
 * assistant key as `surface` would match nothing for developer/community.
 */
const ASSISTANT_FILTERS: Record<string, string[]> = {
  community: ['surface=eq.vitanaland', 'is_anonymous=is.false'],
  anonymous: ['is_anonymous=is.true'],
  admin: ['surface=eq.admin', 'is_anonymous=is.false'],
  backoffice: ['surface=eq.backoffice', 'is_anonymous=is.false'],
  commerce: ['surface=eq.commerce', 'is_anonymous=is.false'],
  developer: ['surface=eq.command-hub', 'is_anonymous=is.false'],
};

export function assistantFilterParams(assistant: string | null | undefined): string[] {
  if (!assistant) return [];
  return ASSISTANT_FILTERS[assistant] ?? ['session_id=eq.__no_such_assistant__'];
}

function filterParams(f: FactFilters): string[] {
  const p: string[] = [];
  if (f.tenant_id) p.push(`tenant_id=eq.${enc(f.tenant_id)}`);
  if (f.surface) p.push(`surface=eq.${enc(f.surface)}`);
  if (f.role) p.push(`role=eq.${enc(f.role)}`);
  if (f.provider) p.push(`provider=eq.${enc(f.provider)}`);
  if (f.lang) p.push(`lang=eq.${enc(f.lang)}`);
  p.push(...assistantFilterParams(f.assistant));
  return p;
}

const ANALYSIS_COLUMNS =
  'session_id,tenant_id,is_anonymous,surface,role,provider,lang,started_at,ended_at,last_activity_at,duration_ms,ttfa_ms,p50_turn_ms,outcome,failure_class';

/** Facts rows started in [sinceIso, untilIso), newest first, capped. */
export async function fetchFactRows(
  filters: FactFilters & { since_iso: string; until_iso?: string | null },
): Promise<{ rows: FactRow[]; truncated: boolean }> {
  const base = [
    `select=${ANALYSIS_COLUMNS}`,
    `started_at=gte.${enc(filters.since_iso)}`,
    ...(filters.until_iso ? [`started_at=lt.${enc(filters.until_iso)}`] : []),
    ...filterParams(filters),
    'order=started_at.desc,session_id.asc',
  ].join('&');
  const rows: FactRow[] = [];
  for (let offset = 0; offset < MAX_FACT_ROWS; offset += PAGE) {
    const page = await get<FactRow[]>(`voice_session_facts?${base}&limit=${PAGE}&offset=${offset}`);
    rows.push(...page);
    if (page.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** Rows with no end yet, started in the last 24 h (live-count candidates). */
export async function fetchOpenFactRows(filters: FactFilters, nowMs: number): Promise<FactRow[]> {
  const since = new Date(nowMs - 24 * 3600_000).toISOString();
  const q = [
    `select=${ANALYSIS_COLUMNS}`,
    'ended_at=is.null',
    `started_at=gte.${enc(since)}`,
    ...filterParams(filters),
    'order=started_at.desc',
    `limit=${PAGE * 5}`,
  ].join('&');
  return get<FactRow[]>(`voice_session_facts?${q}`);
}

export const SESSION_COLUMNS =
  'session_id,tenant_id,user_id,is_anonymous,surface,role,persona_key,profile_resolution,lang,provider,selection_reason,transport,is_mobile,app_version,entry,started_at,ended_at,last_activity_at,duration_ms,turn_count,user_turns,model_turns,audio_in_chunks,audio_out_chunks,ttfa_ms,p50_turn_ms,close_reason,close_code,failure_class,outcome,stall_count,created_at,updated_at';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One page of sessions for the drill-down list. `q` matches a session_id
 * prefix, or a user_id exactly when q is a full UUID (uuid columns have no
 * prefix match in PostgREST).
 */
export async function fetchSessionsPage(
  filters: FactFilters & {
    since_iso: string;
    outcome?: string | null;
    failure_class?: string | null;
    q?: string | null;
    limit: number;
    before?: string | null;
  },
): Promise<Array<Record<string, unknown>>> {
  const p = [
    `select=${SESSION_COLUMNS}`,
    `started_at=gte.${enc(filters.since_iso)}`,
    ...(filters.before ? [`started_at=lt.${enc(filters.before)}`] : []),
    ...filterParams(filters),
  ];
  // Filter on what a row COUNTS as (analysis.effectiveOutcome), not the raw
  // stored column: 'active' and 'no_end' both mean "no end recorded" and are
  // split by the live window; an ended row is matched on its stored outcome.
  const liveCutoff = new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString();
  if (filters.outcome === 'active') {
    p.push('ended_at=is.null', `or=(last_activity_at.gte.${enc(liveCutoff)},and(last_activity_at.is.null,started_at.gte.${enc(liveCutoff)}))`);
  } else if (filters.outcome === 'no_end') {
    p.push('ended_at=is.null', `or=(last_activity_at.lt.${enc(liveCutoff)},and(last_activity_at.is.null,started_at.lt.${enc(liveCutoff)}))`);
  } else if (filters.outcome) {
    p.push('ended_at=not.is.null', `outcome=eq.${enc(filters.outcome)}`);
  }
  if (filters.failure_class) p.push(`failure_class=eq.${enc(filters.failure_class)}`);
  const q = (filters.q || '').trim();
  if (q) {
    if (UUID_RE.test(q)) p.push(`or=(session_id.eq.${enc(q)},user_id.eq.${enc(q)})`);
    else p.push(`session_id=like.${enc(q.replace(/[*%,()]/g, ''))}*`);
  }
  p.push('order=started_at.desc,session_id.asc', `limit=${filters.limit + 1}`);
  return get<Array<Record<string, unknown>>>(`voice_session_facts?${p.join('&')}`);
}

export interface TenantInfo { tenant_id: string; name: string; slug: string | null }

export async function fetchTenants(ids?: string[] | null): Promise<TenantInfo[]> {
  const clean = (ids || []).filter((x) => UUID_RE.test(x));
  if (ids && clean.length === 0) return [];
  const where = ids ? `&tenant_id=in.(${clean.map(enc).join(',')})` : '';
  return get<TenantInfo[]>(`tenants?select=tenant_id,name,slug${where}&order=name.asc&limit=500`);
}

/** Distinct surface/role/provider/lang seen in the hourly rollup since `sinceIso`. */
export async function fetchDistinctDims(
  sinceIso: string,
  tenantId: string | null,
): Promise<{ surfaces: string[]; roles: string[]; providers: string[]; langs: string[] }> {
  const sets = { surfaces: new Set<string>(), roles: new Set<string>(), providers: new Set<string>(), langs: new Set<string>() };
  const base = [
    'select=surface,role,provider,lang',
    `bucket=gte.${enc(sinceIso)}`,
    ...(tenantId ? [`tenant_id=eq.${enc(tenantId)}`] : []),
    'order=bucket.desc',
  ].join('&');
  for (let offset = 0; offset < MAX_FACT_ROWS; offset += PAGE) {
    const page = await get<Array<{ surface: string | null; role: string | null; provider: string | null; lang: string | null }>>(
      `voice_session_facts_hourly?${base}&limit=${PAGE}&offset=${offset}`,
    );
    for (const r of page) {
      if (r.surface) sets.surfaces.add(r.surface);
      if (r.role) sets.roles.add(r.role);
      if (r.provider) sets.providers.add(r.provider);
      if (r.lang) sets.langs.add(r.lang);
    }
    if (page.length < PAGE) break;
  }
  const sorted = (s: Set<string>) => [...s].sort();
  return { surfaces: sorted(sets.surfaces), roles: sorted(sets.roles), providers: sorted(sets.providers), langs: sorted(sets.langs) };
}

/** The caller's active_role in a tenant (tenant-admin check), or null. */
export async function fetchCallerTenantRole(userId: string, tenantId: string): Promise<string | null> {
  if (!UUID_RE.test(userId) || !UUID_RE.test(tenantId)) return null;
  const rows = await get<Array<{ active_role: string | null }>>(
    `user_tenants?select=active_role&user_id=eq.${enc(userId)}&tenant_id=eq.${enc(tenantId)}&limit=1`,
  );
  return rows?.[0]?.active_role ?? null;
}

// ---------------------------------------------------------------------------
// Executed fixes (from the existing healing tables)
// ---------------------------------------------------------------------------

export type FixSource = 'architecture_report' | 'healing_history' | 'self_healing_log';

export interface FixRecord {
  fix_id: string;
  source: FixSource;
  title: string;
  vtid: string | null;
  pr_url: string | null;
  fixed_at: string;
  failure_class: string | null;
  segment: { tenant_id?: string | null; surface?: string | null; role?: string | null; provider?: string | null; lang?: string | null };
  status: string;
}

interface ReportRow {
  id: string;
  class: string;
  normalized_signature: string | null;
  acknowledged_at: string | null;
  generated_at: string;
  status: string;
  related_vtid: string | null;
  summary: string | null;
  execution: { execution_id?: string; vtid?: string; accepted_at?: string } | null;
}
interface ExecutionRow { id: string; status: string | null; pr_url: string | null; completed_at: string | null; updated_at: string | null }
interface HistoryRow { id: string; class: string; normalized_signature: string; fixed_at: string; vtid: string | null; tenant_scope: string | null; verdict: string }
interface SelfHealRow { id: string; vtid: string; endpoint: string; failure_class: string | null; outcome: string; resolved_at: string | null; created_at: string }

const REPORT_SELECT =
  'id,class,normalized_signature,acknowledged_at,generated_at,status,related_vtid,summary:report->recommendation->>summary,execution:report->_execution';
const HISTORY_SELECT = 'id,class,normalized_signature,fixed_at,vtid,tenant_scope,verdict';
const SELF_HEAL_SELECT = 'id,vtid,endpoint,failure_class,outcome,resolved_at,created_at';
const VOICE_SELF_HEAL_FILTER = 'or=(failure_class.like.voice.*,endpoint.like.voice-error*)';

async function prUrlsFor(vtids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = [...new Set(vtids.filter((v) => /^VTID-\d{4,6}$/.test(v)))];
  if (!list.length) return out;
  const rows = await get<Array<{ vtid: string; pr_url: string | null; autopilot_pr_url: string | null }>>(
    `vtid_ledger?select=vtid,pr_url:metadata->>pr_url,autopilot_pr_url:metadata->>autopilot_pr_url&vtid=in.(${list.map(enc).join(',')})`,
  );
  for (const r of rows) {
    const url = r.pr_url || r.autopilot_pr_url;
    if (url) out.set(r.vtid, url);
  }
  return out;
}

async function executionsFor(ids: string[]): Promise<Map<string, ExecutionRow>> {
  const out = new Map<string, ExecutionRow>();
  const list = [...new Set(ids.filter((x) => UUID_RE.test(x)))];
  if (!list.length) return out;
  const rows = await get<ExecutionRow[]>(
    `dev_autopilot_executions?select=id,status,pr_url,completed_at,updated_at&id=in.(${list.map(enc).join(',')})`,
  );
  for (const r of rows) out.set(r.id, r);
  return out;
}

function shortTitle(prefix: string, text: string | null | undefined): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t ? `${prefix}: ${t.length > 140 ? `${t.slice(0, 137)}...` : t}` : prefix;
}

async function normalizeReports(rows: ReportRow[]): Promise<FixRecord[]> {
  const execs = await executionsFor(rows.map((r) => r.execution?.execution_id || ''));
  const prs = await prUrlsFor(rows.map((r) => r.execution?.vtid || r.related_vtid || ''));
  return rows.map((r) => {
    const ex = r.execution?.execution_id ? execs.get(r.execution.execution_id) : undefined;
    const vtid = r.execution?.vtid || r.related_vtid || null;
    return {
      fix_id: `architecture_report:${r.id}`,
      source: 'architecture_report' as const,
      title: shortTitle(`Voice investigator fix for ${r.class}`, r.summary),
      vtid,
      pr_url: ex?.pr_url || (vtid ? prs.get(vtid) ?? null : null),
      fixed_at: ex?.completed_at || r.execution?.accepted_at || r.acknowledged_at || r.generated_at,
      failure_class: r.class,
      segment: {},
      status: ex?.status || r.status,
    };
  });
}

async function normalizeHistory(rows: HistoryRow[]): Promise<FixRecord[]> {
  const prs = await prUrlsFor(rows.map((r) => r.vtid || ''));
  return rows.map((r) => ({
    fix_id: `healing_history:${r.id}`,
    source: 'healing_history' as const,
    title: `Self-healing fix verified: ${r.class} (${r.normalized_signature})`,
    vtid: r.vtid,
    pr_url: r.vtid ? prs.get(r.vtid) ?? null : null,
    fixed_at: r.fixed_at,
    failure_class: r.class,
    segment: { tenant_id: r.tenant_scope && UUID_RE.test(r.tenant_scope) ? r.tenant_scope : null },
    status: r.verdict,
  }));
}

async function normalizeSelfHeal(rows: SelfHealRow[]): Promise<FixRecord[]> {
  const prs = await prUrlsFor(rows.map((r) => r.vtid));
  return rows.map((r) => {
    const cls = r.failure_class && r.failure_class.startsWith('voice.')
      ? r.failure_class
      : (r.endpoint.startsWith('voice-error://') ? r.endpoint.slice('voice-error://'.length) : r.failure_class);
    return {
      fix_id: `self_healing_log:${r.id}`,
      source: 'self_healing_log' as const,
      title: `Self-healed: ${r.endpoint}`,
      vtid: r.vtid,
      pr_url: prs.get(r.vtid) ?? null,
      fixed_at: r.resolved_at || r.created_at,
      failure_class: cls ?? null,
      segment: {},
      status: r.outcome,
    };
  });
}

/** Fixes executed in the last `days` days, newest first. */
export async function fetchFixes(days: number, nowMs: number): Promise<FixRecord[]> {
  const since = enc(new Date(nowMs - days * 86_400_000).toISOString());
  const [reports, history, selfHeal] = await Promise.all([
    get<ReportRow[]>(`voice_architecture_reports?select=${REPORT_SELECT}&status=eq.accepted&acknowledged_at=gte.${since}&order=acknowledged_at.desc&limit=${FIX_LIMIT}`),
    get<HistoryRow[]>(`voice_healing_history?select=${HISTORY_SELECT}&verdict=eq.ok&fixed_at=gte.${since}&order=fixed_at.desc&limit=${FIX_LIMIT}`),
    get<SelfHealRow[]>(`self_healing_log?select=${SELF_HEAL_SELECT}&outcome=eq.fixed&created_at=gte.${since}&${VOICE_SELF_HEAL_FILTER}&order=created_at.desc&limit=${FIX_LIMIT}`),
  ]);
  const all = [
    ...(await normalizeReports(reports)),
    ...(await normalizeHistory(history)),
    ...(await normalizeSelfHeal(selfHeal)),
  ];
  return all.sort((a, b) => Date.parse(b.fixed_at) - Date.parse(a.fixed_at));
}

/** One fix by its `<source>:<id>` id, or null when unknown / malformed. */
export async function fetchFix(fixId: string): Promise<FixRecord | null> {
  const m = /^(architecture_report|healing_history|self_healing_log):([0-9a-f-]{36})$/i.exec(fixId || '');
  if (!m || !UUID_RE.test(m[2])) return null;
  const id = enc(m[2]);
  switch (m[1] as FixSource) {
    case 'architecture_report': {
      const rows = await get<ReportRow[]>(`voice_architecture_reports?select=${REPORT_SELECT}&id=eq.${id}&limit=1`);
      return rows.length ? (await normalizeReports(rows))[0] : null;
    }
    case 'healing_history': {
      const rows = await get<HistoryRow[]>(`voice_healing_history?select=${HISTORY_SELECT}&id=eq.${id}&limit=1`);
      return rows.length ? (await normalizeHistory(rows))[0] : null;
    }
    case 'self_healing_log': {
      const rows = await get<SelfHealRow[]>(`self_healing_log?select=${SELF_HEAL_SELECT}&id=eq.${id}&limit=1`);
      return rows.length ? (await normalizeSelfHeal(rows))[0] : null;
    }
  }
  return null;
}
