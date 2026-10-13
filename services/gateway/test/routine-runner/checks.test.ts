/**
 * VTID-05103 — routine checks, ported verbatim from routines/<name>.md.
 * Each routine: a healthy case (success, no breach) and every breach rule the
 * spec lists, with the topic + VTID the spec emits.
 */
import {
  checkAgentsHeartbeat,
  checkAutopilotRecQuality,
  checkDykTourProgress,
  checkKnowledgeDocsFreshness,
  checkMobileScreenLatency,
  checkOasisEventAnomaly,
  checkSpecMemoryQuarantine,
  checkSupabaseIoAudit,
  checkVitanaIndexHealth,
  MOBILE_TRACKED_SCREENS,
} from '../../src/services/routine-runner/checks';

describe('agents-heartbeat', () => {
  const counts = { total: 3, by_status: { healthy: 2, down: 1 } };
  it('embedded agents never count as problems', () => {
    const v = checkAgentsHeartbeat({
      counts,
      agents: [
        { agent_id: 'a', tier: 'service', derived_status: 'healthy' },
        { agent_id: 'b', tier: 'embedded', derived_status: 'down' },
      ],
    });
    expect(v.status).toBe('success');
    expect(v.breach).toBeUndefined();
  });
  it('a non-healthy service/scheduled agent is a breach on agents.registry.degraded', () => {
    const v = checkAgentsHeartbeat({
      counts,
      agents: [
        { agent_id: 'a', tier: 'service', derived_status: 'degraded' },
        { agent_id: 'c', tier: 'scheduled', derived_status: 'down' },
      ],
    });
    expect(v.status).toBe('partial');
    expect(v.breach).toMatchObject({ topic: 'agents.registry.degraded', vtid: 'VTID-02004' });
    expect(v.breach!.message).toBe('2 agent(s) not healthy: a, c');
  });
});

describe('supabase-io-audit', () => {
  it('healthy', () => {
    expect(checkSupabaseIoAudit({ retention_drift_count: 10, today_count: 100, baseline_avg_per_day: 100 }).status).toBe('success');
  });
  it.each([
    [{ retention_drift_count: 10001, today_count: 100, baseline_avg_per_day: 100 }, 'retention_drift'],
    [{ retention_drift_count: 0, today_count: 201, baseline_avg_per_day: 100 }, 'volume_spike'],
    [{ retention_drift_count: 0, today_count: 29, baseline_avg_per_day: 100 }, 'volume_collapse'],
  ])('%j → %s', (data, kind) => {
    const v = checkSupabaseIoAudit(data);
    expect(v.status).toBe('partial');
    expect(v.findings.breach_kinds).toEqual([kind]);
    expect(v.breach).toMatchObject({ topic: 'database.io_pressure.daily_audit', vtid: 'VTID-02006' });
  });
  it('missing data is a failure, never green', () => {
    expect(checkSupabaseIoAudit({ retention_drift_count: null, today_count: 1, baseline_avg_per_day: 1 }).status).toBe('failure');
  });
});

describe('autopilot-rec-quality', () => {
  const base = {
    yesterday: { total: 100, null_pillar_rate: 0.05, acceptance_rate: 0.4 },
    baseline_window: { acceptance_rate: 0.4 },
    baseline_avg_per_day: { total: 100 },
  };
  it('healthy', () => expect(checkAutopilotRecQuality(base).status).toBe('success'));
  it('null pillar > 10%', () => {
    const v = checkAutopilotRecQuality({ ...base, yesterday: { ...base.yesterday, null_pillar_rate: 0.11 } });
    expect(v.findings.drift_kinds).toEqual(['null_pillar']);
    expect(v.breach).toMatchObject({ topic: 'autopilot.recommendations.quality_drift', vtid: 'VTID-02006' });
  });
  it('acceptance below half the baseline', () => {
    const v = checkAutopilotRecQuality({ ...base, yesterday: { ...base.yesterday, acceptance_rate: 0.19 } });
    expect(v.findings.drift_kinds).toEqual(['acceptance_collapse']);
  });
  it('volume below 30% of the baseline day', () => {
    const v = checkAutopilotRecQuality({ ...base, yesterday: { ...base.yesterday, total: 29 } });
    expect(v.findings.drift_kinds).toEqual(['volume_collapse']);
  });
});

describe('oasis-event-anomaly', () => {
  it('healthy', () => {
    const v = checkOasisEventAnomaly(
      { total_count: 10, top_topics: [{ topic: 'a', count: 4 }] },
      { total_count: 70, top_topics: [{ topic: 'a', count: 28 }] }
    );
    expect(v.status).toBe('success');
  });
  it('a novel topic seen >= 3 times', () => {
    const v = checkOasisEventAnomaly(
      { total_count: 10, top_topics: [{ topic: 'new', count: 3 }] },
      { total_count: 70, top_topics: [{ topic: 'a', count: 28 }] }
    );
    expect(v.findings.novel_topics).toEqual([{ topic: 'new', count: 3 }]);
    expect(v.breach).toMatchObject({ topic: 'oasis.event_anomaly.daily', vtid: 'VTID-02006' });
  });
  it('a spike >= max(5, 3x baseline/day)', () => {
    const v = checkOasisEventAnomaly(
      { total_count: 10, top_topics: [{ topic: 'a', count: 12 }] },
      { total_count: 70, top_topics: [{ topic: 'a', count: 28 }] }
    );
    expect(v.findings.spike_topics).toEqual([{ topic: 'a', today_count: 12, baseline_avg_per_day: 4 }]);
  });
});

describe('vitana-index-health', () => {
  const ok = { active_users: 10, fresh_score_users: 10, coverage_rate: 1, pillar_nullity_rate: 0, balance_factor_p50: 0.8, phase_e_pending: false };
  it('healthy', () => expect(checkVitanaIndexHealth(ok).status).toBe('success'));
  it('every rule', () => {
    const v = checkVitanaIndexHealth({ ...ok, coverage_rate: 0.89, pillar_nullity_rate: 0.06, phase_e_pending: true });
    expect(v.findings.breach_kinds).toEqual(['coverage_below_90', 'pillar_nullity_high', 'phase_e_pending']);
    expect(v.breach).toMatchObject({ topic: 'vitana_index.computation.degraded', vtid: 'VTID-02006' });
  });
});

describe('knowledge-docs-freshness', () => {
  it('feature pending is green', () => {
    expect(checkKnowledgeDocsFreshness({ feature_pending: true, total_docs: 0, stale_count: 0, sample_stalest: [] }).status).toBe('success');
  });
  it('threshold is max(20, 10% of docs)', () => {
    expect(checkKnowledgeDocsFreshness({ feature_pending: false, total_docs: 100, stale_count: 20, sample_stalest: [] }).status).toBe('success');
    const v = checkKnowledgeDocsFreshness({ feature_pending: false, total_docs: 100, stale_count: 21, sample_stalest: [] });
    expect(v.status).toBe('partial');
    expect(v.breach).toMatchObject({ topic: 'docs.staleness.detected', vtid: 'VTID-02018' });
    expect(checkKnowledgeDocsFreshness({ feature_pending: false, total_docs: 1000, stale_count: 101, sample_stalest: [] }).status).toBe('partial');
  });
});

describe('dyk-tour-progress', () => {
  it('feature pending and no users are green', () => {
    expect(checkDykTourProgress({ feature_pending: true, total_tracked: 0, day_distribution: {}, max_day_seen: 0 }).status).toBe('success');
    expect(checkDykTourProgress({ feature_pending: false, total_tracked: 0, day_distribution: {}, max_day_seen: 0 }).status).toBe('success');
  });
  it('more than 5 users and nobody past day 14 is a breach', () => {
    expect(checkDykTourProgress({ feature_pending: false, total_tracked: 6, day_distribution: {}, max_day_seen: 14 }).status).toBe('success');
    const v = checkDykTourProgress({ feature_pending: false, total_tracked: 6, day_distribution: {}, max_day_seen: 13 });
    expect(v.status).toBe('partial');
    expect(v.breach).toMatchObject({ topic: 'dyk.tour.coverage_drop', vtid: 'VTID-02018' });
  });
});

describe('spec-memory-quarantine', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  it('healthy', () => {
    const v = checkSpecMemoryQuarantine(
      { feature_pending: false, quarantined_now: 2, quarantined_recent_7d: 2, sample_oldest: [{ created_at: '2026-10-05T00:00:00Z' }] },
      now
    );
    expect(v.status).toBe('success');
  });
  it('aged (> 14 days) and growing (> 1.5x the week)', () => {
    const v = checkSpecMemoryQuarantine(
      { feature_pending: false, quarantined_now: 4, quarantined_recent_7d: 2, sample_oldest: [{ created_at: '2026-09-27T00:00:00Z' }] },
      now
    );
    expect(v.findings.breach_kinds).toEqual(['quarantine_aged', 'quarantine_growing']);
    expect(v.breach).toMatchObject({ topic: 'voice_healing.quarantine.degraded', vtid: 'VTID-02018' });
  });
});

describe('mobile-screen-latency-rollup', () => {
  const empty = { sample_size: 0, screens: [] };
  it('no samples is green', () => {
    expect(checkMobileScreenLatency(empty, { ios: empty, android: empty }).status).toBe('success');
  });
  it('a tracked screen at or over a poor cut, per device; desktop never judged', () => {
    const android = {
      sample_size: 5,
      screens: [
        { screen: '/inbox', metrics: { LCP: { p75: 4000, count: 5 }, CLS: { p75: 0.1, count: 5 } } },
        { screen: '/untracked', metrics: { LCP: { p75: 9000, count: 5 } } },
      ],
    };
    const ios = { sample_size: 5, screens: [{ screen: '/settings', metrics: { CLS: { p75: 0.25, count: 5 } } }] };
    const v = checkMobileScreenLatency({ sample_size: 10, screens: [] }, { ios, android });
    expect(v.findings.breached_screens).toEqual([
      { platform: 'ios', screen: '/settings', breaches: [{ metric: 'CLS', p75: 0.25, count: 5 }] },
      { platform: 'android', screen: '/inbox', breaches: [{ metric: 'LCP', p75: 4000, count: 5 }] },
    ]);
    expect(v.breach).toMatchObject({ topic: 'mobile.screen.slow', vtid: 'VTID-03177' });
  });
  it('tracks the 9 screens of the spec', () => expect(MOBILE_TRACKED_SCREENS).toHaveLength(9));
});
