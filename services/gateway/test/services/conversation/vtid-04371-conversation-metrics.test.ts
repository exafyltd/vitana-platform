/**
 * VTID-04371 (WS-0.7) — read model over conversation_metrics_hourly:
 * window summary, hourly series, learning-job and narrative freshness.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  summarizeConversationMetrics,
  buildMetricSeries,
  summarizeLearningJobs,
  summarizeNarrativeFreshness,
  LEARNING_AUTOMATIONS,
  type MetricRow,
} from '../../../src/services/conversation/conversation-metrics';

const H1 = '2026-09-23T10:00:00.000Z';
const H2 = '2026-09-23T11:00:00.000Z';

function row(hour: string, metric: string, dimension: string, value: number, sample_count = value): MetricRow {
  return { hour_start: hour, metric, dimension, value, sample_count, computed_at: `${hour.slice(0, 13)}:07:00.000Z` };
}

describe('summarizeConversationMetrics', () => {
  const rows: MetricRow[] = [
    row(H1, 'sessions_started', '', 10),
    row(H1, 'sessions_started', 'lang:de', 7),
    row(H1, 'sessions_started', 'lang:en', 3),
    row(H2, 'sessions_started', '', 6),
    row(H2, 'sessions_started', 'lang:de', 6),
    row(H1, 'sessions_stopped', '', 8),
    row(H2, 'sessions_stopped', '', 4),
    row(H1, 'session_stop_duplicates', '', 2, 8),
    row(H1, 'silent_sessions', '', 3, 8),
    row(H2, 'silent_sessions', '', 1, 4),
    row(H1, 'first_audio_ms_p50', '', 2000, 9),
    row(H2, 'first_audio_ms_p50', '', 3000, 1),
    row(H1, 'first_audio_ms_p50', 'transport:sse', 2000, 9),
    row(H1, 'context_wait_timeouts', '', 8, 9),
    row(H1, 'diag_greeting_sent', '', 9),
    row(H1, 'diag_greeting_sent', 'opener:conv_resume', 6),
    row(H1, 'diag_greeting_sent', 'opener:legacy_default', 3),
    row(H1, 'diag_upstream_error', '', 4),
    row(H1, 'diag_upstream_error', 'kind:content_filter', 1),
    row(H1, 'diag_upstream_error', 'kind:idle_timeout', 2),
    row(H1, 'diag_upstream_error', 'code:nova_stream_error', 1),
    row(H1, 'opener_repeat_24h', '', 3, 9),
    row(H1, 'offer_made', '', 10),
    row(H1, 'offer_made', 'source:wake_brief', 10),
    row(H1, 'offer_accepted', '', 4),
    row(H1, 'offer_declined', '', 2),
    row(H1, 'offer_ignored', '', 1),
    row(H1, 'sessions_finalized', '', 8),
    row(H1, 'finalize_summary_written', '', 6, 8),
    row(H1, 'facts_extracted', '', 12, 3),
  ];

  const s = summarizeConversationMetrics(rows, 24);

  it('sums counts across hours and derives stop coverage from starts', () => {
    expect(s.hours_with_data).toBe(2);
    expect(s.sessions.started).toBe(16);
    expect(s.sessions.stopped).toBe(12);
    expect(s.sessions.stop_coverage).toEqual({ numerator: 12, denominator: 16, rate: 0.75 });
    expect(s.sessions.stop_duplicates).toBe(2);
    expect(s.sessions.silent).toEqual({ numerator: 4, denominator: 12, rate: 4 / 12 });
    expect(s.sessions.by_lang.map((b) => [b.key, b.count])).toEqual([['de', 13], ['en', 3]]);
    expect(s.last_computed_at).toBe('2026-09-23T11:07:00.000Z');
  });

  it('window percentiles are sample-weighted and labelled approximate', () => {
    expect(s.speed.first_audio_ms_p50).toEqual({ value: 2100, samples: 10, approx: true });
    expect(s.speed.by_transport).toEqual([{ transport: 'sse', first_audio_ms_p50: { value: 2000, samples: 9, approx: true } }]);
    expect(s.speed.context_wait_timeouts.rate).toBeCloseTo(8 / 9);
  });

  it('errors are split by failure kind, with unclassified codes kept apart', () => {
    expect(s.reliability.upstream_errors).toBe(4);
    expect(s.reliability.upstream_errors_by_kind.map((b) => b.key)).toEqual([
      'idle_timeout', 'content_filter', 'code:nova_stream_error',
    ]);
  });

  it('openers, offers and learning coverage', () => {
    expect(s.openers.distribution[0]).toEqual({ key: 'conv_resume', count: 6, share: 6 / 9 });
    expect(s.openers.repeat_24h).toEqual({ numerator: 3, denominator: 9, rate: 3 / 9 });
    expect(s.offers).toMatchObject({ made: 10, accepted: 4, declined: 2, replaced: 1, unanswered: 3 });
    expect(s.offers.acceptance.rate).toBe(0.4);
    expect(s.learning.summary_coverage).toEqual({ numerator: 6, denominator: 8, rate: 0.75 });
    expect(s.learning.facts_per_finalized_session).toBe(1.5);
  });

  it('an empty window gives nulls, never NaN or a division by zero', () => {
    const e = summarizeConversationMetrics([], 24);
    expect(e.sessions.stop_coverage.rate).toBeNull();
    expect(e.speed.first_audio_ms_p50.value).toBeNull();
    expect(e.offers.acceptance.rate).toBeNull();
    expect(e.learning.facts_per_finalized_session).toBeNull();
    expect(JSON.stringify(e)).not.toMatch(/NaN|Infinity/);
  });
});

describe('buildMetricSeries', () => {
  it('returns every full hour of the window, oldest first, empty hours null', () => {
    const now = Date.parse('2026-09-23T12:30:00.000Z');
    const series = buildMetricSeries([row(H2, 'sessions_started', '', 6)], 'sessions_started', '', 3, now);
    expect(series).toEqual([
      { hour_start: '2026-09-23T09:00:00.000Z', value: null, sample_count: 0 },
      { hour_start: H1, value: null, sample_count: 0 },
      { hour_start: H2, value: 6, sample_count: 6 },
    ]);
  });
});

describe('learning health', () => {
  const now = Date.parse('2026-09-23T12:00:00.000Z');

  it('reports every nightly job, stale when it never ran or ran more than 36 h ago', () => {
    const jobs = summarizeLearningJobs([
      { automation_id: 'AP-0911', status: 'completed', started_at: '2026-09-23T01:00:00.000Z', completed_at: null },
      { automation_id: 'AP-0911', status: 'failed', started_at: '2026-09-20T01:00:00.000Z', completed_at: null, error_message: 'x' },
      { automation_id: 'AP-0906', status: 'completed', started_at: '2026-07-06T09:02:18.991Z', completed_at: null },
    ], now - 7 * 86_400_000, now);
    expect(jobs.map((j) => j.automation_id)).toEqual([...LEARNING_AUTOMATIONS]);
    const a911 = jobs.find((j) => j.automation_id === 'AP-0911')!;
    expect(a911).toMatchObject({ last_status: 'completed', runs_in_window: 2, age_hours: 11, stale: false });
    expect(jobs.find((j) => j.automation_id === 'AP-0906')!.stale).toBe(true);
    expect(jobs.find((j) => j.automation_id === 'AP-0907')).toMatchObject({ last_started_at: null, stale: true });
  });

  it('narrative freshness counts only parseable stamps inside the max age', () => {
    const f = summarizeNarrativeFreshness(
      [{ generated_at: '2026-09-22T00:00:00.000Z' }, { generated_at: '2026-07-06T00:00:00.000Z' }, { generated_at: 'garbage' }, null],
      now,
    );
    expect(f).toEqual({
      users_with_narrative: 4,
      fresh_7d: 1,
      newest_generated_at: '2026-09-22T00:00:00.000Z',
      oldest_generated_at: '2026-07-06T00:00:00.000Z',
    });
  });
});

describe('source contract', () => {
  const root = path.join(__dirname, '../../../src');
  const route = fs.readFileSync(path.join(root, 'routes/conversation-hub.ts'), 'utf8');
  const repoSrc = fs.readFileSync(path.join(root, 'routes/conversation-hub-repository.ts'), 'utf8');

  it('the metrics handlers read only the rollup, never oasis_events', () => {
    const start = route.indexOf('VTID-04371 (WS-0.7) — dashboards');
    expect(start).toBeGreaterThan(0);
    expect(route.slice(start)).not.toMatch(/fetchOasisEventsByStage|oasis_events'/);
  });

  it('the narrative read selects only the timestamp, never the narrative text', () => {
    const fn = repoSrc.slice(repoSrc.indexOf('fetchProfileNarrativeStamps'));
    expect(fn).toMatch(/select\('generated_at:value->>generated_at'\)/);
  });

  it('the local signal name matches the synthesis module', () => {
    const synth = fs.readFileSync(path.join(root, 'services/user-model-synthesis.ts'), 'utf8');
    const a = /SIGNAL_PROFILE_NARRATIVE = '([^']+)'/.exec(synth)![1];
    const b = /PROFILE_NARRATIVE_SIGNAL = '([^']+)'/.exec(route)![1];
    expect(b).toBe(a);
  });
});
