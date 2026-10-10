/**
 * VTID-05062 — daily production screen-load report.
 *
 * Once per UTC day (POST /api/v1/frontend/screen-load/daily-report/run,
 * called by .github/workflows/SCREEN-LOAD-DAILY.yml) this aggregates the
 * last 24 h of PRODUCTION telemetry that real members' devices already send:
 *
 *   - `screen.nav.measured` (vitana-v1 RUM nav beacon): per tab screen, the
 *     p75 SCREEN_READY for first and return visits, and the share of return
 *     visits on which a first-viewport image was downloaded again;
 *   - `screen.latency.measured` filtered to metric 'LCP': app-wide p75.
 *
 * plus a build check: the 12-char `vitana-app-version` short SHA in the
 * production HTML must be a prefix of a commit that passed STAGING-VERIFY
 * for the community app.
 *
 * This is an operational report over telemetry and one unauthenticated GET
 * of the public production HTML (same class as the post-deploy bundle check)
 * — not a test. No browser, no sign-in, no member-data writes.
 *
 * `buildDailyReport` is pure apart from its injected fetchers, so tests run
 * it on fixtures; `createLiveDailyReportDeps` wires the real readers.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const NAV_TOPIC = 'screen.nav.measured';
export const LATENCY_TOPIC = 'screen.latency.measured';
export const DAILY_REPORT_TOPIC = 'screen.load.daily_report';
export const STAGING_VERIFY_PASSED_TOPIC = 'staging.verify.passed';

/** The bottom-tab screens members switch between (route patterns). */
export const TAB_SCREENS = ['/home', '/inbox', '/comm/events-meetups', '/autopilot'] as const;

/** Budgets (owner can tune). */
export const BUDGETS = {
  return_p75_ms: 1000,
  first_p75_ms: 3000,
  refetch_share: 0.05,
  lcp_p75_ms: 4000,
  min_samples: 20,
} as const;

export const WINDOW_MS = 24 * 60 * 60 * 1000;
/** How far back a STAGING-VERIFY pass may be to vouch for the live build. */
export const VERIFIED_COMMITS_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

export const PRODUCTION_APP_URL = 'https://vitanaland.com/';

export type Verdict = 'pass' | 'breach' | 'insufficient';
export type ReportStatus = 'green' | 'yellow' | 'red';
export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface EventRow {
  created_at?: string;
  metadata?: Record<string, unknown> | null;
}

export interface Measure {
  value: number | null;
  samples: number;
  budget: number;
  verdict: Verdict;
}

export interface ScreenReport {
  screen: string;
  return_p75_ms: Measure;
  first_p75_ms: Measure;
  refetch_share: Measure;
}

export interface BuildCheck {
  verdict: 'pass' | 'fail';
  prod_version: string | null;
  matched_commit: string | null;
  reason: 'matched' | 'html_unavailable' | 'meta_missing' | 'no_verified_commit';
}

export interface DailyReport {
  vtid: 'VTID-05062';
  report_date: string; // UTC YYYY-MM-DD
  generated_at: string;
  window: { since: string; until: string };
  status: ReportStatus;
  health: HealthStatus;
  budgets: typeof BUDGETS;
  screens: ScreenReport[];
  lcp_p75_ms: Measure;
  build: BuildCheck;
  worst: { screen: string; measure: string; value: number; budget: number } | null;
  gchat_text: string;
}

export interface DailyReportDeps {
  now: Date;
  /** Rows of `topic` created at/after `sinceIso` (production rows; re-filtered here). */
  fetchEvents(topic: string, sinceIso: string): Promise<EventRow[]>;
  /** Production app HTML, or null when it could not be fetched. */
  fetchProdHtml(): Promise<string | null>;
  /** Full commit SHAs with a community-app `staging.verify.passed` event since `sinceIso`. */
  fetchVerifiedCommits(sinceIso: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Nearest-rank percentile — same definition as routine-audits' rollup. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isProduction(m: Record<string, unknown>): boolean {
  return m.env === 'production';
}

function measure(value: number | null, samples: number, budget: number): Measure {
  if (samples < BUDGETS.min_samples || value === null) {
    return { value, samples, budget, verdict: 'insufficient' };
  }
  return { value, samples, budget, verdict: value > budget ? 'breach' : 'pass' };
}

/** Reads `<meta name="vitana-app-version" content="…">` (attribute order-insensitive). */
export function parseAppVersion(html: string | null | undefined): string | null {
  if (!html) return null;
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/\bname\s*=\s*["']vitana-app-version["']/i.test(tag)) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    const v = content?.[1]?.trim().toLowerCase() ?? '';
    return /^[0-9a-f]{7,40}$/.test(v) ? v : null;
  }
  return null;
}

export function checkBuild(html: string | null, verifiedCommits: string[]): BuildCheck {
  if (html === null) {
    return { verdict: 'fail', prod_version: null, matched_commit: null, reason: 'html_unavailable' };
  }
  const version = parseAppVersion(html);
  if (!version) {
    return { verdict: 'fail', prod_version: null, matched_commit: null, reason: 'meta_missing' };
  }
  const match = verifiedCommits.map((c) => c.toLowerCase()).find((c) => c.startsWith(version)) ?? null;
  return match
    ? { verdict: 'pass', prod_version: version, matched_commit: match, reason: 'matched' }
    : { verdict: 'fail', prod_version: version, matched_commit: null, reason: 'no_verified_commit' };
}

export function aggregateNav(rows: EventRow[]): ScreenReport[] {
  type Acc = { first: number[]; ret: number[]; retRefetched: number };
  const acc = new Map<string, Acc>(TAB_SCREENS.map((s) => [s, { first: [], ret: [], retRefetched: 0 }]));
  for (const row of rows) {
    const m = row.metadata ?? {};
    if (!isProduction(m)) continue;
    const a = typeof m.screen === 'string' ? acc.get(m.screen) : undefined;
    if (!a) continue;
    const ready = Number(m.ready_ms);
    if (!Number.isFinite(ready)) continue;
    if (m.nav === 'first') a.first.push(ready);
    else if (m.nav === 'return') {
      a.ret.push(ready);
      if (Number(m.img_refetch) > 0) a.retRefetched += 1;
    }
  }
  return TAB_SCREENS.map((screen) => {
    const a = acc.get(screen)!;
    return {
      screen,
      return_p75_ms: measure(percentile(a.ret, 75), a.ret.length, BUDGETS.return_p75_ms),
      first_p75_ms: measure(percentile(a.first, 75), a.first.length, BUDGETS.first_p75_ms),
      refetch_share: measure(
        a.ret.length ? Math.round((a.retRefetched / a.ret.length) * 1000) / 1000 : null,
        a.ret.length,
        BUDGETS.refetch_share,
      ),
    };
  });
}

export function aggregateLcp(rows: EventRow[]): Measure {
  const values: number[] = [];
  for (const row of rows) {
    const m = row.metadata ?? {};
    if (!isProduction(m) || m.metric !== 'LCP') continue;
    const v = Number(m.value);
    if (Number.isFinite(v)) values.push(v);
  }
  return measure(percentile(values, 75), values.length, BUDGETS.lcp_p75_ms);
}

const MEASURE_LABEL: Record<string, string> = {
  return_p75_ms: 'return p75',
  first_p75_ms: 'first p75',
  refetch_share: 'photo re-download share',
};

function fmtMeasure(key: string, m: Measure): string {
  if (m.value === null) return `${MEASURE_LABEL[key] ?? key} n/a (${m.samples})`;
  const v = key === 'refetch_share' ? `${Math.round(m.value * 1000) / 10}%` : `${Math.round(m.value)}ms`;
  const flag = m.verdict === 'breach' ? ' !' : m.verdict === 'insufficient' ? ' ?' : '';
  return `${MEASURE_LABEL[key] ?? key} ${v}${flag} (${m.samples})`;
}

function findWorst(screens: ScreenReport[], lcp: Measure): DailyReport['worst'] {
  let worst: DailyReport['worst'] = null;
  let worstRatio = -1;
  const consider = (screen: string, key: string, m: Measure) => {
    if (m.value === null || m.verdict === 'insufficient') return;
    const ratio = m.budget > 0 ? m.value / m.budget : 0;
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worst = { screen, measure: key, value: m.value, budget: m.budget };
    }
  };
  for (const s of screens) {
    consider(s.screen, 'return_p75_ms', s.return_p75_ms);
    consider(s.screen, 'first_p75_ms', s.first_p75_ms);
    consider(s.screen, 'refetch_share', s.refetch_share);
  }
  consider('(app, first load)', 'lcp_p75_ms', lcp);
  return worst;
}

export function healthFor(status: ReportStatus): HealthStatus {
  return status === 'green' ? 'ok' : status === 'yellow' ? 'degraded' : 'down';
}

export function formatGChat(r: Omit<DailyReport, 'gchat_text'>): string {
  const emoji = r.status === 'green' ? '🟢' : r.status === 'yellow' ? '🟡' : '🔴';
  const lines: string[] = [
    `${emoji} *Screen loading — production ${r.report_date}* (${r.status.toUpperCase()}, VTID-05062)`,
  ];
  for (const s of r.screens) {
    lines.push(
      `• ${s.screen}: ${fmtMeasure('return_p75_ms', s.return_p75_ms)} · ${fmtMeasure('first_p75_ms', s.first_p75_ms)} · ${fmtMeasure('refetch_share', s.refetch_share)}`,
    );
  }
  const lcpFlag = r.lcp_p75_ms.verdict === 'breach' ? ' !' : r.lcp_p75_ms.verdict === 'insufficient' ? ' ?' : '';
  lines.push(
    `• First-load LCP p75: ${r.lcp_p75_ms.value === null ? 'n/a' : `${Math.round(r.lcp_p75_ms.value)}ms`}${lcpFlag} (${r.lcp_p75_ms.samples}) — budget ${r.budgets.lcp_p75_ms}ms`,
  );
  lines.push(
    r.build.verdict === 'pass'
      ? `• Build: ${r.build.prod_version} = STAGING-VERIFY passed ${r.build.matched_commit?.slice(0, 12)}`
      : `• Build: ${r.build.prod_version ?? 'unknown'} NOT verified on staging (${r.build.reason})`,
  );
  if (r.worst) {
    const v = r.worst.measure === 'refetch_share' ? `${Math.round(r.worst.value * 1000) / 10}%` : `${Math.round(r.worst.value)}ms`;
    lines.push(`Worst: ${r.worst.screen} ${MEASURE_LABEL[r.worst.measure] ?? 'LCP p75'} ${v} (budget ${r.worst.measure === 'refetch_share' ? `${r.worst.budget * 100}%` : `${r.worst.budget}ms`})`);
  }
  lines.push(`Budgets: return ≤${r.budgets.return_p75_ms}ms, first ≤${r.budgets.first_p75_ms}ms, re-download ≤${r.budgets.refetch_share * 100}%; <${r.budgets.min_samples} samples = ? (insufficient)`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export async function buildDailyReport(deps: DailyReportDeps): Promise<DailyReport> {
  const until = deps.now;
  const since = new Date(until.getTime() - WINDOW_MS).toISOString();
  const verifiedSince = new Date(until.getTime() - VERIFIED_COMMITS_WINDOW_MS).toISOString();

  const [navRows, latencyRows, html, verified] = await Promise.all([
    deps.fetchEvents(NAV_TOPIC, since),
    deps.fetchEvents(LATENCY_TOPIC, since),
    deps.fetchProdHtml().catch(() => null),
    deps.fetchVerifiedCommits(verifiedSince),
  ]);

  const screens = aggregateNav(navRows);
  const lcp = aggregateLcp(latencyRows);
  const build = checkBuild(html, verified);

  const measures = [...screens.flatMap((s) => [s.return_p75_ms, s.first_p75_ms, s.refetch_share]), lcp];
  const status: ReportStatus =
    build.verdict === 'fail' || measures.some((m) => m.verdict === 'breach')
      ? 'red'
      : measures.some((m) => m.verdict === 'insufficient')
        ? 'yellow'
        : 'green';

  const base: Omit<DailyReport, 'gchat_text'> = {
    vtid: 'VTID-05062',
    report_date: utcDay(until),
    generated_at: until.toISOString(),
    window: { since, until: until.toISOString() },
    status,
    health: healthFor(status),
    budgets: BUDGETS,
    screens,
    lcp_p75_ms: lcp,
    build,
    worst: findWorst(screens, lcp),
  };
  return { ...base, gchat_text: formatGChat(base) };
}

// ---------------------------------------------------------------------------
// Live fetchers (runtime only — never called from tests)
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000;
const MAX_ROWS = 20000;

async function fetchProductionEvents(sb: SupabaseClient, topic: string, sinceIso: string): Promise<EventRow[]> {
  const out: EventRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    let q = sb
      .from('oasis_events')
      .select('created_at, metadata')
      .eq('topic', topic)
      .gte('created_at', sinceIso)
      .eq('metadata->>env', 'production');
    if (topic === LATENCY_TOPIC) q = q.eq('metadata->>metric', 'LCP');
    const { data, error } = await q.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`oasis_events read failed (${topic}): ${error.message}`);
    const rows = (data ?? []) as EventRow[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

async function fetchCommunityAppVerifiedCommits(sb: SupabaseClient, sinceIso: string): Promise<string[]> {
  const { data, error } = await sb
    .from('oasis_events')
    .select('metadata')
    .eq('topic', STAGING_VERIFY_PASSED_TOPIC)
    .eq('metadata->>service', 'community-app')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(`oasis_events read failed (${STAGING_VERIFY_PASSED_TOPIC}): ${error.message}`);
  return (data ?? [])
    .map((r: { metadata?: Record<string, unknown> | null }) => r.metadata?.commit)
    .filter((c): c is string => typeof c === 'string' && /^[0-9a-f]{40}$/i.test(c));
}

/** Read-only, unauthenticated GET of the public production HTML. */
export async function fetchProductionHtml(url: string = PRODUCTION_APP_URL, timeoutMs = 15000): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'GET', headers: { 'Cache-Control': 'no-cache' }, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch (err) {
    console.error('[screen-load-daily-report] production HTML fetch failed:', (err as Error)?.message ?? err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createLiveDailyReportDeps(sb: SupabaseClient, now: Date = new Date()): DailyReportDeps {
  return {
    now,
    fetchEvents: (topic, sinceIso) => fetchProductionEvents(sb, topic, sinceIso),
    fetchProdHtml: () => fetchProductionHtml(),
    fetchVerifiedCommits: (sinceIso) => fetchCommunityAppVerifiedCommits(sb, sinceIso),
  };
}
