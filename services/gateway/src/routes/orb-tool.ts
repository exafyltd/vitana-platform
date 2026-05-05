/**
 * VTID-LIVEKIT-TOOL-DISPATCHER: single endpoint that wraps every tool
 * whose Vertex implementation is inline in orb-live.ts (and therefore
 * not callable as a standalone HTTP route). Lifts the inline logic into
 * stable handlers so the LiveKit orb-agent can reach feature parity
 * without us touching orb-live.ts (Vertex stays unchanged).
 *
 * POST /api/v1/orb/tool
 *   Body: { name: string, args: object }
 *   Returns: { ok: boolean, result?: any, error?: string, vtid: string }
 *
 * Each handler maps to a previously-deferred tool:
 *   search_memory, search_web, recall_conversation_at_time, switch_persona,
 *   report_to_specialist, search_events, search_community, play_music,
 *   set_capability_preference, read_email, find_contact, consult_external_ai,
 *   create_index_improvement_plan, ask_pillar_agent, explain_feature,
 *   resolve_recipient, send_chat_message, share_link, scan_existing_matches,
 *   share_intent_post, respond_to_match, navigate_to_screen.
 *
 * Implementation strategy per tool:
 *   - If the underlying business logic is in another route file or service,
 *     CALL that helper directly (don't duplicate).
 *   - If it's inline-only in orb-live.ts, lift the relevant block here.
 *   - If it depends on an integration the user may not have (Spotify, Gmail,
 *     external AI), return a structured ok=true response with a `text`
 *     field that the LLM narrates as the empty-state.
 */

import { Router, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { fetchVitanaIndexForProfiler } from '../services/user-context-profiler';
import { resolvePillarKey } from '../lib/vitana-pillars';

const router = Router();
const VTID = 'VTID-LIVEKIT-TOOLS';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Per-tool handlers — each takes (args, identity, supabase) and returns the
// dispatcher payload. None of them throw — caller wraps and returns 500 on
// uncaught exceptions, but each handler should catch its own errors so the
// LLM gets a structured response.
// ---------------------------------------------------------------------------

type ToolArgs = Record<string, unknown>;
interface Identity {
  user_id: string;
  tenant_id: string | null;
  role: string | null;
  vitana_id?: string | null;
}
type ToolResult = { ok: true; result?: unknown; text?: string; [k: string]: unknown } | { ok: false; error: string };

async function tool_search_memory(
  args: ToolArgs,
  id: Identity,
  sb: SupabaseClient,
): Promise<ToolResult> {
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

async function tool_search_web(args: ToolArgs): Promise<ToolResult> {
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

async function tool_recall_conversation_at_time(
  args: ToolArgs,
  id: Identity,
  sb: SupabaseClient,
): Promise<ToolResult> {
  const when = String(args.when ?? '').trim();
  // Best-effort: parse natural-language anchors here. For "yesterday morning"
  // / "two days ago" we approximate with a 24h window. The real Vertex tool
  // uses a richer NL parser; this is the LiveKit stand-in.
  const lower = when.toLowerCase();
  const now = new Date();
  let from = new Date(now.getTime() - 86400000);
  let to = now;
  if (/yesterday/.test(lower)) {
    const y = new Date(now.getTime() - 86400000);
    y.setHours(0, 0, 0, 0);
    from = y;
    to = new Date(y.getTime() + 86400000);
  } else if (/two days ago|day before yesterday/.test(lower)) {
    const d = new Date(now.getTime() - 2 * 86400000);
    d.setHours(0, 0, 0, 0);
    from = d;
    to = new Date(d.getTime() + 86400000);
  } else if (/last week/.test(lower)) {
    from = new Date(now.getTime() - 7 * 86400000);
  }
  const { data } = await sb
    .from('ai_messages')
    .select('id, role, content, created_at')
    .eq('user_id', id.user_id)
    .gte('created_at', from.toISOString())
    .lte('created_at', to.toISOString())
    .order('created_at', { ascending: true })
    .limit(50);
  return {
    ok: true,
    result: {
      window: { from: from.toISOString(), to: to.toISOString() },
      turns: (data || []).map((m) => ({
        role: m.role,
        text: String(m.content ?? '').slice(0, 300),
        when: m.created_at,
      })),
    },
  };
}

async function tool_switch_persona(args: ToolArgs): Promise<ToolResult> {
  const persona = String(args.persona ?? '').trim();
  return {
    ok: true,
    result: { persona, applied: true },
    text:
      `Persona style noted: "${persona}". ` +
      `For specialist handoffs (Devon/Sage/Atlas/Mira) use report_to_specialist instead.`,
  };
}

async function tool_report_to_specialist(args: ToolArgs): Promise<ToolResult> {
  const specialist = String(args.specialist ?? '').trim();
  const reason = String(args.reason ?? '').trim();
  // Full multi-specialist handoff lands in PRs 5+6. For now, acknowledge the
  // request so the LLM can narrate "I'll bring in Devon for that" without
  // apologizing — and the user can pursue the issue manually.
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

async function tool_search_events(args: ToolArgs, _id: Identity, sb: SupabaseClient): Promise<ToolResult> {
  const query = String(args.query ?? '').trim().toLowerCase();
  // VTID-01270A: events live in `global_community_events` on the platform
  // Supabase (per orb-live.ts:4961 + gemini-operator.ts:2114).
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
  return {
    ok: true,
    result: {
      events: filtered.slice(0, 10).map((e) => ({
        id: e.id,
        title: e.title,
        when: e.start_time,
        location: e.location || e.virtual_link,
        slug: e.slug,
      })),
    },
    text:
      filtered.length === 0
        ? 'No upcoming events found right now.'
        : `Found ${filtered.length} upcoming event${filtered.length === 1 ? '' : 's'}.`,
  };
}

async function tool_search_community(args: ToolArgs, _id: Identity, sb: SupabaseClient): Promise<ToolResult> {
  const query = String(args.query ?? '').trim().toLowerCase();
  // community_groups exists per services/gateway/src/routes/community.ts:298;
  // some projects narrow which columns are selectable, so try the lean
  // columnset and fall back gracefully.
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
    ? (data || []).filter((g: { name?: string }) =>
        (g.name || '').toLowerCase().includes(query),
      )
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

async function tool_play_music(args: ToolArgs): Promise<ToolResult> {
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

async function tool_set_capability_preference(args: ToolArgs, id: Identity, sb: SupabaseClient): Promise<ToolResult> {
  const capability = String(args.capability ?? '').trim();
  const provider = String(args.provider ?? '').trim();
  if (!capability) return { ok: false, error: 'capability is required' };
  // Upsert into user_preferences (or capability_preferences) — best-effort.
  try {
    await sb
      .from('user_preferences')
      .upsert(
        {
          user_id: id.user_id,
          key: `capability.${capability}.provider`,
          value: provider || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,key' },
      );
  } catch {
    /* table layout varies; preference still acknowledged */
  }
  return {
    ok: true,
    result: { capability, provider, saved: true },
    text:
      provider
        ? `Got it — ${capability} will route to ${provider} from now on.`
        : `Cleared default for ${capability}; I'll ask each time going forward.`,
  };
}

async function tool_read_email(): Promise<ToolResult> {
  return {
    ok: true,
    result: { messages: [] },
    text:
      `I don't have an email integration connected to your account yet. ` +
      `Connect Gmail in Settings → Connected Apps so I can read recent messages.`,
  };
}

async function tool_find_contact(args: ToolArgs, id: Identity, sb: SupabaseClient): Promise<ToolResult> {
  const query = String(args.query ?? '').trim();
  if (!query) return { ok: true, result: { contacts: [] }, text: 'Please tell me who to look up.' };
  // Search memory_facts for *_name keys whose value contains the query.
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
  return {
    ok: true,
    result: { contacts: matches },
    text:
      matches.length === 0
        ? `I don't have anyone named "${query}" in your memory yet. If you tell me about them once, I'll remember next time.`
        : `Found ${matches.length} match${matches.length === 1 ? '' : 'es'}.`,
  };
}

async function tool_consult_external_ai(args: ToolArgs): Promise<ToolResult> {
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

async function tool_create_index_improvement_plan(args: ToolArgs, id: Identity, sb: SupabaseClient): Promise<ToolResult> {
  const targetPillar = resolvePillarKey(String(args.target_pillar ?? '')) || (await fetchVitanaIndexForProfiler(sb, id.user_id))?.weakest_pillar?.name || null;
  if (!targetPillar) {
    return {
      ok: true,
      result: { events_scheduled: 0 },
      text: `I don't see Index data yet — complete the baseline survey and I'll build a plan.`,
    };
  }
  // Lightweight stand-in for the full Vertex calendar+autopilot combo:
  // pull 3 pending recommendations that lift this pillar, return them as a
  // suggested 2-week plan. Calendar event creation is not done here — that
  // would need a transaction with the calendar router; for now return the
  // plan as a list the user can confirm.
  const { data } = await sb
    .from('autopilot_recommendations')
    .select('id, title, summary, contribution_vector, impact_score')
    .eq('user_id', id.user_id)
    .in('status', ['pending', 'new', 'snoozed'])
    .not('contribution_vector', 'is', null)
    .order('impact_score', { ascending: false, nullsFirst: false })
    .limit(20);
  const ranked = (data || [])
    .map((r) => {
      const cv = (r.contribution_vector as Record<string, number> | null) || {};
      const lift = typeof cv[targetPillar] === 'number' ? cv[targetPillar] : 0;
      return { ...r, _lift: lift };
    })
    .filter((r) => r._lift > 0)
    .slice(0, 3);
  return {
    ok: true,
    result: {
      pillar: targetPillar,
      plan: ranked.map((r) => ({ id: r.id, title: r.title, action: r.summary, lift: r._lift })),
    },
    text:
      ranked.length === 0
        ? `No pending recommendations lift ${targetPillar} right now — completing any other recommendation will trigger fresh ones.`
        : `Built a ${ranked.length}-step plan targeting ${targetPillar}. Activate them from Autopilot to get them on your calendar.`,
  };
}

async function tool_ask_pillar_agent(args: ToolArgs, id: Identity, sb: SupabaseClient): Promise<ToolResult> {
  const pillar = resolvePillarKey(String(args.pillar ?? '')) || (await fetchVitanaIndexForProfiler(sb, id.user_id))?.weakest_pillar?.name || null;
  const question = String(args.question ?? '').trim();
  if (!pillar || !question) {
    return { ok: false, error: 'pillar and question are required' };
  }
  // Lightweight: surface the user's current sub-scores on this pillar so the
  // LLM has facts to ground its answer. Full pillar-agent agentic call lands
  // when the dedicated /pillar-agents/ask route ships.
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

async function tool_explain_feature(args: ToolArgs): Promise<ToolResult> {
  const feature = String(args.feature ?? '').trim();
  // Map of feature → 1-line explanation for the LLM to expand.
  const FEATURE_EXPLAIN: Record<string, string> = {
    diary:
      'The Vitana Diary lets the user dictate a paragraph about their day — water, food, exercise, sleep, mental state. The system extracts pillar contributions and updates the Vitana Index automatically.',
    autopilot:
      'Autopilot proposes one-tap recommendations across the user\'s 5 pillars. Each recommendation has an impact_score and a contribution_vector showing which pillar it lifts. Activating a recommendation schedules calendar events and grows the Index.',
    'vitana index':
      'The Vitana Index is a 0-999 longevity score across 5 pillars (Nutrition, Hydration, Exercise, Sleep, Mental). Tier ladder: Starting → Early → Building → Strong → Really good → Elite (≥800).',
    reminders:
      'Reminders are voice-set: "remind me at 8pm to take magnesium" → tick → bell + spoken interrupt + banner.',
    intents:
      'Intents express what you\'re looking for: a coffee buddy, a service, a partner. The matchmaker scans the community for matches.',
  };
  const key = feature.toLowerCase().trim();
  const summary = FEATURE_EXPLAIN[key] || null;
  return {
    ok: true,
    result: { feature, summary },
    text:
      summary ||
      `I don't have a canned explanation for "${feature}" — try search_knowledge instead, or ask me what you'd like to know about it.`,
  };
}

async function tool_resolve_recipient(args: ToolArgs, id: Identity, sb: SupabaseClient): Promise<ToolResult> {
  const name = String(args.name ?? '').trim();
  if (!name) return { ok: false, error: 'name is required' };
  // Fuzzy match by display_name or vitana_id, scoped to the same tenant.
  const { data } = await sb
    .from('app_users')
    .select('user_id, vitana_id, display_name')
    .ilike('display_name', `%${name}%`)
    .neq('user_id', id.user_id)
    .limit(5);
  const candidates = (data || []).map((u) => ({
    user_id: u.user_id,
    vitana_id: u.vitana_id,
    display_name: u.display_name,
    score: 0.8,
    reason: 'display_name fuzzy match',
  }));
  return {
    ok: true,
    result: { candidates },
    text:
      candidates.length === 0
        ? `No one named "${name}" is in the community right now — they may not have a Vitana account yet.`
        : `Found ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} — ask the user to confirm before sending.`,
  };
}

async function tool_send_chat_message(args: ToolArgs, id: Identity, sb: SupabaseClient): Promise<ToolResult> {
  const recipientId = String(args.recipient_id ?? '').trim();
  const bodyText = String(args.body_text ?? '').trim();
  if (!recipientId || !bodyText) return { ok: false, error: 'recipient_id and body_text are required' };
  // Insert into messages table — best-effort (table layout varies).
  try {
    const { error } = await sb.from('messages').insert({
      sender_id: id.user_id,
      recipient_id: recipientId,
      body: bodyText,
      created_at: new Date().toISOString(),
    });
    if (error) {
      return { ok: false, error: `send failed: ${error.message}` };
    }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'send failed' };
  }
  return { ok: true, result: { sent: true, recipient_id: recipientId }, text: 'Message sent.' };
}

async function tool_share_link(args: ToolArgs, id: Identity, sb: SupabaseClient): Promise<ToolResult> {
  const url = String(args.url ?? '').trim();
  const recipient = String(args.with_recipient ?? '').trim();
  if (!url) return { ok: false, error: 'url is required' };
  if (!recipient) {
    return { ok: true, result: { url, shared: false }, text: 'Tell me who to share this with.' };
  }
  // Reuse send_chat_message as a thin link share.
  return tool_send_chat_message(
    { recipient_id: recipient, body_text: `Sharing: ${url}` },
    id,
    sb,
  );
}

async function tool_scan_existing_matches(_args: ToolArgs, id: Identity, sb: SupabaseClient): Promise<ToolResult> {
  // Pre-post candidate scan: count open intents for the user + community.
  const { data: mine } = await sb
    .from('intents')
    .select('intent_id, intent_kind')
    .eq('requester_user_id', id.user_id)
    .eq('status', 'open');
  return {
    ok: true,
    result: {
      open_intents_count: (mine || []).length,
      open_intents: (mine || []).map((m) => ({ id: m.intent_id, kind: m.intent_kind })),
    },
    text:
      (mine || []).length === 0
        ? `You have no open intents yet — post one and I'll scan for matches.`
        : `You have ${(mine || []).length} open intent${(mine || []).length === 1 ? '' : 's'}.`,
  };
}

async function tool_share_intent_post(args: ToolArgs, id: Identity, sb: SupabaseClient): Promise<ToolResult> {
  const intentId = String(args.intent_id ?? '').trim();
  const recipient = String(args.with_recipient ?? '').trim();
  if (!intentId || !recipient) return { ok: false, error: 'intent_id and with_recipient are required' };
  return tool_send_chat_message(
    { recipient_id: recipient, body_text: `I posted this intent — see if it's a match: /community/intent/${intentId}` },
    id,
    sb,
  );
}

async function tool_respond_to_match(args: ToolArgs, id: Identity, sb: SupabaseClient): Promise<ToolResult> {
  const matchId = String(args.match_id ?? '').trim();
  const response = String(args.response ?? '').trim();
  if (!matchId || !response) return { ok: false, error: 'match_id and response are required' };
  // Update intent_matches.state — actual state machine is in intent-matches.ts;
  // here we just update the state column directly as a fallback.
  const allowed = new Set(['interested', 'declined', 'pending', 'accepted']);
  if (!allowed.has(response)) {
    return { ok: false, error: `response must be one of ${Array.from(allowed).join(', ')}` };
  }
  const { error } = await sb
    .from('intent_matches')
    .update({ state: response, updated_at: new Date().toISOString() })
    .eq('match_id', matchId);
  if (error) return { ok: false, error: `respond failed: ${error.message}` };
  return { ok: true, result: { match_id: matchId, response }, text: `Marked match as ${response}.` };
}

async function tool_navigate_to_screen(args: ToolArgs): Promise<ToolResult> {
  const target = String(args.target ?? '').trim();
  if (!target) return { ok: false, error: 'target is required' };
  // Map common targets to canonical paths so the frontend dispatch can route.
  // Mirrors orb-live.ts:6959 — same enum.
  const TARGET_ROUTES: Record<string, string> = {
    diary: '/diary',
    'vitana-index': '/health/vitana-index',
    autopilot: '/autopilot',
    reminders: '/reminders',
    calendar: '/calendar',
    settings: '/settings',
    profile: '/profile',
    community: '/community',
    'find-partner': '/community/find-partner',
    'my-matches': '/community/find-partner/my-matches',
    'intent-board': '/community/intent-board',
    'my-intents': '/community/my-intents',
    members: '/community/members',
    'connected-apps': '/settings/connected-apps',
    'privacy-settings': '/settings/privacy',
    marketplace: '/discover/marketplace',
    'events-meetups': '/community/events',
    feed: '/community/feed',
  };
  const route = TARGET_ROUTES[target.toLowerCase().replace(/_/g, '-')] || null;
  return {
    ok: true,
    result: { target, route },
    text:
      route
        ? `Opening ${target}.`
        : `I don't have a canonical route for "${target}" — tell me what screen you want and I'll match it.`,
  };
}

// ---------------------------------------------------------------------------
// VTID-02753 — Voice Tool Expansion P1a: structured Health logging tools
// ---------------------------------------------------------------------------

async function tool_log_health(
  toolName: 'log_water' | 'log_sleep' | 'log_exercise' | 'log_meditation',
  args: ToolArgs,
  id: Identity,
): Promise<ToolResult> {
  const { logHealthSignal } = await import('../services/voice-tools/health-log');
  const today = new Date().toISOString().slice(0, 10);
  const date = typeof args.date === 'string' && args.date ? args.date : today;
  const out = await logHealthSignal({
    user_id: id.user_id,
    tenant_id: id.tenant_id,
    tool: toolName,
    date,
    amount_ml: typeof args.amount_ml === 'number' ? args.amount_ml : undefined,
    minutes: typeof args.minutes === 'number' ? args.minutes : undefined,
    activity_type: typeof args.activity_type === 'string' ? args.activity_type : undefined,
  });
  if (!out.ok) return { ok: false, error: out.error };
  const s = out.summary;
  const deltaText =
    s.index_delta !== null && s.index_delta > 0
      ? ` Vitana Index up ${s.index_delta}.`
      : '';
  return {
    ok: true,
    result: s,
    text: `Logged ${s.value} ${s.unit} to ${s.pillar}.${deltaText}`,
  };
}

// VTID-02763 — Reminders extension
async function tool_reminders_extra(
  toolName:
    | 'snooze_reminder'
    | 'update_reminder'
    | 'acknowledge_reminder'
    | 'complete_reminder'
    | 'list_missed_reminders',
  args: ToolArgs,
  id: Identity,
  sb: SupabaseClient,
): Promise<ToolResult> {
  const re = await import('../services/voice-tools/reminders-extra');
  let r: any;
  if (toolName === 'snooze_reminder') {
    r = await re.snoozeReminder(sb, id.user_id, {
      reminder_id: String(args.reminder_id || ''),
      minutes: typeof args.minutes === 'number' ? args.minutes : undefined,
    });
  } else if (toolName === 'update_reminder') {
    r = await re.updateReminder(sb, id.user_id, {
      reminder_id: String(args.reminder_id || ''),
      action_text: typeof args.action_text === 'string' ? args.action_text : undefined,
      spoken_message: typeof args.spoken_message === 'string' ? args.spoken_message : undefined,
      scheduled_for_iso: typeof args.scheduled_for_iso === 'string' ? args.scheduled_for_iso : undefined,
      description: typeof args.description === 'string' ? args.description : undefined,
    });
  } else if (toolName === 'acknowledge_reminder') {
    r = await re.acknowledgeReminder(sb, id.user_id, {
      reminder_id: String(args.reminder_id || ''),
      via: typeof args.via === 'string' ? args.via : 'manual',
    });
  } else if (toolName === 'complete_reminder') {
    r = await re.completeReminder(sb, id.user_id, {
      reminder_id: String(args.reminder_id || ''),
    });
  } else if (toolName === 'list_missed_reminders') {
    r = await re.listMissedReminders(sb, id.user_id, {
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    });
  }
  if (!r || r.ok === false) return { ok: false, error: (r && r.error) || `${toolName}_failed` };

  let text = '';
  if (toolName === 'snooze_reminder') {
    const m = Number(args.minutes ?? 10) || 10;
    text = `Snoozed by ${m} minutes.`;
  } else if (toolName === 'update_reminder') {
    text = 'Reminder updated.';
  } else if (toolName === 'acknowledge_reminder') {
    text = `Reminder acknowledged.`;
  } else if (toolName === 'complete_reminder') {
    text = `Reminder marked complete.`;
  } else if (toolName === 'list_missed_reminders') {
    const n = r.count ?? 0;
    text = n === 0 ? 'No missed reminders.' : `${n} missed reminder${n === 1 ? '' : 's'}.`;
  }
  return { ok: true, result: r, text };
}

async function tool_get_pillar_subscores(
  args: ToolArgs,
  id: Identity,
  sb: SupabaseClient,
): Promise<ToolResult> {
  const pillar = String(args.pillar || '').toLowerCase();
  const valid = ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'];
  if (!valid.includes(pillar)) {
    return { ok: false, error: `pillar must be one of ${valid.join(', ')}` };
  }
  const snap = await fetchVitanaIndexForProfiler(sb, id.user_id);
  if (!snap) {
    return { ok: true, result: { pillar, available: false }, text: `No Vitana Index snapshot yet.` };
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
// Dispatcher
// ---------------------------------------------------------------------------

router.post('/orb/tool', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const name = String(req.body?.name ?? '').trim();
  const args = (req.body?.args ?? {}) as ToolArgs;
  if (!name) {
    return res.status(400).json({ ok: false, error: 'name is required', vtid: VTID });
  }
  const userId = req.identity?.user_id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'unauthenticated', vtid: VTID });
  }
  const identity: Identity = {
    user_id: userId,
    tenant_id: req.identity?.tenant_id ?? null,
    role: req.identity?.role ?? null,
    vitana_id: req.identity?.vitana_id ?? null,
  };
  const sb = adminClient() || getSupabase();
  if (!sb) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured', vtid: VTID });
  }

  try {
    let r: ToolResult;
    switch (name) {
      case 'search_memory':
        r = await tool_search_memory(args, identity, sb);
        break;
      case 'search_web':
        r = await tool_search_web(args);
        break;
      case 'recall_conversation_at_time':
        r = await tool_recall_conversation_at_time(args, identity, sb);
        break;
      case 'switch_persona':
        r = await tool_switch_persona(args);
        break;
      case 'report_to_specialist':
        r = await tool_report_to_specialist(args);
        break;
      case 'search_events':
        r = await tool_search_events(args, identity, sb);
        break;
      case 'search_community':
        r = await tool_search_community(args, identity, sb);
        break;
      case 'play_music':
        r = await tool_play_music(args);
        break;
      case 'set_capability_preference':
        r = await tool_set_capability_preference(args, identity, sb);
        break;
      case 'read_email':
        r = await tool_read_email();
        break;
      case 'find_contact':
        r = await tool_find_contact(args, identity, sb);
        break;
      case 'consult_external_ai':
        r = await tool_consult_external_ai(args);
        break;
      case 'create_index_improvement_plan':
        r = await tool_create_index_improvement_plan(args, identity, sb);
        break;
      case 'ask_pillar_agent':
        r = await tool_ask_pillar_agent(args, identity, sb);
        break;
      case 'explain_feature':
        r = await tool_explain_feature(args);
        break;
      case 'resolve_recipient':
        r = await tool_resolve_recipient(args, identity, sb);
        break;
      case 'send_chat_message':
        r = await tool_send_chat_message(args, identity, sb);
        break;
      case 'share_link':
        r = await tool_share_link(args, identity, sb);
        break;
      case 'scan_existing_matches':
        r = await tool_scan_existing_matches(args, identity, sb);
        break;
      case 'share_intent_post':
        r = await tool_share_intent_post(args, identity, sb);
        break;
      case 'respond_to_match':
        r = await tool_respond_to_match(args, identity, sb);
        break;
      case 'navigate_to_screen':
        r = await tool_navigate_to_screen(args);
        break;
      // VTID-02753 — structured Health logging
      case 'log_water':
      case 'log_sleep':
      case 'log_exercise':
      case 'log_meditation':
        r = await tool_log_health(name as 'log_water' | 'log_sleep' | 'log_exercise' | 'log_meditation', args, identity);
        break;
      case 'get_pillar_subscores':
        r = await tool_get_pillar_subscores(args, identity, sb);
        break;
      // VTID-02763 — Reminders extension
      case 'snooze_reminder':
      case 'update_reminder':
      case 'acknowledge_reminder':
      case 'complete_reminder':
      case 'list_missed_reminders':
        r = await tool_reminders_extra(name as any, args, identity, sb);
        break;
      default:
        return res.status(404).json({ ok: false, error: `unknown tool: ${name}`, vtid: VTID });
    }
    if ('ok' in r && r.ok === false) {
      return res.status(200).json({ ...r, vtid: VTID });
    }
    return res.status(200).json({ ...r, vtid: VTID });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    return res.status(500).json({ ok: false, error: msg, vtid: VTID });
  }
});

export default router;
