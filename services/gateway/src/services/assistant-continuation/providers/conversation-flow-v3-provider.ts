/**
 * Conversation Flow v3 — ORB wake-brief provider (SAFE rebuild).
 *
 * LESSON FROM THE BREAKAGE: the previous version put a `navigate_to_screen`
 * action on the opener candidate. That fired navigation AT THE GREETING TURN,
 * which the live session treats as a post-tool turn and DROPS the greeting
 * audio (session.navigationDispatched) → no voice + premature redirect. This
 * rebuild does the OPPOSITE: the opener ONLY SPEAKS — exactly like the
 * production Teacher / login-briefing providers — with a benign `offer_demo`
 * CTA that performs NO navigation. There is no screen change at greeting.
 * Redirect/"show the screen" is a LATER, separate step (future iteration),
 * never bundled into the first utterance.
 *
 * RULE 0 (non-negotiable): every line is a PROPOSAL. Vitana never asks the
 * user to supply the direction ("what can I do for you?" / "was möchtest
 * du?"). It names the next step itself.
 *
 * Flag-gated by `vitana_journey_conversation_v2_enabled` (default OFF / kill
 * switch). OFF → self-suppress, legacy ladder unchanged.
 *
 * Behaviour by focus (priority match → un-learned topic → song → none):
 *   - match : announces the new match BY NOTHING-private and leads to it
 *             ("Du hast ein neues Match! …") — privacy: never the name.
 *   - topic : NAMES the un-learned Guided-Journey feature and asks permission
 *             to INTRODUCE it ("Darf ich dir <Feature> vorstellen?").
 *   - song  : offers to play a song ("Ich würde dir gern einen Song
 *             vorspielen — darf ich?").
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
import { pickFlowFocus, type FlowInputs, type JourneyTopicInput } from '../../guide/conversation-flow-v3';

export const FLOW_V3_EXTRA_KEY = 'conversation_flow_v3' as const;
export const FLOW_V3_PROVIDER_KEY = 'conversation_flow_v3' as const;
export const FLOW_V3_FLAG = 'vitana_journey_conversation_v2_enabled' as const;

// Priority 88 — above the legacy Teacher (85) + bare wake-brief (80), below
// the genuinely-higher specific authors (journey-guide 91, login-briefing 93,
// goal 92, first-time 95, explicit guided-topic tap 96). Self-suppresses when
// the flag is off, so registering always is safe.
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

const de = (lang: string) => (lang || '').toLowerCase().startsWith('de');

export function makeConversationFlowV3Provider(opts: FlowV3ProviderOptions = {}): ContinuationProvider {
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

      const flag = await getSystemControl(FLOW_V3_FLAG).catch(() => null);
      if (!flag || !flag.enabled) {
        return {
          providerKey: FLOW_V3_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: 'flag_disabled',
        };
      }

      const [hasMatch, nextTopic, songAvailable] = await Promise.all([
        fetchHasNewMatch(inputs.supabase, inputs.userId),
        fetchNextUnlearnedTopic(inputs.supabase, inputs.userId),
        fetchSongAvailable(inputs.supabase),
      ]);

      const flowInputs: FlowInputs = {
        has_urgent: false,
        new_match: hasMatch ? { first_name: null } : null, // privacy: never speak the name
        next_topic: nextTopic,
        song_available: songAvailable,
        recently_surfaced: new Set<string>(),
        date_key: new Date().toISOString().slice(0, 10),
      };

      const focus = pickFlowFocus(flowInputs);
      if (focus.kind === 'greeting' || focus.kind === 'defer_to_urgent') {
        return {
          providerKey: FLOW_V3_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: `nothing_to_surface:${focus.kind}`,
        };
      }

      const G = de(inputs.lang);
      let userFacingLine: string;
      let kind: AssistantContinuation['kind'];

      if (focus.kind === 'community_match') {
        // SPEAK ONLY. No navigation here — Vitana announces and leads; the
        // actual screen change is a later step, never at greeting (privacy:
        // no name). RULE 0: a proposal, not a question.
        kind = 'match_journey_next_move';
        userFacingLine = G
          ? 'Du hast ein neues Match! Lass es uns gemeinsam anschauen — ich führe dich gleich hin.'
          : 'You have a new match! Let\'s look at it together — I\'ll take you there in a moment.';
      } else if (focus.kind === 'journey_topic') {
        kind = 'feature_discovery';
        userFacingLine = G
          ? `Darf ich dir ${focus.name} kurz vorstellen und erklären, wie es funktioniert?`
          : `May I quickly introduce you to ${focus.name} and explain how it works?`;
      } else {
        kind = 'check_in';
        userFacingLine = G
          ? 'Ich würde dir gern einen Song vorspielen — darf ich?'
          : "I'd love to play you a song — may I?";
      }

      const candidate: AssistantContinuation = {
        id: `flowv3-${focus.kind}-${newId()}`,
        surface: 'orb_wake',
        kind,
        priority,
        userFacingLine,
        // BENIGN cta — speaks only, performs no navigation (mirrors the
        // Teacher's offer_demo). The route is carried as DATA for a future
        // post-speech step; it is NOT a navigate directive.
        cta: {
          type: 'offer_demo',
          payload: {
            flow_kind: focus.kind,
            topic: focus.name || undefined,
            route_hint: focus.pending_action?.route ?? undefined,
          },
        },
        evidence: [{ kind: `flowv3:${focus.kind}`, detail: focus.name || focus.kind }],
        dedupeKey: focus.nudge_key,
        privacyMode: 'safe_to_speak',
      };

      console.log(
        `[FLOWV3-PICK] user=${inputs.userId.slice(0, 8)} lang=${inputs.lang} kind=${focus.kind} line="${userFacingLine}"`,
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

async function fetchHasNewMatch(supabase: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const intents = await supabase
      .from('user_intents')
      .select('intent_id')
      .eq('requester_user_id', userId)
      .limit(50);
    if (intents.error || !intents.data || intents.data.length === 0) return false;
    const ids = (intents.data as Array<{ intent_id: string }>).map((r) => r.intent_id).filter(Boolean);
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

async function fetchNextUnlearnedTopic(supabase: SupabaseClient, userId: string): Promise<JourneyTopicInput | null> {
  try {
    const state = await supabase
      .from('user_guided_journey_state')
      .select('completed_topic_ids, current_session')
      .eq('user_id', userId)
      .maybeSingle();
    const completed = new Set<string>((state.data?.completed_topic_ids as string[] | null | undefined) ?? []);
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
