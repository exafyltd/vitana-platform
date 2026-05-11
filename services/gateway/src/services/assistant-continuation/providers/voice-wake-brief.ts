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
}

export const VOICE_WAKE_BRIEF_EXTRA_KEY = 'voiceWakeBrief' as const;

// ---------------------------------------------------------------------------
// Renderer — pure function, injectable for tests
// ---------------------------------------------------------------------------

export interface VoiceWakeBriefRenderer {
  render(inputs: VoiceWakeBriefInputs, ctx: ContinuationDecisionContext): string;
}

const DEFAULT_LINES: Record<GreetingPolicy, Record<string, string>> = {
  // Suppressed at provider boundary; never reaches the renderer.
  skip: { en: '', de: '' },
  brief_resume: {
    en: 'Back already? What did you want to follow up on?',
    de: 'Schon zurück? Worauf wolltest du zurückkommen?',
  },
  warm_return: {
    en: 'Welcome back. What is on your mind?',
    de: 'Schön, dass du wieder da bist. Was steht an?',
  },
  fresh_intro: {
    en: 'Hello! How can I help today?',
    de: 'Hallo! Wie kann ich heute helfen?',
  },
};

export const defaultVoiceWakeBriefRenderer: VoiceWakeBriefRenderer = {
  render(inputs) {
    const lang = inputs.lang && inputs.lang.length > 0 ? inputs.lang : 'en';
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

      const candidate: AssistantContinuation = {
        id: `wake-brief-${newId()}`,
        surface: 'orb_wake',
        kind: 'wake_brief',
        priority,
        userFacingLine: line,
        cta: { type: 'explain' },
        evidence: [
          {
            kind: 'greeting_policy',
            detail: inputs.greetingPolicy,
          },
        ],
        dedupeKey: `wake-brief-${inputs.greetingPolicy}`,
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
  return {
    greetingPolicy: policy,
    lang: typeof obj.lang === 'string' ? obj.lang : undefined,
  };
}
