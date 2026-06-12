/**
 * Product Analytics — admin read endpoints (BOOTSTRAP-PRODUCT-ANALYTICS)
 *
 * Mounted at /api/v1/admin/tenants/:tenantId/analytics
 *
 *   GET /summary?days=30    — KPI overview (users, sessions, views, top lists)
 *   GET /assistant?days=30  — Assistant quality (intents, topics, tools, p95)
 *   GET /journeys?days=30   — entry/exit routes, top paths, drop-offs
 *   GET /features?days=30   — adoption: opens, completions, repeat users, trends
 *   GET /interests?days=30  — detected topics, sources, repeated interest
 *   GET /events?limit=100   — recent raw event feed (metadata only)
 *
 * All endpoints are requireTenantAdmin-gated and tenant-scoped. Aggregation
 * happens in TS over a bounded window of raw events — the same pattern as
 * the Navigator telemetry endpoint (admin-navigator.ts GET /telemetry).
 * Long-horizon trends read from product_analytics_daily_rollups.
 *
 * Privacy: responses surface metadata and aggregates only. Raw Assistant
 * message text is never stored in the underlying table, so it can never
 * appear here.
 */

import { Router, Response } from 'express';
import { requireTenantAdmin } from '../../middleware/require-tenant-admin';
import { AuthenticatedRequest } from '../../middleware/auth-supabase-jwt';
import { getSupabase } from '../../lib/supabase';

const router = Router({ mergeParams: true });

// Every endpoint in this router is tenant-admin-gated.
router.use(requireTenantAdmin);
const LOG_PREFIX = '[Analytics:Product:Admin]';

// PostgREST caps response sizes, so page through deterministically.
const PAGE_SIZE = 1000;
const MAX_PAGES = 20; // hard ceiling: 20k events per aggregation window

const EVENT_COLUMNS =
  'event_name, event_type, user_id_hash, session_id, conversation_id, screen_route, feature_key, source, properties, occurred_at';

interface EventRow {
  event_name: string;
  event_type: string;
  user_id_hash: string | null;
  session_id: string;
  conversation_id: string | null;
  screen_route: string;
  feature_key: string | null;
  source: string;
  properties: Record<string, any>;
  occurred_at: string;
}

function getTenantId(req: AuthenticatedRequest): string | null {
  return req.params.tenantId || ((req as any).targetTenantId as string | undefined) || null;
}

function parseDays(req: AuthenticatedRequest): number {
  const raw = Number(req.query.days ?? 30);
  return Number.isFinite(raw) ? Math.max(1, Math.min(90, Math.floor(raw))) : 30;
}

async function fetchEvents(
  supabase: any,
  tenantId: string,
  sinceIso: string,
  eventTypes?: string[],
): Promise<EventRow[]> {
  const rows: EventRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let query = supabase
      .from('product_analytics_events')
      .select(EVENT_COLUMNS)
      .eq('tenant_id', tenantId)
      .gte('occurred_at', sinceIso);
    if (eventTypes && eventTypes.length > 0) query = query.in('event_type', eventTypes);

    const { data, error } = await query
      .order('occurred_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as EventRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

function topCounts(counter: Map<string, number>, limit = 10): Array<{ key: string; count: number }> {
  return [...counter.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function increment(map: Map<string, number>, key: string | null | undefined): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

// ── GET /summary ────────────────────────────────────────────────────────────

router.get('/summary', async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });
  const days = parseDays(req);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const events = await fetchEvents(supabase, tenantId, since);

    const users = new Set<string>();
    const sessions = new Set<string>();
    const conversations = new Set<string>();
    const startedConversations = new Set<string>();
    const resolvedConversations = new Set<string>();
    const routeCounts = new Map<string, number>();
    const featureCounts = new Map<string, number>();
    const interestCounts = new Map<string, number>();
    let screenViews = 0;
    let assistantMessages = 0;
    let featureOpens = 0;
    let featureCompletions = 0;
    let recommendationClicks = 0;

    for (const ev of events) {
      if (ev.user_id_hash) users.add(ev.user_id_hash);
      sessions.add(ev.session_id);
      if (ev.event_type === 'assistant' && ev.conversation_id) conversations.add(ev.conversation_id);
      switch (ev.event_name) {
        case 'screen_viewed':
          screenViews++;
          increment(routeCounts, ev.screen_route);
          break;
        case 'user_message_sent':
          assistantMessages++;
          break;
        case 'feature_opened':
          featureOpens++;
          increment(featureCounts, ev.feature_key);
          break;
        case 'feature_completed':
          featureCompletions++;
          break;
        case 'recommendation_clicked':
          recommendationClicks++;
          break;
        case 'conversation_started':
          if (ev.conversation_id) startedConversations.add(ev.conversation_id);
          break;
        case 'conversation_resolved':
        case 'conversation_abandoned':
          if (ev.conversation_id) resolvedConversations.add(ev.conversation_id);
          break;
      }
      if (ev.event_name === 'topic_detected' || ev.event_name === 'interest_detected') {
        increment(interestCounts, ev.properties?.topic);
      }
    }

    const unresolved = [...startedConversations].filter((c) => !resolvedConversations.has(c));

    return res.json({
      ok: true,
      days,
      active_users: users.size,
      sessions: sessions.size,
      screen_views: screenViews,
      assistant_conversations: conversations.size,
      assistant_messages: assistantMessages,
      feature_opens: featureOpens,
      feature_completions: featureCompletions,
      recommendation_clicks: recommendationClicks,
      unresolved_conversations: unresolved.length,
      top_routes: topCounts(routeCounts).map(({ key, count }) => ({ screen_route: key, count })),
      top_features: topCounts(featureCounts).map(({ key, count }) => ({ feature_key: key, count })),
      top_interests: topCounts(interestCounts).map(({ key, count }) => ({ topic: key, count })),
    });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /summary:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /assistant ──────────────────────────────────────────────────────────

router.get('/assistant', async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });
  const days = parseDays(req);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const events = await fetchEvents(supabase, tenantId, since, ['assistant', 'friction']);

    const users = new Set<string>();
    const conversations = new Set<string>();
    const resolved = new Set<string>();
    const abandoned = new Set<string>();
    const intentCounts = new Map<string, number>();
    const topicCounts = new Map<string, number>();
    const toolCalls = new Map<string, { calls: number; failures: number }>();
    const responseTimes: number[] = [];
    const convoMeta = new Map<
      string,
      { last_event_at: string; topic: string | null; intent: string | null; message_count: number }
    >();
    let messages = 0;
    let positiveFeedback = 0;
    let negativeFeedback = 0;
    let toolCallCount = 0;
    let toolFailureCount = 0;

    for (const ev of events) {
      if (ev.user_id_hash) users.add(ev.user_id_hash);
      const convo = ev.conversation_id;
      if (convo) {
        conversations.add(convo);
        const meta = convoMeta.get(convo) ?? {
          last_event_at: ev.occurred_at,
          topic: null,
          intent: null,
          message_count: 0,
        };
        if (ev.occurred_at > meta.last_event_at) meta.last_event_at = ev.occurred_at;
        if (ev.event_name === 'topic_detected' && ev.properties?.topic) meta.topic = ev.properties.topic;
        if (ev.event_name === 'intent_classified' && ev.properties?.intent) meta.intent = ev.properties.intent;
        if (ev.event_name === 'user_message_sent') meta.message_count++;
        convoMeta.set(convo, meta);
      }

      switch (ev.event_name) {
        case 'user_message_sent':
          messages++;
          break;
        case 'conversation_resolved':
          if (convo) resolved.add(convo);
          break;
        case 'conversation_abandoned':
          if (convo) abandoned.add(convo);
          break;
        case 'intent_classified':
          increment(intentCounts, ev.properties?.intent);
          break;
        case 'topic_detected':
          increment(topicCounts, ev.properties?.topic);
          break;
        case 'assistant_response_completed': {
          const ms = Number(ev.properties?.response_time_ms);
          if (Number.isFinite(ms) && ms >= 0) responseTimes.push(ms);
          break;
        }
        case 'assistant_feedback_given': {
          const sentiment = String(ev.properties?.sentiment ?? '');
          if (sentiment === 'positive') positiveFeedback++;
          else if (sentiment === 'negative') negativeFeedback++;
          break;
        }
        case 'tool_called': {
          toolCallCount++;
          const name = String(ev.properties?.tool_name ?? 'unknown');
          const entry = toolCalls.get(name) ?? { calls: 0, failures: 0 };
          entry.calls++;
          toolCalls.set(name, entry);
          break;
        }
        case 'tool_call_failed': {
          toolFailureCount++;
          const name = String(ev.properties?.tool_name ?? 'unknown');
          const entry = toolCalls.get(name) ?? { calls: 0, failures: 0 };
          entry.failures++;
          toolCalls.set(name, entry);
          break;
        }
      }
    }

    const conversationCount = conversations.size;
    const recentUnresolved = [...convoMeta.entries()]
      .filter(([id]) => !resolved.has(id) && !abandoned.has(id))
      .sort((a, b) => (a[1].last_event_at < b[1].last_event_at ? 1 : -1))
      .slice(0, 25)
      .map(([conversation_id, meta]) => ({ conversation_id, ...meta }));

    return res.json({
      ok: true,
      days,
      conversations: conversationCount,
      messages,
      users: users.size,
      avg_messages_per_conversation: conversationCount > 0 ? Number((messages / conversationCount).toFixed(2)) : 0,
      resolution_rate: ratio(resolved.size, conversationCount),
      abandonment_rate: ratio(abandoned.size, conversationCount),
      positive_feedback: positiveFeedback,
      negative_feedback: negativeFeedback,
      p95_response_ms: percentile(responseTimes, 95),
      tool_failure_rate: ratio(toolFailureCount, toolCallCount),
      top_intents: topCounts(intentCounts).map(({ key, count }) => ({ intent: key, count })),
      top_topics: topCounts(topicCounts).map(({ key, count }) => ({ topic: key, count })),
      top_tools: [...toolCalls.entries()]
        .map(([tool_name, { calls, failures }]) => ({ tool_name, calls, failures }))
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 15),
      recent_unresolved: recentUnresolved,
    });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /assistant:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /journeys ───────────────────────────────────────────────────────────

router.get('/journeys', async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });
  const days = parseDays(req);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const events = await fetchEvents(supabase, tenantId, since, ['journey', 'assistant', 'feature']);

    // Reconstruct per-session screen_viewed sequences (ascending time).
    const sessionViews = new Map<string, Array<{ route: string; at: string }>>();
    const sessionAssisted = new Map<string, string | null>(); // earliest assistant interaction
    const featureOpens = new Map<string, { assisted: number; direct: number }>();
    const featureOpenEvents: Array<{ session: string; feature: string; at: string }> = [];

    for (const ev of events) {
      if (ev.event_name === 'screen_viewed') {
        const list = sessionViews.get(ev.session_id) ?? [];
        list.push({ route: ev.screen_route, at: ev.occurred_at });
        sessionViews.set(ev.session_id, list);
      } else if (ev.event_type === 'assistant') {
        const current = sessionAssisted.get(ev.session_id);
        if (current === undefined || (current !== null && ev.occurred_at < current)) {
          sessionAssisted.set(ev.session_id, ev.occurred_at);
        }
      } else if (ev.event_name === 'feature_opened' && ev.feature_key) {
        featureOpenEvents.push({ session: ev.session_id, feature: ev.feature_key, at: ev.occurred_at });
      }
    }

    const entryRoutes = new Map<string, number>();
    const exitRoutes = new Map<string, number>();
    const pathCounts = new Map<string, number>();
    const routeViews = new Map<string, number>();
    const routeExits = new Map<string, number>();
    let totalScreens = 0;

    for (const views of sessionViews.values()) {
      views.sort((a, b) => (a.at < b.at ? -1 : 1));
      totalScreens += views.length;
      increment(entryRoutes, views[0].route);
      increment(exitRoutes, views[views.length - 1].route);
      increment(routeExits, views[views.length - 1].route);
      for (const v of views) increment(routeViews, v.route);
      // Collapse consecutive repeats and cap path length at 5 hops.
      const path: string[] = [];
      for (const v of views) {
        if (path[path.length - 1] !== v.route) path.push(v.route);
        if (path.length >= 5) break;
      }
      if (path.length >= 2) increment(pathCounts, path.join(' > '));
    }

    for (const open of featureOpenEvents) {
      const assistedAt = sessionAssisted.get(open.session);
      const entry = featureOpens.get(open.feature) ?? { assisted: 0, direct: 0 };
      if (assistedAt && assistedAt <= open.at) entry.assisted++;
      else entry.direct++;
      featureOpens.set(open.feature, entry);
    }

    const dropoffs = [...routeExits.entries()]
      .map(([screen_route, exits]) => ({
        screen_route,
        exits,
        exit_rate: ratio(exits, routeViews.get(screen_route) ?? exits),
      }))
      .sort((a, b) => b.exits - a.exits)
      .slice(0, 15);

    const sessionCount = sessionViews.size;

    return res.json({
      ok: true,
      days,
      sessions: sessionCount,
      screen_views: totalScreens,
      avg_screens_per_session: sessionCount > 0 ? Number((totalScreens / sessionCount).toFixed(2)) : 0,
      top_entry_routes: topCounts(entryRoutes).map(({ key, count }) => ({ screen_route: key, sessions: count })),
      top_exit_routes: topCounts(exitRoutes).map(({ key, count }) => ({ screen_route: key, sessions: count })),
      top_paths: topCounts(pathCounts, 15).map(({ key, count }) => ({ path: key.split(' > '), sessions: count })),
      dropoffs,
      assistant_to_feature: [...featureOpens.entries()]
        .map(([feature_key, { assisted, direct }]) => ({
          feature_key,
          assisted_opens: assisted,
          direct_opens: direct,
        }))
        .sort((a, b) => b.assisted_opens + b.direct_opens - (a.assisted_opens + a.direct_opens))
        .slice(0, 15),
    });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /journeys:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /features ───────────────────────────────────────────────────────────

router.get('/features', async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });
  const days = parseDays(req);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const events = await fetchEvents(supabase, tenantId, since, ['feature', 'assistant']);

    const features = new Map<
      string,
      { opens: number; completions: number; openUsers: Map<string, number>; assistedOpens: number }
    >();
    const byDay = new Map<string, Map<string, { opens: number; completions: number }>>();

    for (const ev of events) {
      if (ev.event_name !== 'feature_opened' && ev.event_name !== 'feature_completed') continue;
      const key = ev.feature_key ?? 'unknown';
      const entry =
        features.get(key) ?? { opens: 0, completions: 0, openUsers: new Map<string, number>(), assistedOpens: 0 };
      const day = ev.occurred_at.slice(0, 10);
      const dayMap = byDay.get(day) ?? new Map();
      const dayEntry = dayMap.get(key) ?? { opens: 0, completions: 0 };

      if (ev.event_name === 'feature_opened') {
        entry.opens++;
        dayEntry.opens++;
        if (ev.properties?.via_assistant === true) entry.assistedOpens++;
        if (ev.user_id_hash) entry.openUsers.set(ev.user_id_hash, (entry.openUsers.get(ev.user_id_hash) ?? 0) + 1);
      } else {
        entry.completions++;
        dayEntry.completions++;
      }
      features.set(key, entry);
      dayMap.set(key, dayEntry);
      byDay.set(day, dayMap);
    }

    const topFeatures = [...features.entries()]
      .map(([feature_key, f]) => ({
        feature_key,
        opens: f.opens,
        completions: f.completions,
        completion_rate: ratio(f.completions, f.opens),
        repeat_users: [...f.openUsers.values()].filter((n) => n >= 2).length,
        assisted_opens: f.assistedOpens,
      }))
      .sort((a, b) => b.opens - a.opens);

    const featureTrends: Array<{ date: string; feature_key: string; opens: number; completions: number }> = [];
    for (const [date, dayMap] of [...byDay.entries()].sort()) {
      for (const [feature_key, counts] of dayMap.entries()) {
        featureTrends.push({ date, feature_key, ...counts });
      }
    }

    return res.json({ ok: true, days, top_features: topFeatures.slice(0, 25), feature_trends: featureTrends });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /features:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /interests ──────────────────────────────────────────────────────────

const INTEREST_EVENTS = new Set([
  'topic_detected',
  'interest_detected',
  'topic_repeated',
  'content_saved',
  'recommendation_saved',
  'community_joined',
  'service_viewed',
  'recommendation_clicked',
]);

router.get('/interests', async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });
  const days = parseDays(req);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const events = await fetchEvents(supabase, tenantId, since, ['interest', 'assistant', 'content']);

    const topics = new Map<string, { users: Map<string, number>; events: number; sources: Map<string, number> }>();

    for (const ev of events) {
      if (!INTEREST_EVENTS.has(ev.event_name)) continue;
      const topic = ev.properties?.topic;
      if (!topic || typeof topic !== 'string') continue;
      const entry = topics.get(topic) ?? { users: new Map<string, number>(), events: 0, sources: new Map<string, number>() };
      entry.events++;
      increment(entry.sources, ev.source);
      if (ev.user_id_hash) entry.users.set(ev.user_id_hash, (entry.users.get(ev.user_id_hash) ?? 0) + 1);
      topics.set(topic, entry);
    }

    const topTopics = [...topics.entries()]
      .map(([topic, t]) => ({
        topic,
        users: t.users.size,
        events: t.events,
        repeated_users: [...t.users.values()].filter((n) => n >= 2).length,
      }))
      .sort((a, b) => b.events - a.events)
      .slice(0, 25);

    const topicSources: Array<{ topic: string; source: string; events: number }> = [];
    for (const [topic, t] of topics.entries()) {
      for (const [source, count] of t.sources.entries()) {
        topicSources.push({ topic, source, events: count });
      }
    }
    topicSources.sort((a, b) => b.events - a.events);

    return res.json({ ok: true, days, top_topics: topTopics, topic_sources: topicSources.slice(0, 50) });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /interests:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ── GET /events ─────────────────────────────────────────────────────────────

router.get('/events', async (req: AuthenticatedRequest, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'TENANT_ID_REQUIRED' });

  const limitRaw = Number(req.query.limit ?? 100);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;
  const eventName = typeof req.query.event_name === 'string' ? req.query.event_name : null;
  const eventType = typeof req.query.event_type === 'string' ? req.query.event_type : null;

  try {
    let query = supabase
      .from('product_analytics_events')
      .select(EVENT_COLUMNS)
      .eq('tenant_id', tenantId)
      .order('occurred_at', { ascending: false })
      .limit(limit);
    if (eventName) query = query.eq('event_name', eventName);
    if (eventType) query = query.eq('event_type', eventType);

    const { data, error } = await query;
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, count: (data ?? []).length, events: data ?? [] });
  } catch (err: any) {
    console.error(`${LOG_PREFIX} GET /events:`, err.message);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

export default router;
