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
  const threshold = Math.max(20, data.total_docs * 0.10);
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
