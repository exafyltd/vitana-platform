/**
 * Conversation Flow v3 — ORB wake-brief provider (live wiring).
 *
 * Flag-gated by `vitana_journey_conversation_v2_enabled`. When ON it is the
 * primary turn-1 author for community voice: it surfaces ONE of, in priority
 * order, a new community match → the next un-learned Guided Journey topic → a
 * "play you a song" delight offer. When OFF it suppresses (legacy Teacher /
 * wake-brief own turn 1, unchanged).
 *
 * Contract (see services/guide/conversation-flow-v3.ts):
 *   - Match & song use the DETERMINISTIC consent path: cta = ask_permission
 *     with onYesTool='navigate_to_screen' + payload.url. The existing
 *     wake-brief wiring persists this to `pending_cta` and the turn handler
 *     fires the navigation on the user's "yes" — no reliance on the LLM
 *     emitting a tool call (the original "confirm → can't show" bug).
 *   - Topic NAMES the feature and asks permission to INTRODUCE it verbally
 *     first; the screen-open is a later, separate offer (no premature nav).
 *   - Match is privacy-safe: the matched person's name is NEVER spoken (the
 *     mutual-reveal gate on intent_matches), only "you have a new match".
 *
 * Selection is read-only. Pure decision lives in the v3 engine; this provider
 * is the thin DB-fetch + render shell (mirrors feature-discovery-teacher.ts).
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AssistantContinuation,
  ContinuationProvider,
  ContinuationDecisionContext,
  ProviderResult,
} from '../types';
import { getSystemControl } from '../../system-controls-service';
import {
  pickFlowFocus,
  type FlowInputs,
  type JourneyTopicInput,
} from '../../guide/conversation-flow-v3';

export const FLOW_V3_EXTRA_KEY = 'conversation_flow_v3' as const;
export const FLOW_V3_PROVIDER_KEY = 'conversation_flow_v3' as const;
export const FLOW_V3_FLAG = 'vitana_journey_conversation_v2_enabled' as const;

// Priority 88 — above the legacy Teacher (85) and the bare wake-brief (80),
// below the genuinely-higher specific authors (journey-guide 91, new-day 90,
// goal 92, first-time 95, explicit guided-topic tap 96), which still lead
// their cases. Reversible via the flag.
const DEFAULT_PRIORITY = 88;

export interface FlowV3Inputs {
  supabase: SupabaseClient;
  tenantId: string;
  userId: string;
  lang: string;
  firstName?: string | null;
}

export interface FlowV3ProviderOptions {
  priority?: number;
  newId?: () => string;
  now?: () => number;
}

function isGerman(lang: string): boolean {
  return (lang || '').toLowerCase().startsWith('de');
}

export function makeConversationFlowV3Provider(
  opts: FlowV3ProviderOptions = {},
): ContinuationProvider {
  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? (() => Date.now());
  const priority = opts.priority ?? DEFAULT_PRIORITY;

  return {
    key: FLOW_V3_PROVIDER_KEY,
    surfaces: ['orb_wake'],
    async produce(ctx: ContinuationDecisionContext): Promise<ProviderResult> {
      const t0 = now();
      const inputs = readInputs(ctx);
      if (!inputs) {
        return { providerKey: FLOW_V3_PROVIDER_KEY, status: 'skipped', latencyMs: 0, reason: 'no_inputs' };
      }

      // Kill switch / staged rollout: off → suppress, legacy path owns turn 1.
      const flag = await getSystemControl(FLOW_V3_FLAG).catch(() => null);
      if (!flag || !flag.enabled) {
        return {
          providerKey: FLOW_V3_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: 'flag_disabled',
        };
      }

      // Fetch the three signals in parallel. Each fails open to "absent".
      const [hasMatch, nextTopic, songAvailable] = await Promise.all([
        fetchHasNewMatch(inputs.supabase, inputs.userId),
        fetchNextUnlearnedTopic(inputs.supabase, inputs.userId),
        fetchSongAvailable(inputs.supabase),
      ]);

      const flowInputs: FlowInputs = {
        has_urgent: false, // urgent reminders are a higher-priority provider already
        new_match: hasMatch ? { first_name: null } : null, // privacy: never speak the name
        next_topic: nextTopic,
        song_available: songAvailable,
        recently_surfaced: new Set<string>(), // ranker handles cross-session dedupe via dedupeKey
        date_key: new Date().toISOString().slice(0, 10),
      };

      const focus = pickFlowFocus(flowInputs);
      const de = isGerman(inputs.lang);

      if (focus.kind === 'greeting' || focus.kind === 'defer_to_urgent') {
        return {
          providerKey: FLOW_V3_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: `nothing_to_surface:${focus.kind}`,
        };
      }

      let candidate: AssistantContinuation;

      if (focus.kind === 'community_match') {
        // Privacy-safe: no name (mutual-reveal gate). Quick permission → the
        // gateway fires /me/matches deterministically on the user's "yes".
        candidate = {
          id: `flowv3-match-${newId()}`,
          surface: 'orb_wake',
          kind: 'match_journey_next_move',
          priority,
          userFacingLine: de
            ? 'Du hast ein neues Match! Soll ich dich direkt hinbringen?'
            : 'You have a new match! Want me to take you straight there?',
          cta: {
            type: 'ask_permission',
            onYesTool: 'navigate_to_screen',
            payload: { url: '/me/matches' },
          },
          evidence: [{ kind: 'flowv3:community_match', detail: 'new_match' }],
          dedupeKey: focus.nudge_key,
          privacyMode: 'safe_to_speak',
        };
      } else if (focus.kind === 'journey_topic') {
        // NAME it + ask to INTRODUCE verbally. No deterministic nav here — the
        // screen-open is a separate later offer (the LLM offers it after the
        // verbal intro). The value is the named verbal introduction.
        candidate = {
          id: `flowv3-topic-${newId()}`,
          surface: 'orb_wake',
          kind: 'feature_discovery',
          priority,
          userFacingLine: de
            ? `Darf ich dir ${focus.name} kurz vorstellen?`
            : `May I quickly introduce you to ${focus.name}?`,
          cta: {
            // No onYesTool: "yes" leads to the VERBAL introduction, not a jump.
            type: 'ask_permission',
            payload: {
              topic: focus.name,
              route: focus.pending_action?.route ?? null,
              // The LLM introduces verbally first, then MAY offer to open the
              // screen; if accepted it navigates to `route`.
              flow: 'introduce_then_offer_screen',
            },
          },
          evidence: [{ kind: 'flowv3:journey_topic', detail: focus.name }],
          dedupeKey: focus.nudge_key,
          privacyMode: 'safe_to_speak',
        };
      } else {
        // song
        candidate = {
          id: `flowv3-song-${newId()}`,
          surface: 'orb_wake',
          kind: 'check_in',
          priority,
          userFacingLine: de
            ? 'Ich würde dir gern einen Song vorspielen — darf ich?'
            : "I'd love to play you a song — may I?",
          cta: {
            type: 'ask_permission',
            onYesTool: 'navigate_to_screen',
            payload: { url: '/comm/media-hub?tab=music&autoplay=random' },
          },
          evidence: [{ kind: 'flowv3:song', detail: 'media_hub_autoplay' }],
          dedupeKey: focus.nudge_key,
          privacyMode: 'safe_to_speak',
        };
      }

      console.log(
        `[FLOWV3-PICK] user=${inputs.userId.slice(0, 8)} lang=${inputs.lang} kind=${focus.kind} ` +
          `nudge=${focus.nudge_key} line="${candidate.userFacingLine}"`,
      );

      return {
        providerKey: FLOW_V3_PROVIDER_KEY,
        status: 'returned',
        latencyMs: Math.max(0, now() - t0),
        candidate,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Inputs + fetchers (fail-open)
// ---------------------------------------------------------------------------

function readInputs(ctx: ContinuationDecisionContext): FlowV3Inputs | null {
  const raw = (ctx.extra as Record<string, unknown> | undefined)?.[FLOW_V3_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const supabase = o.supabase;
  if (!supabase || typeof supabase !== 'object' || typeof (supabase as { from?: unknown }).from !== 'function') {
    return null;
  }
  if (typeof o.tenantId !== 'string' || !o.tenantId) return null;
  if (typeof o.userId !== 'string' || !o.userId) return null;
  return {
    supabase: supabase as SupabaseClient,
    tenantId: o.tenantId,
    userId: o.userId,
    lang: typeof o.lang === 'string' && o.lang ? o.lang : 'en',
    firstName: typeof o.firstName === 'string' && o.firstName.trim() ? o.firstName : null,
  };
}

/** A new community match exists (privacy-gated name resolution deferred). */
async function fetchHasNewMatch(supabase: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const intents = await supabase
      .from('user_intents')
      .select('intent_id')
      .eq('requester_user_id', userId)
      .limit(50);
    if (intents.error || !intents.data || intents.data.length === 0) return false;
    const ids = (intents.data as Array<{ intent_id: string }>)
      .map((r) => r.intent_id)
      .filter(Boolean);
    if (ids.length === 0) return false;
    const idList = ids.map((s) => `"${s}"`).join(',');
    const matches = await supabase
      .from('intent_matches')
      .select('match_id', { count: 'exact', head: true })
      .or(`intent_a_id.in.(${idList}),intent_b_id.in.(${idList})`)
      .eq('state', 'new');
    if (matches.error) return false;
    return (matches.count ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Next published+enabled topic NOT yet green-checked, in (session, position) order. */
async function fetchNextUnlearnedTopic(
  supabase: SupabaseClient,
  userId: string,
): Promise<JourneyTopicInput | null> {
  try {
    const state = await supabase
      .from('user_guided_journey_state')
      .select('completed_topic_ids, current_session')
      .eq('user_id', userId)
      .maybeSingle();
    const completed = new Set<string>(
      (state.data?.completed_topic_ids as string[] | null | undefined) ?? [],
    );
    const fromSession = Math.max(1, Number(state.data?.current_session ?? 1) || 1);

    const topics = await supabase
      .from('journey_checklist_topics')
      .select('topic_id, title, display_label, short_description, vitana_voice_script, manual_path, session, position')
      .eq('status', 'published')
      .eq('enabled', true)
      .gte('session', fromSession)
      .order('session', { ascending: true })
      .order('position', { ascending: true })
      .limit(50);
    if (topics.error || !topics.data) return null;

    type Row = {
      topic_id: string;
      title: string | null;
      display_label: string | null;
      short_description: string | null;
      vitana_voice_script: string | null;
      manual_path: string | null;
      session: number;
    };
    const next = (topics.data as Row[]).find((r) => !completed.has(r.topic_id));
    if (!next) return null;
    const name = (next.title || next.display_label || '').trim();
    if (!name) return null;
    return {
      topic_id: next.topic_id,
      name,
      voice_script: next.vitana_voice_script,
      short_description: next.short_description,
      route: next.manual_path,
      session: next.session,
    };
  } catch {
    return null;
  }
}

/** At least one approved, public music track exists. */
async function fetchSongAvailable(supabase: SupabaseClient): Promise<boolean> {
  try {
    const res = await supabase
      .from('media_uploads')
      .select('id', { count: 'exact', head: true })
      .eq('media_type', 'music')
      .eq('status', 'approved')
      .eq('is_public', true);
    if (res.error) return false;
    return (res.count ?? 0) > 0;
  } catch {
    return false;
  }
}
