/**
 * VTID-04670 (P5 of docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md): learn
 * from the decisions people make on developer recommendations.
 *
 * Every dismiss now carries a reason (DISMISS_REASON_CODES, stored by
 * POST /api/v1/autopilot/recommendations/:id/reject as quality.dismiss for
 * developer rows). This module turns the last ACCEPTANCE_WINDOW_DAYS of
 * decided developer recommendations into per-producer acceptance, keyed
 * exactly like the P4 breaker and the P2 score (breakerKeyFor — scanner id,
 * `impact:<rule>`, else source_type):
 *
 *   activated, completed, rejected (by reason), auto_archived
 *   decided         = activated + completed + rejected   (human decisions)
 *   acceptance_rate = (activated + completed) / decided
 *
 * auto_archived (the P3 review, the lineup cap, expiry) is counted but is
 * not a human decision, so it is on neither side of the rate.
 *
 * A key with ≥ DEMOTION_MIN_DECIDED human decisions and an acceptance rate
 * below DEMOTION_MAX_RATE is DEMOTED: the P2 score multiplies its
 * confidence by DEMOTION_FACTOR, which takes even a fully confident card
 * (1.0 × 0.5) below the 0.6 floor. When at least half of its dismissals
 * say the card was noise (`not_a_real_problem` / `duplicate`) the stronger
 * NOISE_DEMOTION_FACTOR applies.
 *
 * Pure except loadAcceptanceStats (one read, cached) and
 * weeklySummaryTick (reads + one OASIS event per 7 days). A failed read
 * demotes nothing (fail-open: P2 scores as before).
 */
import { breakerKeyFor } from '../dev-autopilot-scanner-breaker';
import { emitOasisEvent } from '../oasis-event-service';
import type { AcceptanceLookup } from './priority';
import { defaultQualityQuery, type QualityQuery } from './rest';

const LOG_PREFIX = '[recommendation-acceptance]';

export const ACCEPTANCE_VTID = 'VTID-04670';

// ---------------------------------------------------------------------------
// Dismiss reasons
// ---------------------------------------------------------------------------

export const DISMISS_REASON_CODES = [
  'not_a_real_problem',
  'not_worth_it',
  'duplicate',
  'already_fixed',
  'wrong_fix',
  'other',
] as const;
export type DismissReasonCode = (typeof DISMISS_REASON_CODES)[number];

/** Dismissals that say the producer emitted noise, not a low-value truth. */
export const NOISE_REASON_CODES: ReadonlySet<DismissReasonCode> = new Set(['not_a_real_problem', 'duplicate']);

export const DISMISS_NOTE_MAX_CHARS = 300;

export function isDismissReasonCode(v: unknown): v is DismissReasonCode {
  return typeof v === 'string' && (DISMISS_REASON_CODES as readonly string[]).includes(v);
}

export interface DismissRecord {
  reason_code: DismissReasonCode;
  note: string | null;
  by: string | null;
  at: string;
}

/** The quality.dismiss object; the note is trimmed and capped. */
export function buildDismissRecord(code: DismissReasonCode, note: unknown, by: string | null, nowMs: number = Date.now()): DismissRecord {
  const n = typeof note === 'string' ? note.trim().slice(0, DISMISS_NOTE_MAX_CHARS) : '';
  return { reason_code: code, note: n || null, by: by || null, at: new Date(nowMs).toISOString() };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export const ACCEPTANCE_WINDOW_DAYS = 90;
export const DEMOTION_MIN_DECIDED = 10;
export const DEMOTION_MAX_RATE = 0.1;
export const DEMOTION_FACTOR = 0.5;
export const NOISE_DEMOTION_FACTOR = 0.35;
/** Share of dismissals that must be noise for NOISE_DEMOTION_FACTOR. */
export const NOISE_SHARE_THRESHOLD = 0.5;
export const ACCEPTANCE_READ_LIMIT = 5000;
export const ACCEPTANCE_CACHE_MS = 10 * 60 * 1000;

export interface AcceptanceRow {
  source_type?: string | null;
  scanner?: string | null;
  rule?: string | null;
  spec_snapshot?: { scanner?: unknown; rule?: unknown } | null;
  status: string;
  dismiss_reason?: string | null;
  updated_at?: string | null;
}

export interface AcceptanceStat {
  key: string;
  activated: number;
  completed: number;
  rejected: number;
  rejected_by_reason: Record<string, number>;
  auto_archived: number;
  decided: number;
  accepted: number;
  acceptance_rate: number | null;
  noise_rejections: number;
  demoted: boolean;
  demotion_factor: number;
}

function blank(key: string): AcceptanceStat {
  return {
    key, activated: 0, completed: 0, rejected: 0, rejected_by_reason: {}, auto_archived: 0,
    decided: 0, accepted: 0, acceptance_rate: null, noise_rejections: 0, demoted: false, demotion_factor: 1,
  };
}

/** Pure: per-key acceptance from decided developer recommendation rows. */
export function computeAcceptanceStats(rows: AcceptanceRow[]): Map<string, AcceptanceStat> {
  const out = new Map<string, AcceptanceStat>();
  for (const r of rows || []) {
    if (!r || r.source_type === 'community' || r.source_type === 'operator_onramp') continue;
    const key = breakerKeyFor(r);
    if (!key) continue;
    const s = out.get(key) || blank(key);
    switch (r.status) {
      case 'activated': s.activated++; break;
      case 'completed': s.completed++; break;
      case 'rejected': {
        s.rejected++;
        const reason = isDismissReasonCode(r.dismiss_reason) ? r.dismiss_reason : 'unspecified';
        s.rejected_by_reason[reason] = (s.rejected_by_reason[reason] || 0) + 1;
        if (NOISE_REASON_CODES.has(reason as DismissReasonCode)) s.noise_rejections++;
        break;
      }
      case 'auto_archived': s.auto_archived++; break;
      default: continue;
    }
    out.set(key, s);
  }
  for (const s of out.values()) {
    s.accepted = s.activated + s.completed;
    s.decided = s.accepted + s.rejected;
    s.acceptance_rate = s.decided > 0 ? Math.round((s.accepted / s.decided) * 10000) / 10000 : null;
    s.demoted = s.decided >= DEMOTION_MIN_DECIDED && (s.acceptance_rate ?? 1) < DEMOTION_MAX_RATE;
    s.demotion_factor = !s.demoted
      ? 1
      : s.rejected > 0 && s.noise_rejections / s.rejected >= NOISE_SHARE_THRESHOLD ? NOISE_DEMOTION_FACTOR : DEMOTION_FACTOR;
  }
  return out;
}

/** The injected lookup priority.ts reads (keeps priority.ts pure). */
export function acceptanceLookupFrom(stats: Map<string, AcceptanceStat> | null | undefined): (key: string) => AcceptanceLookup | null {
  return (key: string) => {
    const s = stats?.get(key);
    if (!s) return null;
    return {
      decided: s.decided,
      accepted: s.accepted,
      acceptance_rate: s.acceptance_rate,
      demoted: s.demoted,
      demotion_factor: s.demotion_factor,
      noise_rejections: s.noise_rejections,
    };
  };
}

/** Top dismiss reasons, most frequent first. */
export function topDismissReasons(s: AcceptanceStat, n = 3): Array<{ reason: string; count: number }> {
  return Object.entries(s.rejected_by_reason)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, n);
}

/** Supervisor payload: demoted keys first, then most decided. */
export function summarizeAcceptance(stats: Map<string, AcceptanceStat>, ok = true) {
  const items = [...stats.values()]
    .sort((a, b) => Number(b.demoted) - Number(a.demoted) || b.decided - a.decided || a.key.localeCompare(b.key))
    .map((s) => ({
      key: s.key,
      decided: s.decided,
      accepted: s.accepted,
      rate: s.acceptance_rate,
      rejected: s.rejected,
      auto_archived: s.auto_archived,
      top_dismiss_reasons: topDismissReasons(s),
      demoted: s.demoted,
      demotion_factor: s.demotion_factor,
    }));
  const decided = items.reduce((a, i) => a + i.decided, 0);
  const accepted = items.reduce((a, i) => a + i.accepted, 0);
  return {
    ok,
    window_days: ACCEPTANCE_WINDOW_DAYS,
    thresholds: { min_decided: DEMOTION_MIN_DECIDED, max_rate: DEMOTION_MAX_RATE, factor: DEMOTION_FACTOR, noise_factor: NOISE_DEMOTION_FACTOR },
    decided,
    accepted,
    rate: decided > 0 ? Math.round((accepted / decided) * 10000) / 10000 : null,
    demoted: items.filter((i) => i.demoted).map((i) => i.key),
    items,
  };
}

/** PostgREST read of decided developer recommendations in the window. */
export function acceptanceQueryPath(sinceIso: string): string {
  return `/rest/v1/autopilot_recommendations?user_id=is.null`
    + `&source_type=not.in.(community,operator_onramp)`
    + `&status=in.(activated,completed,rejected,auto_archived)`
    + `&updated_at=gte.${encodeURIComponent(sinceIso)}`
    + `&select=source_type,status,updated_at,scanner:spec_snapshot->>scanner,rule:spec_snapshot->>rule,dismiss_reason:quality->dismiss->>reason_code`
    + `&order=updated_at.desc&limit=${ACCEPTANCE_READ_LIMIT}`;
}

let cache: { at: number; value: { ok: boolean; stats: Map<string, AcceptanceStat>; rows: AcceptanceRow[] } } | null = null;
let lastWeeklyCheckMs = 0;

/** Test hook. */
export function resetAcceptanceState(): void {
  cache = null;
  lastWeeklyCheckMs = 0;
}

export async function loadAcceptanceStats(
  query: QualityQuery = defaultQualityQuery,
  opts: { nowMs?: number; useCache?: boolean } = {},
): Promise<{ ok: boolean; stats: Map<string, AcceptanceStat>; rows: AcceptanceRow[] }> {
  const nowMs = opts.nowMs ?? Date.now();
  const useCache = opts.useCache !== false;
  if (useCache && cache && nowMs - cache.at < ACCEPTANCE_CACHE_MS) return cache.value;
  const since = new Date(nowMs - ACCEPTANCE_WINDOW_DAYS * 86400000).toISOString();
  try {
    const r = await query<AcceptanceRow[]>(acceptanceQueryPath(since));
    if (!r.ok || !Array.isArray(r.data)) return { ok: false, stats: new Map(), rows: [] };
    const value = { ok: true, stats: computeAcceptanceStats(r.data), rows: r.data };
    if (useCache) cache = { at: nowMs, value };
    return value;
  } catch (err) {
    console.warn(`${LOG_PREFIX} acceptance stats unavailable (nothing demoted): ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, stats: new Map(), rows: [] };
  }
}

// ---------------------------------------------------------------------------
// Weekly summary
// ---------------------------------------------------------------------------

export const WEEKLY_SUMMARY_TOPIC = 'autopilot.recommendations.weekly_summary';
export const WEEKLY_SUMMARY_EVERY_MS = 7 * 86400000;
/** How often the tick even looks (it runs on the 30 s executor loop). */
export const WEEKLY_SUMMARY_CHECK_EVERY_MS = 60 * 60 * 1000;

export interface WeeklySummaryInput {
  stats: Map<string, AcceptanceStat>;
  /** Decided rows of the window (with updated_at) — the last 7 days are sliced out. */
  decidedRows: AcceptanceRow[];
  /** Developer recommendations created in the last 7 days. */
  createdRows: Array<{ source_type: string | null; scanner?: string | null; rule?: string | null }>;
  nowMs: number;
}

/** Pure: the payload of one weekly summary event. */
export function buildWeeklySummary(input: WeeklySummaryInput) {
  const weekAgo = input.nowMs - WEEKLY_SUMMARY_EVERY_MS;
  const createdBySource: Record<string, number> = {};
  const createdByKey: Record<string, number> = {};
  for (const r of input.createdRows || []) {
    const src = r.source_type || 'unknown';
    createdBySource[src] = (createdBySource[src] || 0) + 1;
    const key = breakerKeyFor(r);
    if (key) createdByKey[key] = (createdByKey[key] || 0) + 1;
  }
  const weekRows = (input.decidedRows || []).filter((r) => {
    const t = Date.parse(r.updated_at || '');
    return Number.isFinite(t) && t >= weekAgo;
  });
  const decidedBySource: Record<string, Record<string, number>> = {};
  for (const r of weekRows) {
    const src = r.source_type || 'unknown';
    const bucket = decidedBySource[src] || (decidedBySource[src] = {});
    bucket[r.status] = (bucket[r.status] || 0) + 1;
  }
  const week = summarizeAcceptance(computeAcceptanceStats(weekRows));
  const window = summarizeAcceptance(input.stats);
  return {
    period_start: new Date(weekAgo).toISOString(),
    period_end: new Date(input.nowMs).toISOString(),
    created_by_source: createdBySource,
    created_by_key: createdByKey,
    decided_by_source: decidedBySource,
    week: { decided: week.decided, accepted: week.accepted, rate: week.rate },
    window: { days: ACCEPTANCE_WINDOW_DAYS, decided: window.decided, accepted: window.accepted, rate: window.rate },
    acceptance_by_key: window.items.slice(0, 25).map((i) => ({ key: i.key, decided: i.decided, accepted: i.accepted, rate: i.rate, top_dismiss_reasons: i.top_dismiss_reasons, demoted: i.demoted })),
    demoted_keys: window.demoted,
  };
}

export interface WeeklySummaryDeps {
  query?: QualityQuery;
  emit?: typeof emitOasisEvent;
}

/**
 * At most once per WEEKLY_SUMMARY_EVERY_MS, guarded by the newest
 * `autopilot.recommendations.weekly_summary` event already in oasis_events
 * (so a gateway restart does not re-send it). A failed read sends nothing.
 * Never throws. Returns what it did.
 */
export async function weeklySummaryTick(
  nowMs: number = Date.now(),
  deps: WeeklySummaryDeps = {},
): Promise<{ emitted: boolean; reason: string }> {
  if (nowMs - lastWeeklyCheckMs < WEEKLY_SUMMARY_CHECK_EVERY_MS) return { emitted: false, reason: 'throttled' };
  lastWeeklyCheckMs = nowMs;
  const query = deps.query || defaultQualityQuery;
  const emit = deps.emit || emitOasisEvent;
  try {
    const last = await query<Array<{ created_at: string }>>(
      `/rest/v1/oasis_events?topic=eq.${WEEKLY_SUMMARY_TOPIC}&select=created_at&order=created_at.desc&limit=1`,
    );
    if (!last.ok || !Array.isArray(last.data)) return { emitted: false, reason: 'last_summary_unreadable' };
    const lastMs = last.data[0] ? Date.parse(last.data[0].created_at) : NaN;
    if (Number.isFinite(lastMs) && nowMs - lastMs < WEEKLY_SUMMARY_EVERY_MS) return { emitted: false, reason: 'not_due' };

    const loaded = await loadAcceptanceStats(query, { nowMs, useCache: false });
    if (!loaded.ok) return { emitted: false, reason: 'stats_unreadable' };
    const weekAgoIso = new Date(nowMs - WEEKLY_SUMMARY_EVERY_MS).toISOString();
    const created = await query<Array<{ source_type: string | null; scanner?: string | null; rule?: string | null }>>(
      `/rest/v1/autopilot_recommendations?user_id=is.null&source_type=not.in.(community,operator_onramp)`
      + `&created_at=gte.${encodeURIComponent(weekAgoIso)}`
      + `&select=source_type,scanner:spec_snapshot->>scanner,rule:spec_snapshot->>rule&limit=${ACCEPTANCE_READ_LIMIT}`,
    );
    if (!created.ok || !Array.isArray(created.data)) return { emitted: false, reason: 'created_unreadable' };

    const payload = buildWeeklySummary({ stats: loaded.stats, decidedRows: loaded.rows, createdRows: created.data, nowMs });
    const createdTotal = Object.values(payload.created_by_source).reduce((a, b) => a + b, 0);
    const rate = payload.week.rate === null ? 'n/a' : `${Math.round(payload.week.rate * 100)}%`;
    await emit({
      vtid: ACCEPTANCE_VTID,
      type: WEEKLY_SUMMARY_TOPIC,
      source: 'recommendation-quality',
      status: payload.demoted_keys.length > 0 ? 'warning' : 'info',
      message: `Developer recommendations this week: ${createdTotal} created, ${payload.week.decided} decided, ${rate} accepted; ${payload.demoted_keys.length} producer(s) demoted`,
      payload,
    });
    return { emitted: true, reason: 'due' };
  } catch (err) {
    console.warn(`${LOG_PREFIX} weekly summary failed: ${err instanceof Error ? err.message : String(err)}`);
    return { emitted: false, reason: 'error' };
  }
}
