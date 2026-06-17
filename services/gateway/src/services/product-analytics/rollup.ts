/**
 * Product Analytics — daily rollup job (BOOTSTRAP-PRODUCT-ANALYTICS)
 *
 * Aggregates the prior UTC day's product_analytics_events into
 * product_analytics_daily_rollups, one row per (tenant, date, metric,
 * dimensions). Upserts on that unique key, so re-running for the same day
 * never double-counts.
 *
 * Also enforces retention: raw events older than 180 days are purged after
 * a successful rollup tick (rollups themselves are kept for 2 years —
 * pruned here too).
 *
 * Scheduling follows the in-process pattern of morning-brief-scheduler:
 * hourly tick, idempotent per day, env-gated via
 * PRODUCT_ANALYTICS_ROLLUP_ENABLED (default on). runDailyRollup() is
 * exported separately so it can be invoked manually or from tests.
 */

import { getSupabase } from '../../lib/supabase';

const LOG_PREFIX = '[Analytics:Product:Rollup]';

const TICK_MS = 60 * 60 * 1000; // hourly; runDailyRollup no-ops if the day is done
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

export const RAW_EVENT_RETENTION_DAYS = 180;
export const ROLLUP_RETENTION_DAYS = 365 * 2;

interface EventRow {
  event_name: string;
  event_type: string;
  tenant_id: string;
  user_id_hash: string | null;
  session_id: string;
  conversation_id: string | null;
  screen_route: string;
  feature_key: string | null;
  properties: Record<string, any>;
  occurred_at: string;
}

interface RollupRow {
  tenant_id: string;
  rollup_date: string;
  metric_key: string;
  dimensions: Record<string, string>;
  metric_value: number;
  updated_at: string;
}

function increment(map: Map<string, number>, key: string | null | undefined, by = 1): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * Computes rollup rows for one tenant-day worth of events. Pure — exported
 * for tests.
 */
export function computeRollups(tenantId: string, rollupDate: string, events: EventRow[]): RollupRow[] {
  const users = new Set<string>();
  const sessions = new Set<string>();
  const conversations = new Set<string>();
  const routeCounts = new Map<string, number>();
  const featureOpens = new Map<string, number>();
  const featureCompletions = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  const exitCounts = new Map<string, number>();
  const sessionLastRoute = new Map<string, { route: string; at: string }>();
  let screenViews = 0;
  let messages = 0;
  let toolFailures = 0;
  let positiveFeedback = 0;
  let negativeFeedback = 0;

  for (const ev of events) {
    if (ev.user_id_hash) users.add(ev.user_id_hash);
    sessions.add(ev.session_id);
    if (ev.event_type === 'assistant' && ev.conversation_id) conversations.add(ev.conversation_id);

    switch (ev.event_name) {
      case 'screen_viewed': {
        screenViews++;
        increment(routeCounts, ev.screen_route);
        const last = sessionLastRoute.get(ev.session_id);
        if (!last || ev.occurred_at > last.at) {
          sessionLastRoute.set(ev.session_id, { route: ev.screen_route, at: ev.occurred_at });
        }
        break;
      }
      case 'user_message_sent':
        messages++;
        break;
      case 'feature_opened':
        increment(featureOpens, ev.feature_key);
        break;
      case 'feature_completed':
        increment(featureCompletions, ev.feature_key);
        break;
      case 'topic_detected':
      case 'interest_detected':
        increment(topicCounts, ev.properties?.topic);
        break;
      case 'tool_call_failed':
        toolFailures++;
        break;
      case 'assistant_feedback_given': {
        const sentiment = String(ev.properties?.sentiment ?? '');
        if (sentiment === 'positive') positiveFeedback++;
        else if (sentiment === 'negative') negativeFeedback++;
        break;
      }
    }
  }

  for (const { route } of sessionLastRoute.values()) increment(exitCounts, route);

  const now = new Date().toISOString();
  const row = (metric_key: string, metric_value: number, dimensions: Record<string, string> = {}): RollupRow => ({
    tenant_id: tenantId,
    rollup_date: rollupDate,
    metric_key,
    dimensions,
    metric_value,
    updated_at: now,
  });

  const rows: RollupRow[] = [
    row('active_users', users.size),
    row('sessions', sessions.size),
    row('screen_views', screenViews),
    row('assistant_conversations', conversations.size),
    row('assistant_messages', messages),
    row('tool_failures', toolFailures),
    row('feedback_positive', positiveFeedback),
    row('feedback_negative', negativeFeedback),
  ];

  for (const [screen_route, count] of routeCounts) rows.push(row('route_views', count, { screen_route }));
  for (const [feature_key, count] of featureOpens) rows.push(row('feature_opens', count, { feature_key }));
  for (const [feature_key, count] of featureCompletions) rows.push(row('feature_completions', count, { feature_key }));
  for (const [topic, count] of topicCounts) rows.push(row('topic_events', count, { topic }));
  for (const [screen_route, count] of exitCounts) rows.push(row('session_exits', count, { screen_route }));

  return rows;
}

async function fetchDayEvents(supabase: any, dayStartIso: string, dayEndIso: string): Promise<EventRow[]> {
  const rows: EventRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from('product_analytics_events')
      .select(
        'event_name, event_type, tenant_id, user_id_hash, session_id, conversation_id, screen_route, feature_key, properties, occurred_at',
      )
      .gte('occurred_at', dayStartIso)
      .lt('occurred_at', dayEndIso)
      .order('occurred_at', { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as EventRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Rolls up one UTC day (default: yesterday). Idempotent — upserts on
 * (tenant_id, rollup_date, metric_key, dimensions).
 */
export async function runDailyRollup(targetDate?: string): Promise<{ ok: boolean; rows: number; date: string }> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, rows: 0, date: targetDate ?? '' };

  const date = targetDate ?? new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = new Date(new Date(dayStart).getTime() + 86400000).toISOString();

  const events = await fetchDayEvents(supabase, dayStart, dayEnd);

  const byTenant = new Map<string, EventRow[]>();
  for (const ev of events) {
    const list = byTenant.get(ev.tenant_id) ?? [];
    list.push(ev);
    byTenant.set(ev.tenant_id, list);
  }

  let total = 0;
  for (const [tenantId, tenantEvents] of byTenant) {
    const rows = computeRollups(tenantId, date, tenantEvents);
    if (rows.length === 0) continue;
    const { error } = await supabase
      .from('product_analytics_daily_rollups')
      .upsert(rows, { onConflict: 'tenant_id,rollup_date,metric_key,dimensions' });
    if (error) {
      console.error(`${LOG_PREFIX} upsert failed for tenant ${tenantId}: ${error.message}`);
      continue;
    }
    total += rows.length;
  }

  console.log(`${LOG_PREFIX} rolled up ${date}: ${events.length} events → ${total} rollup rows`);
  return { ok: true, rows: total, date };
}

/** Purges raw events and rollups past their retention windows. */
export async function purgeExpiredAnalytics(): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  const rawCutoff = new Date(Date.now() - RAW_EVENT_RETENTION_DAYS * 86400000).toISOString();
  const rollupCutoff = new Date(Date.now() - ROLLUP_RETENTION_DAYS * 86400000).toISOString().slice(0, 10);

  const { error: rawErr } = await supabase
    .from('product_analytics_events')
    .delete()
    .lt('received_at', rawCutoff);
  if (rawErr) console.warn(`${LOG_PREFIX} raw purge failed: ${rawErr.message}`);

  const { error: rollupErr } = await supabase
    .from('product_analytics_daily_rollups')
    .delete()
    .lt('rollup_date', rollupCutoff);
  if (rollupErr) console.warn(`${LOG_PREFIX} rollup purge failed: ${rollupErr.message}`);
}

let timerId: NodeJS.Timeout | undefined;
let lastCompletedDate: string | null = null;

export function startProductAnalyticsRollupScheduler(): void {
  if (timerId) return;

  const enabled = (process.env.PRODUCT_ANALYTICS_ROLLUP_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log(`${LOG_PREFIX} disabled (PRODUCT_ANALYTICS_ROLLUP_ENABLED=false)`);
    return;
  }

  const tick = async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (lastCompletedDate === yesterday) return; // today's rollup already done
    try {
      const result = await runDailyRollup(yesterday);
      if (result.ok) {
        lastCompletedDate = yesterday;
        await purgeExpiredAnalytics();
      }
    } catch (err: any) {
      console.error(`${LOG_PREFIX} tick error:`, err?.message || err);
    }
  };

  timerId = setInterval(tick, TICK_MS);
  timerId.unref?.();
  void tick();
  console.log(`${LOG_PREFIX} started — hourly tick, idempotent per UTC day`);
}

export function stopProductAnalyticsRollupScheduler(): void {
  if (timerId) clearInterval(timerId);
  timerId = undefined;
}
