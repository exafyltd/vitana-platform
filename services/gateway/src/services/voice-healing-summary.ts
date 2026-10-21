/**
 * Voice Healing Summary + Shadow Comparison + Live Monitor (VTID-01965, VTID-01991)
 *
 * Aggregates the Voice Self-Healing Loop's state for the dashboard:
 *
 *   buildHealingSummary():
 *     Per-class metrics (24h/7d/30d dispatch counts, fix success rate
 *     probe-verified, avg time-to-recurrence, rollback count, quarantine
 *     status, probation status, latest investigation report ID).
 *     Plus loop-wide unknown-class debt percentage (Week-1/2/4 SLO band).
 *
 *   buildShadowComparison(window_hours):
 *     Joins voice_healing_shadow_log decisions in the window with the
 *     ACTUAL outcomes captured in voice_healing_history for the same
 *     (class, signature) pair. Used during the ≥48h shadow observation
 *     period before flipping mode=live.
 *
 *   buildLiveMonitor() (VTID-01991):
 *     Real-time view for the Command Hub Voice tab. Recent voice
 *     session-stops with audio_in/audio_out ratios, 24h rollup of
 *     BAD/warn/OK counts, and watchdog telemetry (watchdog_skipped vs
 *     watchdog_fired) so ops can see the VTID-01984 watchdog fix working.
 *
 * Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md
 */

import {
  VOICE_FAILURE_CLASSES,
  VoiceFailureClass,
} from './voice-failure-taxonomy';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

function supabaseHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
  };
}

function isoMinusHours(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

// =============================================================================
// Healing Summary
// =============================================================================

export interface PerClassSummary {
  class: VoiceFailureClass;
  dispatch_count_24h: number;
  dispatch_count_7d: number;
  dispatch_count_30d: number;
  rollback_count_7d: number;
  fix_success_rate_7d: number | null;
  avg_recurrence_after_fix_ms_7d: number | null;
  quarantine_status: 'active' | 'quarantined' | 'probation' | 'released' | 'unknown';
  probation_until: string | null;
  latest_investigation_report_id: string | null;
}

export interface UnknownClassDebt {
  unknown_count_24h: number;
  total_count_24h: number;
  unknown_pct_24h: number;
  /** SLO band per the plan: week 1 < 25%, week 2 < 10%, week 4 < 5%. */
  slo_band: 'week1' | 'week2' | 'week4' | 'over_slo';
}

export interface HealingSummary {
  generated_at: string;
  per_class: PerClassSummary[];
  unknown_class_debt: UnknownClassDebt;
}

interface HistoryRow {
  class: string;
  normalized_signature: string;
  dispatched_at: string;
  verdict: 'ok' | 'rollback' | 'partial' | 'suppressed';
  recurrence_after_fix_ms: number | null;
}

async function fetchHistoryWindow(sinceIso: string): Promise<HistoryRow[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return [];
  const url =
    `${SUPABASE_URL}/rest/v1/voice_healing_history?` +
    `dispatched_at=gte.${encodeURIComponent(sinceIso)}&` +
    `select=class,normalized_signature,dispatched_at,verdict,recurrence_after_fix_ms&` +
    `order=dispatched_at.desc&limit=2000`;
  try {
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) return [];
    return (await res.json()) as HistoryRow[];
  } catch {
    return [];
  }
}

interface QuarantineRow {
  class: string;
  normalized_signature: string;
  status: string;
  probation_until: string | null;
}

async function fetchQuarantineRows(): Promise<QuarantineRow[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return [];
  const url =
    `${SUPABASE_URL}/rest/v1/voice_healing_quarantine?` +
    `status=in.(quarantined,probation)&` +
    `select=class,normalized_signature,status,probation_until&limit=500`;
  try {
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) return [];
    return (await res.json()) as QuarantineRow[];
  } catch {
    return [];
  }
}

interface ReportRow {
  id: string;
  class: string;
  generated_at: string;
}

async function fetchLatestReports(): Promise<Map<string, ReportRow>> {
  const map = new Map<string, ReportRow>();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return map;
  const url =
    `${SUPABASE_URL}/rest/v1/voice_architecture_reports?` +
    `select=id,class,generated_at&order=generated_at.desc&limit=200`;
  try {
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) return map;
    const rows = (await res.json()) as ReportRow[];
    for (const r of rows) {
      if (!map.has(r.class)) map.set(r.class, r);
    }
    return map;
  } catch {
    return map;
  }
}

function computeUnknownClassDebt(history24h: HistoryRow[]): UnknownClassDebt {
  const total = history24h.length;
  const unknown = history24h.filter((r) => r.class === 'voice.unknown').length;
  const pct = total > 0 ? (unknown / total) * 100 : 0;
  const slo_band: UnknownClassDebt['slo_band'] =
    pct < 5 ? 'week4' : pct < 10 ? 'week2' : pct < 25 ? 'week1' : 'over_slo';
  return {
    unknown_count_24h: unknown,
    total_count_24h: total,
    unknown_pct_24h: Number(pct.toFixed(2)),
    slo_band,
  };
}

function computePerClass(
  klass: VoiceFailureClass,
  hist24h: HistoryRow[],
  hist7d: HistoryRow[],
  hist30d: HistoryRow[],
  quarantineRows: QuarantineRow[],
  reportMap: Map<string, ReportRow>,
): PerClassSummary {
  const filter24 = hist24h.filter((r) => r.class === klass);
  const filter7 = hist7d.filter((r) => r.class === klass);
  const filter30 = hist30d.filter((r) => r.class === klass);

  const dispatch_count_24h = filter24.length;
  const dispatch_count_7d = filter7.length;
  const dispatch_count_30d = filter30.length;

  const rollbacks7 = filter7.filter((r) => r.verdict === 'rollback');
  const rollback_count_7d = rollbacks7.length;

  const verdicts7 = filter7.filter((r) => r.verdict === 'ok' || r.verdict === 'rollback');
  const successes7 = filter7.filter((r) => r.verdict === 'ok');
  const fix_success_rate_7d =
    verdicts7.length > 0
      ? Number(((successes7.length / verdicts7.length) * 100).toFixed(2))
      : null;

  const recurrenceVals7 = filter7
    .map((r) => r.recurrence_after_fix_ms)
    .filter((v): v is number => typeof v === 'number');
  const avg_recurrence_after_fix_ms_7d =
    recurrenceVals7.length > 0
      ? Math.round(recurrenceVals7.reduce((a, b) => a + b, 0) / recurrenceVals7.length)
      : null;

  // For status, prefer the most "active" status across signatures (quarantined > probation > active).
  const qRows = quarantineRows.filter((q) => q.class === klass);
  let quarantine_status: PerClassSummary['quarantine_status'] = 'active';
  let probation_until: string | null = null;
  if (qRows.some((q) => q.status === 'quarantined')) {
    quarantine_status = 'quarantined';
  } else if (qRows.some((q) => q.status === 'probation')) {
    quarantine_status = 'probation';
    probation_until =
      qRows.find((q) => q.status === 'probation')?.probation_until ?? null;
  }

  const latestReport = reportMap.get(klass);

  return {
    class: klass,
    dispatch_count_24h,
    dispatch_count_7d,
    dispatch_count_30d,
    rollback_count_7d,
    fix_success_rate_7d,
    avg_recurrence_after_fix_ms_7d,
    quarantine_status,
    probation_until,
    latest_investigation_report_id: latestReport?.id ?? null,
  };
}

export async function buildHealingSummary(): Promise<HealingSummary> {
  const since24h = isoMinusHours(24);
  const since7d = isoMinusHours(24 * 7);
  const since30d = isoMinusHours(24 * 30);

  const [hist24h, hist7d, hist30d, quarantineRows, reportMap] = await Promise.all([
    fetchHistoryWindow(since24h),
    fetchHistoryWindow(since7d),
    fetchHistoryWindow(since30d),
    fetchQuarantineRows(),
    fetchLatestReports(),
  ]);

  const per_class: PerClassSummary[] = VOICE_FAILURE_CLASSES.map((c) =>
    computePerClass(c, hist24h, hist7d, hist30d, quarantineRows, reportMap),
  );

  const unknown_class_debt = computeUnknownClassDebt(hist24h);

  return {
    generated_at: new Date().toISOString(),
    per_class,
    unknown_class_debt,
  };
}

// =============================================================================
// Shadow Comparison
// =============================================================================

export interface ShadowComparisonRow {
  class: string;
  normalized_signature: string | null;
  shadow_action: string;
  shadow_decided_at: string;
  /** Did history record an actual verdict for this (class, signature) within
   *  ±15 min of the shadow decision? */
  matched_actual: boolean;
  actual_verdict: string | null;
  actual_dispatched_at: string | null;
}

export interface ShadowComparison {
  window_hours: number;
  generated_at: string;
  total_shadow_decisions: number;
  rows: ShadowComparisonRow[];
  by_action: Record<string, number>;
  match_rate: number;
}

interface ShadowRow {
  decided_at: string;
  mode: string;
  action: string;
  class: string | null;
  normalized_signature: string | null;
  spec_hash: string | null;
}

async function fetchShadowRows(sinceIso: string): Promise<ShadowRow[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return [];
  const url =
    `${SUPABASE_URL}/rest/v1/voice_healing_shadow_log?` +
    `decided_at=gte.${encodeURIComponent(sinceIso)}&` +
    `select=decided_at,mode,action,class,normalized_signature,spec_hash&` +
    `order=decided_at.desc&limit=2000`;
  try {
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) return [];
    return (await res.json()) as ShadowRow[];
  } catch {
    return [];
  }
}

const MATCH_WINDOW_MS = 15 * 60 * 1000; // ±15 minutes

export async function buildShadowComparison(windowHours: number): Promise<ShadowComparison> {
  const sinceIso = isoMinusHours(windowHours);
  const [shadowRows, historyRows] = await Promise.all([
    fetchShadowRows(sinceIso),
    fetchHistoryWindow(sinceIso),
  ]);

  // Index history by (class, signature) for fast lookup.
  const histIndex = new Map<string, HistoryRow[]>();
  for (const h of historyRows) {
    const key = `${h.class}|${h.normalized_signature}`;
    const arr = histIndex.get(key) ?? [];
    arr.push(h);
    histIndex.set(key, arr);
  }

  const rows: ShadowComparisonRow[] = [];
  const by_action: Record<string, number> = {};
  let matched = 0;

  for (const s of shadowRows) {
    by_action[s.action] = (by_action[s.action] ?? 0) + 1;
    if (!s.class || !s.normalized_signature) {
      rows.push({
        class: s.class ?? '',
        normalized_signature: s.normalized_signature,
        shadow_action: s.action,
        shadow_decided_at: s.decided_at,
        matched_actual: false,
        actual_verdict: null,
        actual_dispatched_at: null,
      });
      continue;
    }
    const key = `${s.class}|${s.normalized_signature}`;
    const candidates = histIndex.get(key) ?? [];
    const shadowMs = new Date(s.decided_at).getTime();
    let match: HistoryRow | undefined;
    for (const c of candidates) {
      const cMs = new Date(c.dispatched_at).getTime();
      if (Math.abs(cMs - shadowMs) <= MATCH_WINDOW_MS) {
        match = c;
        break;
      }
    }
    if (match) matched++;
    rows.push({
      class: s.class,
      normalized_signature: s.normalized_signature,
      shadow_action: s.action,
      shadow_decided_at: s.decided_at,
      matched_actual: !!match,
      actual_verdict: match?.verdict ?? null,
      actual_dispatched_at: match?.dispatched_at ?? null,
    });
  }

  const match_rate = shadowRows.length > 0 ? Number(((matched / shadowRows.length) * 100).toFixed(2)) : 0;

  return {
    window_hours: windowHours,
    generated_at: new Date().toISOString(),
    total_shadow_decisions: shadowRows.length,
    rows: rows.slice(0, 200), // cap response size
    by_action,
    match_rate,
  };
}

// =============================================================================
// Live Monitor (VTID-01991)
// =============================================================================

export type SessionHealth = 'ok' | 'warn' | 'bad';

export interface LiveSessionRow {
  session_id: string;
  ended_at: string;
  audio_in_chunks: number;
  audio_out_chunks: number;
  ratio: number;
  turn_count: number;
  duration_ms: number;
  user_id: string | null;
  reason: string | null;
  health: SessionHealth;
}

export interface LiveMonitorRollup {
  total_sessions: number;
  ok_count: number;
  warn_count: number;
  bad_count: number;
  bad_pct: number;
}

export interface LiveMonitor {
  generated_at: string;
  recent_sessions: LiveSessionRow[];
  rollup_24h: LiveMonitorRollup;
  /** Count of orb.live.diag events with stage='watchdog_skipped' in last 24h. >0 means VTID-01984 fix is firing. */
  watchdog_skipped_24h: number;
  /** Count of orb.live.diag events with stage='watchdog_fired' AND reason='forwarding_no_ack' in last 24h. Should drop near zero post-VTID-01984. */
  watchdog_fired_forwarding_24h: number;
  /** Total watchdog_fired events (any reason) in last 24h, for context. */
  watchdog_fired_any_24h: number;
}

function ratioHealth(ratio: number): SessionHealth {
  if (ratio > 5) return 'bad';
  if (ratio > 3) return 'warn';
  return 'ok';
}

interface SessionStopRow {
  created_at: string;
  metadata: Record<string, unknown>;
}

async function fetchSessionStops(sinceIso: string, limit: number): Promise<SessionStopRow[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return [];
  const url =
    `${SUPABASE_URL}/rest/v1/oasis_events?` +
    `topic=eq.vtid.live.session.stop&` +
    `created_at=gte.${encodeURIComponent(sinceIso)}&` +
    `select=created_at,metadata&order=created_at.desc&limit=${limit}`;
  try {
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) return [];
    return (await res.json()) as SessionStopRow[];
  } catch {
    return [];
  }
}

async function fetchDiagCount(stage: string, sinceIso: string, extraFilter = ''): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return 0;
  const url =
    `${SUPABASE_URL}/rest/v1/oasis_events?` +
    `topic=eq.orb.live.diag&` +
    `metadata->>stage=eq.${encodeURIComponent(stage)}&` +
    `created_at=gte.${encodeURIComponent(sinceIso)}` +
    extraFilter +
    `&select=id`;
  try {
    const res = await fetch(url, {
      headers: { ...supabaseHeaders(), Prefer: 'count=exact' },
    });
    if (!res.ok) return 0;
    const cr = res.headers.get('content-range') || '';
    const m = /\/(\d+)$/.exec(cr);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

function rowFromStop(stop: SessionStopRow): LiveSessionRow {
  const m = stop.metadata || {};
  const ai = Number(m.audio_in_chunks ?? 0);
  const ao = Number(m.audio_out_chunks ?? 0);
  const ratio = ao > 0 ? ai / ao : ai > 0 ? ai : 0;
  return {
    session_id: String(m.session_id ?? '(unknown)'),
    ended_at: stop.created_at,
    audio_in_chunks: ai,
    audio_out_chunks: ao,
    ratio: Number(ratio.toFixed(1)),
    turn_count: Number(m.turn_count ?? 0),
    duration_ms: Number(m.duration_ms ?? 0),
    user_id: (m.user_id as string | null) ?? null,
    reason: (m.reason as string | null) ?? null,
    health: ratioHealth(ratio),
  };
}

/**
 * Live Monitor for the Command Hub Voice Self-Healing tab. Shows recent
 * session-stops with audio_in/audio_out ratios + 24h health rollup +
 * watchdog telemetry (proves VTID-01984 fix is firing).
 */
export async function buildLiveMonitor(): Promise<LiveMonitor> {
  const since24hIso = isoMinusHours(24);

  const [stops24h, recentStops, watchdogSkipped, watchdogFiredFwd, watchdogFiredAny] =
    await Promise.all([
      fetchSessionStops(since24hIso, 500),
      fetchSessionStops(since24hIso, 20),
      fetchDiagCount('watchdog_skipped', since24hIso),
      // forwarding_no_ack: filter on metadata->>reason
      fetchDiagCount(
        'watchdog_fired',
        since24hIso,
        '&metadata->>reason=eq.forwarding_no_ack',
      ),
      fetchDiagCount('watchdog_fired', since24hIso),
    ]);

  // Compute rollup over the 24h dataset, but only count sessions that
  // actually exchanged audio (audio_in_chunks > 0). Sessions that ended
  // immediately (mic permission denied, abandoned) skew BAD% otherwise.
  let total = 0;
  let ok = 0;
  let warn = 0;
  let bad = 0;
  for (const s of stops24h) {
    const ai = Number(s.metadata?.audio_in_chunks ?? 0);
    const ao = Number(s.metadata?.audio_out_chunks ?? 0);
    if (ai === 0 && ao === 0) continue;
    if (ai < 50) continue; // session too short to be a real conversation
    total++;
    const ratio = ao > 0 ? ai / ao : ai;
    const h = ratioHealth(ratio);
    if (h === 'ok') ok++;
    else if (h === 'warn') warn++;
    else bad++;
  }
  const bad_pct = total > 0 ? Number(((bad / total) * 100).toFixed(1)) : 0;

  return {
    generated_at: new Date().toISOString(),
    recent_sessions: recentStops.map(rowFromStop),
    rollup_24h: {
      total_sessions: total,
      ok_count: ok,
      warn_count: warn,
      bad_count: bad,
      bad_pct,
    },
    watchdog_skipped_24h: watchdogSkipped,
    watchdog_fired_forwarding_24h: watchdogFiredFwd,
    watchdog_fired_any_24h: watchdogFiredAny,
  };
}
