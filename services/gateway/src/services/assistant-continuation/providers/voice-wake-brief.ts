/**
 * VTID-02915 (B0d.2) — Voice Wake Brief continuation provider.
 *
 * The first real provider in the Central Continuation Contract framework
 * (B0d.1). Produces the backend-owned first spoken line after ORB
 * activation — the replacement for the passive
 * `vitana-v1/src/lib/instantGreeting.ts` ("I'm here, I'm listening").
 *
 * Scope (B0d.2):
 *   - Pure provider file. NO orb-live.ts wiring (that lands in B0d.4).
 *   - NO module-load side-effects: the factory is exported and tests
 *     register fakes; production wiring registers the provider explicitly.
 *   - Inputs flow through `ContinuationDecisionContext.extra.voiceWakeBrief`.
 *     The orchestrator caller (B0d.4) computes `greetingPolicy` via the
 *     existing A4 `decideGreetingPolicy()` and forwards it.
 *
 * Behavior:
 *   - `greetingPolicy === 'skip'` → `status: 'suppressed'` with reason
 *     `greeting_policy_skip`. The orb stays silent; this is the
 *     transparent-reconnect path (VTID-02637 lesson).
 *   - Other policies → returned `wake_brief` candidate with a rendered
 *     line. The renderer is injectable so future slices can grow it
 *     without reshaping the provider.
 *   - Missing inputs → `status: 'skipped'` with reason
 *     `no_voice_wake_brief_inputs`. The orchestrator records this so the
 *     B0d.3 reliability timeline can see "wake-brief was not even
 *     consulted because the upstream caller did not pass inputs".
 *
 * Priority: 80. High enough to beat generic feature-discovery on the
 * wake surface, low enough that a future urgent-reminder provider
 * (priority 95+) can win when relevant. The plan documents this
 * priority order; we don't bake a global priority registry here yet.
 */

import { randomUUID } from 'crypto';
import type {
  AssistantContinuation,
  ContinuationProvider,
  ContinuationDecisionContext,
  ProviderResult,
} from '../types';
import type { GreetingPolicy } from '../../../orb/live/instruction/greeting-policy';
import type {
  DecisionPillarMomentum,
  PillarKey,
} from '../../../orb/context/types';
import { pickShortGapGreetings } from '../../../orb/instruction/greeting-pools';

// ---------------------------------------------------------------------------
// Temporal / bucketed fallback pools
// (R2 — BOOTSTRAP-ORB-R2-GREETING-POLICY)
// ---------------------------------------------------------------------------
//
// These pools were lifted verbatim from the legacy `## GREETING POLICY` stack
// in `orb/live/instruction/live-system-instruction.ts`. That stack rendered
// an 8-bucket × multi-language fallback opening policy directly into the
// Vertex system_instruction, even though the Central Continuation Contract
// (this provider + teacher + new-day) already owns the first spoken line in
// production — making it dead text on Vertex and omitted entirely on LiveKit
// (a soft transport conflict). The fallback content now lives HERE, on the
// priority-80 pure-fallback producer that owns the temporal fallback pools.
//
// The actual per-language greeting STRINGS still live in
// `orb/instruction/greeting-pools.ts` (`SHORT_GAP_GREETING_PHRASES`, surfaced
// via `pickShortGapGreetings`); only the bucket templating moved here. No
// greeting string or language was dropped in the move.

/** Time-since-last-session buckets the legacy stack keyed its templates on. */
export type WakeBriefTemporalBucket =
  | 'reconnect'
  | 'recent'
  | 'same_day'
  | 'today'
  | 'yesterday'
  | 'week'
  | 'long'
  | 'first';

/**
 * The 8-bucket structural opening templates. Byte-identical to the
 * `BUCKET_DEFAULT_TEMPLATES` previously inlined in live-system-instruction.ts.
 * `{{greeting_time_of_day}}` and `{{short_gap_phrase_menu}}` are substituted
 * by `renderWakeBriefFallbackBlock()` below.
 */
export const WAKE_BRIEF_BUCKET_TEMPLATES: Record<WakeBriefTemporalBucket, string> = {
  reconnect:
`- BUCKET = reconnect (transparent server-side resume — the user did NOT perceive any pause).
  • DO NOT speak. DO NOT greet. DO NOT acknowledge any "interruption", "reconnection", "resume", "where were we", "I'm back", "I'm listening", "picking up", or anything similar. Saying any of these creates a perceived apology that the user reads as a bug.
  • Wait for the user to speak. Your next message must be a direct response to the user's next utterance — nothing else.
  • If the user says nothing, you say nothing. Silence is correct here.`,
  recent:
`- BUCKET = recent (2–15 min since last session).
  • Do NOT use a formal greeting. NO "Hello <name>!", NO "Hi there!", NO self-introduction. NO user name.
  • Open with ONE single short phrase. NEVER use two-part sentences joined by dashes or commas.
{{short_gap_phrase_menu}}
  • Max ONE short phrase. Warm but direct.`,
  same_day:
`- BUCKET = same_day (15 min – 8 h since last session).
  • Light re-engagement. NOT a formal greeting. No user name. NEVER "Hello <name>!" as if you've never met.
  • Open with ONE single short phrase. NEVER use two-part sentences joined by dashes or commas.
{{short_gap_phrase_menu}}
  • Max ONE short phrase. Warm and direct.`,
  today:
`- BUCKET = today (8–24 h since last session — this is a NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "What's on your mind today?"
      "Where would you like to focus today?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.`,
  yesterday:
`- BUCKET = yesterday (this is a NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "What would you like to explore today?"
      "Picking up where we left off?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.`,
  week:
`- BUCKET = week (2–7 days since last session — this is a NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "Good to hear from you again — what's been on your mind?"
      "What would you like to explore today?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.`,
  long:
`- BUCKET = long (> 7 days since last session — this is a NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available — for >7-day absences the candidate should explicitly acknowledge the gap).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "It's been a few days — happy you're back. What's been on your mind?"
      "What would you like to focus on today?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.`,
  first:
`- BUCKET = first (telemetry lookup found no prior session — usually treat as RETURNING with NEW-DAY greeting).
  • ALWAYS open with "Good {{greeting_time_of_day}}, [Name]." using the user's name from memory context.
  • If no name is available in memory, just say "Good {{greeting_time_of_day}}."
  • EXCEPTION: when the brain context's USER AWARENESS shows tenure.stage="day0", the user is genuinely new. Use the FULL INTRODUCTION shape from the brain context's OPENING SHAPE MATRIX — that overrides this fallback.
  • LEGACY-FALLBACK ONLY (use the brain context's candidate when available).
  • Example follow-up if no candidate exists (pick ONE or skip):
      "What's on your mind today?"
      "Where would you like to focus today?"
  • Max TWO short sentences total: the time-of-day greeting + optionally one question.`,
};

/**
 * Expand the `{{short_gap_phrase_menu}}` token. Identical line-for-line to
 * the `expandShortGapPhraseMenu()` helper that used to live inside
 * `buildTemporalJourneyContextSection`. Pulls the per-language greeting
 * strings from the preserved `SHORT_GAP_GREETING_PHRASES` pool.
 */
export function expandShortGapPhraseMenu(
  lang: string,
  wakeBriefOverrideActive?: boolean,
): string {
  if (wakeBriefOverrideActive) {
    return '  • SHORT-GAP PHRASE LIST SUPPRESSED — a VERTEX WAKE BRIEF override is active later in this prompt. Speak the override line verbatim instead of any phrase here.';
  }
  const examples = pickShortGapGreetings(lang, 6);
  const out: string[] = [
    '  • Pick ONE of these example phrasings (use them VERBATIM — they are already in the user\'s language; pick a different one than last time):',
  ];
  for (const p of examples) {
    out.push(`      "${p}"`);
  }
  out.push('  • Rotate across sessions — the user notices repetition. If the previous session used one of these, pick a different one.');
  return out.join('\n');
}

/**
 * Render the bucket's fallback opening block with the two dynamic tokens
 * substituted — the no-provider fallback content that used to be inlined in
 * the Vertex system_instruction. Pure; no IO.
 */
export function renderWakeBriefFallbackBlock(
  bucket: WakeBriefTemporalBucket,
  lang: string,
  greetingTimeOfDay: string,
  wakeBriefOverrideActive?: boolean,
): string {
  const menu = expandShortGapPhraseMenu(lang, wakeBriefOverrideActive);
  return WAKE_BRIEF_BUCKET_TEMPLATES[bucket]
    .replace(/\{\{greeting_time_of_day\}\}/g, greetingTimeOfDay || 'day')
    .replace(/\{\{short_gap_phrase_menu\}\}/g, menu);
}

// ---------------------------------------------------------------------------
// Inputs the orchestrator caller forwards via ctx.extra.voiceWakeBrief
// ---------------------------------------------------------------------------

/**
 * Inputs the provider consumes. The orchestrator caller (B0d.4) attaches
 * an object of this shape to `ContinuationDecisionContext.extra` under
 * the key `'voiceWakeBrief'`.
 *
 * Future slices may extend this with:
 *   - vitanaId        (for "@alex3700, welcome back" personalization)
 *   - lastSessionTopic (for warm-return continuity)
 *   - reminderDueIn   (when an imminent reminder should color the brief)
 *
 * The shape is intentionally minimal in B0d.2 to keep the slice tight.
 */
export interface VoiceWakeBriefInputs {
  /** From A4's `decideGreetingPolicy()`. The provider gates on this. */
  greetingPolicy: GreetingPolicy;
  /** ISO 639-1 language code. Defaults to `'en'` when absent. */
  lang?: string;
  /**
   * VTID-03053 — Distilled pillar-momentum from the AssistantDecisionContext.
   * When present AND confidence is medium/high AND the suggested focus
   * pillar has slipping/unknown momentum, the renderer produces a
   * proactive observation instead of the generic greeting. Null/missing →
   * the renderer falls through to the generic policy-keyed line.
   *
   * Enum-only by contract; no raw scores, no medical interpretation.
   */
  pillarMomentum?: DecisionPillarMomentum | null;
}

export const VOICE_WAKE_BRIEF_EXTRA_KEY = 'voiceWakeBrief' as const;

// ---------------------------------------------------------------------------
// Renderer — pure function, injectable for tests
// ---------------------------------------------------------------------------

export interface VoiceWakeBriefRenderer {
  render(inputs: VoiceWakeBriefInputs, ctx: ContinuationDecisionContext): string;
}

// VTID-03083: warmer, service-grade copy. "Back already?" / "Schon
// zurück?" reads as dismissive — a service assistant greets a returning
// user warmly, never with a confronting question. Same rule for every
// policy.
const DEFAULT_LINES: Record<GreetingPolicy, Record<string, string>> = {
  // Suppressed at provider boundary; never reaches the renderer.
  skip: { en: '', de: '' },
  // Lead to the next step, NOT "pick up where we left off": this default line
  // carries no recalled last-session content, so the resume promise is empty and
  // the user calls it ("I don't remember where we ended").
  brief_resume: {
    en: 'Welcome back. Let me show you your next step.',
    de: 'Schön, dich wieder zu hören. Lass mich dir deinen nächsten Schritt zeigen.',
  },
  warm_return: {
    en: 'Welcome back. Let me show you where we are.',
    de: 'Schön, dass du wieder da bist. Lass mich dir zeigen, wo wir gerade stehen.',
  },
  fresh_intro: {
    en: "Hello! Let me show you where we'll begin.",
    de: 'Hallo! Lass mich dir zeigen, wo wir anfangen.',
  },
};

/**
 * VTID-03053 — Per-pillar proactive observation. ONLY used when:
 *   - pillarMomentum is present
 *   - confidence is medium or high (low confidence + unknown both fall
 *     through to the generic line so the orb doesn't speculate)
 *   - suggested_focus is set AND its momentum band is 'slipping' or
 *     'unknown' (steady/improving pillars don't warrant proactive nudge)
 *
 * Output is ONE short sentence + ONE open question — never a list, never
 * medical interpretation, never a number. Mirrors the "one next-best
 * action, not multiple" rule from the original B0d/B0e scope.
 */
const PILLAR_PROACTIVE_LINES: Record<PillarKey, Record<string, string>> = {
  sleep: {
    en: "Your sleep pillar has been slipping lately. Let me show you what's getting in the way.",
    de: 'Deine Schlaf-Säule sackt in letzter Zeit etwas ab. Lass mich dir zeigen, was da hineinspielt.',
  },
  nutrition: {
    en: "Your nutrition pillar has been slipping lately. Let me help you get it back on track.",
    de: 'Deine Ernährungs-Säule sackt in letzter Zeit etwas ab. Lass uns das gemeinsam wieder aufbauen.',
  },
  exercise: {
    en: 'Your exercise pillar has been slipping lately. Let me set up something light for today.',
    de: 'Deine Bewegungs-Säule sackt in letzter Zeit etwas ab. Lass uns heute etwas Leichtes einplanen.',
  },
  hydration: {
    en: 'Your hydration pillar has been slipping lately. Let me add a small step to lift it back up.',
    de: 'Deine Hydrations-Säule sackt in letzter Zeit etwas ab. Lass uns einen kleinen Schritt einbauen.',
  },
  mental: {
    en: "Your mental pillar has been slipping lately. Let me help with what's weighing on you.",
    de: 'Deine Mental-Säule sackt in letzter Zeit etwas ab. Lass mich dir mit dem helfen, was dich gerade beschäftigt.',
  },
};

/**
 * Whether the pillar-momentum signal warrants a proactive opener vs the
 * generic policy-keyed line. Pure; no IO. Exported for tests.
 */
export function shouldUsePillarProactiveLine(
  pm: DecisionPillarMomentum | null | undefined,
  policy: GreetingPolicy,
): boolean {
  // Skip is handled at the provider boundary; never reaches the renderer.
  // brief_resume keeps its tight "back already?" line — proactive context
  // would feel out of place mid-thread.
  if (policy === 'skip' || policy === 'brief_resume') return false;
  if (!pm) return false;
  if (pm.confidence === 'low') return false;
  if (!pm.suggested_focus) return false;
  const row = pm.per_pillar.find((p) => p.pillar === pm.suggested_focus);
  if (!row) return false;
  return row.momentum === 'slipping' || row.momentum === 'unknown';
}

export const defaultVoiceWakeBriefRenderer: VoiceWakeBriefRenderer = {
  render(inputs) {
    const lang = inputs.lang && inputs.lang.length > 0 ? inputs.lang : 'en';

    if (shouldUsePillarProactiveLine(inputs.pillarMomentum, inputs.greetingPolicy)) {
      const focus = inputs.pillarMomentum!.suggested_focus as PillarKey;
      const byLang = PILLAR_PROACTIVE_LINES[focus];
      const line = byLang[lang] ?? byLang.en;
      if (line && line.length > 0) return line;
    }

    const byLang = DEFAULT_LINES[inputs.greetingPolicy];
    return byLang[lang] ?? byLang.en ?? '';
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface VoiceWakeBriefProviderOptions {
  /** Replace the default renderer (used by tests + future signal-driven slices). */
  renderer?: VoiceWakeBriefRenderer;
  /** Injected for deterministic ids in tests. */
  newId?: () => string;
  /** Injected for deterministic latencies in tests. */
  now?: () => number;
  /** Override the default priority (80). Future slices may tune. */
  priority?: number;
}

export const VOICE_WAKE_BRIEF_PROVIDER_KEY = 'voice_wake_brief' as const;
const DEFAULT_PRIORITY = 80;

/**
 * Build a Voice Wake Brief provider. Exported as a factory (not a
 * pre-built singleton) so production wiring can pass real dependencies
 * and tests can pass fakes.
 */
export function makeVoiceWakeBriefProvider(
  opts: VoiceWakeBriefProviderOptions = {},
): ContinuationProvider {
  const renderer = opts.renderer ?? defaultVoiceWakeBriefRenderer;
  const newId = opts.newId ?? randomUUID;
  const now = opts.now ?? (() => Date.now());
  const priority = opts.priority ?? DEFAULT_PRIORITY;

  return {
    key: VOICE_WAKE_BRIEF_PROVIDER_KEY,
    surfaces: ['orb_wake'],
    produce(ctx: ContinuationDecisionContext): ProviderResult {
      const t0 = now();

      const inputs = readInputs(ctx);
      if (!inputs) {
        return {
          providerKey: VOICE_WAKE_BRIEF_PROVIDER_KEY,
          status: 'skipped',
          latencyMs: Math.max(0, now() - t0),
          reason: 'no_voice_wake_brief_inputs',
        };
      }

      if (inputs.greetingPolicy === 'skip') {
        return {
          providerKey: VOICE_WAKE_BRIEF_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, now() - t0),
          reason: 'greeting_policy_skip',
        };
      }

      let line: string;
      try {
        line = renderer.render(inputs, ctx);
      } catch (err) {
        return {
          providerKey: VOICE_WAKE_BRIEF_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      if (typeof line !== 'string' || line.trim().length === 0) {
        return {
          providerKey: VOICE_WAKE_BRIEF_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, now() - t0),
          reason: 'renderer_produced_empty_line',
        };
      }

      const usedPillarProactive = shouldUsePillarProactiveLine(
        inputs.pillarMomentum,
        inputs.greetingPolicy,
      );
      const evidence: AssistantContinuation['evidence'] = [
        {
          kind: 'greeting_policy',
          detail: inputs.greetingPolicy,
        },
      ];
      let dedupeKey = `wake-brief-${inputs.greetingPolicy}`;
      if (usedPillarProactive && inputs.pillarMomentum) {
        evidence.push({
          kind: 'pillar_momentum_slipping',
          detail: inputs.pillarMomentum.suggested_focus ?? 'unknown',
          weight: inputs.pillarMomentum.confidence === 'high' ? 1 : 0.6,
        });
        // Distinct dedupe key when the proactive variant fires — same
        // greeting policy with a different observation should NOT
        // collide with the generic-line dedupe row.
        dedupeKey = `wake-brief-${inputs.greetingPolicy}-pillar-${inputs.pillarMomentum.suggested_focus}`;
      }

      const candidate: AssistantContinuation = {
        id: `wake-brief-${newId()}`,
        surface: 'orb_wake',
        kind: 'wake_brief',
        priority,
        userFacingLine: line,
        cta: { type: 'explain' },
        evidence,
        dedupeKey,
        privacyMode: 'safe_to_speak',
      };

      return {
        providerKey: VOICE_WAKE_BRIEF_PROVIDER_KEY,
        status: 'returned',
        latencyMs: Math.max(0, now() - t0),
        candidate,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pull `VoiceWakeBriefInputs` out of `ContinuationDecisionContext.extra`.
 * Defensive — tolerates `extra` being absent or shaped wrong. Returns
 * `null` when the inputs are missing or unusable; the caller turns that
 * into a `status: 'skipped'` result.
 */
function readInputs(
  ctx: ContinuationDecisionContext,
): VoiceWakeBriefInputs | null {
  const extra = ctx.extra;
  if (!extra || typeof extra !== 'object') return null;
  const raw = (extra as Record<string, unknown>)[VOICE_WAKE_BRIEF_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const policy = obj.greetingPolicy;
  if (
    policy !== 'skip' &&
    policy !== 'brief_resume' &&
    policy !== 'warm_return' &&
    policy !== 'fresh_intro'
  ) {
    return null;
  }
  // VTID-03053: forward pillarMomentum when present. Defensive: only
  // accept it as a structured object (the wiring helper always passes
  // either a DecisionPillarMomentum or null/undefined).
  const pillarMomentumRaw = obj.pillarMomentum;
  const pillarMomentum =
    pillarMomentumRaw && typeof pillarMomentumRaw === 'object'
      ? (pillarMomentumRaw as VoiceWakeBriefInputs['pillarMomentum'])
      : null;
  return {
    greetingPolicy: policy,
    lang: typeof obj.lang === 'string' ? obj.lang : undefined,
    pillarMomentum,
  };
}
