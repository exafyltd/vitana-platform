/**
 * Conversation Flow v3 — the unified ORB opener decision engine.
 *
 * Replaces the abstract "darf ich dir kurz etwas zeigen?" Teacher invitation
 * and the scattered opener lineages with ONE pure decision per activation.
 *
 * The user's contract (do NOT regress these):
 *   - Topic offers NAME the feature up front and INTRODUCE it verbally — the
 *     word "show" is reserved for the SECOND, visual step (offer to open the
 *     screen) which only comes AFTER the verbal introduction.
 *   - One topic at a time, always a polite permission ask ("darf ich…?").
 *   - A new community MATCH outranks teaching and navigates RIGHT AWAY
 *     (no permission gate) — "Hey Mariia, du hast ein neues Match…".
 *   - A "play you a song" delight offer: permission-gated, then redirect to
 *     the Media Hub and autoplay a RANDOM approved track.
 *   - Teaching content + wording come from the Guided Journey (94 sessions /
 *     254 topics); only topics NOT yet green-checked are eligible.
 *
 * This module is PURE (no DB, no IO) so the decision table is unit-testable.
 * A thin fetcher supplies the inputs; the renderer turns the decision into a
 * prompt block + an armed pending action the live session can fire
 * deterministically on the user's "yes".
 *
 * Spec: docs/SPEC-journey-conversation-v2.md (extended) + this file's contract.
 */

export type FlowFocusKind =
  | 'community_match'   // top priority, immediate redirect, NOT permission-gated
  | 'journey_topic'     // name → introduce verbally → offer to open the screen
  | 'song'              // permission-gated → redirect to Media Hub + autoplay
  | 'greeting'          // nothing to surface — light greeting / pause
  | 'defer_to_urgent';  // an urgent reminder/calendar item pre-empts everything

/** A journey topic already filtered to "not yet green-checked" (un-learned). */
export interface JourneyTopicInput {
  topic_id: string;
  /** Human name of the feature/topic, e.g. "Life Compass". */
  name: string;
  /** Verbal introduction wording, sourced from the topic content. */
  voice_script: string | null;
  /** Short fallback explanation when voice_script is empty. */
  short_description: string | null;
  /** The mobile route/overlay this topic opens, e.g. "/memory?open=life_compass". */
  route: string | null;
  session: number;
}

export interface FlowInputs {
  /** An urgent, time-sensitive reminder/calendar item exists — pre-empts all. */
  has_urgent: boolean;
  /** A new, unseen community match. firstName drives "Hey {name}". */
  new_match: { first_name: string | null } | null;
  /** Next un-learned Guided Journey topic, or null when all green / none. */
  next_topic: JourneyTopicInput | null;
  /** At least one approved track exists in the Media Hub music list. */
  song_available: boolean;
  /** Pace/dedupe: nudge_keys already surfaced recently (skip them). */
  recently_surfaced: Set<string>;
  /** YYYY-MM-DD for date-stamped, once-per-day nudge keys. */
  date_key: string;
}

/** The route + behavior the live session arms and fires on the user's "yes". */
export interface PendingVisualAction {
  route: string;
  /** Fire WITHOUT a permission turn (matches) vs. only after an explicit yes. */
  immediate: boolean;
  /** Media Hub autoplay marker — already encoded in the route, surfaced for logs. */
  autoplay_random?: boolean;
}

export interface FlowFocus {
  kind: FlowFocusKind;
  nudge_key: string;
  /** The feature/topic/subject name to speak. Empty for greeting/urgent. */
  name: string;
  /** Verbal-introduction script (journey topic only). */
  verbal_script?: string;
  /** Reason for the LLM (not spoken verbatim). */
  reason: string;
  /** The deterministic navigation to fire on consent (null for greeting/urgent). */
  pending_action: PendingVisualAction | null;
}

/**
 * Pick the single conversation focus for this activation.
 *
 * Priority (highest first):
 *   0. urgent reminder/calendar → defer (engine does not override safety/time)
 *   1. new community match       → immediate redirect
 *   2. next un-learned topic     → name + introduce + offer to open
 *   3. song offer                → permission → redirect + autoplay
 *   4. greeting                  → nothing to surface
 */
export function pickFlowFocus(inputs: FlowInputs): FlowFocus {
  if (inputs.has_urgent) {
    return {
      kind: 'defer_to_urgent',
      nudge_key: 'urgent',
      name: '',
      reason: 'an urgent time-sensitive reminder/calendar item pre-empts the opener',
      pending_action: null,
    };
  }

  // 1. New community match — top priority, immediate redirect, no permission ask.
  if (inputs.new_match) {
    const key = `match:${inputs.date_key}`;
    if (!inputs.recently_surfaced.has(key)) {
      return {
        kind: 'community_match',
        nudge_key: key,
        name: (inputs.new_match.first_name || '').trim(),
        reason:
          'a new community match — lead by name and redirect to the matches screen immediately (no permission ask)',
        pending_action: { route: '/me/matches', immediate: true },
      };
    }
  }

  // 2. Next un-learned Guided Journey topic — name it, introduce verbally,
  //    THEN offer to open the screen.
  if (inputs.next_topic) {
    const t = inputs.next_topic;
    const key = `topic:${t.topic_id}:${inputs.date_key}`;
    if (!inputs.recently_surfaced.has(key) && t.name.trim().length > 0) {
      const script = (t.voice_script || t.short_description || '').trim();
      return {
        kind: 'journey_topic',
        nudge_key: key,
        name: t.name.trim(),
        verbal_script: script,
        reason: `next un-learned Guided Journey topic (session ${t.session}) — name it, introduce it verbally, then offer to open its screen`,
        // Route may be null when the topic has no screen mapping yet; the
        // renderer omits the "open screen" offer in that case.
        pending_action: t.route
          ? { route: t.route, immediate: false }
          : null,
      };
    }
  }

  // 3. Song delight offer — permission-gated, then redirect + autoplay random.
  if (inputs.song_available) {
    const key = `song:${inputs.date_key}`;
    if (!inputs.recently_surfaced.has(key)) {
      return {
        kind: 'song',
        nudge_key: key,
        name: '',
        reason:
          'offer to play a song; on consent, redirect to the Media Hub music tab and autoplay a random approved track',
        pending_action: {
          route: '/comm/media-hub?tab=music&autoplay=random',
          immediate: false,
          autoplay_random: true,
        },
      };
    }
  }

  // 4. Nothing to surface — light greeting / pause.
  return {
    kind: 'greeting',
    nudge_key: 'greeting',
    name: '',
    reason: 'no match, no un-learned topic, no song to offer — keep it to a light greeting',
    pending_action: null,
  };
}

/**
 * Affirmative detection for the deterministic "yes → fire the pending action"
 * path. Pure + multilingual (DE/EN/ES/SR + common variants). Conservative:
 * only matches clear acceptances so we never navigate on an ambiguous turn.
 *
 * Word-set + phrase matching (Unicode-safe — ASCII \b breaks after accented
 * letters like "sí"/"später", so we tokenize on \p{L} with the `u` flag).
 * Negation always wins.
 */
const AFFIRM_WORDS = new Set([
  'yes', 'yeah', 'yep', 'sure', 'okay', 'ok',
  'ja', 'jawohl', 'gerne', 'gern', 'klar', 'mach', 'zeig', 'los', 'bitte',
  'si', 'sí', 'claro', 'vale', 'dale',
  'da', 'naravno', 'vazi', 'važi', 'hajde', 'molim',
]);
const AFFIRM_PHRASES = ['please do', 'go ahead', 'do it', 'show me', 'sounds good', 'na klar', 'por favor', 'adelante'];

const NEG_WORDS = new Set(['no', 'nope', 'nein', 'nee', 'ne', 'skip', 'later', 'lass']);
const NEG_PHRASES = [
  'not now', "don't", 'dont',
  'nicht jetzt', 'später', 'spater',
  'ahora no', 'más tarde', 'mas tarde', 'para nada',
  'kasnije', 'preskoči', 'preskoci',
];

export function detectAffirmative(userText: string): boolean {
  const raw = (userText || '').toLowerCase().trim();
  if (raw.length === 0) return false;
  // Negation anywhere wins (e.g. "no, gerne nicht").
  if (NEG_PHRASES.some((p) => raw.includes(p))) return false;
  const words = raw.split(/[^\p{L}]+/u).filter(Boolean);
  if (words.some((w) => NEG_WORDS.has(w))) return false;
  if (AFFIRM_PHRASES.some((p) => raw.includes(p))) return true;
  return words.some((w) => AFFIRM_WORDS.has(w));
}

/**
 * Render the focus as a prompt block. Instructions only — the words are
 * generated in the user's language (the caller injects the language
 * directive). NEVER contains a sanctioned user-facing sentence to recite.
 */
export function renderFlowFocusBlock(focus: FlowFocus): string {
  switch (focus.kind) {
    case 'defer_to_urgent':
      return ''; // urgent path owns turn 1; v3 stays out of the way.

    case 'community_match':
      return [
        '=== OPENER: NEW COMMUNITY MATCH (highest priority, immediate) ===',
        `The user has a new community match.${focus.name ? ` Their first name is "${focus.name}".` : ''}`,
        'Open warmly BY NAME and tell them you are taking them straight there —',
        'e.g. "Hey {name}, du hast ein neues Match — ich bringe dich direkt hin."',
        'This is NOT a permission ask. Do not ask "darf ich"; you are already taking them.',
        `The app navigates to ${focus.pending_action?.route} immediately. Speak ONE warm sentence.`,
        "Generate it in the user's language per the language directive. Never English for a non-English user.",
      ].join('\n');

    case 'journey_topic': {
      const lines = [
        '=== OPENER: INTRODUCE ONE GUIDED-JOURNEY FEATURE (named, verbal-first) ===',
        `The feature to introduce is "${focus.name}". You MUST name it up front — never "may I show you something" abstractly.`,
        '',
        'STEP 1 — Ask permission to INTRODUCE it (polite, named, NOT "show"):',
        `  e.g. "Darf ich dir ${focus.name} kurz vorstellen?" / "May I introduce you to ${focus.name}?"`,
        '  Wait for the user to say yes.',
        '',
        'STEP 2 — On yes, INTRODUCE it VERBALLY (explain how it works, in speech):',
        focus.verbal_script
          ? `  Base your explanation on this content (paraphrase naturally, in the user's language):\n  "${truncate(focus.verbal_script, 600)}"`
          : `  Explain in 2-3 sentences what ${focus.name} is and how it helps.`,
        '  Do NOT open any screen yet. This step is voice-only.',
      ];
      if (focus.pending_action) {
        lines.push(
          '',
          'STEP 3 — ONLY AFTER the verbal introduction, offer the VISUAL:',
          `  e.g. "Möchtest du, dass ich dir den Bildschirm dazu öffne?" / "Want me to open the screen for it?"`,
          `  On yes, the app opens ${focus.pending_action.route}.`,
        );
      }
      lines.push(
        '',
        'Rules: ONE feature only. "show"/"open the screen" belongs to STEP 3, never STEP 1.',
        "Generate every line in the user's language per the language directive.",
        `On decline at any step, accept gracefully and stop (pause nudge_key="${focus.nudge_key}").`,
      );
      return lines.join('\n');
    }

    case 'song':
      return [
        '=== OPENER: OFFER TO PLAY A SONG (delight, permission-gated) ===',
        'Offer, politely, to play the user a song —',
        '  e.g. "Ich würde dir gern einen Song vorspielen — darf ich?" / "I would love to play you a song — may I?"',
        `On yes, the app opens ${focus.pending_action?.route} and a random approved track starts right away.`,
        'Speak ONE short warm line afterwards (e.g. "Ich lege gleich etwas für dich auf.").',
        "Generate it in the user's language per the language directive.",
        `On decline, accept gracefully (pause nudge_key="${focus.nudge_key}").`,
      ].join('\n');

    case 'greeting':
    default:
      return [
        '=== OPENER: LIGHT GREETING ===',
        'Nothing specific to surface. Greet warmly and briefly by name if known; do not invent an offer.',
        "Generate it in the user's language per the language directive.",
      ].join('\n');
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}
