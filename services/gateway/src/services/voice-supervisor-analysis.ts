/**
 * VTID-04776 / VTID-04778 — Voice Supervisor analysis (pure).
 *
 * Everything the Supervisor computes from `voice_session_facts` rows lives
 * here as pure functions: KPIs, the segment matrix, the "is it everyone or
 * one segment?" verdict, and the before/after fix-impact comparison. No I/O,
 * no env reads, no clock reads except through arguments — so each rule is
 * unit-tested directly (test/vtid-04776-voice-supervisor.test.ts).
 *
 * Rate denominators are FINISHED sessions (outcome set and not 'active').
 * An 'active' row whose last activity is older than ACTIVE_WINDOW_MS never
 * received an end (gateway restart, lost stop) and is counted as
 * 'abandoned' — it is in the denominator, never in a failure numerator.
 */

export const MIN_SAMPLE = 20;
/** Matrix cells use a smaller floor than verdicts: they are read, not alerted on. */
export const CELL_MIN_SAMPLE = 10;
export const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

export type FailureMetric = 'silent' | 'one_way' | 'drop' | 'error';
export const FAILURE_METRICS: readonly FailureMetric[] = ['silent', 'one_way', 'drop', 'error'];

/** Overall rate above which a failure metric is a system problem. */
export const SYSTEM_THRESHOLDS: Record<FailureMetric, number> = {
  silent: 0.10,
  one_way: 0.10,
  drop: 0.15,
  error: 0.05,
};
/** Share of a dimension's eligible segments that must be bad for "everyone". */
export const SYSTEM_SPREAD = 0.6;
/** Latency (p50 time to first audio) health bands for matrix cells. */
export const TTFA_WARN_MS = 2500;
export const TTFA_BAD_MS = 4000;

export type Dimension = 'tenant' | 'surface' | 'role' | 'provider' | 'lang' | 'assistant';
export const VERDICT_DIMENSIONS: readonly Exclude<Dimension, 'assistant'>[] = ['tenant', 'surface', 'role', 'provider', 'lang'];

export interface FactRow {
  session_id: string;
  tenant_id?: string | null;
  user_id?: string | null;
  is_anonymous?: boolean | null;
  surface?: string | null;
  role?: string | null;
  provider?: string | null;
  lang?: string | null;
  started_at: string;
  ended_at?: string | null;
  last_activity_at?: string | null;
  duration_ms?: number | null;
  ttfa_ms?: number | null;
  p50_turn_ms?: number | null;
  outcome?: string | null;
  failure_class?: string | null;
}

export interface Kpis {
  sessions: number;
  finished: number;
  ok_rate: number | null;
  silent_rate: number | null;
  one_way_rate: number | null;
  drop_rate: number | null;
  error_rate: number | null;
  p50_ttfa_ms: number | null;
  p95_ttfa_ms: number | null;
  p50_turn_ms: number | null;
  avg_duration_ms: number | null;
}

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

export function percentile(values: number[], p: number): number | null {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0];
  // Linear interpolation — the same definition as Postgres percentile_cont.
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return Math.round(v[lo] + (v[hi] - v[lo]) * (idx - lo));
}

function ratio(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

/** The outcome a row counts as, at `nowMs`. 'active' = still live. */
export function effectiveOutcome(row: FactRow, nowMs: number): string {
  const o = row.outcome || (row.ended_at ? 'ok' : 'active');
  if (o !== 'active') return o;
  if (row.ended_at) return 'ok';
  const last = Date.parse(row.last_activity_at || row.started_at);
  return Number.isFinite(last) && nowMs - last <= ACTIVE_WINDOW_MS ? 'active' : 'abandoned';
}

export function isLive(row: FactRow, nowMs: number): boolean {
  return effectiveOutcome(row, nowMs) === 'active';
}

const OUTCOME_FOR: Record<FailureMetric, string> = {
  silent: 'silent',
  one_way: 'one_way',
  drop: 'dropped',
  error: 'error',
};

interface Tally {
  sessions: number;
  finished: number;
  counts: Record<string, number>;
  ttfa: number[];
  turn: number[];
  durations: number[];
  failureClass: Record<string, number>;
}

function tally(rows: FactRow[], nowMs: number): Tally {
  const t: Tally = { sessions: 0, finished: 0, counts: {}, ttfa: [], turn: [], durations: [], failureClass: {} };
  for (const r of rows) {
    t.sessions++;
    const o = effectiveOutcome(r, nowMs);
    if (o === 'active') continue;
    t.finished++;
    t.counts[o] = (t.counts[o] || 0) + 1;
    if (typeof r.ttfa_ms === 'number') t.ttfa.push(r.ttfa_ms);
    if (typeof r.p50_turn_ms === 'number') t.turn.push(r.p50_turn_ms);
    if (typeof r.duration_ms === 'number') t.durations.push(r.duration_ms);
    if (r.failure_class) t.failureClass[r.failure_class] = (t.failureClass[r.failure_class] || 0) + 1;
  }
  return t;
}

export function computeKpis(rows: FactRow[], nowMs: number): Kpis {
  const t = tally(rows, nowMs);
  const rate = (o: string) => ratio(t.counts[o] || 0, t.finished);
  return {
    sessions: t.sessions,
    finished: t.finished,
    ok_rate: rate('ok'),
    silent_rate: rate('silent'),
    one_way_rate: rate('one_way'),
    drop_rate: rate('dropped'),
    error_rate: rate('error'),
    p50_ttfa_ms: percentile(t.ttfa, 0.5),
    p95_ttfa_ms: percentile(t.ttfa, 0.95),
    p50_turn_ms: percentile(t.turn, 0.5),
    avg_duration_ms: t.durations.length ? Math.round(t.durations.reduce((a, b) => a + b, 0) / t.durations.length) : null,
  };
}

/** Rate of finished sessions with this failure_class (fix impact on a class). */
export function failureClassRate(rows: FactRow[], failureClass: string, nowMs: number): number | null {
  const t = tally(rows, nowMs);
  return ratio(t.failureClass[failureClass] || 0, t.finished);
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

export const ASSISTANT_LABELS: Record<string, string> = {
  community: 'Community Vitana',
  admin: 'Admin Vitana',
  backoffice: 'BackOffice Vitana',
  commerce: 'Commerce Vitana',
  developer: 'Developer ORB (Command Hub)',
  anonymous: 'Anonymous',
};

/** Which assistant profile served the row (the `assistant` column). */
export function assistantKey(row: FactRow): string {
  if (row.is_anonymous) return 'anonymous';
  switch (row.surface) {
    case 'admin': return 'admin';
    case 'backoffice': return 'backoffice';
    case 'commerce': return 'commerce';
    case 'command-hub': return 'developer';
    default: return 'community';
  }
}

export function dimensionKey(row: FactRow, dim: Dimension): string {
  switch (dim) {
    case 'tenant': return row.tenant_id || 'none';
    case 'surface': return row.surface || 'unknown';
    case 'role': return row.role || 'unknown';
    case 'provider': return row.provider || 'unknown';
    case 'lang': return row.lang || 'unknown';
    case 'assistant': return assistantKey(row);
  }
}

export type Labeler = (dim: Dimension, key: string) => string;

export function defaultLabel(dim: Dimension, key: string, tenantNames?: Record<string, string>): string {
  if (dim === 'assistant') return ASSISTANT_LABELS[key] ?? key;
  if (dim === 'tenant') return key === 'none' ? 'No tenant' : (tenantNames?.[key] ?? key);
  return key;
}

function groupBy(rows: FactRow[], dim: Dimension): Map<string, FactRow[]> {
  const m = new Map<string, FactRow[]>();
  for (const r of rows) {
    const k = dimensionKey(r, dim);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Verdict: everyone, or one segment?
// ---------------------------------------------------------------------------

export interface Verdict {
  scope: 'system' | Exclude<Dimension, 'assistant'>;
  key: string;
  label: string;
  metric: FailureMetric | 'ttfa';
  segment_rate: number;
  baseline_rate: number | null;
  sessions: number;
  severity: 'critical' | 'warning';
  message: string;
}

export type VerdictSummary = 'healthy' | 'system_wide' | 'segment_specific' | 'insufficient_data';

const METRIC_TEXT: Record<FailureMetric | 'ttfa', string> = {
  silent: 'silent sessions',
  one_way: 'one-way audio',
  drop: 'dropped sessions',
  error: 'errored sessions',
  ttfa: 'time to first audio (p50)',
};

function pct(x: number | null): string {
  return x === null ? 'n/a' : `${Math.round(x * 1000) / 10}%`;
}

/** Pure anomaly rule for a failure rate vs the rest of the traffic. */
export function isRateAnomalous(segmentRate: number, baselineRate: number): boolean {
  return segmentRate >= Math.max(baselineRate * 2, baselineRate + 0.10);
}

/** Pure anomaly rule for p50 time-to-first-audio vs the rest. */
export function isLatencyAnomalous(segmentP50: number, baselineP50: number): boolean {
  return segmentP50 >= baselineP50 * 1.5 && segmentP50 - baselineP50 >= 500;
}

function metricRate(t: Tally, m: FailureMetric): number | null {
  return ratio(t.counts[OUTCOME_FOR[m]] || 0, t.finished);
}

export function computeVerdicts(
  rows: FactRow[],
  nowMs: number,
  label: Labeler = (d, k) => defaultLabel(d, k),
): { verdicts: Verdict[]; verdict_summary: VerdictSummary } {
  const total = tally(rows, nowMs);
  if (total.finished < MIN_SAMPLE) return { verdicts: [], verdict_summary: 'insufficient_data' };

  const segmentVerdicts: Verdict[] = [];
  const systemVerdicts: Verdict[] = [];

  for (const dim of VERDICT_DIMENSIONS) {
    const groups = groupBy(rows, dim);
    if (groups.size < 2) continue; // nothing to compare against
    for (const [key, segRows] of groups) {
      const seg = tally(segRows, nowMs);
      if (seg.finished < MIN_SAMPLE) continue;
      const restRows = rows.filter((r) => dimensionKey(r, dim) !== key);
      const rest = tally(restRows, nowMs);
      if (rest.finished < MIN_SAMPLE) continue;
      for (const m of FAILURE_METRICS) {
        const sr = metricRate(seg, m) ?? 0;
        const br = metricRate(rest, m) ?? 0;
        if (sr > 0 && isRateAnomalous(sr, br)) {
          segmentVerdicts.push({
            scope: dim,
            key,
            label: label(dim, key),
            metric: m,
            segment_rate: sr,
            baseline_rate: br,
            sessions: seg.finished,
            severity: sr >= SYSTEM_THRESHOLDS[m] && sr >= br * 3 ? 'critical' : 'warning',
            message: `${METRIC_TEXT[m]} at ${pct(sr)} for ${dim} ${label(dim, key)} vs ${pct(br)} elsewhere (${seg.finished} sessions)`,
          });
        }
      }
      const segP50 = seg.ttfa.length >= MIN_SAMPLE ? percentile(seg.ttfa, 0.5) : null;
      const restP50 = rest.ttfa.length >= MIN_SAMPLE ? percentile(rest.ttfa, 0.5) : null;
      if (segP50 !== null && restP50 !== null && isLatencyAnomalous(segP50, restP50)) {
        segmentVerdicts.push({
          scope: dim,
          key,
          label: label(dim, key),
          metric: 'ttfa',
          segment_rate: segP50,
          baseline_rate: restP50,
          sessions: seg.finished,
          severity: segP50 >= restP50 * 2 ? 'critical' : 'warning',
          message: `${METRIC_TEXT.ttfa} ${segP50} ms for ${dim} ${label(dim, key)} vs ${restP50} ms elsewhere (${seg.ttfa.length} sessions)`,
        });
      }
    }
  }

  // System-wide: the overall rate is over threshold AND either the failure is
  // spread across >= 60% of some dimension's eligible segments, or no single
  // segment explains it (no segment anomaly found for that metric).
  for (const m of FAILURE_METRICS) {
    const overall = metricRate(total, m) ?? 0;
    if (overall <= SYSTEM_THRESHOLDS[m]) continue;
    const explained = segmentVerdicts.some((v) => v.metric === m);
    let spread = false;
    for (const dim of VERDICT_DIMENSIONS) {
      const eligible = [...groupBy(rows, dim).values()]
        .map((g) => tally(g, nowMs))
        .filter((t) => t.finished >= MIN_SAMPLE);
      if (eligible.length < 2) continue;
      const bad = eligible.filter((t) => (metricRate(t, m) ?? 0) > SYSTEM_THRESHOLDS[m]).length;
      if (bad / eligible.length >= SYSTEM_SPREAD) { spread = true; break; }
    }
    if (spread || !explained) {
      systemVerdicts.push({
        scope: 'system',
        key: m,
        label: 'All voice sessions',
        metric: m,
        segment_rate: overall,
        baseline_rate: null,
        sessions: total.finished,
        severity: 'critical',
        message: `${METRIC_TEXT[m]} at ${pct(overall)} across all voice sessions (threshold ${pct(SYSTEM_THRESHOLDS[m])}, ${total.finished} sessions)`,
      });
    }
  }

  const severityRank = (v: Verdict) => (v.severity === 'critical' ? 0 : 1);
  segmentVerdicts.sort((a, b) => severityRank(a) - severityRank(b) || b.sessions - a.sessions);
  const verdicts = [...systemVerdicts, ...segmentVerdicts];
  const verdict_summary: VerdictSummary = systemVerdicts.length
    ? 'system_wide'
    : segmentVerdicts.length
      ? 'segment_specific'
      : 'healthy';
  return { verdicts, verdict_summary };
}

// ---------------------------------------------------------------------------
// Segment matrix
// ---------------------------------------------------------------------------

export interface Cell {
  sessions: number;
  ok_rate: number | null;
  silent_rate: number | null;
  one_way_rate: number | null;
  drop_rate: number | null;
  p50_ttfa_ms: number | null;
  health: 'ok' | 'warn' | 'bad' | 'insufficient';
}

export function cellHealth(k: Kpis): Cell['health'] {
  if (k.finished < CELL_MIN_SAMPLE) return 'insufficient';
  const rates: Array<[FailureMetric, number | null]> = [
    ['silent', k.silent_rate], ['one_way', k.one_way_rate], ['drop', k.drop_rate], ['error', k.error_rate],
  ];
  if (rates.some(([m, r]) => (r ?? 0) > SYSTEM_THRESHOLDS[m]) || (k.p50_ttfa_ms ?? 0) > TTFA_BAD_MS) return 'bad';
  if (rates.some(([m, r]) => (r ?? 0) > SYSTEM_THRESHOLDS[m] / 2) || (k.p50_ttfa_ms ?? 0) > TTFA_WARN_MS) return 'warn';
  return 'ok';
}

export function toCell(rows: FactRow[], nowMs: number): Cell {
  const k = computeKpis(rows, nowMs);
  return {
    sessions: k.sessions,
    ok_rate: k.ok_rate,
    silent_rate: k.silent_rate,
    one_way_rate: k.one_way_rate,
    drop_rate: k.drop_rate,
    p50_ttfa_ms: k.p50_ttfa_ms,
    health: cellHealth(k),
  };
}

export interface SegmentMatrix {
  row_dim: Dimension;
  col_dim: Dimension;
  columns: Array<{ key: string; label: string }>;
  rows: Array<{ key: string; label: string; cells: Record<string, Cell>; total: Cell }>;
  totals: Cell;
}

const ASSISTANT_ORDER = ['community', 'admin', 'backoffice', 'commerce', 'developer', 'anonymous'];

export function buildSegmentMatrix(
  rows: FactRow[],
  rowDim: Dimension,
  colDim: Dimension,
  nowMs: number,
  label: Labeler = (d, k) => defaultLabel(d, k),
): SegmentMatrix {
  const colGroups = groupBy(rows, colDim);
  const colKeys = colDim === 'assistant'
    ? ASSISTANT_ORDER.filter((k) => colGroups.has(k))
    : [...colGroups.entries()].sort((a, b) => b[1].length - a[1].length).map(([k]) => k);
  const rowGroups = [...groupBy(rows, rowDim).entries()].sort((a, b) => b[1].length - a[1].length);
  return {
    row_dim: rowDim,
    col_dim: colDim,
    columns: colKeys.map((k) => ({ key: k, label: label(colDim, k) })),
    rows: rowGroups.map(([key, segRows]) => {
      const byCol = groupBy(segRows, colDim);
      const cells: Record<string, Cell> = {};
      for (const ck of colKeys) {
        const cr = byCol.get(ck);
        if (cr && cr.length) cells[ck] = toCell(cr, nowMs);
      }
      return { key, label: label(rowDim, key), cells, total: toCell(segRows, nowMs) };
    }),
    totals: toCell(rows, nowMs),
  };
}

// ---------------------------------------------------------------------------
// Fix impact (VTID-04778)
// ---------------------------------------------------------------------------

export type ImpactVerdict = 'improved' | 'no_change' | 'regressed' | 'insufficient_data';

export interface ImpactComparison {
  target_metric: string;
  before_rate: number | null;
  after_rate: number | null;
  verdict: ImpactVerdict;
}

/** Improved/regressed needs >= 25% relative AND >= 2 percentage points. */
export const IMPACT_RELATIVE = 0.25;
export const IMPACT_ABSOLUTE = 0.02;

/**
 * Pure: compare a failure rate before vs after a fix. Lower is better.
 * Both windows need >= MIN_SAMPLE finished sessions.
 */
export function compareImpact(input: {
  before_sessions: number;
  after_sessions: number;
  before_rate: number | null;
  after_rate: number | null;
  target_metric: string;
}): ImpactComparison {
  const base = { target_metric: input.target_metric, before_rate: input.before_rate, after_rate: input.after_rate };
  if (input.before_sessions < MIN_SAMPLE || input.after_sessions < MIN_SAMPLE ||
      input.before_rate === null || input.after_rate === null) {
    return { ...base, verdict: 'insufficient_data' };
  }
  const diff = input.after_rate - input.before_rate;
  const rel = input.before_rate > 0 ? Math.abs(diff) / input.before_rate : (Math.abs(diff) > 0 ? Infinity : 0);
  if (diff < 0 && -diff >= IMPACT_ABSOLUTE && rel >= IMPACT_RELATIVE) return { ...base, verdict: 'improved' };
  if (diff > 0 && diff >= IMPACT_ABSOLUTE && rel >= IMPACT_RELATIVE) return { ...base, verdict: 'regressed' };
  return { ...base, verdict: 'no_change' };
}

/** The failure rate a fix is judged on: its class's rate when known, else 1 - ok_rate. */
export function targetFailureRate(rows: FactRow[], failureClass: string | null, nowMs: number): number | null {
  if (failureClass) return failureClassRate(rows, failureClass, nowMs);
  const k = computeKpis(rows, nowMs);
  return k.ok_rate === null ? null : 1 - k.ok_rate;
}

function diffOrNull(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}

export function kpiDelta(before: Kpis, after: Kpis): Record<'ok_rate' | 'silent_rate' | 'one_way_rate' | 'drop_rate' | 'p50_ttfa_ms', number | null> {
  return {
    ok_rate: diffOrNull(before.ok_rate, after.ok_rate),
    silent_rate: diffOrNull(before.silent_rate, after.silent_rate),
    one_way_rate: diffOrNull(before.one_way_rate, after.one_way_rate),
    drop_rate: diffOrNull(before.drop_rate, after.drop_rate),
    p50_ttfa_ms: diffOrNull(before.p50_ttfa_ms, after.p50_ttfa_ms),
  };
}

/** Rows matching a (possibly partial) segment. */
export function filterSegment(
  rows: FactRow[],
  seg: { tenant_id?: string | null; surface?: string | null; role?: string | null; provider?: string | null; lang?: string | null },
): FactRow[] {
  return rows.filter((r) =>
    (!seg.tenant_id || r.tenant_id === seg.tenant_id) &&
    (!seg.surface || r.surface === seg.surface) &&
    (!seg.role || r.role === seg.role) &&
    (!seg.provider || r.provider === seg.provider) &&
    (!seg.lang || r.lang === seg.lang));
}
