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
}

export type OrbToolResult =
  | { ok: true; result?: unknown; text?: string; [k: string]: unknown }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export async function tool_search_memory(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const query = String(args.query ?? '').trim();
  const limit = Math.min(20, Math.max(1, Number(args.limit ?? 5)));
  if (!query) return { ok: true, result: { items: [] }, text: 'No query provided.' };
  const { data, error } = await sb
    .from('memory_items')
    .select('id, content, category_key, created_at, importance')
    .eq('user_id', id.user_id)
    .ilike('content', `%${query}%`)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return { ok: false, error: `memory search failed: ${error.message}` };
  return {
    ok: true,
    result: {
      items: (data || []).map((d) => ({
        id: d.id,
        content: String(d.content ?? '').slice(0, 400),
        category: d.category_key,
        when: d.created_at,
      })),
    },
  };
}

export async function tool_search_web(args: OrbToolArgs): Promise<OrbToolResult> {
  const query = String(args.query ?? '').trim();
  if (!query) return { ok: true, result: { items: [] }, text: 'No query provided.' };
  return {
    ok: true,
    result: { items: [] },
    text:
      `Web search isn't connected to a provider in this build. ` +
      `Ask me what I already know about "${query}" — I'll answer from your memory + the Knowledge Hub instead.`,
  };
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
  _id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const query = String(args.query ?? '').trim().toLowerCase();
  const { data, error } = await sb
    .from('global_community_events')
    .select('id, title, description, start_time, end_time, location, virtual_link, slug')
    .gte('start_time', new Date().toISOString())
    .order('start_time', { ascending: true })
    .limit(20);
  if (error) {
    return {
      ok: true,
      result: { events: [] },
      text: `Couldn't search events right now: ${error.message}`,
    };
  }
  const filtered = query
    ? (data || []).filter(
        (e: { title?: string; description?: string }) =>
          (e.title || '').toLowerCase().includes(query) ||
          (e.description || '').toLowerCase().includes(query),
      )
    : data || [];
  const top = filtered.slice(0, 10).map((e) => ({
    id: e.id,
    title: e.title,
    when: e.start_time,
    location: e.location || e.virtual_link,
    slug: e.slug,
  }));
  // Voice-friendly summary: include event titles + when so the LLM can read
  // them back. The earlier "Found N upcoming events" produced silence on the
  // voice side because the LLM had no titles to speak.
  const lines = top.map((e) => {
    const when = e.when
      ? new Date(e.when).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '';
    const loc = e.location ? ` at ${String(e.location).slice(0, 80)}` : '';
    return `- ${e.title}${when ? ` (${when})` : ''}${loc}`;
  });
  return {
    ok: true,
    result: { events: top },
    text:
      filtered.length === 0
        ? 'No upcoming events found right now.'
        : `Upcoming events (${filtered.length}):\n${lines.join('\n')}`,
  };
}

export async function tool_search_community(
  args: OrbToolArgs,
  _id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const query = String(args.query ?? '').trim().toLowerCase();
  const { data, error } = await sb
    .from('community_groups')
    .select('id, name, slug')
    .limit(100);
  if (error) {
    return {
      ok: true,
      result: { groups: [] },
      text: `Community group search isn't available right now: ${error.message}`,
    };
  }
  const filtered = query
    ? (data || []).filter((g: { name?: string }) => (g.name || '').toLowerCase().includes(query))
    : data || [];
  return {
    ok: true,
    result: {
      groups: filtered.slice(0, 10).map((g) => ({ id: g.id, name: g.name, slug: g.slug })),
    },
    text:
      filtered.length === 0
        ? `No matching community groups found for "${query || 'all'}".`
        : `Found ${filtered.length} group${filtered.length === 1 ? '' : 's'}.`,
  };
}

export async function tool_play_music(args: OrbToolArgs): Promise<OrbToolResult> {
  const query = String(args.query ?? '').trim();
  return {
    ok: true,
    result: { query, status: 'no_provider_connected' },
    text:
      `I don't have a music provider connected to your account yet. ` +
      `Connect Spotify or YouTube Music in Settings → Connected Apps and ` +
      `I'll be able to play "${query}" next time.`,
  };
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

export async function tool_consult_external_ai(args: OrbToolArgs): Promise<OrbToolResult> {
  const prompt = String(args.prompt ?? '').slice(0, 200);
  return {
    ok: true,
    result: { prompt, forwarded_to: null, status: 'no_external_ai_connected' },
    text:
      `You don't have an external AI assistant (ChatGPT/Claude/Gemini) connected ` +
      `to your account yet. Connect one in Settings → Integrations and I'll forward ` +
      `questions like "${prompt}" through next time.`,
  };
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
  const pillar =
    resolvePillarKey(String(args.pillar ?? '')) ||
    (await fetchVitanaIndexForProfiler(sb, id.user_id))?.weakest_pillar?.name ||
    null;
  const question = String(args.question ?? '').trim();
  if (!pillar || !question) {
    return { ok: false, error: 'pillar and question are required' };
  }
  const snap = await fetchVitanaIndexForProfiler(sb, id.user_id);
  const subs = (snap?.subscores as Record<string, unknown> | undefined)?.[pillar];
  return {
    ok: true,
    result: {
      pillar,
      question,
      subscores: subs ?? null,
      note: 'pillar agent is in lightweight mode — surfaces sub-scores; full agentic answer ships in a follow-up',
    },
  };
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

export async function tool_navigate_to_screen(args: OrbToolArgs): Promise<OrbToolResult> {
  const screenIdArg = String(args.screen_id ?? args.target ?? '').trim();
  if (!screenIdArg) return { ok: false, error: 'screen_id (or legacy target) is required' };

  let entry: NavCatalogEntry | null = lookupScreen(screenIdArg) || lookupByAlias(screenIdArg);
  if (!entry) {
    const similar = suggestSimilar(screenIdArg, 1);
    if (similar.length > 0) entry = similar[0];
  }
  if (!entry) {
    return {
      ok: true,
      result: { screen_id: screenIdArg, route: null },
      text: `I don't have a canonical screen for "${screenIdArg}" — tell me what you want to see and I'll match it.`,
    };
  }

  const missing: string[] = [];
  let route = entry.route.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => {
    const v = args[name];
    if (v === undefined || v === null || String(v).trim() === '') {
      missing.push(String(name));
      return ':' + String(name);
    }
    return encodeURIComponent(String(v).trim().replace(/^@/, ''));
  });
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing required param(s) for ${entry.screen_id}: ${missing.join(', ')}.`,
    };
  }

  if (entry.entry_kind === 'overlay' && entry.overlay) {
    const sep = route.includes('?') ? '&' : '?';
    const params = new URLSearchParams();
    params.set('open', entry.overlay.query_marker);
    const needs = entry.overlay.needs_param;
    if (needs) {
      const v = args[needs];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        params.set(needs, String(v).trim().replace(/^@/, ''));
      }
    }
    route = `${route}${sep}${params.toString()}`;
  }

  const title = getContent(entry, 'en').title;
  return {
    ok: true,
    result: { screen_id: entry.screen_id, route, title, entry_kind: entry.entry_kind || 'route' },
    text: `Opening ${title}.`,
  };
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
  search_web: (args) => tool_search_web(args),
  recall_conversation_at_time: tool_recall_conversation_at_time,
  switch_persona: (args) => tool_switch_persona(args),
  report_to_specialist: (args) => tool_report_to_specialist(args),
  search_events: tool_search_events,
  search_community: tool_search_community,
  play_music: (args) => tool_play_music(args),
  set_capability_preference: tool_set_capability_preference,
  read_email: tool_read_email,
  get_schedule: tool_get_schedule,
  add_to_calendar: tool_add_to_calendar,
  find_contact: tool_find_contact,
  consult_external_ai: (args) => tool_consult_external_ai(args),
  create_index_improvement_plan: tool_create_index_improvement_plan,
  ask_pillar_agent: tool_ask_pillar_agent,
  explain_feature: (args) => tool_explain_feature(args),
  resolve_recipient: tool_resolve_recipient,
  send_chat_message: tool_send_chat_message,
  share_link: tool_share_link,
  scan_existing_matches: tool_scan_existing_matches,
  share_intent_post: tool_share_intent_post,
  respond_to_match: tool_respond_to_match,
  navigate_to_screen: (args) => tool_navigate_to_screen(args),
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
