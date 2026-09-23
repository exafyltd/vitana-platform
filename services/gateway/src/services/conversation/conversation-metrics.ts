/**
 * VTID-04371 (WS-0.7) — read model over `conversation_metrics_hourly`.
 *
 * The table is filled hourly by the SQL function
 * `conversation_metrics_rollup_hour()` (pg_cron, migration
 * 20260923140000). Nothing here reads oasis_events: the Command Hub
 * dashboards only ever see the rollup, so a page load costs one indexed range
 * read however much traffic the window held.
 *
 * Pure functions only — the route passes in the rows it read.
 *
 * Window percentiles: the rollup stores one p50/p90 per hour. Exact window
 * percentiles are not recoverable from those, so a window value is the
 * sample-weighted mean of the hourly values and is labelled `approx: true`.
 */

export interface MetricRow {
  hour_start: string;
  metric: string;
  dimension: string;
  value: number;
  sample_count: number;
  computed_at?: string;
}

export interface Rate {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface WeightedValue {
  value: number | null;
  samples: number;
  approx: true;
}

export interface Breakdown {
  key: string;
  count: number;
  share: number | null;
}

export interface MetricsSummary {
  window_hours: number;
  hours_with_data: number;
  last_computed_at: string | null;
  sessions: {
    started: number;
    stopped: number;
    stop_coverage: Rate;
    stop_duplicates: number;
    silent: Rate;
    user_turns_avg: WeightedValue;
    duration_ms_p50: WeightedValue;
    duration_ms_p90: WeightedValue;
    by_lang: Breakdown[];
  };
  speed: {
    first_audio_ms_p50: WeightedValue;
    first_audio_ms_p90: WeightedValue;
    context_wait_timeouts: Rate;
    by_transport: Array<{ transport: string; first_audio_ms_p50: WeightedValue }>;
  };
  reliability: {
    greetings_sent: number;
    model_started_speaking: number;
    upstream_errors: number;
    upstream_errors_by_kind: Breakdown[];
    premature_close_retries: number;
    reconnects: number;
    greeting_recoveries: number;
    watchdog_fired: number;
    stalls_by_reason: Breakdown[];
    tool_failures: number;
    tool_failures_by_tool: Breakdown[];
  };
  openers: {
    distribution: Breakdown[];
    repeat_24h: Rate;
  };
  offers: {
    made: number;
    accepted: number;
    declined: number;
    replaced: number;
    /** made − accepted − declined − replaced: offers that ran out unanswered. */
    unanswered: number;
    acceptance: Rate;
    by_source: Breakdown[];
  };
  learning: {
    sessions_finalized: number;
    summary_coverage: Rate;
    memory_committed: Rate;
    threads_written: number;
    threads_touched: number;
    promises_written: number;
    facts_extracted: number;
    facts_per_finalized_session: number | null;
  };
}

function rate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, rate: denominator > 0 ? numerator / denominator : null };
}

function totalOf(rows: MetricRow[], metric: string, dimension = ''): number {
  let s = 0;
  for (const r of rows) if (r.metric === metric && r.dimension === dimension) s += Number(r.value) || 0;
  return s;
}

function samplesOf(rows: MetricRow[], metric: string, dimension = ''): number {
  let s = 0;
  for (const r of rows) if (r.metric === metric && r.dimension === dimension) s += Number(r.sample_count) || 0;
  return s;
}

function weighted(rows: MetricRow[], metric: string, dimension = ''): WeightedValue {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    if (r.metric !== metric || r.dimension !== dimension) continue;
    const w = Number(r.sample_count) || 0;
    if (w <= 0 || !Number.isFinite(Number(r.value))) continue;
    num += Number(r.value) * w;
    den += w;
  }
  return { value: den > 0 ? Math.round((num / den) * 10) / 10 : null, samples: den, approx: true };
}

function breakdown(rows: MetricRow[], metric: string, prefix: string): Breakdown[] {
  const byKey = new Map<string, number>();
  for (const r of rows) {
    if (r.metric !== metric || !r.dimension.startsWith(prefix)) continue;
    const key = r.dimension.slice(prefix.length);
    byKey.set(key, (byKey.get(key) || 0) + (Number(r.value) || 0));
  }
  const total = Array.from(byKey.values()).reduce((a, b) => a + b, 0);
  return Array.from(byKey.entries())
    .map(([key, count]) => ({ key, count, share: total > 0 ? count / total : null }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function summarizeConversationMetrics(rows: MetricRow[], windowHours: number): MetricsSummary {
  const hours = new Set(rows.map((r) => r.hour_start));
  let lastComputed: string | null = null;
  for (const r of rows) {
    if (r.computed_at && (!lastComputed || r.computed_at > lastComputed)) lastComputed = r.computed_at;
  }

  const started = totalOf(rows, 'sessions_started');
  const stopped = totalOf(rows, 'sessions_stopped');
  const transports = new Set(
    rows.filter((r) => r.metric === 'first_audio_ms_p50' && r.dimension.startsWith('transport:'))
      .map((r) => r.dimension.slice('transport:'.length)),
  );

  const made = totalOf(rows, 'offer_made');
  const accepted = totalOf(rows, 'offer_accepted');
  const declined = totalOf(rows, 'offer_declined');
  const replaced = totalOf(rows, 'offer_ignored');

  const finalized = totalOf(rows, 'sessions_finalized');
  const facts = totalOf(rows, 'facts_extracted');

  return {
    window_hours: windowHours,
    hours_with_data: hours.size,
    last_computed_at: lastComputed,
    sessions: {
      started,
      stopped,
      stop_coverage: rate(stopped, started),
      stop_duplicates: totalOf(rows, 'session_stop_duplicates'),
      silent: rate(totalOf(rows, 'silent_sessions'), samplesOf(rows, 'silent_sessions')),
      user_turns_avg: weighted(rows, 'user_turns_avg'),
      duration_ms_p50: weighted(rows, 'session_duration_ms_p50'),
      duration_ms_p90: weighted(rows, 'session_duration_ms_p90'),
      by_lang: breakdown(rows, 'sessions_started', 'lang:'),
    },
    speed: {
      first_audio_ms_p50: weighted(rows, 'first_audio_ms_p50'),
      first_audio_ms_p90: weighted(rows, 'first_audio_ms_p90'),
      context_wait_timeouts: rate(totalOf(rows, 'context_wait_timeouts'), samplesOf(rows, 'context_wait_timeouts')),
      by_transport: Array.from(transports).sort().map((t) => ({
        transport: t,
        first_audio_ms_p50: weighted(rows, 'first_audio_ms_p50', `transport:${t}`),
      })),
    },
    reliability: {
      greetings_sent: totalOf(rows, 'diag_greeting_sent'),
      model_started_speaking: totalOf(rows, 'diag_model_start_speaking'),
      upstream_errors: totalOf(rows, 'diag_upstream_error'),
      upstream_errors_by_kind: [
        ...breakdown(rows, 'diag_upstream_error', 'kind:'),
        ...breakdown(rows, 'diag_upstream_error', 'code:').map((b) => ({ ...b, key: `code:${b.key}` })),
      ],
      premature_close_retries: totalOf(rows, 'diag_nova_premature_close_retry'),
      reconnects: totalOf(rows, 'diag_reconnect_triggered'),
      greeting_recoveries: totalOf(rows, 'diag_greeting_recovery'),
      watchdog_fired: totalOf(rows, 'diag_watchdog_fired'),
      stalls_by_reason: breakdown(rows, 'stall_detected', 'reason:'),
      tool_failures: totalOf(rows, 'diag_tool_failed'),
      tool_failures_by_tool: breakdown(rows, 'diag_tool_failed', 'tool:'),
    },
    openers: {
      distribution: breakdown(rows, 'diag_greeting_sent', 'opener:'),
      repeat_24h: rate(totalOf(rows, 'opener_repeat_24h'), samplesOf(rows, 'opener_repeat_24h')),
    },
    offers: {
      made,
      accepted,
      declined,
      replaced,
      unanswered: Math.max(0, made - accepted - declined - replaced),
      acceptance: rate(accepted, made),
      by_source: breakdown(rows, 'offer_made', 'source:'),
    },
    learning: {
      sessions_finalized: finalized,
      summary_coverage: rate(totalOf(rows, 'finalize_summary_written'), samplesOf(rows, 'finalize_summary_written')),
      memory_committed: rate(totalOf(rows, 'finalize_memory_committed'), samplesOf(rows, 'finalize_memory_committed')),
      threads_written: totalOf(rows, 'finalize_threads_written'),
      threads_touched: totalOf(rows, 'finalize_threads_touched'),
      promises_written: totalOf(rows, 'finalize_promises_written'),
      facts_extracted: facts,
      facts_per_finalized_session: finalized > 0 ? Math.round((facts / finalized) * 100) / 100 : null,
    },
  };
}

/** One hourly series, oldest first, with empty hours filled as null. */
export function buildMetricSeries(
  rows: MetricRow[],
  metric: string,
  dimension: string,
  windowHours: number,
  nowMs: number,
): Array<{ hour_start: string; value: number | null; sample_count: number }> {
  const byHour = new Map<number, MetricRow>();
  for (const r of rows) {
    if (r.metric === metric && r.dimension === dimension) byHour.set(Date.parse(r.hour_start), r);
  }
  const currentHour = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const out: Array<{ hour_start: string; value: number | null; sample_count: number }> = [];
  for (let k = windowHours; k >= 1; k--) {
    const h = currentHour - k * 3_600_000;
    const r = byHour.get(h);
    out.push({
      hour_start: new Date(h).toISOString(),
      value: r ? Number(r.value) : null,
      sample_count: r ? Number(r.sample_count) || 0 : 0,
    });
  }
  return out;
}

/** The nightly learning jobs the Assistant › Metrics tab reports on (AP-0906..AP-0913). */
export const LEARNING_AUTOMATIONS = [
  'AP-0906', 'AP-0907', 'AP-0908', 'AP-0909', 'AP-0910', 'AP-0911', 'AP-0912', 'AP-0913',
] as const;

export interface AutomationRunRow {
  automation_id: string;
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_message?: string | null;
}

export interface LearningJobHealth {
  automation_id: string;
  last_started_at: string | null;
  last_status: string | null;
  last_error: string | null;
  runs_in_window: number;
  age_hours: number | null;
  /** A nightly job older than 36 h has missed at least one night. */
  stale: boolean;
}

export function summarizeLearningJobs(
  runs: AutomationRunRow[],
  windowStartMs: number,
  nowMs: number,
): LearningJobHealth[] {
  return LEARNING_AUTOMATIONS.map((id) => {
    const mine = runs
      .filter((r) => r.automation_id === id && r.started_at)
      .sort((a, b) => Date.parse(b.started_at as string) - Date.parse(a.started_at as string));
    const last = mine[0];
    const lastMs = last ? Date.parse(last.started_at as string) : NaN;
    const ageHours = Number.isFinite(lastMs) ? Math.round(((nowMs - lastMs) / 3_600_000) * 10) / 10 : null;
    return {
      automation_id: id,
      last_started_at: last?.started_at ?? null,
      last_status: last?.status ?? null,
      last_error: last?.error_message ?? null,
      runs_in_window: mine.filter((r) => Date.parse(r.started_at as string) >= windowStartMs).length,
      age_hours: ageHours,
      stale: ageHours === null || ageHours > 36,
    };
  });
}

export interface NarrativeFreshness {
  users_with_narrative: number;
  fresh_7d: number;
  newest_generated_at: string | null;
  oldest_generated_at: string | null;
}

export function summarizeNarrativeFreshness(
  values: Array<{ generated_at?: unknown } | null | undefined>,
  nowMs: number,
  maxAgeDays = 7,
): NarrativeFreshness {
  const stamps = values
    .map((v) => (v && typeof v.generated_at === 'string' ? v.generated_at : null))
    .filter((s): s is string => !!s && Number.isFinite(Date.parse(s)))
    .sort();
  const cutoff = nowMs - maxAgeDays * 86_400_000;
  return {
    users_with_narrative: values.length,
    fresh_7d: stamps.filter((s) => Date.parse(s) >= cutoff).length,
    newest_generated_at: stamps.length ? stamps[stamps.length - 1] : null,
    oldest_generated_at: stamps.length ? stamps[0] : null,
  };
}
