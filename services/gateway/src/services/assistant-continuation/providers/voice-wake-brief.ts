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
  brief_resume: {
    en: 'Welcome back. What would you like to pick up on?',
    de: 'Schön, dich wieder zu hören. Womit kann ich dir helfen?',
  },
  warm_return: {
    en: 'Welcome back. What is on your mind?',
    de: 'Schön, dass du wieder da bist. Womit kann ich dir helfen?',
  },
  fresh_intro: {
    en: 'Hello! How can I help today?',
    de: 'Hallo! Wie kann ich dir heute helfen?',
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
    en: 'Your sleep pillar has been slipping lately. Want to look at what is getting in the way?',
    de: 'Deine Schlaf-Säule sackt in letzter Zeit etwas ab. Wollen wir uns anschauen, was da hineinspielt?',
  },
  nutrition: {
    en: 'Your nutrition pillar has been slipping lately. Want help getting it back on track?',
    de: 'Deine Ernährungs-Säule sackt in letzter Zeit etwas ab. Sollen wir das gemeinsam wieder aufbauen?',
  },
  exercise: {
    en: 'Your exercise pillar has been slipping lately. Want to set up something light for today?',
    de: 'Deine Bewegungs-Säule sackt in letzter Zeit etwas ab. Sollen wir heute etwas Leichtes einplanen?',
  },
  hydration: {
    en: 'Your hydration pillar has been slipping lately. Want a small step to lift it back up?',
    de: 'Deine Hydrations-Säule sackt in letzter Zeit etwas ab. Wollen wir einen kleinen Schritt einbauen?',
  },
  mental: {
    en: 'Your mental pillar has been slipping lately. What is weighing on you right now?',
    de: 'Deine Mental-Säule sackt in letzter Zeit etwas ab. Was beschäftigt dich gerade?',
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
