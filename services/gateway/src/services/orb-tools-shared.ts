/**
 * Orb tool dispatcher — shared library.
 *
 * Single canonical implementation for every tool the orb agent (LiveKit
 * pipeline today; Vertex pipeline progressively migrated in follow-up
 * PRs) exposes to the LLM whose business logic was previously inline-only
 * inside services/gateway/src/routes/orb-live.ts.
 *
 * Why a shared module:
 *   - Vertex's orb-live.ts WebSocket message handler dispatched tools
 *     INLINE — ~20 case-blocks with bespoke logic per tool.
 *   - The LiveKit pipeline started with a parallel re-implementation in
 *     services/gateway/src/routes/orb-tool.ts which immediately drifted
 *     (search_events lost titles in text response, search_community
 *     queried a non-existent table, etc.).
 *   - Each drift required a separate fix. With 22 tools at risk the work
 *     compounds.
 *
 * Contract:
 *   - Both pipelines call dispatchOrbTool(name, args, identity, sb).
 *   - Return shape is OrbToolResult (ok+result+text or ok=false+error).
 *   - Handlers never throw — dispatchOrbTool wraps the call and converts
 *     any unexpected exception into ok=false.
 *   - LLM-facing text MUST contain the actual content the LLM will speak;
 *     "Found 3 events" without titles is a regression bug, not a feature.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { fetchVitanaIndexForProfiler } from './user-context-profiler';
import { resolvePillarKey } from '../lib/vitana-pillars';
import {
  lookupScreen,
  lookupByAlias,
  lookupByRoute,
  suggestSimilar,
  getContent,
  type NavCatalogEntry,
} from '../lib/navigation-catalog';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrbToolArgs = Record<string, unknown>;

export interface OrbToolIdentity {
  user_id: string;
  tenant_id: string | null;
  role: string | null;
  vitana_id?: string | null;
  /**
   * Optional Bearer JWT for the user. Some tool handlers self-call the
   * gateway's HTTP API for tier checks + authoritative business logic
   * (e.g. /api/v1/intent-scan, /api/v1/intents/:id/share). Pipelines that
   * have a user JWT in hand (Vertex's session.access_token,
   * LiveKit's gateway-issued user_jwt) should populate this.
   */
  user_jwt?: string | null;
  /**
   * Optional WebSocket / room session context. Some tool handlers (the
   * retrieval-router-backed search tools, the AI-delegation tool) take
   * a session-scoped ID + locale + start-time so they can correlate
   * traces and pick the right per-session ranking caches. Vertex
   * populates from session.sessionId / session.thread_id / session.lang /
   * session.createdAt / session.turn_count; LiveKit can synthesize from
   * orb_session_id + sensible defaults.
   */
  session_id?: string | null;
  thread_id?: string | null;
  turn_number?: number | null;
  session_started_iso?: string | null;
  lang?: string | null;
  /**
   * PR 1.B-5 — navigator-gate identity facts. Populated from session
   * state (Vertex: session.isAnonymous + session.is_mobile; LiveKit:
   * Identity.is_anonymous + Identity.is_mobile) so the shared
   * tool_navigate_to_screen handler can enforce the same gates Vertex's
   * handleNavigateToScreen has today: anonymous-safe screens, viewport
   * lock (VTID-02789), mobile_route override.
   */
  is_anonymous?: boolean | null;
  is_mobile?: boolean | null;
}

export type OrbToolResult =
  | { ok: true; result?: unknown; text?: string; [k: string]: unknown }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * Shared retrieval-router-backed search. Both Vertex's search_memory and
 * search_web (and search_knowledge if/when it lifts) call into the same
 * computeRetrievalRouterDecision + buildContextPack stack. The only
 * differences are: force_sources, limit_overrides, the hits field they
 * read from the contextPack, and the output formatter.
 */
async function _runRetrievalSearch(
  toolName: 'search_memory' | 'search_web' | 'search_knowledge',
  args: OrbToolArgs,
  id: OrbToolIdentity,
): Promise<OrbToolResult> {
  const query = String(args.query ?? '').trim();
  if (!query) {
    return { ok: false, error: `${toolName} requires a non-empty query.` };
  }

  const { computeRetrievalRouterDecision } = await import('./retrieval-router');
  const { buildContextPack } = await import('./context-pack-builder');
  const { createContextLens } = await import('../types/context-lens');

  // Per-tool router config (matches orb-live.ts:4538/4645/4593).
  let routerConfig: {
    channel: 'orb';
    force_sources: ('memory_garden' | 'knowledge_hub' | 'web_search')[];
    limit_overrides: { memory_garden: number; knowledge_hub: number; web_search: number };
  };
  if (toolName === 'search_memory') {
    routerConfig = {
      channel: 'orb',
      force_sources: ['memory_garden'],
      limit_overrides: { memory_garden: 8, knowledge_hub: 0, web_search: 0 },
    };
  } else if (toolName === 'search_web') {
    routerConfig = {
      channel: 'orb',
      force_sources: ['web_search'],
      limit_overrides: { memory_garden: 0, knowledge_hub: 0, web_search: 5 },
    };
  } else {
    routerConfig = {
      channel: 'orb',
      force_sources: ['knowledge_hub'],
      limit_overrides: { memory_garden: 0, knowledge_hub: 4, web_search: 0 },
    };
  }
  const routerDecision = computeRetrievalRouterDecision(query, routerConfig);

  if (!id.tenant_id) {
    return { ok: false, error: `${toolName} requires a tenant_id on the session.` };
  }

  const lens = createContextLens(id.tenant_id, id.user_id, {
    workspace_scope: 'product',
    active_role: id.role || undefined,
  });

  // Synthesize session-context fields when the caller didn't provide them
  // (LiveKit pipeline doesn't have a long-lived WebSocket sessionId; using
  // orb_session_id from args.session_id when available, else user_id).
  const threadId = id.thread_id || id.session_id || `${id.user_id}:${toolName}`;
  const turnNumber = typeof id.turn_number === 'number' ? id.turn_number : 0;
  const conversationStart = id.session_started_iso || new Date().toISOString();
  const role = id.role || 'user';

  const contextPack = await buildContextPack({
    lens,
    query,
    channel: 'orb',
    thread_id: threadId,
    turn_number: turnNumber,
    conversation_start: conversationStart,
    role,
    router_decision: routerDecision,
  });

  // VTID-01224-FIX: voice cap. Oversized function_response payloads stall
  // the Live API. Mirror Vertex's per-tool 4 KB ceiling.
  const MAX = 4000;

  if (toolName === 'search_memory') {
    const memoryHits = (contextPack.memory_hits || []) as Array<{
      category_key?: string;
      content?: string;
    }>;
    if (memoryHits.length === 0) {
      return {
        ok: true,
        result: { items: [] },
        text: 'No relevant memories found for this query.',
      };
    }
    const top = memoryHits.slice(0, 8);
    let formatted = top
      .map((h) => `[${h.category_key || 'memory'}] ${(h.content || '').substring(0, 300)}`)
      .join('\n');
    if (formatted.length > MAX) formatted = formatted.substring(0, MAX) + '\n... (truncated)';
    return {
      ok: true,
      result: { items: top },
      text: `Found ${top.length} relevant memories:\n${formatted}`,
    };
  }

  if (toolName === 'search_web') {
    const webHits = (contextPack.web_hits || []) as Array<{
      title?: string;
      snippet?: string;
      content?: string;
      url?: string;
      citation?: string;
    }>;
    if (webHits.length === 0) {
      return {
        ok: true,
        result: { items: [] },
        text: 'No relevant web results found for this query.',
      };
    }
    let formatted = webHits
      .map(
        (h) =>
          `**${h.title || 'Web Result'}**\n${h.snippet || h.content || ''}\nSource: ${h.url || h.citation || 'web'}`,
      )
      .join('\n\n');
    if (formatted.length > MAX) formatted = formatted.substring(0, MAX) + '\n... (truncated)';
    return {
      ok: true,
      result: { items: webHits },
      text: `Found ${webHits.length} relevant web results:\n${formatted}`,
    };
  }

  // search_knowledge (kept for future lift; Vertex still has its own case
  // today, but the shared dispatcher routes here when called).
  const knowledgeHits = (contextPack.knowledge_hits || []) as Array<{
    title?: string;
    excerpt?: string;
    content?: string;
    citation?: string;
  }>;
  if (knowledgeHits.length === 0) {
    return {
      ok: true,
      result: { items: [] },
      text: 'No relevant knowledge entries found for this query.',
    };
  }
  let formatted = knowledgeHits
    .map((h) => `**${h.title || 'KB'}**\n${h.excerpt || h.content || ''}\nSource: ${h.citation || 'kb'}`)
    .join('\n\n');
  if (formatted.length > MAX) formatted = formatted.substring(0, MAX) + '\n... (truncated)';
  return {
    ok: true,
    result: { items: knowledgeHits },
    text: `Found ${knowledgeHits.length} relevant knowledge entries:\n${formatted}`,
  };
}

export async function tool_search_memory(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR D-3: lifted from orb-live.ts:4538 (VTID-01224). Vertex's auth impl
  // routes through computeRetrievalRouterDecision + buildContextPack —
  // proper retrieval-router with relevance ranking, embeddings, etc. The
  // previous shared stub did naive ilike — strict regression vs Vertex.
  return _runRetrievalSearch('search_memory', args, id);
}

export async function tool_search_web(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR D-3: lifted from orb-live.ts:4645 (VTID-01224). Vertex calls the
  // same retrieval-router stack with web_search forced. The previous
  // shared stub returned a hardcoded "web search isn't connected" message.
  return _runRetrievalSearch('search_web', args, id);
}

export async function tool_recall_conversation_at_time(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  // Lifted from orb-live.ts:4287 (PR B-3 of the lift-not-duplicate refactor).
  // Both pipelines now call services/tool-recall-conversation through the
  // shared dispatcher. Accepts both `time_hint` (Vertex's canonical) and
  // legacy `when` (the prior LiveKit Python tool key).
  const time_hint = String(args.time_hint ?? args.when ?? '').trim();
  if (!time_hint) {
    return { ok: false, error: 'time_hint is required' };
  }
  const topic_hint = typeof args.topic_hint === 'string' ? args.topic_hint : undefined;

  const userTimezone =
    typeof args.user_timezone === 'string' ? (args.user_timezone as string) : undefined;

  try {
    const { executeRecallConversationAtTime } = await import('./tool-recall-conversation');
    const recall = await executeRecallConversationAtTime(
      { time_hint, topic_hint },
      { user_id: id.user_id, user_timezone: userTimezone },
    );
    if (!recall.ok) {
      return { ok: false, error: recall.error || 'recall_failed' };
    }
    // Cap payload to keep below the 4 KB function-response stall threshold.
    const payload = JSON.stringify(recall);
    const MAX = 4000;
    const text = payload.length > MAX ? payload.slice(0, MAX) + '...(truncated)' : payload;
    return { ok: true, result: recall, text };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'recall_exception';
    return { ok: false, error: msg };
  }
}

export async function tool_switch_persona(args: OrbToolArgs): Promise<OrbToolResult> {
  const persona = String(args.persona ?? '').trim();
  return {
    ok: true,
    result: { persona, applied: true },
    text:
      `Persona style noted: "${persona}". ` +
      `For specialist handoffs (Devon/Sage/Atlas/Mira) use report_to_specialist instead.`,
  };
}

export async function tool_report_to_specialist(args: OrbToolArgs): Promise<OrbToolResult> {
  const specialist = String(args.specialist ?? '').trim();
  const reason = String(args.reason ?? '').trim();
  return {
    ok: true,
    result: { specialist, reason, status: 'acknowledged' },
    text:
      `Handoff to ${specialist || 'a specialist'} acknowledged. The full ` +
      `live persona swap (audible voice change) lands in a follow-up; for ` +
      `now, please continue with me and I'll pass the context forward when ` +
      `that ships.`,
  };
}

export async function tool_search_events(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR B-10: lifted from orb-live.ts:5139 (VTID-01270A). Vertex's auth impl
  // ranks ALL upcoming events through scoreAndRankEvents (not just an
  // ilike), boosts by user's home_city for proximity, fetches live_rooms
  // in parallel, and supports 7 args (query/type_filter/location/organizer/
  // date_from/date_to/max_price). The previous shared impl had none of
  // that — strict regression vs Vertex.
  //
  // Lifting: same scoring engine, same home_city lookup, same parallel
  // live_rooms fetch (now via SupabaseClient instead of REST).
  const query = String(args.query ?? '').trim();
  const typeFilter = String(args.type_filter ?? 'all');
  const locationFilter = String(args.location ?? '').trim();
  const organizerFilter = String(args.organizer ?? '').trim();
  const dateFrom = String(args.date_from ?? '').trim();
  const dateTo = String(args.date_to ?? '').trim();
  const maxPrice = args.max_price !== undefined ? Number(args.max_price) : undefined;

  const now = new Date().toISOString();
  const liveRoomResults: string[] = [];

  type EventRowLite = {
    id: string;
    title: string;
    description: string | null;
    start_time: string;
    end_time: string | null;
    location: string | null;
    virtual_link: string | null;
    slug: string | null;
    metadata: Record<string, unknown> | null;
  };

  let scoredResult:
    | import('./event-relevance-scoring').ScoredEventResults
    | null = null;

  const fetchPromises: Promise<void>[] = [];

  // Primary: events from global_community_events.
  if (typeFilter === 'meetup' || typeFilter === 'all') {
    fetchPromises.push(
      (async () => {
        try {
          const startGte = dateFrom ? `${dateFrom}T00:00:00Z` : now;
          let q = sb
            .from('global_community_events')
            .select('id, title, description, start_time, end_time, location, virtual_link, slug, metadata')
            .gte('start_time', startGte)
            .order('start_time', { ascending: true })
            .limit(50);
          if (dateTo) {
            q = q.lte('start_time', `${dateTo}T23:59:59Z`);
          }
          const { data: events, error } = await q;
          if (error || !events) return;

          // Optional home-city proximity boost.
          let userHomeCity: string | undefined;
          try {
            const { data: locRow } = await sb
              .from('location_preferences')
              .select('home_city')
              .eq('user_id', id.user_id)
              .maybeSingle();
            const hc = (locRow as { home_city: string | null } | null)?.home_city;
            if (hc) userHomeCity = hc;
          } catch {
            /* best-effort — proceed without proximity */
          }

          const { scoreAndRankEvents } = await import('./event-relevance-scoring');
          const filters: import('./event-relevance-scoring').EventSearchFilters = {
            query,
            location: locationFilter,
            organizer: organizerFilter,
            maxPrice,
            userHomeCity,
          };
          scoredResult = scoreAndRankEvents(
            (events as EventRowLite[] as unknown) as import('./event-relevance-scoring').EventRecord[],
            filters,
            6,
          );
        } catch {
          /* swallow — empty scoredResult means no scored output */
        }
      })(),
    );
  }

  // Secondary: live rooms (tenant-scoped).
  if ((typeFilter === 'live_room' || typeFilter === 'all') && id.tenant_id) {
    fetchPromises.push(
      (async () => {
        try {
          let q = sb
            .from('live_rooms')
            .select('id, title, starts_at, status')
            .eq('tenant_id', id.tenant_id!)
            .in('status', ['scheduled', 'live'])
            .order('starts_at', { ascending: true })
            .limit(4);
          if (query) {
            q = q.ilike('title', `%${query}%`);
          }
          const { data: rooms } = await q;
          for (const r of ((rooms as Array<{
            id: string;
            title: string;
            starts_at: string;
            status: string;
          }>) ?? [])) {
            const dateLabel = r.starts_at
              ? new Date(r.starts_at).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : 'TBD';
            const statusLabel = r.status === 'live' ? 'LIVE NOW' : dateLabel;
            liveRoomResults.push(`[Live Room] ${r.title} | ${statusLabel}`);
          }
        } catch {
          /* live_rooms may not exist in some envs; treat as empty */
        }
      })(),
    );
  }

  await Promise.allSettled(fetchPromises);

  const sr = scoredResult as
    | import('./event-relevance-scoring').ScoredEventResults
    | null;
  const hasEvents = !!(sr && (sr.best.length > 0 || sr.alternatives.length > 0));
  const hasRooms = liveRoomResults.length > 0;

  if (!hasEvents && !hasRooms) {
    return {
      ok: true,
      result: { events: [], live_rooms: [] },
      text:
        'No upcoming events found at this time. Check back soon — new events are added regularly!',
    };
  }

  let formatted = '';
  if (hasEvents) {
    const { formatForVoice } = await import('./event-relevance-scoring');
    formatted = formatForVoice(sr!);
  }
  if (hasRooms) {
    if (formatted) formatted += '\n\n';
    formatted += liveRoomResults.join('\n');
  }

  return {
    ok: true,
    result: {
      best: sr?.best ?? [],
      alternatives: sr?.alternatives ?? [],
      live_rooms: liveRoomResults,
    },
    text: formatted,
  };
}

export async function tool_search_community(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR B-8: lifted from orb-live.ts:5291 (VTID-01270A). The previous shared
  // stub queried community_groups with no tenant scope and selected only
  // (id, name, slug) — but the canonical schema has the public-listing
  // columns (topic_key, description, is_public) Vertex reads. The stub
  // also failed entirely on environments where the schema cache hadn't
  // loaded the columns. Lifting Vertex's authoritative impl: tenant-
  // scoped, public-only, OR-filter on (name|description|topic_key),
  // voice-friendly truncation at 2 KB.
  const query = String(args.query ?? '').trim();
  if (!id.tenant_id) {
    // Without a tenant_id we can't safely scope the search.
    return {
      ok: true,
      result: { groups: [] },
      text: 'Community search is unavailable for this session (no tenant context).',
    };
  }

  let q = sb
    .from('community_groups')
    .select('id, name, topic_key, description, is_public')
    .eq('tenant_id', id.tenant_id)
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .limit(8);
  if (query) {
    // Match Vertex's OR filter across name + description + topic_key.
    q = q.or(
      `name.ilike.*${query}*,description.ilike.*${query}*,topic_key.ilike.*${query}*`,
    );
  }

  const { data, error } = await q;
  if (error) {
    return {
      ok: true,
      result: { groups: [] },
      text: 'Could not search community groups at this time.',
    };
  }
  const groups =
    (data as Array<{ id: string; name: string; topic_key: string; description: string }>) ?? [];
  if (groups.length === 0) {
    return {
      ok: true,
      result: { groups: [] },
      text: 'No community groups found matching your query.',
    };
  }
  const MAX = 2000;
  let formatted = groups
    .map((g) => `${g.name} — ${(g.description || '').substring(0, 120)} | Topic: ${g.topic_key}`)
    .join('\n');
  if (formatted.length > MAX) {
    formatted = formatted.substring(0, MAX) + '\n... (truncated)';
  }
  return {
    ok: true,
    result: { groups },
    text: `Found ${groups.length} community groups:\n${formatted}`,
  };
}

export async function tool_play_music(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR D-4: lifted from orb-live.ts:5559 (VTID-01942). Vertex's auth impl
  // calls executeCapability('music.play'), records the play on the user
  // timeline (history-awareness for [RECENT] / [ACTIVITY_14D] in profiler),
  // and emits an SSE/WS directive so the orb widget opens the URL native
  // (Spotify/YouTube/Apple Music intents on iOS/Android, browser otherwise).
  //
  // The previous shared stub was a hardcoded "no provider connected" — strict
  // regression. The lift:
  //   - calls executeCapability + handles hub-miss + not-connected nudges
  //   - writes the timeline row (provider-unaware)
  //   - returns a `directive` payload in `result` that Vertex's case picks up
  //     and emits via SSE/WS. LiveKit doesn't (no SSE/WS) — the URL is in
  //     the result and a follow-up PR can publish it via LiveKit's data
  //     channel if the product wants the same auto-open behaviour there.
  const query = String(args.query ?? '').trim();
  const requestedSource = typeof args.source === 'string' ? (args.source as string).trim() : undefined;
  if (!query) {
    return { ok: false, error: 'play_music requires a "query" argument' };
  }
  try {
    const { executeCapability } = await import('../capabilities');
    const disp = (await executeCapability(
      { supabase: sb, userId: id.user_id, tenantId: id.tenant_id ?? '' },
      'music.play',
      { query, ...(requestedSource ? { source: requestedSource } : {}) },
    )) as Record<string, unknown> & {
      ok?: boolean;
      url?: string;
      raw?: Record<string, unknown>;
      error?: string;
      routing_reason?: string;
      suggest_default?: boolean;
      preference_set_method?: string;
    };

    if (!disp.ok || !disp.url) {
      const errText = String(disp.error ?? '');
      const isHubMiss = /no (music|podcast|shorts) found in the vitana media hub/i.test(errText);
      const isNotConnected = /isn't connected|requires a connected provider/i.test(errText);
      if (isHubMiss || isNotConnected) {
        const text = isHubMiss
          ? `I couldn't find "${query}" in the Vitana Media Hub. To play the real track, you'll need to link a music service like YouTube Music, Spotify, or Apple Music — want me to take you to Connected Apps?`
          : `You haven't connected that music service yet. Want me to take you to Connected Apps so you can link it?`;
        return {
          ok: true,
          result: { played: false, reason: isHubMiss ? 'hub_miss' : 'not_connected' },
          text,
        };
      }
      return { ok: false, error: errText || 'music.play returned no URL' };
    }

    const raw = (disp.raw ?? {}) as { title?: string; channel?: string; source?: string };
    const title = raw.title ?? query;
    const channel = raw.channel ?? '';
    const source = raw.source ?? 'unknown';
    const routingReason = disp.routing_reason;
    const suggestDefault = Boolean(disp.suggest_default);
    const preferenceSetMethod = disp.preference_set_method;

    const rawRec = (disp.raw ?? {}) as Record<string, unknown>;
    const androidIntent = typeof rawRec.android_intent === 'string' ? rawRec.android_intent : undefined;
    const iosScheme = typeof rawRec.ios_scheme === 'string' ? rawRec.ios_scheme : undefined;

    const directive = {
      type: 'orb_directive',
      directive: 'open_url',
      url: disp.url,
      android_intent: androidIntent,
      ios_scheme: iosScheme,
      title,
      channel,
      source,
      query,
      routing_reason: routingReason,
      suggest_default: suggestDefault,
      vtid: 'VTID-01942',
    };

    const providerDisplay =
      source === 'youtube_music' ? 'YouTube Music'
      : source === 'spotify' ? 'Spotify'
      : source === 'apple_music' ? 'Apple Music'
      : source === 'vitana_hub' ? 'the Vitana Media Hub'
      : source;

    const baseAck = channel
      ? `Now playing "${title}" by ${channel} on ${providerDisplay}.`
      : `Now playing "${title}" on ${providerDisplay}.`;

    let tail = '';
    if (routingReason === 'hub_fallback') {
      tail = ' Want me to link your Spotify or YouTube Music so I can play the real track next time?';
    } else if (suggestDefault) {
      tail = ` That's three plays in a row on ${providerDisplay} — want me to make it your default for music?`;
    } else if (routingReason === 'preference' && preferenceSetMethod === 'explicit') {
      tail = '';
    }

    // Timeline writeback (provider-unaware — both pipelines benefit).
    try {
      const { writeTimelineRow } = await import('./timeline-projector');
      writeTimelineRow({
        user_id: id.user_id,
        activity_type: 'media.music.play',
        activity_data: {
          query,
          title,
          channel,
          source,
          routing_reason: routingReason,
          url: disp.url,
        },
        context_data: { surface: 'orb' },
        dedupe_key: `media:music:${source}:${title}:${Math.floor(Date.now() / 60_000)}`,
        source: 'projector:orb',
      }).catch(() => {
        /* fire-and-forget; timeline failures shouldn't kill playback */
      });
    } catch {
      /* timeline-projector unavailable (test env); proceed */
    }

    return {
      ok: true,
      result: {
        played: true,
        url: disp.url,
        title,
        channel,
        source,
        directive, // Vertex's case picks this up and emits via SSE/WS
      },
      text: `${baseAck}${tail}`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'play_music error' };
  }
}

export async function tool_set_capability_preference(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR B-4: lifted from orb-live.ts:5572 (VTID-01942).
  // Vertex's authoritative impl: writes/clears user_capability_preferences
  // (the schema the rest of the platform reads from), not the LiveKit-only
  // user_preferences table. Both pipelines now persist preferences to the
  // same row.
  const capability = String(args.capability ?? '').trim();
  // Accept both 'connector_id' (Vertex's canonical) and 'provider' (legacy
  // LiveKit Python tool key) so call sites continue to work unchanged.
  const connectorId = String(args.connector_id ?? args.provider ?? '').trim();
  const clear = Boolean(args.clear);

  if (!capability) {
    return { ok: false, error: 'capability is required' };
  }
  if (!clear && !connectorId) {
    return { ok: false, error: 'connector_id is required unless clear=true' };
  }

  if (clear) {
    const { error } = await sb
      .from('user_capability_preferences')
      .delete()
      .eq('user_id', id.user_id)
      .eq('capability_id', capability);
    if (error) {
      return { ok: false, error: `Couldn't clear preference: ${error.message}` };
    }
    return {
      ok: true,
      result: { capability, cleared: true },
      text: `Okay — cleared your default for ${capability}. I'll ask again next time.`,
    };
  }

  const { error } = await sb.from('user_capability_preferences').upsert(
    {
      tenant_id: id.tenant_id,
      user_id: id.user_id,
      capability_id: capability,
      preferred_connector_id: connectorId,
      set_method: 'explicit',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id,user_id,capability_id' },
  );
  if (error) {
    return { ok: false, error: `Couldn't save preference: ${error.message}` };
  }

  const displayName =
    connectorId === 'google' ? 'YouTube Music'
      : connectorId === 'spotify' ? 'Spotify'
      : connectorId === 'apple_music' ? 'Apple Music'
      : connectorId === 'vitana_hub' ? 'the Vitana Media Hub'
      : connectorId;

  return {
    ok: true,
    result: { capability, connector_id: connectorId, saved: true },
    text: `Got it — ${displayName} is your default for ${capability} now.`,
  };
}

/**
 * Unified runner for capability-based tools (Gmail, Google Calendar, Google
 * Contacts). Mirrors Vertex's read_email|get_schedule|add_to_calendar|
 * find_contact case at orb-live.ts:5648 — same executeCapability call,
 * same not-connected nudge, same per-tool voice text shaping.
 *
 * Returning `text` (not just structured result) is critical: voice tools
 * pipe `text` to the LLM as the function-response, and "Found 3 emails"
 * with no titles produces effectively-silent voice. Per-tool shaping
 * lives here so both pipelines share the exact same speakable output.
 */
async function _runCapabilityTool(
  toolName: string,
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const capabilityMap: Record<string, string> = {
    read_email: 'email.read',
    get_schedule: 'calendar.list',
    add_to_calendar: 'calendar.create',
    find_contact: 'contacts.read',
  };
  const capabilityId = capabilityMap[toolName];
  if (!capabilityId) {
    return { ok: false, error: `unknown capability tool: ${toolName}` };
  }

  // Lazy-imported so the shared module doesn't pull the capabilities graph
  // when it's only being used for placeholder tools.
  const { executeCapability } = await import('../capabilities');
  const disp = (await executeCapability(
    { supabase: sb, userId: id.user_id, tenantId: id.tenant_id || '' },
    capabilityId,
    args ?? {},
  )) as Record<string, unknown> & { ok?: boolean; error?: string; raw?: Record<string, unknown> };

  if (!disp.ok) {
    const errText = String(disp.error ?? 'Capability failed');
    const notConnected = /isn't connected|requires a connected provider|No active google/i.test(errText);
    if (notConnected) {
      return {
        ok: true,
        result: { connected: false },
        text:
          `I can't check that yet — you haven't connected your Google account. ` +
          `Want me to take you to Connected Apps?`,
      };
    }
    return { ok: false, error: errText };
  }

  const raw = (disp.raw ?? {}) as Record<string, unknown>;

  if (toolName === 'read_email') {
    const messages = (raw.messages as Array<{ from: string; subject: string; snippet?: string }>) ?? [];
    if (messages.length === 0) {
      return {
        ok: true,
        result: { messages: [] },
        text: (raw.summary as string) ?? 'No unread emails.',
      };
    }
    const compact = messages
      .slice(0, 5)
      .map((m) => {
        const fromName = m.from.replace(/<[^>]+>/, '').trim() || m.from;
        return `from ${fromName}, subject "${m.subject}"`;
      })
      .join('; ');
    return {
      ok: true,
      result: { messages },
      text: `${(raw.summary as string) ?? ''} ${compact}. Want me to read any in detail?`.trim(),
    };
  }

  if (toolName === 'get_schedule') {
    const events =
      (raw.events as Array<{
        summary: string;
        start: string;
        all_day?: boolean;
        location?: string;
      }>) ?? [];
    if (events.length === 0) {
      return {
        ok: true,
        result: { events: [] },
        text: (raw.summary as string) ?? 'Nothing on your calendar.',
      };
    }
    const lines = events
      .slice(0, 8)
      .map((ev) => {
        const when = ev.all_day
          ? 'all day'
          : ev.start
            ? new Date(ev.start).toLocaleString('en-US', {
                weekday: 'short',
                hour: 'numeric',
                minute: '2-digit',
                month: 'short',
                day: 'numeric',
              })
            : '';
        const loc = ev.location ? ` (${ev.location})` : '';
        return `${when}: ${ev.summary}${loc}`;
      })
      .join('; ');
    return {
      ok: true,
      result: { events },
      text: `${(raw.summary as string) ?? ''} ${lines}.`.trim(),
    };
  }

  if (toolName === 'add_to_calendar') {
    const title = (raw.summary as string) ?? (args.title as string) ?? 'the event';
    const start = (raw.start as string) ?? '';
    const when = start
      ? new Date(start).toLocaleString('en-US', {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
          month: 'short',
          day: 'numeric',
        })
      : '';
    return {
      ok: true,
      result: { added: true, title, start },
      text: `Added — ${title}${when ? ' at ' + when : ''}.`,
    };
  }

  if (toolName === 'find_contact') {
    const contacts = (raw.contacts as Array<{ name: string; emails: string[]; phones: string[] }>) ?? [];
    if (contacts.length === 0) {
      // VTID-LIVEKIT-FALLBACK: when Google Contacts has no match, fall back to
      // memory_facts so users without an integration still get answers from
      // their personal memory.
      const query = String(args.query ?? '').trim();
      if (query) {
        const { data: facts } = await sb
          .from('memory_facts')
          .select('fact_key, fact_value, entity')
          .eq('user_id', id.user_id)
          .like('fact_key', '%_name')
          .ilike('fact_value', `%${query}%`)
          .is('superseded_by', null)
          .limit(10);
        const matches = (facts || []).map((f) => ({
          name: f.fact_value,
          relation: f.fact_key.replace(/_name$/, ''),
          scope: f.entity,
        }));
        if (matches.length > 0) {
          return {
            ok: true,
            result: { contacts: matches, source: 'memory_facts' },
            text: `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} in your memory.`,
          };
        }
      }
      return {
        ok: true,
        result: { contacts: [] },
        text: (raw.summary as string) ?? 'No contacts matched.',
      };
    }
    if (contacts.length > 5) {
      const names = contacts
        .slice(0, 5)
        .map((c) => c.name)
        .filter(Boolean)
        .join(', ');
      return {
        ok: true,
        result: { contacts },
        text: `Found ${contacts.length} matches: ${names}, and more. Which one?`,
      };
    }
    const spoken = contacts
      .map((c) => {
        const bits: string[] = [];
        if (c.emails?.[0]) bits.push(`email ${c.emails[0]}`);
        if (c.phones?.[0]) bits.push(`phone ${c.phones[0]}`);
        return `${c.name || 'Unknown'}${bits.length ? ' — ' + bits.join(', ') : ''}`;
      })
      .join('; ');
    return { ok: true, result: { contacts }, text: spoken };
  }

  return { ok: false, error: `unhandled capability tool: ${toolName}` };
}

export async function tool_read_email(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  return _runCapabilityTool('read_email', args, id, sb);
}

export async function tool_get_schedule(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  return _runCapabilityTool('get_schedule', args, id, sb);
}

export async function tool_add_to_calendar(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  return _runCapabilityTool('add_to_calendar', args, id, sb);
}

export async function tool_find_contact(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  return _runCapabilityTool('find_contact', args, id, sb);
}

export async function tool_consult_external_ai(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR D-2: lifted from orb-live.ts:5800 (BOOTSTRAP-ORB-DELEGATION-ROUTE).
  // Vertex's auth impl calls the canonical executeDelegation pipeline which
  // resolves the user's connected external-AI provider, enforces budget
  // caps, calls the provider with their credentials, and returns
  // adapted-for-voice text. The previous shared stub was a hardcoded
  // "you don't have an external AI" placeholder — strict regression.
  if (!id.user_id) {
    return {
      ok: true,
      result: { reason: 'no_session' },
      text: 'External AI consultation requires a signed-in session. I\'ll answer this one myself.',
    };
  }
  const question = String(args.question ?? '').trim();
  if (!question) {
    return { ok: false, error: 'consult_external_ai requires a non-empty question.' };
  }
  const providerHint = typeof args.provider_hint === 'string'
    ? (args.provider_hint as 'chatgpt' | 'claude' | 'google-ai')
    : undefined;

  try {
    const { executeDelegation, adaptForDelivery } = await import('../orb/delegation');
    const taskClass = typeof args.task_class === 'string'
      ? (args.task_class as import('../orb/delegation').DelegationStrength)
      : undefined;

    const startedAt = id.session_started_iso ? new Date(id.session_started_iso).getTime() : Date.now();

    const outcome = await executeDelegation({
      userId: id.user_id,
      tenantId: id.tenant_id ?? '',
      sessionId: id.session_id ?? `${id.user_id}:consult_external_ai`,
      question,
      taskClass,
      providerHint,
      privacyLevel: 'public',
      lang: id.lang ?? 'en',
      startedAt,
    });

    if (!outcome.ok) {
      // Graceful user-facing copy by failure reason, mirroring Vertex.
      const reason = outcome.failure.reason;
      let text = `That external AI isn't reachable right now, so I'll answer this myself.`;
      if (reason === 'no_providers_connected' || reason === 'no_credentials') {
        text = "You haven't connected an external AI yet, so I'll answer this one myself.";
      } else if (reason === 'budget_cap_exceeded') {
        text = `You've reached this month's spending cap for that AI, so I'll answer this myself.`;
      } else if (reason === 'provider_timeout') {
        text = `That AI is taking too long to respond. Let me answer instead.`;
      }
      return { ok: true, result: { reason }, text };
    }

    const voiceText = adaptForDelivery(outcome.result, 'voice');
    return {
      ok: true,
      result: {
        provider: outcome.result.providerId,
        model: outcome.result.model,
        usage: outcome.result.usage,
        latency_ms: outcome.result.latencyMs,
      },
      text: voiceText,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'consult_external_ai error' };
  }
}

export async function tool_create_index_improvement_plan(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR B-9: lifted from orb-live.ts:5800. Vertex's auth impl actually
  // creates calendar events for the plan, falls back to PILLAR_ACTION_TEMPLATES
  // when the autopilot queue is empty (R4 failure mode), and tags events
  // with proper wellness_tags + source_ref_type. The previous shared stub
  // just returned a list of recommendations and told the user to activate
  // them manually — never wrote to the calendar. LiveKit users got an
  // unactionable plan.
  try {
    const { PILLAR_TAGS, PILLAR_ACTION_TEMPLATES } = await import('../lib/vitana-pillars');
    const { createCalendarEvent } = await import('./calendar-service');

    let pillar: string | undefined = resolvePillarKey(args.pillar as string | undefined);
    if (!pillar) {
      const snap = await fetchVitanaIndexForProfiler(sb, id.user_id);
      pillar = snap?.weakest_pillar?.name;
    }
    if (!pillar) {
      return {
        ok: true,
        result: { ok: false, reason: 'no_index_data' },
        text:
          "I don't see Index data for this user yet, so I can't build a plan. " +
          "Complete the 5-question baseline survey first.",
      };
    }

    const days = typeof args.days === 'number' ? Math.min(90, Math.max(7, args.days)) : 14;
    const perWeek =
      typeof args.actions_per_week === 'number'
        ? Math.min(7, Math.max(1, args.actions_per_week))
        : 3;

    const { data } = await sb
      .from('autopilot_recommendations')
      .select('id, title, action_description, contribution_vector, priority')
      .eq('user_id', id.user_id)
      .in('status', ['pending', 'new', 'snoozed'])
      .not('contribution_vector', 'is', null)
      .order('priority', { ascending: false })
      .limit(50);

    const ranked = (data || [])
      .map((r: Record<string, unknown>) => {
        const cv = (r.contribution_vector as Record<string, number> | null) ?? {};
        const lift = typeof cv[pillar!] === 'number' ? cv[pillar!] : 0;
        return { ...r, _lift: lift };
      })
      .filter((r: { _lift: number }) => r._lift > 0)
      .sort((a: { _lift: number }, b: { _lift: number }) => b._lift - a._lift);

    type PlanItem = {
      title: string;
      description: string;
      source: 'autopilot' | 'template';
      source_ref_id: string | null;
    };
    const source: PlanItem[] =
      ranked.length > 0
        ? ranked.map((r): PlanItem => ({
            title: String((r as Record<string, unknown>).title ?? ''),
            description: String((r as Record<string, unknown>).action_description ?? ''),
            source: 'autopilot',
            source_ref_id: String((r as Record<string, unknown>).id ?? ''),
          }))
        : (
            PILLAR_ACTION_TEMPLATES[pillar as keyof typeof PILLAR_ACTION_TEMPLATES] ?? []
          ).map((t): PlanItem => ({
            title: t.title,
            description: t.description,
            source: 'template',
            source_ref_id: null,
          }));

    if (source.length === 0) {
      return {
        ok: true,
        result: { ok: false, reason: 'no_actions' },
        text: `I can't find any actions for the ${pillar} pillar right now — neither pending autopilot suggestions nor templates. This is unexpected; please report.`,
      };
    }

    const weeks = Math.ceil(days / 7);
    const totalEvents = weeks * perWeek;
    const scheduled: { title: string; start_time: string; source: string }[] = [];
    const startOfToday = new Date();
    startOfToday.setHours(10, 0, 0, 0);
    startOfToday.setDate(startOfToday.getDate() + 1); // start tomorrow

    const tags = PILLAR_TAGS[pillar as keyof typeof PILLAR_TAGS];
    const wellnessTags: string[] = tags ? [...tags] : [pillar!];

    for (let i = 0; i < totalEvents; i++) {
      const item = source[i % source.length];
      const eventDate = new Date(startOfToday);
      eventDate.setDate(eventDate.getDate() + Math.floor((i * 7) / perWeek));
      if (eventDate.getTime() > Date.now() + days * 24 * 60 * 60 * 1000) break;
      const startIso = eventDate.toISOString();
      const endIso = new Date(eventDate.getTime() + 30 * 60 * 1000).toISOString();

      try {
        const evt = await createCalendarEvent(id.user_id, {
          title: item.title,
          start_time: startIso,
          end_time: endIso,
          description: `${item.description}\n\nPart of your Vitana Index improvement plan (target: ${pillar}).`.trim(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          event_type: 'health' as any,
          status: 'confirmed',
          priority: 'medium',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          role_context: ((id.role || 'community') as any),
          source_type: 'assistant',
          source_ref_type:
            item.source === 'autopilot' ? 'autopilot_recommendation' : 'pillar_template',
          source_ref_id: item.source_ref_id ?? undefined,
          priority_score: 60,
          wellness_tags: wellnessTags,
          metadata: {
            created_via: 'orb_voice',
            plan: 'index_improvement',
            target_pillar: pillar,
            plan_source: item.source,
          },
          is_recurring: false,
        });
        if (evt) {
          scheduled.push({ title: evt.title, start_time: evt.start_time, source: item.source });
        }
      } catch {
        /* per-event failures swallowed; reported as count-mismatch in result */
      }
    }

    if (scheduled.length === 0) {
      return { ok: false, error: 'No events could be scheduled (calendar write failed).' };
    }

    const payload = {
      pillar,
      days,
      actions_per_week: perWeek,
      scheduled_count: scheduled.length,
      source_mix: {
        autopilot: scheduled.filter((s) => s.source === 'autopilot').length,
        template: scheduled.filter((s) => s.source === 'template').length,
      },
      first_event: scheduled[0],
      last_event: scheduled[scheduled.length - 1],
      all_titles: scheduled.map((s) => s.title),
    };
    return {
      ok: true,
      result: payload,
      text: `Scheduled ${scheduled.length} ${pillar} actions on your calendar over the next ${days} days.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'create_index_improvement_plan error' };
  }
}

export async function tool_ask_pillar_agent(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR B-8: lifted from orb-live.ts:6225. Vertex calls the real
  // pillar-agents/router service (askPillarAgent) which routes by pillar
  // intent + returns answer text + citations + structured data. The
  // previous shared stub just surfaced raw subscores with a note saying
  // "lightweight mode" — a strict regression vs Vertex.
  const question = typeof args.question === 'string' ? (args.question as string).trim() : '';
  if (!question) {
    return { ok: false, error: 'question is required' };
  }
  // resolvePillarKey silently translates retired aliases; undefined =
  // no explicit pillar passed, let the router auto-detect.
  const explicit = resolvePillarKey(args.pillar as string | undefined);
  try {
    const { askPillarAgent } = await import('./pillar-agents/router');
    const answer = await askPillarAgent(sb, id.user_id, question, explicit);
    if (!answer) {
      const payload = {
        routed: false as const,
        reason: 'no_pillar_detected_or_agent_unavailable',
        guidance: 'Voice should fall back to search_knowledge against the Book of the Vitana Index.',
      };
      return { ok: true, result: payload, text: JSON.stringify(payload) };
    }
    const payload = {
      routed: true as const,
      pillar: answer.pillar,
      text: answer.text,
      citations: answer.citations,
      data: answer.data,
      agent_version: answer.agent_version,
    };
    return { ok: true, result: payload, text: answer.text || JSON.stringify(payload) };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'ask_pillar_agent error' };
  }
}

export async function tool_explain_feature(args: OrbToolArgs): Promise<OrbToolResult> {
  // Accept either `topic` (Vertex's canonical key) or legacy `feature`.
  // Both pipelines must work — the LiveKit Python tool sends `feature`, the
  // Vertex-side function-tool schema declares `topic`.
  const topic = String(args.topic ?? args.feature ?? '').trim();
  if (!topic) {
    return { ok: false, error: 'topic is required' };
  }
  const mode = args.mode === 'teach_only' || args.mode === 'teach_then_nav'
    ? (args.mode as 'teach_only' | 'teach_then_nav')
    : 'teach_then_nav';

  const { explainFeature } = await import('./explain-feature-service');
  const result = explainFeature(topic);

  if (!result.found) {
    // Vertex's not-found path returns guidance text steering voice to
    // search_knowledge with KB instructions. Mirror that exactly so both
    // pipelines produce identical fallback behaviour.
    const payload = {
      found: false as const,
      reason: result.reason ?? 'no_pattern_match',
      guidance:
        'Voice should fall back to search_knowledge. Search the Maxina ' +
        'Instruction Manual (kb/instruction-manual/maxina/*) first — it covers ' +
        'every concept and screen with fixed sections (What it is / Why it ' +
        'matters / Where to find it / What you see / How to use it). The ' +
        'kb/vitana-system/how-to/ corpus is supporting material.',
    };
    return {
      ok: true,
      result: payload,
      // Vertex returned JSON.stringify(payload) as `result` (string). For voice
      // it doesn't actually speak this — the LLM sees the structured fall-back
      // signal and chooses the next tool. dispatchOrbToolForVertex will
      // stringify the structured result for Vertex callers.
      text: '',
    };
  }

  const payload = {
    found: true as const,
    mode,
    topic_canonical: result.topic_canonical,
    pillar_lift: result.pillar_lift,
    summary_voice_en: result.summary_voice_en,
    summary_voice_de: result.summary_voice_de,
    steps_voice_en: result.steps_voice_en,
    steps_voice_de: result.steps_voice_de,
    redirect_route: result.redirect_route,
    redirect_offer_en: result.redirect_offer_en,
    redirect_offer_de: result.redirect_offer_de,
    citation: result.citation,
  };
  return { ok: true, result: payload, text: '' };
}

export async function tool_resolve_recipient(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR B-6: lifted from orb-live.ts:6340 (VTID-01967). The shared stub did
  // a naive ilike; Vertex calls the canonical Supabase RPC
  // resolve_recipient_candidates which scopes to the actor's tenant + same-
  // user filter and returns scored candidates with a `reason`. That RPC is
  // also what the rest of the platform uses for messaging, so unifying here
  // keeps "resolve who the user means" identical across surfaces.
  const spoken = String(args.spoken_name ?? args.name ?? '').trim();
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
  if (!spoken) {
    return { ok: false, error: 'spoken_name is required' };
  }
  const { data, error } = await sb.rpc('resolve_recipient_candidates', {
    p_actor: id.user_id,
    p_token: spoken,
    p_limit: limit,
    p_global: false,
  });
  if (error) {
    return { ok: false, error: error.message };
  }
  const candidates = (data || []) as Array<{
    user_id: string;
    vitana_id: string | null;
    display_name: string | null;
    score: number;
    reason: string;
  }>;
  const top_confidence = candidates.length > 0 ? Number(candidates[0].score) : 0;
  const ambiguous =
    candidates.length === 0 ||
    top_confidence < 0.85 ||
    (candidates.length > 1 &&
      Number(candidates[1].score) / Math.max(top_confidence, 0.0001) > 0.85);

  let text: string;
  if (candidates.length === 0) {
    text = `No one named "${spoken}" is in the community right now — they may not have a Vitana account yet.`;
  } else if (ambiguous) {
    const names = candidates
      .slice(0, 3)
      .map((c) => c.display_name || c.vitana_id || c.user_id)
      .join(', ');
    text = `Found ${candidates.length} possible matches: ${names}. Which one did you mean?`;
  } else {
    const top = candidates[0];
    text = `Best match: ${top.display_name || top.vitana_id || top.user_id} (confidence ${(top_confidence * 100).toFixed(0)}%).`;
  }

  return {
    ok: true,
    result: { candidates, top_confidence, ambiguous },
    text,
  };
}

export async function tool_send_chat_message(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR B-6: lifted from orb-live.ts:6388 (VTID-01967). Vertex's auth impl
  // wrote to the canonical chat_messages table with a quota guard,
  // vitana_id resolution, and a self-message guard. The previous shared
  // stub wrote to a 'messages' table that does not exist in the canonical
  // schema, so any LiveKit-sent message was silently dropped.
  // Accepts both Vertex args (recipient_user_id, body, recipient_label) and
  // legacy LiveKit (recipient_id, body_text).
  const recipientUserId = String(args.recipient_user_id ?? args.recipient_id ?? '').trim();
  const recipientLabel = String(args.recipient_label ?? '').trim();
  const body = String(args.body ?? args.body_text ?? '').trim();

  if (!recipientUserId || !body) {
    return { ok: false, error: 'recipient_user_id and body are required' };
  }
  if (recipientUserId === id.user_id) {
    return { ok: false, error: 'cannot message yourself' };
  }

  try {
    const { checkVoiceSendQuota } = await import('./voice-message-guard');
    const { resolveVitanaId } = await import('../middleware/auth-supabase-jwt');

    const recipientVitanaId = await resolveVitanaId(recipientUserId);
    const quota = await checkVoiceSendQuota({
      session_id: `${id.user_id}:send_chat_message`,
      actor_id: id.user_id,
      vitana_id: id.vitana_id ?? null,
      recipient_user_id: recipientUserId,
      recipient_vitana_id: recipientVitanaId,
      kind: 'message',
      body_length: body.length,
    });
    if (!quota.allowed) {
      return {
        ok: true,
        result: { rate_limited: true, reason: quota.reason },
        text: `Couldn't send (${quota.reason ?? 'rate-limited'}). Try again in a bit.`,
      };
    }

    const senderVitanaId = id.vitana_id ?? (await resolveVitanaId(id.user_id));
    const { error: insErr } = await sb.from('chat_messages').insert({
      tenant_id: id.tenant_id,
      sender_id: id.user_id,
      receiver_id: recipientUserId,
      content: body,
      ...(senderVitanaId && { sender_vitana_id: senderVitanaId }),
      ...(recipientVitanaId && { receiver_vitana_id: recipientVitanaId }),
      metadata: {
        source: 'voice',
        session_id: `${id.user_id}:send_chat_message`,
        recipient_label: recipientLabel || recipientVitanaId,
      },
    });
    if (insErr) {
      return { ok: false, error: insErr.message };
    }
    const recipDisplay = recipientLabel || recipientVitanaId || recipientUserId;
    return {
      ok: true,
      result: {
        recipient_label: recipDisplay,
        remaining: quota.remaining,
      },
      text: `Sent to ${recipDisplay}.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'send_chat_message error';
    return { ok: false, error: msg };
  }
}

export async function tool_share_link(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR B-5: lifted from orb-live.ts:6536 (VTID-01967). Both pipelines now
  // share rate-limited link sharing through chat_messages with the same
  // self-share guard, voice-send quota check, and metadata shape.
  // Accepts the legacy LiveKit args (url, with_recipient) AND Vertex args
  // (target_url, recipient_user_id, recipient_label, target_kind).
  const recipientUserId = String(args.recipient_user_id ?? args.with_recipient ?? '').trim();
  const recipientLabel = String(args.recipient_label ?? '').trim();
  const targetUrl = String(args.target_url ?? args.url ?? '').trim();
  const targetKind = String(args.target_kind ?? 'page').trim();

  if (!recipientUserId || !targetUrl) {
    return { ok: false, error: 'recipient_user_id and target_url are required' };
  }
  if (recipientUserId === id.user_id) {
    return { ok: false, error: 'cannot share with yourself' };
  }

  try {
    const { checkVoiceSendQuota } = await import('./voice-message-guard');
    const { resolveVitanaId } = await import('../middleware/auth-supabase-jwt');

    const recipientVitanaId = await resolveVitanaId(recipientUserId);

    const quota = await checkVoiceSendQuota({
      // session_id is Vertex-specific; pass user_id so the quota guard can
      // still scope per-user when called from LiveKit (which has no
      // long-lived WebSocket sessionId).
      session_id: `${id.user_id}:share_link`,
      actor_id: id.user_id,
      vitana_id: id.vitana_id ?? null,
      recipient_user_id: recipientUserId,
      recipient_vitana_id: recipientVitanaId,
      kind: 'share_link',
      target_url: targetUrl,
    });
    if (!quota.allowed) {
      return {
        ok: true,
        result: { rate_limited: true, reason: quota.reason },
        text: `I can't send that right now (${quota.reason ?? 'rate-limited'}). Try again in a bit.`,
      };
    }

    const senderVitanaId =
      id.vitana_id ?? (await resolveVitanaId(id.user_id));
    const previewBody = `🔗 ${targetUrl}`;

    const { error: insErr } = await sb.from('chat_messages').insert({
      tenant_id: id.tenant_id,
      sender_id: id.user_id,
      receiver_id: recipientUserId,
      content: previewBody,
      message_type: 'link_share',
      ...(senderVitanaId && { sender_vitana_id: senderVitanaId }),
      ...(recipientVitanaId && { receiver_vitana_id: recipientVitanaId }),
      metadata: {
        source: 'voice',
        session_id: `${id.user_id}:share_link`,
        kind: 'shared_link',
        target_url: targetUrl,
        target_kind: targetKind,
        recipient_label: recipientLabel || recipientVitanaId,
      },
    });
    if (insErr) {
      return { ok: false, error: insErr.message };
    }

    const recipDisplay = recipientLabel || recipientVitanaId || recipientUserId;
    return {
      ok: true,
      result: {
        recipient_label: recipDisplay,
        target_kind: targetKind,
        remaining: quota.remaining,
      },
      text: `Sent the link to ${recipDisplay}.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'share_link error';
    return { ok: false, error: msg };
  }
}

export async function tool_scan_existing_matches(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR B-7: lifted from orb-live.ts:7004 (VTID-DANCE-D11.B). Vertex called
  // the canonical /api/v1/intent-scan internal endpoint with the user's
  // JWT — that endpoint enforces tier limits + matchmaker rate caps. The
  // previous shared stub queried the `intents` table directly with no
  // tier check, no scoring, just raw open-intent count.
  const intentKind = String(args.intent_kind ?? '').trim();
  if (!intentKind) {
    return { ok: false, error: 'intent_kind is required' };
  }
  if (!id.user_jwt) {
    return { ok: false, error: 'scan_existing_matches requires user_jwt; call from an authenticated session' };
  }
  const params = new URLSearchParams({ intent_kind: intentKind });
  if (args.category_prefix) params.set('category_prefix', String(args.category_prefix));
  if (args.variety) params.set('variety', String(args.variety));

  try {
    const url = `${process.env.GATEWAY_INTERNAL_URL || 'http://localhost:8080'}/api/v1/intent-scan?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${id.user_jwt}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: (data as { error?: string }).error || 'scan_failed' };
    }
    return { ok: true, result: data, text: JSON.stringify(data) };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'scan_existing_matches error' };
  }
}

export async function tool_share_intent_post(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR B-7: lifted from orb-live.ts:6940 (VTID-DANCE-D10). Vertex's auth
  // impl is a 2-stage flow (read-back → confirm) that POSTs to the
  // canonical /api/v1/intents/:id/share endpoint with the user's JWT.
  // The previous shared stub just sent a chat message with the raw URL —
  // no tier check, no notification handling, no recipient validation
  // beyond regex.
  const intentId = String(args.intent_id ?? '').trim();
  const recipients = Array.isArray(args.recipient_vitana_ids)
    ? (args.recipient_vitana_ids as unknown[])
        .map((r) => String(r ?? '').trim().replace(/^@/, '').toLowerCase())
        .filter((r) => /^[a-z][a-z0-9]{3,15}$/.test(r))
    : [];
  const note = typeof args.note === 'string' ? (args.note as string).slice(0, 280) : null;
  const confirmed = Boolean(args.confirmed);

  if (!intentId) return { ok: false, error: 'intent_id is required' };
  if (recipients.length === 0) {
    return { ok: false, error: 'recipient_vitana_ids must include at least one valid id' };
  }

  // Stage 1 — read-back without dispatching.
  if (!confirmed) {
    const payload = {
      ok: true,
      stage: 'confirmation' as const,
      intent_id: intentId,
      recipients,
      note,
      instructions: `Read back the recipients (@${recipients.join(', @')}) and ask the user to confirm. Then call share_intent_post again with confirmed=true.`,
    };
    return { ok: true, result: payload, text: JSON.stringify(payload) };
  }

  if (!id.user_jwt) {
    return { ok: false, error: 'share_intent_post requires user_jwt; call from an authenticated session' };
  }

  try {
    const url = `${process.env.GATEWAY_INTERNAL_URL || 'http://localhost:8080'}/api/v1/intents/${encodeURIComponent(intentId)}/share`;
    const fetchRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${id.user_jwt}`,
      },
      body: JSON.stringify({
        recipient_vitana_ids: recipients,
        note: note || undefined,
        channel: 'in_app',
      }),
    });
    const data = await fetchRes.json().catch(() => ({}));
    if (!fetchRes.ok) {
      return { ok: false, error: (data as { error?: string }).error || 'share_failed' };
    }
    return { ok: true, result: data, text: JSON.stringify(data) };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'share_intent_post error' };
  }
}

export async function tool_respond_to_match(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  // PR B-7: lifted from orb-live.ts:6855 (VTID-01975). Vertex's auth impl:
  //   - 2-stage confirmation
  //   - Resolves intent A vs B owner so the right state field is set
  //   - Computes mutual_interest unlock when both parties have responded
  //   - Calls tryUnlockReveal + notifyMutualInterest on mutual interest
  // The previous shared stub naively wrote `state = response` with no owner
  // resolution and no notification — every voice response that should have
  // unlocked mutual_interest stayed stuck in *_responded_by_X state.
  const matchId = String(args.match_id ?? '').trim();
  const response = String(args.response ?? '').trim() as 'express_interest' | 'decline';
  const confirmed = args.confirmed === true;

  if (!matchId || !['express_interest', 'decline'].includes(response)) {
    return {
      ok: false,
      error: 'match_id and response (express_interest|decline) required',
    };
  }
  if (!confirmed) {
    const payload = {
      ok: true,
      stage: 'awaiting_confirmation',
      instructions: `Confirm with the user before calling respond_to_match again with confirmed=true.`,
    };
    return { ok: true, result: payload, text: JSON.stringify(payload) };
  }

  try {
    const { data: m } = await sb
      .from('intent_matches')
      .select('match_id, intent_a_id, intent_b_id, state, kind_pairing')
      .eq('match_id', matchId)
      .maybeSingle();
    if (!m) return { ok: false, error: 'match_not_found' };

    const { data: aOwner } = await sb
      .from('user_intents')
      .select('requester_user_id')
      .eq('intent_id', (m as { intent_a_id: string }).intent_a_id)
      .maybeSingle();
    const isA =
      aOwner && (aOwner as { requester_user_id: string }).requester_user_id === id.user_id;
    const stateField =
      response === 'express_interest'
        ? isA
          ? 'responded_by_a'
          : 'responded_by_b'
        : 'declined';

    let nextState: string = stateField;
    if (response === 'express_interest') {
      const curState = (m as { state: string }).state;
      if (curState === 'responded_by_b' && stateField === 'responded_by_a') nextState = 'mutual_interest';
      if (curState === 'responded_by_a' && stateField === 'responded_by_b') nextState = 'mutual_interest';
    }

    await sb.from('intent_matches').update({ state: nextState }).eq('match_id', matchId);

    if (nextState === 'mutual_interest') {
      const { tryUnlockReveal } = await import('./intent-mutual-reveal');
      const { notifyMutualInterest } = await import('./intent-notifier');
      await tryUnlockReveal(matchId);
      await notifyMutualInterest(matchId);
    }

    const payload = {
      ok: true,
      stage: 'updated',
      state: nextState,
      mutual_interest_unlocked: nextState === 'mutual_interest',
    };
    return {
      ok: true,
      result: payload,
      text: JSON.stringify(payload),
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'respond_to_match error' };
  }
}

/**
 * PR 1.B-5: lifts orb-live.ts:handleNavigateToScreen's 7 gates into the
 * shared dispatcher so LiveKit's tool_navigate_to_screen enforces the
 * same robustness Vertex has today.
 *
 * Gates:
 *   1. Anonymous gate — refuses non-anonymous_safe screens for anonymous
 *      sessions. error_kind='auth_required'.
 *   2. Viewport gate (VTID-02789) — refuses mobile-only screens on
 *      desktop and desktop-only on mobile. error_kind='wrong_viewport'.
 *   3. Mobile_route override — when session is mobile AND the entry has
 *      a mobile_route, use it instead of route.
 *   4. Already-there dedup — skips when current_route already matches
 *      the resolved base path (overlay entries always pass).
 *   5. OASIS error_kind events — every rejection emits orb.navigator.blocked
 *      with a typed error_kind so admins can debug specific failure modes.
 *   6. Identity threading — is_anonymous + is_mobile read from
 *      OrbToolIdentity; current_route + recent_routes from args (consistent
 *      with the get_current_screen / navigate convention).
 *   7. Returns the directive payload — Vertex post-processes it for SSE/WS
 *      session-state mutations; LiveKit's wrapper publishes via the data
 *      channel.
 */
export async function tool_navigate_to_screen(
  args: OrbToolArgs,
  id: OrbToolIdentity,
): Promise<OrbToolResult> {
  const screenIdArg = String(args.screen_id ?? args.target ?? '').trim();
  if (!screenIdArg) return { ok: false, error: 'screen_id (or legacy target) is required' };

  // Identity facts (with args fallback for the LiveKit Python wrapper that
  // sends them in the body alongside current_route).
  const isAnon = (typeof args.is_anonymous === 'boolean' ? args.is_anonymous : id.is_anonymous)
    ?? !id.user_id;
  const isMobile = (typeof args.is_mobile === 'boolean' ? args.is_mobile : id.is_mobile) ?? false;
  const currentRoute = typeof args.current_route === 'string' && args.current_route.length > 0
    ? args.current_route
    : null;
  const lang = (id.lang || 'en') as string;
  const sessionId = id.session_id || null;

  const { emitOasisEvent } = await import('./oasis-event-service');

  // Three-tier resolution: exact → alias → fuzzy.
  let entry: NavCatalogEntry | null = lookupScreen(screenIdArg) || lookupByAlias(screenIdArg);
  if (!entry) {
    const similar = suggestSimilar(screenIdArg, 1);
    if (similar.length > 0) {
      entry = similar[0];
      emitOasisEvent({
        vtid: 'VTID-NAV-01',
        type: 'orb.navigator.blocked',
        source: 'orb-tools-shared',
        status: 'info',
        message: `Fuzzy-resolved screen_id '${screenIdArg}' → '${entry.screen_id}'`,
        payload: {
          session_id: sessionId,
          attempted_screen_id: screenIdArg,
          resolved_screen_id: entry.screen_id,
          error_kind: 'fuzzy_resolved',
        },
      }).catch(() => {});
    }
  }
  if (!entry) {
    emitOasisEvent({
      vtid: 'VTID-NAV-01',
      type: 'orb.navigator.blocked',
      source: 'orb-tools-shared',
      status: 'warning',
      message: `Unknown screen_id '${screenIdArg}' — no suggestions`,
      payload: {
        session_id: sessionId,
        attempted_screen_id: screenIdArg,
        error_kind: 'unknown',
        suggestions: [],
      },
    }).catch(() => {});
    return {
      ok: false,
      error: `Unknown screen_id '${screenIdArg}'. No matching screens found in the catalog.`,
    };
  }

  // GATE 1: anonymous_safe.
  if (isAnon && !entry.anonymous_safe) {
    emitOasisEvent({
      vtid: 'VTID-NAV-01',
      type: 'orb.navigator.blocked',
      source: 'orb-tools-shared',
      status: 'warning',
      message: `Screen '${screenIdArg}' requires authentication`,
      payload: {
        session_id: sessionId,
        attempted_screen_id: screenIdArg,
        error_kind: 'auth_required',
      },
    }).catch(() => {});
    return {
      ok: false,
      error: `Screen '${screenIdArg}' requires the user to be signed in. Tell them briefly and offer to take them to registration instead.`,
    };
  }

  // GATE 2: viewport (VTID-02789).
  if (entry.viewport_only) {
    const sessionViewport: 'mobile' | 'desktop' = isMobile ? 'mobile' : 'desktop';
    if (entry.viewport_only !== sessionViewport) {
      emitOasisEvent({
        vtid: 'VTID-02789',
        type: 'orb.navigator.blocked',
        source: 'orb-tools-shared',
        status: 'warning',
        message: `Screen '${entry.screen_id}' is ${entry.viewport_only}-only; session is ${sessionViewport}`,
        payload: {
          session_id: sessionId,
          attempted_screen_id: screenIdArg,
          error_kind: 'wrong_viewport',
          required_viewport: entry.viewport_only,
          session_viewport: sessionViewport,
        },
      }).catch(() => {});
      return {
        ok: false,
        error: `Screen '${entry.screen_id}' is only available on ${entry.viewport_only}. Suggest a different screen or stay in voice.`,
      };
    }
  }

  // GATE 3: mobile_route override (VTID-02789).
  const baseRoute = (isMobile && entry.mobile_route) ? entry.mobile_route : entry.route;

  // Param substitution.
  const missing: string[] = [];
  let resolvedRoute = baseRoute.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => {
    const v = args[name];
    if (v === undefined || v === null || String(v).trim() === '') {
      missing.push(String(name));
      return ':' + String(name);
    }
    return encodeURIComponent(String(v).trim().replace(/^@/, ''));
  });
  if (missing.length > 0) {
    emitOasisEvent({
      vtid: 'VTID-NAV-01',
      type: 'orb.navigator.blocked',
      source: 'orb-tools-shared',
      status: 'warning',
      message: `Missing route param(s) for ${entry.screen_id}: ${missing.join(', ')}`,
      payload: {
        session_id: sessionId,
        attempted_screen_id: screenIdArg,
        error_kind: 'missing_param',
        missing_params: missing,
      },
    }).catch(() => {});
    return {
      ok: false,
      error: `Cannot navigate to ${entry.screen_id}: missing required parameter(s) ${missing.join(', ')}. Ask the user to provide them, then call navigate_to_screen again.`,
    };
  }

  // Overlay query-marker append.
  if (entry.entry_kind === 'overlay' && entry.overlay) {
    const sep = resolvedRoute.includes('?') ? '&' : '?';
    const params = new URLSearchParams();
    params.set('open', entry.overlay.query_marker);
    const needs = entry.overlay.needs_param;
    if (needs) {
      const v = args[needs];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        params.set(needs, String(v).trim().replace(/^@/, ''));
      }
    }
    resolvedRoute = `${resolvedRoute}${sep}${params.toString()}`;
  }

  // GATE 4: already-there dedup. Compare to the resolved BASE path
  // (mobile_route or route, no querystring) — same as Vertex line 4208.
  const baseRoutePath = baseRoute.split('?')[0];
  if (currentRoute && currentRoute === baseRoutePath && entry.entry_kind !== 'overlay') {
    emitOasisEvent({
      vtid: 'VTID-NAV-01',
      type: 'orb.navigator.blocked',
      source: 'orb-tools-shared',
      status: 'info',
      message: `User is already on ${baseRoutePath}`,
      payload: {
        session_id: sessionId,
        attempted_screen_id: screenIdArg,
        error_kind: 'already_there',
      },
    }).catch(() => {});
    return {
      ok: true,
      result: {
        screen_id: entry.screen_id,
        route: entry.route,
        already_there: true,
        entry_kind: entry.entry_kind || 'route',
      },
      text: `The user is already on ${entry.route}. Suggest a related screen or just answer in voice instead.`,
    };
  }

  // Success → directive payload.
  const content = getContent(entry, lang);
  const directive = {
    type: 'orb_directive',
    directive: 'navigate',
    screen_id: entry.screen_id,
    route: resolvedRoute,
    title: content.title,
    reason: String(args.reason || 'navigate_to_screen tool call'),
    entry_kind: entry.entry_kind || 'route',
    vtid: 'VTID-NAV-01',
  };

  emitOasisEvent({
    vtid: 'VTID-NAV-01',
    type: 'orb.navigator.requested',
    source: 'orb-tools-shared',
    status: 'info',
    message: `navigate_to_screen ${entry.screen_id} (${resolvedRoute})`,
    payload: {
      session_id: sessionId,
      screen_id: entry.screen_id,
      route: resolvedRoute,
      entry_kind: entry.entry_kind || 'route',
      reason: directive.reason,
      is_anonymous: isAnon,
    },
  }).catch(() => {});

  return {
    ok: true,
    result: {
      screen_id: entry.screen_id,
      route: resolvedRoute,
      base_route: baseRoutePath,
      title: content.title,
      entry_kind: entry.entry_kind || 'route',
      directive,
    },
    text: entry.entry_kind === 'overlay'
      ? `Overlay opened: ${content.title}. The user stays on their current screen — the popup is now visible. Continue the conversation; do NOT navigate elsewhere unless the user asks.`
      : `Navigation queued to ${content.title} (${resolvedRoute}). The user is now being taken to the "${content.title}" screen. The widget is closing now. DO NOT generate any more audio or text for this turn. Your turn is complete — stop speaking immediately. If the user later asks which screen they are on, they are on "${content.title}".`,
  };
}

// ---------------------------------------------------------------------------
// VTID-NAV-UNIFIED — free-text `navigate` tool (PR 1.B-4)
//
// Lifts orb-live.ts:handleNavigate into the shared dispatcher: runs the
// 8-step consultNavigator resolution (override-trigger → keyword fast path
// → semantic + KB + memory parallel → 70/30 hybrid scoring → confidence
// bucketing → confident/ambiguous/unknown decision → anonymous gate → KB
// excerpts), then constructs the redirect directive payload + builds the
// LLM-facing guidance text.
//
// Vertex pipeline: consumes `result.directive` to emit immediately on its
// SSE/WS transport, sets session.pendingNavigation, eagerly updates
// session.current_route, writes navigator-action memory.
//
// LiveKit pipeline: the Python wrapper publishes `result.directive` over
// the room data channel via _dispatch_with_directive (PR 1.B-0), and
// updates GatewayClient.current_route from result.route so the next
// get_current_screen call sees the fresh value.
//
// The tool is anonymous-safe — anonymous users hit the same consult engine
// but the navigator's anonymous-safe gating prevents leaking authenticated
// screens, returning blocked_reason='requires_auth' instead.
// ---------------------------------------------------------------------------

/**
 * Surface-scoped role derivation. Mirrors orb-live.ts:deriveSurfaceRole —
 * vitanaland.com routes → community, /admin/* → admin, /command-hub/* →
 * developer. The DB role is deliberately ignored: a developer browsing
 * vitanaland.com still sees only community routes from the Navigator.
 */
function deriveNavigatorSurfaceRole(currentRoute: string | undefined | null): string {
  const route = (currentRoute || '').toLowerCase();
  if (route.startsWith('/command-hub')) return 'developer';
  if (route === '/admin' || route.startsWith('/admin/')) return 'admin';
  return 'community';
}

export async function tool_navigate(
  args: OrbToolArgs,
  id: OrbToolIdentity,
): Promise<OrbToolResult> {
  const question = String(args.question ?? '').trim();
  if (!question) {
    return { ok: false, error: 'navigate requires a non-empty question.' };
  }

  const lang = (id.lang || 'en') as string;
  const currentRoute = typeof args.current_route === 'string' && args.current_route.length > 0
    ? args.current_route
    : null;
  const recentRoutes: string[] = Array.isArray(args.recent_routes)
    ? (args.recent_routes as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const transcriptExcerpt = typeof args.transcript_excerpt === 'string' ? args.transcript_excerpt : '';

  // VTID-NAVIGATOR-SCOPING + VTID-MOBILE-COMMUNITY-ONLY: surface-scoped role
  // is derived from the current route, never the DB role. Anonymous when
  // either user_id or tenant_id is missing.
  const surfaceRole = deriveNavigatorSurfaceRole(currentRoute);
  const isAnonymous = !id.user_id || !id.tenant_id;

  const { consultNavigator } = await import('./navigator-consult');
  const { emitOasisEvent } = await import('./oasis-event-service');

  const consultInput = {
    question,
    lang,
    identity: !isAnonymous
      ? {
          user_id: id.user_id,
          tenant_id: id.tenant_id as string,
          role: surfaceRole,
        }
      : null,
    is_anonymous: isAnonymous,
    current_route: currentRoute || undefined,
    recent_routes: recentRoutes,
    transcript_excerpt: transcriptExcerpt || undefined,
    session_id: id.session_id || undefined,
    turn_number: id.turn_number || undefined,
    conversation_start: id.session_started_iso || new Date().toISOString(),
  };

  const consultResult = await consultNavigator(consultInput);

  // OASIS consulted event — same payload shape Vertex emits today.
  emitOasisEvent({
    vtid: 'VTID-NAV-01',
    type: 'orb.navigator.consulted',
    source: 'orb-tools-shared',
    status: consultResult.confidence === 'low' ? 'warning' : 'info',
    message: `navigate: confidence=${consultResult.confidence}, decision=${consultResult.decision}, primary=${consultResult.primary?.screen_id || 'none'}`,
    payload: {
      session_id: id.session_id || null,
      question,
      primary_screen_id: consultResult.primary?.screen_id || null,
      confidence: consultResult.confidence,
      decision: consultResult.decision,
      alternative_screen_ids: consultResult.alternatives.slice(0, 3).map((a) => a.screen_id),
      kb_excerpt_count: consultResult.kb_excerpt_count,
      memory_hint_count: consultResult.memory_hint_count,
      ms_elapsed: consultResult.ms_elapsed,
      is_anonymous: isAnonymous,
    },
  }).catch(() => {});

  // VTID-02781: ambiguous → return either/or clarification text. No directive.
  if (
    consultResult.decision === 'ambiguous' &&
    consultResult.alternatives.length >= 2 &&
    !consultResult.blocked_reason
  ) {
    const top = consultResult.alternatives[0];
    const second = consultResult.alternatives[1];
    const third = consultResult.alternatives[2] || null;
    emitOasisEvent({
      vtid: 'VTID-02781',
      type: 'orb.navigator.disambiguated',
      source: 'orb-tools-shared',
      status: 'info',
      message: `disambiguating: ${top.screen_id} vs ${second.screen_id}${third ? ' vs ' + third.screen_id : ''}`,
      payload: {
        session_id: id.session_id || null,
        question,
        candidates: consultResult.alternatives.slice(0, 3).map((a) => ({
          screen_id: a.screen_id,
          route: a.route,
          title: a.title,
        })),
        ms_elapsed: consultResult.ms_elapsed,
        lang,
      },
    }).catch(() => {});

    const lines: string[] = [];
    lines.push('NAVIGATING_TO: null (waiting for user choice — DO NOT redirect)');
    lines.push(`DECISION: ambiguous`);
    lines.push(`CANDIDATES:`);
    consultResult.alternatives.slice(0, 3).forEach((a, i) => {
      lines.push(`  [${i + 1}] ${a.screen_id} — ${a.title} (${a.route})`);
    });
    const askLine =
      consultResult.suggested_question ||
      (lang.startsWith('de')
        ? `Meinst du ${top.title} oder ${second.title}${third ? ' — oder ' + third.title : ''}?`
        : `Do you mean ${top.title} or ${second.title}${third ? ' — or ' + third.title : ''}?`);
    lines.push(`ASK_USER: ${askLine}`);
    lines.push('');
    lines.push('Ask the either/or question naturally. WAIT for the user to pick.');
    lines.push('Then call navigate_to_screen with the chosen screen_id directly —');
    lines.push('do not call navigate again unless the user rephrases their request.');

    return {
      ok: true,
      result: {
        decision: 'ambiguous',
        alternatives: consultResult.alternatives.slice(0, 3).map((a) => ({
          screen_id: a.screen_id,
          route: a.route,
          title: a.title,
        })),
        suggested_question: askLine,
      },
      text: lines.join('\n'),
    };
  }

  // Primary match with sufficient confidence → auto-navigate. Build directive.
  if (consultResult.primary && consultResult.confidence !== 'low' && !consultResult.blocked_reason) {
    const entry = lookupScreen(consultResult.primary.screen_id);
    if (entry) {
      const content = getContent(entry, lang);
      const directive = {
        type: 'orb_directive',
        directive: 'navigate',
        screen_id: entry.screen_id,
        route: entry.route,
        title: content.title,
        reason: question,
        vtid: 'VTID-NAV-01',
      };

      emitOasisEvent({
        vtid: 'VTID-NAV-01',
        type: 'orb.navigator.dispatched',
        source: 'orb-tools-shared',
        status: 'info',
        message: `immediate dispatch to ${entry.screen_id}`,
        payload: {
          session_id: id.session_id || null,
          screen_id: entry.screen_id,
          route: entry.route,
          drain_wait_ms: 0,
        },
      }).catch(() => {});

      emitOasisEvent({
        vtid: 'VTID-NAV-01',
        type: 'orb.navigator.requested',
        source: 'orb-tools-shared',
        status: 'info',
        message: `navigate auto-redirect to ${entry.screen_id} (${entry.route})`,
        payload: {
          session_id: id.session_id || null,
          screen_id: entry.screen_id,
          route: entry.route,
          reason: question,
          is_anonymous: isAnonymous,
        },
      }).catch(() => {});

      const lines: string[] = [];
      lines.push(`NAVIGATING_TO: ${content.title}`);
      lines.push(`GUIDANCE: ${consultResult.explanation}`);
      if (consultResult.kb_excerpts.length > 0) {
        lines.push('ADDITIONAL_CONTEXT:');
        consultResult.kb_excerpts.forEach((x, i) => lines.push(`  [${i + 1}] ${x}`));
      }
      lines.push('');
      lines.push('Speak the GUIDANCE naturally to the user. Be helpful and warm —');
      lines.push('explain the feature, tell them what they can do on that screen,');
      lines.push('and let them know you are taking them there. The redirect happens');
      lines.push('automatically when you finish speaking.');

      return {
        ok: true,
        result: {
          decision: 'confident',
          confidence: consultResult.confidence,
          screen_id: entry.screen_id,
          route: entry.route,
          title: content.title,
          reason: question,
          directive,
        },
        text: lines.join('\n'),
      };
    }
  }

  // Blocked / confirmation / low-confidence — no directive, return clarification text.
  if (consultResult.blocked_reason === 'requires_auth') {
    return {
      ok: true,
      result: { decision: 'unknown', blocked_reason: 'requires_auth' },
      text:
        'NAVIGATING_TO: null\nGUIDANCE: ' +
        consultResult.explanation +
        '\nTell the user this feature requires joining the community and offer to take them to registration.',
    };
  }

  if (consultResult.confirmation_needed && consultResult.primary && consultResult.alternative) {
    const ask =
      consultResult.suggested_question ||
      `Would you like to go to ${consultResult.primary.title} or ${consultResult.alternative.title}?`;
    return {
      ok: true,
      result: {
        decision: 'ambiguous',
        suggested_question: ask,
        alternatives: [
          {
            screen_id: consultResult.primary.screen_id,
            route: consultResult.primary.route,
            title: consultResult.primary.title,
          },
          {
            screen_id: consultResult.alternative.screen_id,
            route: consultResult.alternative.route,
            title: consultResult.alternative.title,
          },
        ],
      },
      text:
        `NAVIGATING_TO: null (waiting for user choice)\nGUIDANCE: ${consultResult.explanation}\n` +
        `ASK_USER: ${ask}\n` +
        'Ask the user to choose, then call navigate again with their answer.',
    };
  }

  return {
    ok: true,
    result: { decision: 'unknown' },
    text:
      'NAVIGATING_TO: null\nGUIDANCE: ' +
      consultResult.explanation +
      '\nAsk the user to clarify what they are looking for so you can help them find it.',
  };
}

// ---------------------------------------------------------------------------
// VTID-01975 — view_intent_matches (PR 1.B-6)
//
// Lists the user's top-N intent matches for a given intent and auto-redirects
// to INTENTS.MATCH_DETAIL when the result is unambiguous (single match OR
// the top score dominates the runner-up by ≥ AMBIG_GAP). Otherwise returns
// the list-only payload so the LLM can read it and ask the user which to
// open. Same business logic Vertex's inline case at orb-live.ts:6372 ran;
// the auto-nav directive is the new behaviour both pipelines pick up.
// ---------------------------------------------------------------------------

const INTENT_MATCH_AUTONAV_GAP = 0.15;

export async function tool_view_intent_matches(
  args: OrbToolArgs,
  id: OrbToolIdentity,
): Promise<OrbToolResult> {
  const intentId = String(args.intent_id ?? '').trim();
  if (!intentId) return { ok: false, error: 'intent_id is required' };
  if (!id.user_id) return { ok: false, error: 'authentication required' };

  const limit = Math.min(Math.max(Number(args.limit) || 3, 1), 10);
  try {
    const { surfaceTopMatches } = await import('./intent-matcher');
    const { redactMatchForReader } = await import('./intent-mutual-reveal');
    const matches = await surfaceTopMatches(intentId, limit);
    const redacted = await Promise.all(matches.map((m) => redactMatchForReader(m, id.user_id)));
    const slim = redacted.map((m) => ({
      match_id: m.match_id,
      vitana_id_b: m.vitana_id_b,
      score: m.score,
      kind_pairing: m.kind_pairing,
      state: m.state,
      redacted: m.redacted,
    }));

    // Unambiguity: 1 match OR top score - second score >= AMBIG_GAP. Ambiguous
    // results stay list-only and the LLM disambiguates verbally.
    const top = slim[0];
    const second = slim[1];
    const dominant =
      !!top &&
      (slim.length === 1 ||
        (typeof top.score === 'number' &&
          typeof second?.score === 'number' &&
          top.score - second.score >= INTENT_MATCH_AUTONAV_GAP));

    if (dominant && top) {
      const route = `/intents/match/${encodeURIComponent(top.match_id)}`;
      const directive = {
        type: 'orb_directive',
        directive: 'navigate',
        screen_id: 'INTENTS.MATCH_DETAIL',
        route,
        title: 'Match Detail',
        reason: 'view_intent_matches dominant pick',
        vtid: 'VTID-01975',
      };
      const { emitOasisEvent } = await import('./oasis-event-service');
      emitOasisEvent({
        vtid: 'VTID-01975',
        type: 'orb.intent_matches.auto_nav',
        source: 'orb-tools-shared',
        status: 'info',
        message: `view_intent_matches auto-redirect → match=${top.match_id}`,
        payload: {
          session_id: id.session_id || null,
          intent_id: intentId,
          match_id: top.match_id,
          score: top.score,
          runner_up_score: second?.score ?? null,
        },
        actor_id: id.user_id,
        actor_role: 'user',
        surface: 'orb',
      }).catch(() => {});

      return {
        ok: true,
        result: {
          ok: true,
          matches: slim,
          decision: 'auto_nav',
          directive,
          redirect: { route },
        },
        text: `Opening your top match. Score ${top.score.toFixed(2)} — clearly the best fit.`,
      };
    }

    return {
      ok: true,
      result: { ok: true, matches: slim, decision: 'list_only' },
      text: JSON.stringify({ ok: true, matches: slim }),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('[VTID-01975] view_intent_matches error:', msg);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// VTID-NAV-TIMEJOURNEY — get_current_screen (PR 1.B-3)
//
// Mirrors orb-live.ts:handleGetCurrentScreen byte-for-byte: resolves the
// user's LIVE current route via the navigation catalog and includes the
// recent-screens trail so the LLM can answer "where am I?" / "where was I
// before?" in one tool call. Anonymous-safe — reads no user-scoped state.
//
// Both pipelines pass current_route + recent_routes via args (Vertex from
// session.current_route / session.recent_routes; LiveKit from
// GatewayClient.current_route / .recent_routes which session.py seeds from
// the bootstrap response).
// ---------------------------------------------------------------------------

export async function tool_get_current_screen(
  args: OrbToolArgs,
  id: OrbToolIdentity,
): Promise<OrbToolResult> {
  const route = typeof args.current_route === 'string' && args.current_route.length > 0
    ? args.current_route
    : null;
  const recent: string[] = Array.isArray(args.recent_routes)
    ? (args.recent_routes as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const lang = (id.lang || 'en') as string;

  if (!route) {
    return {
      ok: true,
      result: { route: null, recent_screens: [] },
      text: "The host app has not reported a current screen for this session. Tell the user you can see they're in the Vitana app but not which specific screen, and ask what they'd like to do next.",
    };
  }

  const entry = lookupByRoute(route);
  if (entry) {
    const content = getContent(entry, lang);
    const trailTitles: string[] = [];
    for (const r of recent) {
      if (r === route) continue;
      const e = lookupByRoute(r);
      if (e) trailTitles.push(getContent(e, lang).title);
      if (trailTitles.length >= 4) break;
    }
    return {
      ok: true,
      result: {
        title: content.title,
        description: content.description,
        category: entry.category,
        screen_id: entry.screen_id,
        route: entry.route,
        recent_screens: trailTitles,
      },
      text: JSON.stringify({
        title: content.title,
        description: content.description,
        category: entry.category,
        screen_id: entry.screen_id,
        route: entry.route,
        recent_screens: trailTitles,
      }),
    };
  }

  // Unknown route — catalog miss.
  const fallback = {
    title: 'Unknown screen',
    description: 'The user is on a route that is not in the navigation catalog.',
    route,
    recent_screens: [],
  };
  return {
    ok: true,
    result: fallback,
    text: JSON.stringify(fallback),
  };
}

// ---------------------------------------------------------------------------
// VTID-02753 — structured Health logging tools (LiveKit/text path).
// Vertex path is wired in orb-live.ts directly. This shared handler keeps
// the text-mode pipeline (POST /api/v1/orb/tool) in parity.
// ---------------------------------------------------------------------------

async function tool_log_health(
  toolName: 'log_water' | 'log_sleep' | 'log_exercise' | 'log_meditation',
  args: OrbToolArgs,
  identity: OrbToolIdentity,
): Promise<OrbToolResult> {
  const { logHealthSignal } = await import('./voice-tools/health-log');
  const today = new Date().toISOString().slice(0, 10);
  const date = typeof args.date === 'string' && args.date ? args.date : today;
  const out = await logHealthSignal({
    user_id: identity.user_id,
    tenant_id: identity.tenant_id,
    tool: toolName,
    date,
    amount_ml: typeof args.amount_ml === 'number' ? args.amount_ml : undefined,
    minutes: typeof args.minutes === 'number' ? args.minutes : undefined,
    activity_type: typeof args.activity_type === 'string' ? args.activity_type : undefined,
  });
  if (!out.ok) return { ok: false, error: out.error };
  const s = out.summary;
  const deltaText =
    s.index_delta !== null && s.index_delta > 0 ? ` Vitana Index up ${s.index_delta}.` : '';
  return {
    ok: true,
    result: s,
    text: `Logged ${s.value} ${s.unit} to ${s.pillar}.${deltaText}`,
  };
}

async function tool_get_pillar_subscores(
  args: OrbToolArgs,
  identity: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const pillar = String(args.pillar || '').toLowerCase();
  const valid = ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'];
  if (!valid.includes(pillar)) {
    return { ok: false, error: `pillar must be one of ${valid.join(', ')}` };
  }
  const snap = await fetchVitanaIndexForProfiler(sb, identity.user_id);
  if (!snap) {
    return { ok: true, result: { pillar, available: false }, text: 'No Vitana Index snapshot yet.' };
  }
  const sub = snap.subscores?.[pillar as keyof typeof snap.subscores];
  const pillarScore = snap.pillars[pillar as keyof typeof snap.pillars] ?? 0;
  if (!sub) {
    return {
      ok: true,
      result: { pillar, pillar_score: pillarScore, subscores: null, reason: 'no_subscores_for_pillar' },
      text: `${pillar} sits at ${pillarScore} but per-component breakdown isn't available on this Index row.`,
    };
  }
  const dominant = Object.entries(sub).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const hint =
    sub.data < 10 && sub.completions < 20
      ? 'Mostly baseline — log entries or connect a tracker to climb.'
      : sub.streak < 10
        ? 'Streak is low — consistency for 3+ days will lift this pillar.'
        : "Solid mix — keep doing what you're doing.";
  return {
    ok: true,
    result: {
      pillar,
      pillar_score: pillarScore,
      subscores: sub,
      caps: { baseline: 40, completions: 80, data: 40, streak: 40 },
      dominant,
      hint,
    },
    text: `${pillar}: ${pillarScore}. ${hint}`,
  };
}

// ---------------------------------------------------------------------------
// VTID-02830 — Find Perfect flagships (deep marketplace + practitioner search)
//
// Both tools fuse the user's weakest Vitana Index pillar + active Life Compass
// goal with multi-criteria filters from the natural-language ask. They degrade
// gracefully: when the backing catalog table is empty/missing in the active
// environment, the tool returns ok=true with available=false + a clean
// "not yet computed" reason so the orb can speak it.
// ---------------------------------------------------------------------------

async function _getWeakestPillarAndGoal(
  sb: SupabaseClient,
  userId: string,
): Promise<{ weakest_pillar: string | null; compass_goal: string | null }> {
  let weakest: string | null = null;
  let goal: string | null = null;
  try {
    const { data: idx } = await sb
      .from('vitana_index_scores')
      .select('pillars')
      .eq('user_id', userId)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (idx?.pillars && typeof idx.pillars === 'object') {
      const pairs = Object.entries(idx.pillars as Record<string, number>);
      pairs.sort((a, b) => a[1] - b[1]);
      weakest = pairs[0]?.[0] ?? null;
    }
  } catch {
    /* table may not exist in all envs */
  }
  try {
    const { data: lc } = await sb
      .from('life_compass')
      .select('current_goal')
      .eq('user_id', userId)
      .maybeSingle();
    goal = (lc?.current_goal as string) ?? null;
  } catch {
    /* table may not exist */
  }
  return { weakest_pillar: weakest, compass_goal: goal };
}

export async function tool_find_perfect_product(
  args: OrbToolArgs,
  identity: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const goalText = String(args.goal_text ?? '').trim();
  const askedPillar = String(args.pillar ?? '').trim().toLowerCase();
  const maxPrice = args.max_price != null ? Number(args.max_price) : null;
  const excludeIngredients = Array.isArray(args.exclude_ingredients)
    ? (args.exclude_ingredients as string[]).map((s) => String(s).toLowerCase())
    : [];

  const ctx = await _getWeakestPillarAndGoal(sb, identity.user_id);
  const targetPillar = askedPillar || ctx.weakest_pillar || '';

  let query = sb.from('products_catalog').select('*').limit(10);
  if (targetPillar) query = query.contains('pillar_tags', [targetPillar]);
  if (maxPrice && Number.isFinite(maxPrice)) query = query.lte('price', maxPrice);

  const { data, error } = await query;
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) {
      return {
        ok: true,
        result: { available: false, reason: 'products_catalog_not_deployed' },
        text: 'I don\'t have a product catalog wired up in this environment yet, so I can\'t recommend anything.',
      };
    }
    return { ok: false, error: `find_perfect_product failed: ${error.message}` };
  }

  const filtered = (data || []).filter((p: any) => {
    if (!excludeIngredients.length) return true;
    const ings = (p.ingredients || []).map((i: string) => String(i).toLowerCase());
    return !excludeIngredients.some((ex) => ings.includes(ex));
  }).slice(0, 3);

  if (filtered.length === 0) {
    return {
      ok: true,
      result: { available: true, results: [], pillar: targetPillar || null },
      text: `I couldn't find a product matching your filters${targetPillar ? ` for the ${targetPillar} pillar` : ''}.`,
    };
  }

  const rationaleBits: string[] = [];
  if (targetPillar) rationaleBits.push(`focused on your ${targetPillar} pillar`);
  if (ctx.compass_goal) rationaleBits.push(`aligned with your goal "${ctx.compass_goal}"`);
  if (goalText) rationaleBits.push(`matching: ${goalText}`);
  const rationale = rationaleBits.length
    ? `Top picks ${rationaleBits.join(', ')}.`
    : 'Top community-rated picks for you.';

  const titles = filtered.map((p: any) => p.name || p.title || 'product').slice(0, 3);
  return {
    ok: true,
    result: {
      available: true,
      pillar: targetPillar || null,
      compass_goal: ctx.compass_goal,
      rationale,
      results: filtered,
    },
    text: `${rationale} Top three: ${titles.join(', ')}.`,
  };
}

export async function tool_find_perfect_practitioner(
  args: OrbToolArgs,
  identity: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const specialty = String(args.specialty ?? '').trim();
  const language = String(args.language ?? '').trim();
  const telehealthOk = args.telehealth_ok;
  const maxPrice = args.max_price != null ? Number(args.max_price) : null;

  const ctx = await _getWeakestPillarAndGoal(sb, identity.user_id);

  let query = sb.from('services_catalog').select('*').limit(10);
  if (specialty) query = query.ilike('specialty', `%${specialty}%`);
  if (language) query = query.contains('languages', [language]);
  if (telehealthOk === true || telehealthOk === false) query = query.eq('telehealth_supported', telehealthOk);
  if (maxPrice && Number.isFinite(maxPrice)) query = query.lte('price', maxPrice);

  const { data, error } = await query;
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) {
      return {
        ok: true,
        result: { available: false, reason: 'services_catalog_not_deployed' },
        text: 'I don\'t have a practitioner catalog wired up in this environment yet, so I can\'t recommend anyone.',
      };
    }
    return { ok: false, error: `find_perfect_practitioner failed: ${error.message}` };
  }

  const top3 = (data || []).slice(0, 3);
  if (top3.length === 0) {
    return {
      ok: true,
      result: { available: true, results: [] },
      text: `I couldn't find a practitioner matching your filters.`,
    };
  }

  const rationaleBits: string[] = [];
  if (specialty) rationaleBits.push(`specialty "${specialty}"`);
  if (ctx.compass_goal) rationaleBits.push(`aligned with your goal "${ctx.compass_goal}"`);
  const rationale = rationaleBits.length
    ? `Top practitioners matching ${rationaleBits.join(' and ')}.`
    : 'Top-rated practitioners matching your filters.';

  const names = top3.map((p: any) => p.display_name || p.name || 'practitioner');
  return {
    ok: true,
    result: {
      available: true,
      compass_goal: ctx.compass_goal,
      rationale,
      results: top3,
    },
    text: `${rationale} Top three: ${names.join(', ')}.`,
  };
}

// ---------------------------------------------------------------------------
// VTID-02754 — find_community_member (PR 1.B-1)
//
// Lifts Vertex's inline find_community_member case from orb-live.ts:5430 into
// the shared dispatcher. Both pipelines now run identical ranker + history
// persistence + redirect-route construction. The shared module returns a
// `directive` payload nested in `result` so the caller can emit it on
// whichever transport it has — Vertex emits via SSE/WS in
// session.pendingNavigation; LiveKit publishes on the data channel from
// _dispatch_with_directive in tools.py.
// ---------------------------------------------------------------------------

export async function tool_find_community_member(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const query = String(args.query ?? '').trim();
  if (!query || query.length < 2) {
    return { ok: false, error: 'query_too_short' };
  }
  if (!id.user_id || !id.tenant_id) {
    return { ok: false, error: 'auth_required' };
  }
  const excluded = Array.isArray(args.excluded_vitana_ids)
    ? (args.excluded_vitana_ids as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 25)
    : [];

  try {
    const { findCommunityMember, hashQuery } = await import('./voice-tools/community-member-ranker');

    const outcome = await findCommunityMember(sb, {
      viewer_user_id: id.user_id,
      viewer_tenant_id: id.tenant_id,
      query,
      excluded_vitana_ids: excluded,
    });

    // Persist to community_search_history (frontend reads by search_id to
    // render WhyThisMatchCard). Failure here doesn't block the redirect —
    // the card just gracefully no-ops.
    let searchId: string | undefined;
    try {
      const { data: inserted } = await sb
        .from('community_search_history')
        .insert({
          viewer_user_id: id.user_id,
          viewer_vitana_id: id.vitana_id ?? null,
          tenant_id: id.tenant_id,
          query,
          query_hash: hashQuery(query, id.user_id),
          tier: outcome.tier,
          lane: outcome.lane,
          winner_user_id: outcome.winnerUserId,
          winner_vitana_id: outcome.result.vitana_id,
          recipe_json: outcome.result.match_recipe,
          excluded_vitana_ids: excluded,
        })
        .select('search_id')
        .maybeSingle();
      searchId = (inserted as { search_id?: string } | null)?.search_id;
    } catch (persistErr: unknown) {
      const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      console.warn(`[VTID-02754] community_search_history insert failed: ${msg}`);
    }

    // Bake search_id into the redirect route so WhyThisMatchCard can fetch
    // the recipe by id. Same behaviour as Vertex's inline case.
    const baseRoute = outcome.result.redirect.route;
    const route = searchId && !baseRoute.includes('search_id=')
      ? `${baseRoute}${baseRoute.includes('?') ? '&' : '?'}search_id=${searchId}`
      : baseRoute;

    const directive = {
      type: 'orb_directive',
      directive: 'navigate',
      screen_id: 'profile_with_match',
      route,
      title: `Profile: ${outcome.result.display_name}`,
      vtid: 'VTID-02754',
    };

    // Telemetry — same payload shape Vertex emits today.
    try {
      const { emitOasisEvent } = await import('./oasis-event-service');
      emitOasisEvent({
        vtid: 'VTID-02754',
        type: 'community.find_member.matched',
        source: 'orb-tools-shared',
        status: 'info',
        message: `find_community_member matched "${query}" → ${outcome.result.vitana_id}`,
        payload: {
          query,
          tier: outcome.tier,
          lane: outcome.lane,
          winner_vitana_id: outcome.result.vitana_id,
          ethics_reroute: !!outcome.result.match_recipe?.ethics_reroute,
          search_id: searchId,
        },
        actor_id: id.user_id,
        actor_role: 'user',
        surface: 'orb',
        vitana_id: id.vitana_id ?? undefined,
      }).catch(() => {});
    } catch {
      /* telemetry never blocks the user flow */
    }

    return {
      ok: true,
      result: {
        vitana_id: outcome.result.vitana_id,
        display_name: outcome.result.display_name,
        search_id: searchId,
        match_recipe: outcome.result.match_recipe,
        directive,
      },
      text: outcome.result.voice_summary,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('[VTID-02754] find_community_member error:', msg);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Registry + dispatcher
// ---------------------------------------------------------------------------

type OrbToolHandler = (
  args: OrbToolArgs,
  identity: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

export const ORB_TOOL_REGISTRY: Record<string, OrbToolHandler> = {
  search_memory: tool_search_memory,
  search_web: tool_search_web,
  recall_conversation_at_time: tool_recall_conversation_at_time,
  switch_persona: (args) => tool_switch_persona(args),
  report_to_specialist: (args) => tool_report_to_specialist(args),
  search_events: tool_search_events,
  search_community: tool_search_community,
  // VTID-02754 — auto-redirecting community member search (PR 1.B-1)
  find_community_member: tool_find_community_member,
  // VTID-02753 — structured Health logging (LiveKit/text path)
  log_water:        (args, id, sb) => tool_log_health('log_water', args, id),
  log_sleep:        (args, id, sb) => tool_log_health('log_sleep', args, id),
  log_exercise:     (args, id, sb) => tool_log_health('log_exercise', args, id),
  log_meditation:   (args, id, sb) => tool_log_health('log_meditation', args, id),
  get_pillar_subscores: tool_get_pillar_subscores,
  play_music: tool_play_music,
  set_capability_preference: tool_set_capability_preference,
  read_email: tool_read_email,
  get_schedule: tool_get_schedule,
  add_to_calendar: tool_add_to_calendar,
  find_contact: tool_find_contact,
  consult_external_ai: tool_consult_external_ai,
  create_index_improvement_plan: tool_create_index_improvement_plan,
  ask_pillar_agent: tool_ask_pillar_agent,
  explain_feature: (args) => tool_explain_feature(args),
  resolve_recipient: tool_resolve_recipient,
  send_chat_message: tool_send_chat_message,
  share_link: tool_share_link,
  scan_existing_matches: tool_scan_existing_matches,
  share_intent_post: tool_share_intent_post,
  respond_to_match: tool_respond_to_match,
  navigate_to_screen: (args, id) => tool_navigate_to_screen(args, id),
  // VTID-NAV-UNIFIED — free-text navigate (PR 1.B-4). Runs consultNavigator's
  // 8-step resolution and constructs the redirect directive.
  navigate: tool_navigate,
  // VTID-01975 — view_intent_matches (PR 1.B-6). Auto-redirects to
  // INTENTS.MATCH_DETAIL when the top score dominates the runner-up;
  // otherwise lists matches and lets the LLM disambiguate verbally.
  view_intent_matches: tool_view_intent_matches,
  // VTID-NAV-TIMEJOURNEY — get_current_screen (PR 1.B-3). Resolves the user's
  // LIVE current screen via the nav catalog. Anonymous-safe — pulls
  // current_route + recent_routes from args (Vertex/LiveKit pass them via
  // session/GatewayClient state at dispatch time).
  get_current_screen: tool_get_current_screen,
  // VTID-02830 — Find Perfect flagships (deep marketplace + practitioner search)
  find_perfect_product: tool_find_perfect_product,
  find_perfect_practitioner: tool_find_perfect_practitioner,
};

export const ORB_TOOL_NAMES = Object.keys(ORB_TOOL_REGISTRY);

/**
 * Single entry-point both pipelines call. Wraps the handler so unexpected
 * exceptions become structured `ok: false` responses rather than crashing
 * the LLM tool loop.
 */
export async function dispatchOrbTool(
  name: string,
  args: OrbToolArgs,
  identity: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const handler = ORB_TOOL_REGISTRY[name];
  if (!handler) {
    return { ok: false, error: `unknown tool: ${name}` };
  }
  try {
    return await handler(args, identity, sb);
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown error' };
  }
}

// ---------------------------------------------------------------------------
// Vertex adapter
// ---------------------------------------------------------------------------

/**
 * Vertex's tool-dispatch handler in orb-live.ts returns `{success, result, error}`
 * (string `result`), not the `{ok, result, text}` shape the LiveKit dispatcher
 * uses. This adapter calls dispatchOrbTool and translates the response so a
 * Vertex case body can be replaced with a one-liner:
 *
 *   case 'play_music':
 *     return await dispatchOrbToolForVertex('play_music', args, session, sb);
 *
 * The translation rules:
 *   - ok: true    → success: true, result: text || JSON.stringify(result)
 *   - ok: false   → success: false, error: error
 *
 * The LLM-visible content is the `text` field if present, otherwise the
 * stringified `result`. This matches how Vertex callers downstream feed the
 * `result` string into the function-response sent back to Gemini.
 */
export interface VertexLikeIdentity {
  user_id: string;
  tenant_id: string | null;
  role?: string | null;
  vitana_id?: string | null;
  user_jwt?: string | null;
  session_id?: string | null;
  thread_id?: string | null;
  turn_number?: number | null;
  session_started_iso?: string | null;
  lang?: string | null;
  is_anonymous?: boolean | null;
  is_mobile?: boolean | null;
}

export interface VertexLikeToolResult {
  success: boolean;
  result: string;
  error?: string;
}

export async function dispatchOrbToolForVertex(
  name: string,
  args: OrbToolArgs,
  identity: VertexLikeIdentity,
  sb: SupabaseClient,
): Promise<VertexLikeToolResult> {
  const r = await dispatchOrbTool(
    name,
    args,
    {
      user_id: identity.user_id,
      tenant_id: identity.tenant_id,
      role: identity.role ?? null,
      vitana_id: identity.vitana_id ?? null,
      user_jwt: identity.user_jwt ?? null,
      session_id: identity.session_id ?? null,
      thread_id: identity.thread_id ?? null,
      turn_number: identity.turn_number ?? null,
      session_started_iso: identity.session_started_iso ?? null,
      lang: identity.lang ?? null,
      is_anonymous: identity.is_anonymous ?? null,
      is_mobile: identity.is_mobile ?? null,
    },
    sb,
  );
  if (r.ok === false) {
    return { success: false, result: '', error: r.error };
  }
  // Prefer text (which is what the LLM speaks); fall back to JSON of result.
  let resultStr: string;
  if (typeof r.text === 'string' && r.text.length > 0) {
    resultStr = r.text;
  } else if (r.result !== undefined) {
    try {
      resultStr = JSON.stringify(r.result);
    } catch {
      resultStr = String(r.result);
    }
  } else {
    resultStr = '';
  }
  return { success: true, result: resultStr };
}
