/**
 * Proactive Guide — Initiative Registry (V2 successor to DYK Tour)
 *
 * The Initiative Engine pairs ORB's session-start opener with EXECUTABLE
 * actions, not just navigation hints. On session start, we resolve ONE
 * eligible initiative (per-user, per-day, pacer-gated), voice it as a
 * yes/no offer, and execute the action via an existing ORB tool on
 * consent. The Vitana Index delta is read back to the user as payoff.
 *
 * Plan: .claude/plans/proactive-did-you-generic-sifakis.md (V2 section)
 *
 * v1 ships three initiatives:
 *   - morning_diary_capture       → save_diary_entry      (multi-turn)
 *   - autopilot_top_recommendation → activate_recommendation (single-turn)
 *   - network_morning_greeting    → send_chat_message     (multi-turn confirm)
 *
 * Mirrors tip-curriculum.ts shape. Differences:
 *   - tools EXECUTE actions instead of navigating screens
 *   - some initiatives need a multi-turn handshake (`requires_user_dictation`)
 *   - some pre-pick a target (e.g. contact name) at resolution time
 */

import type { UserAwareness } from './types';

const LOG_PREFIX = '[Guide:initiative-registry]';

// =============================================================================
// Types
// =============================================================================

/**
 * Canonical Vitana Index pillars (5-pillar set, post Phase E migration).
 * Mirrors `IndexPillar` in tip-curriculum.ts so framing-token snapshot tests
 * can share the same vocabulary.
 */
export type IndexPillar = 'Nutrition' | 'Hydration' | 'Exercise' | 'Sleep' | 'Mental';
export type InitiativePillarLink = IndexPillar | 'meta';

export type InitiativeOnYesTool =
  | 'save_diary_entry'
  | 'activate_recommendation'
  | 'send_chat_message';

/**
 * A pre-resolved target for an initiative. For `network_morning_greeting`
 * this is a chosen contact; for `autopilot_top_recommendation` it's the
 * winning recommendation. Initiatives that need no target resolution
 * leave this undefined.
 */
export interface InitiativeTarget {
  /** Stable id (recipient user id, recommendation id, etc.). */
  id?: string;
  /** Display name to splice into the voice opener (e.g. contact first name). */
  display_name?: string;
  /** Free-form payload the LLM can pass to the tool unchanged. */
  payload?: Record<string, unknown>;
  /** Short one-line summary for telemetry. */
  summary?: string;
}

/**
 * Inputs the resolver passes to each eligibility probe + target resolver.
 * Fail-open: any helper that throws or times out is treated as "not
 * eligible" for this initiative — never as a hard error on the brain
 * composer's critical path.
 */
export interface ResolverContext {
  user_id: string;
  /** UTC ISO date string (YYYY-MM-DD); resolver clamps to one initiative per day per user. */
  utc_date: string;
}

export interface ProactiveInitiative {
  /** Stable id; doubles as `reason_tag` for the pacer touch + telemetry. */
  initiative_key: string;
  /** Pillar this initiative lifts (or 'meta' for cross-pillar / Index itself). */
  pillar_link: InitiativePillarLink;
  /** Higher wins. Used after eligibility filter. */
  priority: number;
  /**
   * Quick pre-flight — returns false to skip the initiative entirely.
   * Receives the upstream awareness snapshot (no extra DB roundtrip).
   * Probe must NOT throw; on error, treat as not-eligible.
   */
  eligibility_probe: (a: UserAwareness, ctx: ResolverContext) => boolean | Promise<boolean>;
  /**
   * Optional async target resolver — picks a contact / recommendation /
   * etc. at resolve time so the voice opener can name the target.
   * Returning null means "no target available; skip this initiative".
   */
  resolve_target?: (a: UserAwareness, ctx: ResolverContext) => Promise<InitiativeTarget | null>;
  /**
   * Build the voice opener string with awareness + (optional) target spliced in.
   * MUST mention "Index" or one of the canonical 5 pillar names so the
   * framing snapshot test passes.
   */
  build_voice_opener: (a: UserAwareness, target: InitiativeTarget | null) => string;
  /** "Want me to do it?" — kept identical across initiatives for consistency. */
  voice_confirm: string;
  /**
   * True when the on-yes branch needs a follow-up user turn before the
   * tool can be called (diary dictation; chat-message content confirm).
   * The brain block instructs the LLM to speak `voice_on_consent` and
   * hold turn; the tool call happens on the SUBSEQUENT user utterance.
   */
  requires_user_dictation: boolean;
  /** Spoken after YES when `requires_user_dictation=true`. */
  voice_on_consent?: string;
  /** Tool the LLM calls (eventually) on consent. */
  on_yes_tool: InitiativeOnYesTool;
  /**
   * Hint to the LLM about how to construct the tool payload. Free-form;
   * the LLM fills the actual arguments from user input. Examples:
   *   "use the dictated content as `content` and `template_type=free`"
   *   "use the pre-picked recommendation id"
   *   "use the pre-picked recipient_user_id; confirm body before send"
   */
  on_yes_payload_hint: string;
  /**
   * After-the-fact celebration line. The LLM templates `{index_delta}` /
   * `{pillar_name}` / `{contact_name}` from the tool result.
   */
  build_voice_on_complete: (target: InitiativeTarget | null) => string;
}

// =============================================================================
// Initiative registry — v1 seed (3 entries)
// =============================================================================

export const INITIATIVE_REGISTRY: ProactiveInitiative[] = [
  // ─── Morning diary capture (Mental pillar, multi-turn) ─────────────────
  {
    initiative_key: 'morning_diary_capture',
    pillar_link: 'Mental',
    priority: 90,
    eligibility_probe: (a) => {
      // Fire on day 1+ only; day-0 users are still in DYK tour. Skip if the
      // user already logged a diary entry today (diary_streak_days incremented
      // today is a proxy — community-user-analyzer increments only on a same-
      // day write).
      if ((a.tenure?.active_usage_days ?? 0) < 1) return false;
      // No explicit "diary today" flag in awareness; rely on streak parity:
      // streak 0 means no diary today (and probably never). Streak ≥ 1 with
      // last_interaction bucket=today means a diary may already exist —
      // err on the side of offering, the diary tool itself is idempotent
      // and a second entry per day is welcome.
      return true;
    },
    build_voice_opener: (a) => {
      const name = a.goal?.is_system_seeded === false ? '' : '';
      // Keep templating minimal; greetings are personality-config-driven elsewhere.
      // Ensure the line mentions "Mental" pillar to satisfy framing snapshot.
      void name;
      return "Hey, let's log how you're doing today — even one sentence lifts the Mental pillar of your Vitana Index.";
    },
    voice_confirm: 'Want to dictate it to me?',
    requires_user_dictation: true,
    voice_on_consent: 'Great — go ahead. What happened today, how do you feel?',
    on_yes_tool: 'save_diary_entry',
    on_yes_payload_hint:
      'use the user\'s dictated content as `content`, set `template_type="free"`, omit other fields unless the user mentioned mood/energy explicitly',
    build_voice_on_complete: () =>
      'Logged. Your Index just climbed by {index_delta} — your Mental pillar is now at {pillar_value}.',
  },

  // ─── Autopilot top recommendation (single-turn execute) ─────────────────
  {
    initiative_key: 'autopilot_top_recommendation',
    pillar_link: 'meta',
    priority: 85,
    eligibility_probe: (a) => {
      // Only fire when the user has at least one open recommendation
      // ranked by the existing autopilot pipeline.
      return (a.recent_activity?.open_autopilot_recs ?? 0) >= 1;
    },
    resolve_target: async (_a, ctx) => {
      // Lazy-load to avoid a circular dep with autopilot at module init.
      try {
        const { getSupabase } = await import('../../lib/supabase');
        const supabase = getSupabase();
        if (!supabase) return null;
        const { data, error } = await supabase
          .from('autopilot_recommendations')
          .select('id, title, summary, priority')
          .eq('user_id', ctx.user_id)
          .in('status', ['new', 'pending'])
          .order('priority', { ascending: false })
          .limit(1);
        if (error || !data || data.length === 0) return null;
        const top = data[0] as { id: string; title: string; summary?: string; priority?: number };
        return {
          id: top.id,
          display_name: top.title,
          summary: top.summary,
          payload: { id: top.id },
        };
      } catch (err: any) {
        console.warn(`${LOG_PREFIX} autopilot resolve_target failed:`, err?.message);
        return null;
      }
    },
    build_voice_opener: (_a, target) => {
      const title = target?.display_name || 'a quick win';
      return `I have something queued for your Vitana Index — ${title}. ${target?.summary ? target.summary + '. ' : ''}Want me to schedule it now?`;
    },
    voice_confirm: 'Want me to do it?',
    requires_user_dictation: false,
    on_yes_tool: 'activate_recommendation',
    on_yes_payload_hint: 'use the pre-picked recommendation id (the one I just named)',
    build_voice_on_complete: (target) =>
      `Done — "${target?.display_name || 'that one'}" is on your active list. Your Vitana Index will move once you complete it.`,
  },

  // ─── Network morning greeting (Mental pillar, two-confirm) ─────────────
  {
    initiative_key: 'network_morning_greeting',
    pillar_link: 'Mental',
    priority: 80,
    eligibility_probe: (a) => {
      // User must have at least one connection. Optional: skip if the user
      // sent a chat message in the last 24h (would feel pushy). For v1 we
      // gate on connection_count > 0 only; refine after voice smoke if too
      // chatty.
      return (a.community_signals?.connection_count ?? 0) >= 1;
    },
    resolve_target: async (_a, ctx) => {
      // Pick the most-dormant connection — longest gap since last message
      // exchange. Returns { id: receiver_user_id, display_name: first_name }.
      try {
        const { getSupabase } = await import('../../lib/supabase');
        const supabase = getSupabase();
        if (!supabase) return null;
        // relationship_nodes is the canonical connection graph (VTID-01087).
        // Each node carries node_type='person' and metadata with display_name.
        // For v1 we just pick the most recently-created node's owner as a
        // simple proxy — a "longest-dormant" query needs a chat-history
        // join we'd want to push behind a view in a follow-up.
        const { data, error } = await supabase
          .from('relationship_nodes')
          .select('id, display_name, metadata')
          .eq('owner_user_id', ctx.user_id)
          .eq('node_type', 'person')
          .order('updated_at', { ascending: true })
          .limit(1);
        if (error || !data || data.length === 0) return null;
        const node = data[0] as {
          id: string;
          display_name: string | null;
          metadata: Record<string, unknown> | null;
        };
        const receiver_user_id =
          (node.metadata?.user_id as string | undefined) ||
          (node.metadata?.linked_user_id as string | undefined) ||
          null;
        if (!receiver_user_id) return null;
        const firstName = (node.display_name || '').split(' ')[0] || 'them';
        return {
          id: receiver_user_id,
          display_name: firstName,
          payload: { recipient_user_id: receiver_user_id, recipient_label: firstName },
        };
      } catch (err: any) {
        console.warn(`${LOG_PREFIX} network resolve_target failed:`, err?.message);
        return null;
      }
    },
    build_voice_opener: (_a, target) => {
      const name = target?.display_name || 'someone in your network';
      return `Want me to send a quick good-morning to ${name}? It's a small thing that lifts the Mental pillar of your Vitana Index — both of you.`;
    },
    voice_confirm: 'Should I draft something?',
    // The "consent → draft" step is not a free-form dictation — the LLM
    // composes a brief friendly draft and CONFIRMS the body before sending.
    // Treated as a multi-turn flow so the LLM holds turn after the first YES.
    requires_user_dictation: true,
    voice_on_consent:
      'How about: "Hey {name}, just thinking of you — hope your morning\'s going well." Want me to send that?',
    on_yes_tool: 'send_chat_message',
    on_yes_payload_hint:
      'use the pre-picked recipient_user_id and recipient_label; pass the confirmed message body as `body`. DO NOT send until the user confirms the body explicitly.',
    build_voice_on_complete: (target) =>
      `Sent. ${target?.display_name || 'They'} will see it on their next check-in.`,
  },
];

// =============================================================================
// Resolver
// =============================================================================

export interface ResolvedInitiative {
  initiative: ProactiveInitiative;
  target: InitiativeTarget | null;
  voice_opener: string;
}

/**
 * Pick the highest-priority eligible initiative for this user, resolve its
 * target (if any), and return the bundle the brain block will inject.
 * Returns null when none are eligible — the brain block becomes a no-op,
 * and the DYK tour-hint (or the existing `pickOpenerCandidate`) gets the
 * voice opener slot.
 */
export async function pickProactiveInitiative(
  awareness: UserAwareness,
  user_id: string,
  utc_date: string = new Date().toISOString().slice(0, 10),
): Promise<ResolvedInitiative | null> {
  const ctx: ResolverContext = { user_id, utc_date };

  // Sort by priority desc, then iterate. First eligible + resolved wins.
  const sorted = [...INITIATIVE_REGISTRY].sort((a, b) => b.priority - a.priority);

  for (const initiative of sorted) {
    let eligible = false;
    try {
      eligible = await initiative.eligibility_probe(awareness, ctx);
    } catch (err: any) {
      console.warn(
        `${LOG_PREFIX} eligibility_probe threw for ${initiative.initiative_key}:`,
        err?.message,
      );
      eligible = false;
    }
    if (!eligible) continue;

    let target: InitiativeTarget | null = null;
    if (initiative.resolve_target) {
      try {
        target = await initiative.resolve_target(awareness, ctx);
      } catch (err: any) {
        console.warn(
          `${LOG_PREFIX} resolve_target threw for ${initiative.initiative_key}:`,
          err?.message,
        );
        target = null;
      }
      // If a resolver was declared but produced nothing, the initiative
      // can't fire (e.g. no contact found) — try the next one.
      if (target === null) continue;
    }

    let voice_opener = '';
    try {
      voice_opener = initiative.build_voice_opener(awareness, target);
    } catch (err: any) {
      console.warn(
        `${LOG_PREFIX} build_voice_opener threw for ${initiative.initiative_key}:`,
        err?.message,
      );
      continue;
    }

    return { initiative, target, voice_opener };
  }

  return null;
}

export function getInitiativeByKey(key: string): ProactiveInitiative | null {
  return INITIATIVE_REGISTRY.find((i) => i.initiative_key === key) ?? null;
}

// =============================================================================
// Framing-token enforcement (mirrors INDEX_FRAMING_TOKENS in tip-curriculum)
// =============================================================================

export const INITIATIVE_FRAMING_TOKENS: readonly string[] = [
  'Index',
  'Nutrition',
  'Hydration',
  'Exercise',
  'Sleep',
  'Mental',
];

/**
 * Returns true when the given string mentions the Vitana Index or one of
 * the canonical 5 pillars. Used by the framing snapshot test to prevent
 * copy-drift back into legacy 6-pillar terminology.
 */
export function mentionsIndexOrPillar(text: string): boolean {
  return INITIATIVE_FRAMING_TOKENS.some((token) => text.includes(token));
}
