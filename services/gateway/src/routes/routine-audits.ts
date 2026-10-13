/**
 * Routine Audit Endpoints (VTID-02006, VTID-02018)
 *
 * Server-side aggregation queries for the daily routines:
 *   - oasis-event-anomaly        → oasis-summary
 *   - supabase-io-audit          → io-pressure
 *   - autopilot-rec-quality      → autopilot-recs
 *   - vitana-index-health        → vitana-index
 *   - knowledge-docs-freshness   → knowledge-docs-staleness
 *   - dyk-tour-progress          → dyk-tour-progress
 *   - spec-memory-quarantine     → spec-memory-quarantine
 *   - mobile-screen-latency-rollup → mobile-screen-latency
 *
 * VTID-05103: each aggregation is an exported `audit*` function. The HTTP
 * routes are thin wrappers around them, and the in-gateway routine runner
 * (services/routine-runner) calls the same functions directly.
 *
 * All endpoints require `X-Routine-Token: $ROUTINE_INGEST_TOKEN` so the
 * remote-sandbox routine can authenticate without the Supabase service
 * role being embedded in its prompt.
 *
 * All endpoints are READ-ONLY. Each one wraps a single Supabase query and
 * returns aggregated results suitable for threshold checks.
 */

import { Router, Request, Response, NextFunction } from 'express';

export const routineAuditsRouter = Router();

const LOG_PREFIX = '[routine-audits]';

// =============================================================================
// Auth — same X-Routine-Token gate as /api/v1/routines POST/PATCH
// =============================================================================

function requireRoutineToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ROUTINE_INGEST_TOKEN;
  if (!expected) {
    res.status(503).json({ ok: false, error: 'ROUTINE_INGEST_TOKEN env var not configured' });
    return;
  }
  if (req.header('x-routine-token') !== expected) {
    res.status(401).json({ ok: false, error: 'Invalid or missing X-Routine-Token header' });
    return;
  }
  next();
}

async function supaFetch<T>(path: string, headers: Record<string, string> = {}): Promise<T | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const res = await fetch(`${url}${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...headers },
  });
  if (!res.ok) {
    console.error(`${LOG_PREFIX} supa fetch failed: ${res.status} ${path}`);
    return null;
  }
  return (await res.json()) as T;
}

async function supaCount(path: string): Promise<number | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const res = await fetch(`${url}${path}`, {
    method: 'HEAD',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'count=exact',
      Range: '0-0',
      'Range-Unit': 'items',
    },
  });
  if (!res.ok && res.status !== 206) return null;
  const cr = res.headers.get('content-range');
  if (!cr) return null;
  // content-range looks like "0-0/1234"
  const m = cr.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

// =============================================================================
// GET /api/v1/routines/audits/oasis-summary
// Used by: oasis-event-anomaly, supabase-io-audit
// =============================================================================

export async function auditOasisSummary(params: { windowHours?: number; untilHours?: number } = {}) {
  const sinceHours = Math.min(params.windowHours || 24, 24 * 14);
  const untilHours = params.untilHours || 0;
  const since = hoursAgoIso(sinceHours);
  const until = hoursAgoIso(untilHours);

  const totalCount = await supaCount(
    `/rest/v1/oasis_events?created_at=gte.${since}&created_at=lt.${until}`
  );
  const errorCount = await supaCount(
    `/rest/v1/oasis_events?created_at=gte.${since}&created_at=lt.${until}&status=in.(error,critical,warning)`
  );
  const infoCount = await supaCount(
    `/rest/v1/oasis_events?created_at=gte.${since}&created_at=lt.${until}&status=eq.info`
  );

  // Top 10 topics by count — pull a sample (limit 1000) and bucket client-side
  const sample = await supaFetch<Array<{ topic: string }>>(
    `/rest/v1/oasis_events?created_at=gte.${since}&created_at=lt.${until}&select=topic&order=created_at.desc&limit=2000`
  );
  const byTopic: Record<string, number> = {};
  if (sample) {
    for (const row of sample) {
      const t = row.topic || 'untyped';
      byTopic[t] = (byTopic[t] || 0) + 1;
    }
  }
  const topTopics = Object.entries(byTopic)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([topic, count]) => ({ topic, count }));

  return {
    window: { since, until, sinceHours, untilHours },
    total_count: totalCount,
    error_count: errorCount,
    info_count: infoCount,
    top_topics: topTopics,
    sample_size: sample?.length ?? 0,
  };
}

routineAuditsRouter.get(
  '/api/v1/routines/audits/oasis-summary',
  requireRoutineToken,
  async (req: Request, res: Response) => {
    try {
      const body = await auditOasisSummary({
        windowHours: parseInt(req.query.window_hours as string) || 24,
        untilHours: parseInt(req.query.until_hours as string) || 0,
      });
      return res.json({ ok: true, ...body });
    } catch (e: any) {
      console.error(`${LOG_PREFIX} oasis-summary error:`, e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// =============================================================================
// GET /api/v1/routines/audits/io-pressure
// Used by: supabase-io-audit
// =============================================================================

export async function auditIoPressure() {
  // Stale info-events that should have been pruned by the retention cron.
  const sevenDaysAgo = hoursAgoIso(7 * 24);
  const retentionDrift = await supaCount(
    `/rest/v1/oasis_events?status=eq.info&created_at=lt.${sevenDaysAgo}`
  );

  // Volume comparison — today vs prior 7d
  const todayCount = await supaCount(
    `/rest/v1/oasis_events?created_at=gte.${hoursAgoIso(24)}`
  );
  const baselineCount = await supaCount(
    `/rest/v1/oasis_events?created_at=gte.${hoursAgoIso(192)}&created_at=lt.${hoursAgoIso(24)}`
  );
  const baselineAvgPerDay = baselineCount != null ? Math.round(baselineCount / 7) : null;

  return {
    retention_drift_count: retentionDrift,
    today_count: todayCount,
    baseline_avg_per_day: baselineAvgPerDay,
  };
}

routineAuditsRouter.get(
  '/api/v1/routines/audits/io-pressure',
  requireRoutineToken,
  async (_req: Request, res: Response) => {
    try {
      return res.json({ ok: true, ...(await auditIoPressure()) });
    } catch (e: any) {
      console.error(`${LOG_PREFIX} io-pressure error:`, e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// =============================================================================
// GET /api/v1/routines/audits/autopilot-recs
// Used by: autopilot-rec-quality
// =============================================================================

interface AutopilotRecRow {
  id: string;
  pillar_tag: string | null;
  created_at: string;
}
interface AutopilotActionRow {
  recommendation_id: string;
  action: string;
  created_at: string;
}

async function summariseAutopilotWindow(sinceHours: number, untilHours: number) {
  const since = hoursAgoIso(sinceHours);
  const until = hoursAgoIso(untilHours);

  const recs = await supaFetch<AutopilotRecRow[]>(
    `/rest/v1/autopilot_recommendations?created_at=gte.${since}&created_at=lt.${until}` +
      `&select=id,pillar_tag,created_at&limit=2000&order=created_at.desc`
  );
  const actions = await supaFetch<AutopilotActionRow[]>(
    `/rest/v1/autopilot_recommendation_actions?created_at=gte.${since}&created_at=lt.${until}` +
      `&select=recommendation_id,action,created_at&limit=5000&order=created_at.desc`
  );

  const total = recs?.length ?? 0;
  const byPillar: Record<string, number> = {};
  let nullPillar = 0;
  for (const r of recs ?? []) {
    if (!r.pillar_tag) {
      nullPillar++;
    } else {
      byPillar[r.pillar_tag] = (byPillar[r.pillar_tag] || 0) + 1;
    }
  }
  const byAction: Record<string, number> = {};
  for (const a of actions ?? []) {
    byAction[a.action] = (byAction[a.action] || 0) + 1;
  }
  const accepted = byAction['accepted'] || byAction['approve'] || 0;
  const dismissed = byAction['dismissed'] || byAction['dismiss'] || 0;
  const snoozed = byAction['snoozed'] || byAction['snooze'] || 0;
  const totalActions = accepted + dismissed + snoozed;
  const acceptanceRate = totalActions > 0 ? accepted / totalActions : null;

  return {
    total,
    null_pillar_count: nullPillar,
    null_pillar_rate: total > 0 ? nullPillar / total : 0,
    by_pillar: byPillar,
    accepted,
    dismissed,
    snoozed,
    acceptance_rate: acceptanceRate,
    actions_total: totalActions,
  };
}

export async function auditAutopilotRecs() {
  const yesterday = await summariseAutopilotWindow(24, 0);
  const baseline = await summariseAutopilotWindow(192, 24);
  const baselineAvgPerDay = {
    total: Math.round(baseline.total / 7),
    accepted: Math.round(baseline.accepted / 7),
    dismissed: Math.round(baseline.dismissed / 7),
    snoozed: Math.round(baseline.snoozed / 7),
  };
  return {
    yesterday,
    baseline_window: baseline,
    baseline_avg_per_day: baselineAvgPerDay,
  };
}

routineAuditsRouter.get(
  '/api/v1/routines/audits/autopilot-recs',
  requireRoutineToken,
  async (_req: Request, res: Response) => {
    try {
      return res.json({ ok: true, ...(await auditAutopilotRecs()) });
    } catch (e: any) {
      console.error(`${LOG_PREFIX} autopilot-recs error:`, e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// =============================================================================
// GET /api/v1/routines/audits/vitana-index
// Used by: vitana-index-health
// =============================================================================

interface VitanaIndexRow {
  user_id: string | null;
  overall: number | null;
  nutrition: number | null;
  hydration: number | null;
  exercise: number | null;
  sleep: number | null;
  mental: number | null;
  balance_factor: number | null;
  created_at: string;
}

export async function auditVitanaIndex() {
  // Active users — distinct actor_id from oasis_events in last 7d as a usage proxy.
  const activeRows = await supaFetch<Array<{ actor_id: string | null }>>(
    `/rest/v1/oasis_events?created_at=gte.${hoursAgoIso(168)}&actor_id=not.is.null` +
      `&select=actor_id&limit=20000`
  );
  const activeUsers = new Set<string>();
  for (const r of activeRows ?? []) if (r.actor_id) activeUsers.add(r.actor_id);

  // Fresh scores — distinct user_id from vitana_index_scores in last 24h.
  const freshRows = await supaFetch<VitanaIndexRow[]>(
    `/rest/v1/vitana_index_scores?created_at=gte.${hoursAgoIso(24)}` +
      `&select=user_id,overall,nutrition,hydration,exercise,sleep,mental,balance_factor,created_at` +
      `&limit=10000&order=created_at.desc`
  );
  const freshUsers = new Set<string>();
  let pillarNullCount = 0;
  const balanceFactors: number[] = [];
  for (const r of freshRows ?? []) {
    if (r.user_id) freshUsers.add(r.user_id);
    if (
      r.nutrition == null ||
      r.hydration == null ||
      r.exercise == null ||
      r.sleep == null ||
      r.mental == null
    ) {
      pillarNullCount++;
    }
    if (r.balance_factor != null) balanceFactors.push(r.balance_factor);
  }
  balanceFactors.sort((a, b) => a - b);
  const balanceP50 = balanceFactors.length
    ? balanceFactors[Math.floor(balanceFactors.length / 2)]
    : null;

  const coverageRate =
    activeUsers.size > 0 ? freshUsers.size / activeUsers.size : null;
  const pillarNullityRate =
    freshRows && freshRows.length > 0 ? pillarNullCount / freshRows.length : 0;

  // Phase E config table presence
  const configCheck = await supaFetch<Array<{ name?: string }>>(
    '/rest/v1/vitana_index_config?select=name&limit=1'
  );
  const phaseEPending = configCheck === null;

  return {
    active_users: activeUsers.size,
    fresh_score_users: freshUsers.size,
    coverage_rate: coverageRate,
    pillar_nullity_rate: pillarNullityRate,
    balance_factor_p50: balanceP50,
    fresh_rows_total: freshRows?.length ?? 0,
    phase_e_pending: phaseEPending,
  };
}

routineAuditsRouter.get(
  '/api/v1/routines/audits/vitana-index',
  requireRoutineToken,
  async (_req: Request, res: Response) => {
    try {
      return res.json({ ok: true, ...(await auditVitanaIndex()) });
    } catch (e: any) {
      console.error(`${LOG_PREFIX} vitana-index error:`, e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// =============================================================================
// VTID-02018 — Tier C-2 audit endpoints
// =============================================================================

// -----------------------------------------------------------------------------
// GET /api/v1/routines/audits/knowledge-docs-staleness
// Used by: knowledge-docs-freshness routine
// -----------------------------------------------------------------------------

export async function auditKnowledgeDocsStaleness(params: { staleAfterDays?: number } = {}) {
  const staleAfterDays = Math.min(params.staleAfterDays || 180, 730);
  const staleCutoff = new Date(Date.now() - staleAfterDays * 24 * 60 * 60 * 1000).toISOString();

  const totalCount = await supaCount('/rest/v1/knowledge_docs');
  // Stale = updated_at older than cutoff (or created_at if updated_at missing)
  const staleCount = await supaCount(
    `/rest/v1/knowledge_docs?updated_at=lt.${staleCutoff}`
  );

  // Sample of the stalest entries for the audit log
  const sample = await supaFetch<Array<{
    id: string;
    title?: string;
    path?: string;
    updated_at?: string;
    created_at?: string;
  }>>(
    `/rest/v1/knowledge_docs?updated_at=lt.${staleCutoff}` +
      `&select=id,title,path,updated_at,created_at` +
      `&order=updated_at.asc&limit=10`
  );

  // If the table doesn't exist totalCount will be null; surface that as `feature_pending`.
  const featurePending = totalCount === null;

  return {
    feature_pending: featurePending,
    total_docs: totalCount ?? 0,
    stale_count: staleCount ?? 0,
    stale_after_days: staleAfterDays,
    sample_stalest: sample ?? [],
  };
}

routineAuditsRouter.get(
  '/api/v1/routines/audits/knowledge-docs-staleness',
  requireRoutineToken,
  async (req: Request, res: Response) => {
    try {
      const body = await auditKnowledgeDocsStaleness({
        staleAfterDays: parseInt(req.query.stale_after_days as string) || 180,
      });
      return res.json({ ok: true, ...body });
    } catch (e: any) {
      console.error(`${LOG_PREFIX} knowledge-docs-staleness error:`, e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// VTID-05098: /routines/audits/push-pipeline and /routines/audits/migration-backlog
// were removed with their routines (push-pipeline-probe, migration-backlog).
// Push dispatch is covered by /api/v1/ops/health/push-dispatch; migration drift
// by MIGRATION-DRIFT-CHECK. See docs/autonomy/LOOP-ENGINEERING.md §5.

// -----------------------------------------------------------------------------
// GET /api/v1/routines/audits/dyk-tour-progress
// Used by: dyk-tour-progress routine
// -----------------------------------------------------------------------------

export async function auditDykTourProgress() {
  // dyk_user_active_days tracks per-user usage day counters.
  // Some installs track tour state in a sibling table; we read what exists.
  const totalTracked = await supaCount('/rest/v1/dyk_user_active_days');
  // Distribution of active_day values (1..30) — pull a sample.
  const sample = await supaFetch<Array<{ user_id?: string; active_day?: number }>>(
    '/rest/v1/dyk_user_active_days?select=user_id,active_day&order=active_day.desc&limit=2000'
  );
  const dayDistribution: Record<number, number> = {};
  let maxDay = 0;
  for (const row of sample ?? []) {
    const d = row.active_day ?? 0;
    dayDistribution[d] = (dayDistribution[d] || 0) + 1;
    if (d > maxDay) maxDay = d;
  }

  const featurePending = totalTracked === null;

  return {
    feature_pending: featurePending,
    total_tracked: totalTracked ?? 0,
    day_distribution: dayDistribution,
    max_day_seen: maxDay,
    sample_size: sample?.length ?? 0,
  };
}

routineAuditsRouter.get(
  '/api/v1/routines/audits/dyk-tour-progress',
  requireRoutineToken,
  async (_req: Request, res: Response) => {
    try {
      return res.json({ ok: true, ...(await auditDykTourProgress()) });
    } catch (e: any) {
      console.error(`${LOG_PREFIX} dyk-tour-progress error:`, e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// -----------------------------------------------------------------------------
// GET /api/v1/routines/audits/spec-memory-quarantine
// Used by: spec-memory-quarantine routine
// -----------------------------------------------------------------------------

export async function auditSpecMemoryQuarantine() {
  // The voice self-healing loop uses a shadow log; quarantined entries
  // have outcome='quarantined' or status='quarantined'.
  const totalShadow = await supaCount('/rest/v1/voice_healing_shadow_log');
  const quarantinedNow = await supaCount(
    '/rest/v1/voice_healing_shadow_log?outcome=eq.quarantined'
  );
  const quarantinedRecent = await supaCount(
    `/rest/v1/voice_healing_shadow_log?outcome=eq.quarantined&created_at=gte.${hoursAgoIso(7 * 24)}`
  );

  // Sample the oldest quarantined entries for the audit log
  const sample = await supaFetch<Array<{
    id?: string;
    endpoint?: string;
    failure_class?: string;
    outcome?: string;
    created_at?: string;
  }>>(
    '/rest/v1/voice_healing_shadow_log?outcome=eq.quarantined' +
      '&select=id,endpoint,failure_class,outcome,created_at' +
      '&order=created_at.asc&limit=10'
  );

  const featurePending = totalShadow === null;

  return {
    feature_pending: featurePending,
    total_shadow_log: totalShadow ?? 0,
    quarantined_now: quarantinedNow ?? 0,
    quarantined_recent_7d: quarantinedRecent ?? 0,
    sample_oldest: sample ?? [],
  };
}

// =============================================================================
// VTID-05141 — voice-lab-triage data (Loop Engineering Phase 3b, loop L7)
//
// Reads voice_session_facts (VTID-04776: one row per ORB voice session, with
// outcome and voice-failure-taxonomy failure_class) over a real time window.
// /api/v1/voice-lab/live/sessions is not used: it ignores time windows and
// hard-codes error_count to 0 (voice-lab.ts list route).
// =============================================================================

/** Outcomes that count as an error session for voice-lab-triage. */
export const VOICE_ERROR_OUTCOMES = ['silent', 'one_way', 'dropped', 'error'];
const VOICE_PAGE = 1000;
const VOICE_MAX_ROWS = 20000;

export async function auditVoiceSessionOutcomes(params: { sinceHours: number; untilHours?: number }) {
  const since = hoursAgoIso(params.sinceHours);
  const until = hoursAgoIso(params.untilHours ?? 0);
  let total = 0;
  let errorSessions = 0;
  const byFailureClass: Record<string, number> = {};
  let truncated = false;
  for (let offset = 0; ; offset += VOICE_PAGE) {
    if (offset >= VOICE_MAX_ROWS) { truncated = true; break; }
    const page = await supaFetch<Array<{ outcome: string | null; failure_class: string | null }>>(
      '/rest/v1/voice_session_facts?select=outcome,failure_class' +
        `&started_at=gte.${since}&started_at=lt.${until}` +
        '&outcome=not.is.null&outcome=neq.active' +
        `&order=started_at.asc&limit=${VOICE_PAGE}&offset=${offset}`
    );
    if (page === null) throw new Error('voice_session_facts read failed');
    for (const r of page) {
      total += 1;
      if (r.outcome && VOICE_ERROR_OUTCOMES.includes(r.outcome)) {
        errorSessions += 1;
        const fc = r.failure_class || 'voice.unknown';
        byFailureClass[fc] = (byFailureClass[fc] || 0) + 1;
      }
    }
    if (page.length < VOICE_PAGE) break;
  }
  return {
    window: { since, until },
    total_sessions: total,
    error_sessions: errorSessions,
    error_rate: total > 0 ? errorSessions / total : null,
    by_failure_class: byFailureClass,
    truncated,
  };
}

routineAuditsRouter.get(
  '/api/v1/routines/audits/spec-memory-quarantine',
  requireRoutineToken,
  async (_req: Request, res: Response) => {
    try {
      return res.json({ ok: true, ...(await auditSpecMemoryQuarantine()) });
    } catch (e: any) {
      console.error(`${LOG_PREFIX} spec-memory-quarantine error:`, e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// =============================================================================
// GET /api/v1/routines/audits/mobile-screen-latency
// Used by: mobile-screen-latency-rollup
//
// Rolls up the `screen.latency.measured` OASIS events (emitted by the
// vitana-v1 RUM beacon, see vitana-v1/src/lib/rum.ts) into a per-screen,
// per-metric p75 over the requested window. The rum-beacon receiver is a
// thin pipe with no aggregation — this is where "dashboards do that
// downstream" actually happens, so the rollup routine can threshold-check
// each mobile surface instead of drowning in the raw beacon firehose.
//
// Each beacon lands in oasis_events as:
//   topic    = 'screen.latency.measured'
//   metadata = { screen, metric, value, rating, session, captured_at, ... }
// =============================================================================

// p75 of a numeric sample (nearest-rank). Mobile perf is judged on the
// tail, not the mean — a fast median hides the users who actually complain.
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

export async function auditMobileScreenLatency(params: { windowHours?: number; platform?: string } = {}) {
  const sinceHours = Math.min(params.windowHours || 24, 24 * 14);
  const since = hoursAgoIso(sinceHours);

  // Optional device filter so the rollup can compare iOS vs Android vs
  // desktop. Absent → all devices (backward compatible with the original
  // single-call rollup).
  const platformRaw = typeof params.platform === 'string' ? params.platform.toLowerCase() : '';
  const platformFilter = (['ios', 'android', 'desktop', 'other'] as const).find((p) => p === platformRaw) ?? null;

  // Pull a bounded sample of recent latency beacons. limit=5000 keeps the
  // response well under PostgREST's hard cap while covering a normal day's
  // volume; if a screen ever exceeds this the p75 is still representative.
  const sample = await supaFetch<Array<{ metadata: Record<string, any> | null }>>(
    `/rest/v1/oasis_events?topic=eq.screen.latency.measured` +
      `&created_at=gte.${since}` +
      `&select=metadata&order=created_at.desc&limit=5000`
  );

  if (sample === null) {
    // Supabase creds absent (e.g. local) — let the routine treat this as
    // a soft "no data" rather than a breach.
    return { window_hours: sinceHours, platform: platformFilter, sample_size: 0, platform_breakdown: {}, screens: [] };
  }

  // Bucket raw values by screen → metric, optionally restricted to one
  // platform. Track an all-up device breakdown alongside so a single call
  // still surfaces where the traffic is coming from.
  type Bucket = Record<string, Record<string, number[]>>;
  const buckets: Bucket = {};
  let worstRatingBy: Record<string, string> = {};
  const platformBreakdown: Record<string, number> = {};
  let matched = 0;
  for (const row of sample) {
    const m = row.metadata || {};
    const platform = typeof m.platform === 'string' ? m.platform : 'unknown';
    platformBreakdown[platform] = (platformBreakdown[platform] ?? 0) + 1;
    if (platformFilter && platform !== platformFilter) continue;
    const screen = typeof m.screen === 'string' ? m.screen : null;
    const metric = typeof m.metric === 'string' ? m.metric : null;
    const value = typeof m.value === 'number' ? m.value : Number(m.value);
    if (!screen || !metric || !Number.isFinite(value)) continue;
    matched += 1;
    (buckets[screen] ??= {})[metric] ??= [];
    buckets[screen][metric].push(value);
    if (m.rating === 'poor') worstRatingBy[`${screen}|${metric}`] = 'poor';
  }

  const screens = Object.entries(buckets).map(([screen, metrics]) => ({
    screen,
    samples: Object.values(metrics).reduce((n, arr) => n + arr.length, 0),
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([metric, values]) => [
        metric,
        {
          p75: percentile(values, 75),
          p95: percentile(values, 95),
          count: values.length,
          worst_rating: worstRatingBy[`${screen}|${metric}`] ?? null,
        },
      ])
    ),
  }));

  return {
    window_hours: sinceHours,
    platform: platformFilter,
    // When a platform filter is applied, sample_size reflects the matched
    // beacons so the rollup's `sample_size === 0` skip works per platform.
    sample_size: platformFilter ? matched : sample.length,
    platform_breakdown: platformBreakdown,
    screens,
  };
}

routineAuditsRouter.get(
  '/api/v1/routines/audits/mobile-screen-latency',
  requireRoutineToken,
  async (req: Request, res: Response) => {
    try {
      const body = await auditMobileScreenLatency({
        windowHours: parseInt(req.query.window_hours as string) || 24,
        platform: typeof req.query.platform === 'string' ? req.query.platform : undefined,
      });
      return res.json({ ok: true, ...body });
    } catch (e: any) {
      console.error(`${LOG_PREFIX} mobile-screen-latency error:`, e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);
