/**
 * VTID-05103 — Routine checks (Loop Engineering Phase 3a).
 *
 * One pure function per routine: audit data in, verdict out. The thresholds
 * are ported verbatim from each routine's own spec in `routines/<name>.md`
 * (the "Threshold" / "Drift check" step); the spec stays the source of truth
 * and these functions are its executable form. No I/O here — the runner
 * (runner.ts) loads the data (sources.ts), records the run and routes breaches.
 */

export type RoutineStatus = 'success' | 'partial' | 'failure';

export interface RoutineBreach {
  /** OASIS topic the spec emits on a breach. */
  topic: string;
  /** VTID the spec stamps on that event. */
  vtid: string;
  message: string;
  payload: Record<string, unknown>;
  /** OASIS status of the breach event; 'warning' unless the spec calls it an incident. */
  status?: 'warning' | 'error';
}

export interface RoutineVerdict {
  status: RoutineStatus;
  summary: string;
  findings: Record<string, unknown>;
  breach?: RoutineBreach;
}

const pct = (n: number | null | undefined): string =>
  n == null ? 'n/a' : `${Math.round(n * 1000) / 10}%`;

function unavailable(what: string, findings: Record<string, unknown> = {}): RoutineVerdict {
  return { status: 'failure', summary: `❌ ${what} unavailable — see findings`, findings };
}

// routines/agents-heartbeat.md — steps 3–5
export function checkAgentsHeartbeat(data: {
  counts: { total: number; by_status: Record<string, number> };
  agents: Array<{
    agent_id: string;
    tier: string;
    derived_status: string;
    last_heartbeat_at?: string | null;
    heartbeat_age_ms?: number | null;
    last_error?: string | null;
  }>;
}): RoutineVerdict {
  const problems = data.agents
    .filter((a) => a.tier !== 'embedded' && a.derived_status !== 'healthy')
    .map((a) => ({
      agent_id: a.agent_id,
      tier: a.tier,
      derived_status: a.derived_status,
      last_heartbeat_at: a.last_heartbeat_at ?? null,
      heartbeat_age_ms: a.heartbeat_age_ms ?? null,
      last_error: a.last_error ?? null,
    }));
  const findings = {
    agents_total: data.counts.total,
    agents_problem: problems.length,
    by_status: data.counts.by_status,
    problems,
  };
  if (problems.length === 0) {
    return { status: 'success', summary: `✅ All ${data.counts.total} agents healthy across service / embedded / scheduled tiers`, findings };
  }
  const ids = problems.map((p) => p.agent_id).join(', ');
  return {
    status: 'partial',
    summary: `⚠️ ${problems.length} agents not healthy: ${ids}. OASIS event emitted, self-healing notified.`,
    findings,
    breach: {
      topic: 'agents.registry.degraded',
      vtid: 'VTID-02004',
      message: `${problems.length} agent(s) not healthy: ${ids}`,
      payload: { problems, totals: { total: data.counts.total, by_status: data.counts.by_status } },
    },
  };
}

// routines/supabase-io-audit.md — steps 3–5
export function checkSupabaseIoAudit(data: {
  retention_drift_count: number | null;
  today_count: number | null;
  baseline_avg_per_day: number | null;
}): RoutineVerdict {
  const { retention_drift_count, today_count, baseline_avg_per_day } = data;
  if (retention_drift_count == null || today_count == null || baseline_avg_per_day == null) {
    return unavailable('io-pressure audit data', { ...data });
  }
  const breach_kinds: string[] = [];
  if (retention_drift_count > 10000) breach_kinds.push('retention_drift');
  if (today_count > baseline_avg_per_day * 2) breach_kinds.push('volume_spike');
  if (today_count < baseline_avg_per_day * 0.3) breach_kinds.push('volume_collapse');
  const findings = { retention_drift_count, today_count, baseline_avg_per_day, breach_kinds };
  if (breach_kinds.length === 0) {
    return { status: 'success', summary: `✅ Supabase IO healthy: retention OK, volume ${today_count}/${baseline_avg_per_day}/day`, findings };
  }
  return {
    status: 'partial',
    summary: `⚠️ Supabase IO pressure: ${breach_kinds.join(', ')}. OASIS event emitted, self-healing notified.`,
    findings,
    breach: {
      topic: 'database.io_pressure.daily_audit',
      vtid: 'VTID-02006',
      message: breach_kinds.join(', '),
      payload: findings,
    },
  };
}

// routines/autopilot-rec-quality.md — steps 3–5
export function checkAutopilotRecQuality(data: {
  yesterday: { total: number; null_pillar_rate: number; acceptance_rate: number | null };
  baseline_window: { acceptance_rate: number | null };
  baseline_avg_per_day: { total: number };
}): RoutineVerdict {
  const { yesterday, baseline_window: baseline, baseline_avg_per_day } = data;
  const drift_kinds: string[] = [];
  if (yesterday.null_pillar_rate > 0.10) drift_kinds.push('null_pillar');
  if (
    baseline.acceptance_rate &&
    yesterday.acceptance_rate &&
    yesterday.acceptance_rate < baseline.acceptance_rate * 0.5
  ) {
    drift_kinds.push('acceptance_collapse');
  }
  if (baseline_avg_per_day.total > 0 && yesterday.total < baseline_avg_per_day.total * 0.3) {
    drift_kinds.push('volume_collapse');
  }
  const findings = { yesterday, baseline_avg_per_day, drift_kinds };
  if (drift_kinds.length === 0) {
    return {
      status: 'success',
      summary: `✅ Autopilot recs healthy: ${yesterday.total} recs, ${pct(yesterday.acceptance_rate)} accepted, ${pct(yesterday.null_pillar_rate)} missing pillar`,
      findings,
    };
  }
  return {
    status: 'partial',
    summary: `⚠️ Autopilot drift: ${drift_kinds.join(', ')}. OASIS event emitted, self-healing notified.`,
    findings,
    breach: {
      topic: 'autopilot.recommendations.quality_drift',
      vtid: 'VTID-02006',
      message: drift_kinds.join(', '),
      payload: findings,
    },
  };
}

// routines/oasis-event-anomaly.md — steps 3–5
export function checkOasisEventAnomaly(
  today: { total_count: number | null; top_topics: Array<{ topic: string; count: number }> },
  baseline: { total_count: number | null; top_topics: Array<{ topic: string; count: number }> }
): RoutineVerdict {
  if (today.total_count == null || baseline.total_count == null) {
    return unavailable('oasis-summary audit data', { today_total: today.total_count, baseline_total: baseline.total_count });
  }
  const todayBy = new Map(today.top_topics.map((t) => [t.topic, t.count]));
  const baseBy = new Map(baseline.top_topics.map((t) => [t.topic, t.count]));
  const novel_topics = [...todayBy.entries()]
    .filter(([topic, count]) => count >= 3 && !baseBy.has(topic))
    .map(([topic, count]) => ({ topic, count }));
  const spike_topics: Array<{ topic: string; today_count: number; baseline_avg_per_day: number }> = [];
  for (const [topic, today_count] of todayBy) {
    const base = baseBy.get(topic);
    if (base == null) continue;
    const baseline_avg_per_day = base / 7;
    if (today_count >= Math.max(5, baseline_avg_per_day * 3)) {
      spike_topics.push({ topic, today_count, baseline_avg_per_day });
    }
  }
  const findings = { today_total: today.total_count, baseline_total: baseline.total_count, novel_topics, spike_topics };
  if (novel_topics.length === 0 && spike_topics.length === 0) {
    return { status: 'success', summary: `✅ OASIS distribution healthy: ${today.total_count} events, no novel topics, no spikes`, findings };
  }
  return {
    status: 'partial',
    summary: `⚠️ OASIS anomaly: ${novel_topics.length} novel + ${spike_topics.length} spikes. OASIS event emitted, self-healing notified.`,
    findings,
    breach: {
      topic: 'oasis.event_anomaly.daily',
      vtid: 'VTID-02006',
      message: `Novel: ${novel_topics.length}, spikes: ${spike_topics.length}`,
      payload: findings,
    },
  };
}

// routines/vitana-index-health.md — steps 3–5
export function checkVitanaIndexHealth(data: {
  active_users: number;
  fresh_score_users: number;
  coverage_rate: number | null;
  pillar_nullity_rate: number;
  balance_factor_p50: number | null;
  phase_e_pending: boolean;
}): RoutineVerdict {
  const breach_kinds: string[] = [];
  if (data.coverage_rate != null && data.coverage_rate < 0.90) breach_kinds.push('coverage_below_90');
  if (data.pillar_nullity_rate > 0.05) breach_kinds.push('pillar_nullity_high');
  if (data.phase_e_pending === true) breach_kinds.push('phase_e_pending');
  const findings = { ...data, breach_kinds };
  if (breach_kinds.length === 0) {
    return {
      status: 'success',
      summary: `✅ Vitana Index healthy: ${pct(data.coverage_rate)} coverage, ${pct(data.pillar_nullity_rate)} null pillars, balance p50 ${data.balance_factor_p50 ?? 'n/a'}`,
      findings,
    };
  }
  return {
    status: 'partial',
    summary: `⚠️ Vitana Index degraded: ${breach_kinds.join(', ')}. OASIS event emitted, self-healing notified.`,
    findings,
    breach: {
      topic: 'vitana_index.computation.degraded',
      vtid: 'VTID-02006',
      message: breach_kinds.join(', '),
      payload: {
        active_users: data.active_users,
        coverage_rate: data.coverage_rate,
        pillar_nullity_rate: data.pillar_nullity_rate,
        phase_e_pending: data.phase_e_pending,
        breach_kinds,
      },
    },
  };
}

// routines/knowledge-docs-freshness.md — steps 3–6
export function checkKnowledgeDocsFreshness(data: {
  feature_pending: boolean;
  total_docs: number;
  stale_count: number;
  sample_stalest: unknown[];
}): RoutineVerdict {
  if (data.feature_pending) {
    return { status: 'success', summary: '✅ knowledge_docs table not yet present — feature pending', findings: { feature_pending: true } };
  }
  const threshold = Math.max(20, Math.round(data.total_docs * 0.1 * 10) / 10);
  const findings = { total_docs: data.total_docs, stale_count: data.stale_count, threshold, sample_stalest: data.sample_stalest };
  if (!(data.stale_count > threshold)) {
    return { status: 'success', summary: `✅ Knowledge docs healthy: ${data.stale_count}/${data.total_docs} stale`, findings };
  }
  return {
    status: 'partial',
    summary: `⚠️ ${data.stale_count} stale knowledge docs (>${threshold}). OASIS event emitted, self-healing notified.`,
    findings,
    breach: {
      topic: 'docs.staleness.detected',
      vtid: 'VTID-02018',
      message: `${data.stale_count} of ${data.total_docs} knowledge docs stale (>${threshold})`,
      payload: { total_docs: data.total_docs, stale_count: data.stale_count, sample_stalest: data.sample_stalest },
    },
  };
}

// routines/dyk-tour-progress.md — steps 3–7
export function checkDykTourProgress(data: {
  feature_pending: boolean;
  total_tracked: number;
  day_distribution: Record<string, number>;
  max_day_seen: number;
}): RoutineVerdict {
  if (data.feature_pending) {
    return { status: 'success', summary: '✅ dyk_user_active_days not yet present — feature pending', findings: { feature_pending: true } };
  }
  if (data.total_tracked === 0) {
    return { status: 'success', summary: '✅ No DYK tour users yet — nothing to triage', findings: { total_tracked: 0 } };
  }
  const findings = { total_tracked: data.total_tracked, max_day_seen: data.max_day_seen, day_distribution: data.day_distribution };
  const breach = data.max_day_seen < 14 && data.total_tracked > 5;
  if (!breach) {
    return { status: 'success', summary: `✅ DYK tour healthy: ${data.total_tracked} users tracked, max day ${data.max_day_seen}`, findings };
  }
  return {
    status: 'partial',
    summary: `⚠️ DYK tour stuck: ${data.total_tracked} users, max day ${data.max_day_seen}. OASIS event emitted, self-healing notified.`,
    findings,
    breach: {
      topic: 'dyk.tour.coverage_drop',
      vtid: 'VTID-02018',
      message: `DYK tour stuck: ${data.total_tracked} users tracked, nobody past day ${data.max_day_seen}`,
      payload: findings,
    },
  };
}

// routines/spec-memory-quarantine.md — steps 3–6
export function checkSpecMemoryQuarantine(
  data: {
    feature_pending: boolean;
    quarantined_now: number;
    quarantined_recent_7d: number;
    sample_oldest: Array<{ created_at?: string }>;
  },
  now: Date = new Date()
): RoutineVerdict {
  if (data.feature_pending) {
    return { status: 'success', summary: '✅ voice_healing_shadow_log not yet present — feature pending', findings: { feature_pending: true } };
  }
  const breach_kinds: string[] = [];
  const oldest = data.sample_oldest[0]?.created_at ?? null;
  if (oldest && now.getTime() - new Date(oldest).getTime() > 14 * 24 * 60 * 60 * 1000) {
    breach_kinds.push('quarantine_aged');
  }
  if (data.quarantined_recent_7d > 0 && data.quarantined_now > data.quarantined_recent_7d * 1.5) {
    breach_kinds.push('quarantine_growing');
  }
  const findings = {
    quarantined_now: data.quarantined_now,
    quarantined_recent_7d: data.quarantined_recent_7d,
    oldest,
    sample_oldest: data.sample_oldest,
    breach_kinds,
  };
  if (breach_kinds.length === 0) {
    return { status: 'success', summary: `✅ Spec memory gate healthy: ${data.quarantined_now} quarantined, oldest within 14d`, findings };
  }
  return {
    status: 'partial',
    summary: `⚠️ Spec memory gate: ${breach_kinds.join(', ')}. OASIS event emitted, self-healing notified.`,
    findings,
    breach: {
      topic: 'voice_healing.quarantine.degraded',
      vtid: 'VTID-02018',
      message: breach_kinds.join(', '),
      payload: findings,
    },
  };
}

// routines/mobile-screen-latency-rollup.md — "Tracked screens & budgets" + steps 3–5
export const MOBILE_TRACKED_SCREENS = [
  '/comm/events-meetups',
  '/comm/find-partner',
  '/inbox',
  '/autopilot',
  '/settings',
  '/memory',
  '/comm/media-hub',
  '/comm/live-rooms',
  '/me/profile',
] as const;

export const MOBILE_POOR: Record<string, number> = { LCP: 4000, TTFB: 1800, FCP: 3000, INP: 500, CLS: 0.25 };

interface LatencyRollup {
  sample_size: number;
  platform_breakdown?: Record<string, number>;
  screens: Array<{ screen: string; metrics: Record<string, { p75: number | null; count?: number }> }>;
}

export function checkMobileScreenLatency(
  allUp: LatencyRollup,
  byPlatform: { ios: LatencyRollup; android: LatencyRollup }
): RoutineVerdict {
  if (allUp.sample_size === 0) {
    return { status: 'success', summary: '✅ No mobile latency samples in window — telemetry dark or quiet', findings: { sample_size: 0 } };
  }
  const breached_screens: Array<{ platform: string; screen: string; breaches: Array<{ metric: string; p75: number; count?: number }> }> = [];
  for (const platform of ['ios', 'android'] as const) {
    const rollup = byPlatform[platform];
    if (!rollup || rollup.sample_size === 0) continue;
    for (const route of MOBILE_TRACKED_SCREENS) {
      const row = rollup.screens.find((s) => s.screen === route);
      if (!row) continue;
      const breaches: Array<{ metric: string; p75: number; count?: number }> = [];
      for (const [metric, m] of Object.entries(row.metrics)) {
        const poor = MOBILE_POOR[metric];
        if (poor != null && m.p75 != null && m.p75 >= poor) breaches.push({ metric, p75: m.p75, count: m.count });
      }
      if (breaches.length) breached_screens.push({ platform, screen: route, breaches });
    }
  }
  const findings = { sample_size: allUp.sample_size, breached_screens };
  if (breached_screens.length === 0) {
    return { status: 'success', summary: `✅ All ${MOBILE_TRACKED_SCREENS.length} mobile screens within p75 budget (${allUp.sample_size} samples)`, findings };
  }
  const list = breached_screens.map((b) => `${b.platform}:${b.screen}`).join(', ');
  return {
    status: 'partial',
    summary: `⚠️ ${breached_screens.length} mobile screens slow: ${list}. OASIS event emitted, self-healing notified.`,
    findings,
    breach: {
      topic: 'mobile.screen.slow',
      vtid: 'VTID-03177',
      message: `${breached_screens.length} mobile screens over budget: ${list}`,
      payload: { window_hours: 24, breached_screens, sample_size: allUp.sample_size, platform_breakdown: allUp.platform_breakdown ?? {} },
    },
  };
}

// =============================================================================
// VTID-05141 (Loop Engineering Phase 3b)
// =============================================================================

export interface VoiceWindow {
  total_sessions: number;
  error_sessions: number;
  error_rate: number | null;
  by_failure_class: Record<string, number>;
  truncated?: boolean;
}

// routines/voice-lab-triage.md — step 3 (thresholds), step 4 (event)
export function checkVoiceLabTriage(yesterday: VoiceWindow, baseline: VoiceWindow): RoutineVerdict {
  const baselineAvgPerDay = baseline.total_sessions / 7;
  const novel = Object.entries(yesterday.by_failure_class)
    .filter(([fc, n]) => n >= 3 && !(fc in baseline.by_failure_class))
    .map(([fc, n]) => ({ failure_class: fc, sessions: n }));
  const kinds: string[] = [];
  if (
    yesterday.error_rate != null &&
    baseline.error_rate != null &&
    yesterday.error_rate > baseline.error_rate * 1.5 &&
    yesterday.error_sessions >= 3
  ) kinds.push('error_rate_spike');
  if (novel.length > 0) kinds.push('novel_failure_class');
  if (baselineAvgPerDay > 0 && yesterday.total_sessions < baselineAvgPerDay * 0.3) kinds.push('session_collapse');

  const top = (m: Record<string, number>) =>
    Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([failure_class, sessions]) => ({ failure_class, sessions }));
  const findings = {
    yesterday: { ...yesterday, top_failure_classes: top(yesterday.by_failure_class), novel_failure_classes: novel },
    baseline: { ...baseline, avg_sessions_per_day: Math.round(baselineAvgPerDay * 10) / 10, top_failure_classes: top(baseline.by_failure_class) },
    regression_kinds: kinds,
  };
  if (!kinds.length) {
    return {
      status: 'success',
      summary: `✅ Voice healthy: ${yesterday.total_sessions} sessions, ${yesterday.error_sessions} errors, error rate ${pct(yesterday.error_rate)} (within baseline)`,
      findings,
    };
  }
  return {
    status: 'partial',
    summary: `⚠️ Voice regression: ${kinds.join(', ')}. OASIS event emitted, self-healing notified.`,
    findings,
    breach: {
      topic: 'voice.live.regression.daily_triage',
      vtid: 'VTID-01155',
      message: `Voice regression detected: ${kinds.join(', ')}`,
      payload: { yesterday: findings.yesterday, baseline: findings.baseline, regression_kind: kinds[0], regression_kinds: kinds },
    },
  };
}

export interface BudgetLineInput {
  scope: 'platform' | 'agent' | 'run';
  key: string;
  spent_usd: number;
  limit_usd: number;
  used_pct: number;
  over: boolean;
}

// routines/llm-spend-budget.md
export function checkLlmSpendBudget(data: { rows: number; since: string; truncated: boolean; lines: BudgetLineInput[] }): RoutineVerdict {
  const platform = data.lines.find((l) => l.scope === 'platform');
  const over = data.lines.filter((l) => l.over);
  const findings = {
    since: data.since,
    calls: data.rows,
    truncated: data.truncated,
    platform: platform ?? null,
    over_budget: over,
    top_lines: data.lines.slice(0, 10),
  };
  if (data.rows === 0) {
    return { status: 'failure', summary: '❌ No llm.call.completed events today — no spend data', findings };
  }
  if (!over.length) {
    return {
      status: 'success',
      summary: `✅ LLM spend within budget: $${platform?.spent_usd ?? 0} of $${platform?.limit_usd ?? 0} today (${data.rows} calls)`,
      findings,
    };
  }
  return {
    status: 'partial',
    summary: `⚠️ LLM spend over budget: ${over.map((l) => `${l.scope}:${l.key} $${l.spent_usd}/$${l.limit_usd}`).join(', ')}. OASIS event emitted.`,
    findings,
    breach: {
      topic: 'llm.spend.budget_exceeded',
      vtid: 'VTID-05141',
      message: `${over.length} LLM budget line(s) over limit today`,
      payload: { since: data.since, over_budget: over, platform: platform ?? null },
    },
  };
}

export interface GoogleCallInput {
  created_at: string;
  provider: string | null;
  model: string | null;
  stage: string | null;
  service: string | null;
  fallback_used: boolean;
}

// routines/llm-fallback-watch.md — rows are already filtered by isGoogleLlmCall
export function checkLlmFallbackWatch(googleCalls: GoogleCallInput[]): RoutineVerdict {
  const fallback = googleCalls.filter((r) => r.fallback_used);
  const routed = googleCalls.filter((r) => !r.fallback_used);
  const stages = (rows: GoogleCallInput[]) => [...new Set(rows.map((r) => r.stage || r.service || 'unknown'))];
  const findings = {
    google_calls_24h: googleCalls.length,
    fallback_to_google: fallback.length,
    routed_at_google: routed.length,
    fallback_stages: stages(fallback),
    routed_stages: stages(routed),
    models: [...new Set(googleCalls.map((r) => r.model))].slice(0, 5),
  };
  if (!googleCalls.length) {
    return { status: 'success', summary: '✅ No LLM call landed on Google in 24 h', findings };
  }
  return {
    status: 'partial',
    summary: `⚠️ ${googleCalls.length} LLM call(s) landed on Google in 24 h (${fallback.length} fallback, ${routed.length} routed). Incident emitted, self-healing notified.`,
    findings,
    breach: {
      topic: 'llm.fallback.google_incident',
      vtid: 'VTID-05141',
      status: 'error',
      message: `${googleCalls.length} LLM call(s) landed on Google in 24 h — an incident (CLAUDE.md 10c)`,
      payload: findings,
    },
  };
}

// =============================================================================
// VTID-05148 (Loop Engineering Phase 4 — L3 Learn)
// =============================================================================

export interface RepeatFailureClass {
  failure_class: string;
  fixes: number;
  repeated: number;
  rate: number | null;
}

export interface LearnMetrics {
  window_days: number;
  repeat_failure: {
    fixes: number;
    repeated: number;
    rate: number | null;
    follow_up_days: number;
    by_class: RepeatFailureClass[];
    truncated: boolean;
  };
  pattern_reuse:
    | { state: 'measured'; fixes: number; reused: number; share: number | null }
    | { state: 'not_measured'; reason: string };
  escaped_bugs_to_tests: { with_tests: number; without_tests: number; unknown: number; share: number | null };
}

/** A class breaches when more than this share of its fixes failed again within the follow-up window… */
export const REPEAT_FAILURE_RATE_MAX = 0.3;
/** …and it has at least this many fixes. */
export const REPEAT_FAILURE_MIN_FIXES = 5;

// routines/learn-outcomes.md — "Breach"
export function checkLearnOutcomes(
  metrics: LearnMetrics,
  steps: { tests_added: Record<string, unknown>; graduation: Record<string, unknown> }
): RoutineVerdict {
  const high = metrics.repeat_failure.by_class.filter(
    (c) => c.fixes >= REPEAT_FAILURE_MIN_FIXES && c.rate != null && c.rate > REPEAT_FAILURE_RATE_MAX
  );
  const tests = metrics.escaped_bugs_to_tests;
  const reuse = metrics.pattern_reuse.state === 'measured' ? pct(metrics.pattern_reuse.share) : 'not measured';
  const line =
    `repeat-failure ${pct(metrics.repeat_failure.rate)} of ${metrics.repeat_failure.fixes} fixes, ` +
    `pattern reuse ${reuse}, escaped bugs → tests ${pct(tests.share)} (${tests.unknown} unknown)`;
  const findings = { metrics, tests_added_step: steps.tests_added, graduation_step: steps.graduation, high_repeat_classes: high };
  if (!high.length) {
    return { status: 'success', summary: `✅ L3 Learn: ${line}`, findings };
  }
  const list = high.map((c) => `${c.failure_class} ${pct(c.rate)} (${c.repeated}/${c.fixes})`).join(', ');
  return {
    status: 'partial',
    summary: `⚠️ Repeat-failure rate high: ${list}. OASIS event emitted, self-healing notified.`,
    findings,
    breach: {
      topic: 'learn.repeat_failure.high',
      vtid: 'VTID-05148',
      message: `${high.length} failure class(es) failed again after a fix in more than ${REPEAT_FAILURE_RATE_MAX * 100}% of cases: ${list}`,
      payload: {
        window_days: metrics.window_days,
        follow_up_days: metrics.repeat_failure.follow_up_days,
        classes: high,
      },
    },
  };
}

// =============================================================================
// VTID-05153 (Loop Engineering Phase 5 — L9 Supplier catalog, wave 1)
// =============================================================================

export type NotMeasured = { state: 'not_measured'; reason: string };

export interface SupplierCatalogMetrics {
  category: string;
  /** Rows this run checked (at most 20) and wrote a result for. */
  rows_checked: number;
  /** Rows that became ready_for_review with no supplier edit since their previous check. */
  rows_auto_normalized: number;
  /** needs_fix + returned_to_supplier among this run's checked rows / rows checked; null with none checked. */
  validation_failure_rate: number | null;
  /** ready_for_review (images checked) / every category row that has a result; null with none. */
  ready_for_approval_share: number | null;
  ready_for_approval_target: number;
  /** Category rows with a result, per state (the whole category, after this run). */
  by_state: Record<string, number>;
  /** Error codes on this run's checked rows. */
  by_error_code: Record<string, number>;
  time_to_listing: NotMeasured;
  human_edits_per_listing: NotMeasured;
}

export interface SupplierCatalogRun {
  pool_rows: number;
  pool_truncated: boolean;
  excluded_rows: number;
  candidates: number;
  probes: { total: number; network_errors: number; outage: boolean };
  write_conflicts: number;
  write_errors: number;
}

/** L9's wave-1 target: 80% of rows ready for approval without manual entry. */
export const READY_FOR_APPROVAL_TARGET = 0.8;

// routines/supplier-catalog-check.md — "Breach": none in wave 1. Poor supplier
// data is not a code failure and is never routed to self-healing; a crashed
// run is a failure (the runner's stagnation stop applies).
export function checkSupplierCatalog(metrics: SupplierCatalogMetrics, run: SupplierCatalogRun): RoutineVerdict {
  const line =
    `${metrics.rows_checked} ${metrics.category} rows checked, ready for approval ${pct(metrics.ready_for_approval_share)} ` +
    `(target ${pct(metrics.ready_for_approval_target)}), failure rate ${pct(metrics.validation_failure_rate)}` +
    (run.probes.outage ? ', images unchecked (probe outage)' : '');
  const findings = { metrics, run };
  if (run.write_errors > 0) {
    return { status: 'partial', summary: `⚠️ L9 Supplier catalog: ${line}; ${run.write_errors} result write(s) failed`, findings };
  }
  return { status: 'success', summary: `✅ L9 Supplier catalog: ${line}`, findings };
}
