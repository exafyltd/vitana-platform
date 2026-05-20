/**
 * VTID-03056 (B0d-real slice Xa) — Next Action provider entry point.
 *
 * The "Contextual Next Action Provider" the user asked for. It composes
 * across the registered NextActionSources (autopilot, reminders,
 * calendar, life-compass, pillar-momentum, diary, journey-stage, match,
 * continuity) and produces ONE AssistantContinuation per surface.
 *
 * This slice (Xa) ships the SKELETON only:
 *   - `makeNextActionProvider()` factory wired to the composer.
 *   - The composer's source registry is EMPTY by default; production
 *     wiring under `sources/` will register concrete sources in
 *     Xb-Xe slices.
 *   - When no sources are registered or no source returns a candidate,
 *     the provider returns `status: 'suppressed'` with a typed reason —
 *     not `status: 'returned'`. This lets the framework's existing
 *     voice-wake-brief provider (B0d-mini hardcoded path) still produce
 *     the fallback greeting line.
 *   - Priority defaults to 90 (above voice-wake-brief's 80) so a real
 *     B0d-real candidate beats the hardcoded fallback. Per-source
 *     priorities live INSIDE each source — this 90 is the
 *     provider-level priority the framework sees.
 *
 * The provider is registered in `services/wake-brief-wiring.ts` next
 * to voice-wake-brief so both fire on `orb_wake`. When a real source
 * has a candidate, the framework picks this one (priority 90 > 80);
 * when no source has anything, the framework picks voice-wake-brief
 * (which has its own hardcoded line). Either way the orb has a first
 * spoken line.
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  AssistantContinuation,
  ContinuationDecisionContext,
  ContinuationProvider,
  ProviderResult,
} from '../../types';

import {
  defaultNextActionComposer,
} from './composer';
import type {
  NextActionComposer,
  NextActionSourceContext,
  ScoredCandidate,
  NextActionComposeResult,
} from './types';
// VTID-03066 (B0d-real Xi): per-source candidate emit. Fires from inside
// produce() after compose() returns. Gives operators visibility into the
// FULL slate (winner + losers + skipped) without waiting for the
// decision-id-keyed framework events.
import { emitPerSourceCandidates } from './emit-telemetry';

// ---------------------------------------------------------------------------
// Inputs the wiring passes via ctx.extra.nextAction
// ---------------------------------------------------------------------------

/**
 * The slim view the next-action provider needs from the wiring layer.
 * The wiring code (e.g. orb-livekit.ts bootstrap, ai-chat turn-end) is
 * responsible for plumbing the supabase client + decisionContext.
 *
 * decisionContext stays opaque to the composer; each source casts what
 * it needs from it (e.g. pillar_momentum, continuity).
 */
export interface NextActionInputs {
  supabase: SupabaseClient;
  decisionContext: unknown;
  /**
   * VTID-03073: language for the wake-brief / turn-end line. Forwarded
   * by wake-brief-wiring.ts so every source's `renderLine(... lang)`
   * picks the user's actual locale. Before this fix the provider
   * defaulted to 'en' regardless of caller, so German users got
   * English next-action lines for a week.
   */
  lang?: string;
}

export const NEXT_ACTION_EXTRA_KEY = 'nextAction' as const;
export const NEXT_ACTION_PROVIDER_KEY = 'contextual_next_action' as const;
// VTID-03108 (Item 1): this is now a ceiling, not the wrap target. The
// actual wrap priority is the SOURCE's own priority (context-aware:
// minutes-until-fire, confidence band, match stage). 100 means
// effectively no ceiling for the highest-priority sources (max source
// priority is 95 in current bands). Tests can pass a smaller value to
// pin the ceiling and verify clamping.
const DEFAULT_PRIORITY = 100;

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export interface NextActionProviderOptions {
  /** Override the default module-level composer (used by tests). */
  composer?: NextActionComposer;
  /** Deterministic id generator for tests. */
  newId?: () => string;
  /** Provider-level priority. Default 90 (above voice-wake-brief's 80). */
  priority?: number;
}

/**
 * Build the Contextual Next Action provider. Exported as a factory so
 * tests can pass a fresh composer with stubbed sources and prod wiring
 * uses the module-level singleton with whatever sources have registered.
 */
export function makeNextActionProvider(
  opts: NextActionProviderOptions = {},
): ContinuationProvider {
  const composer = opts.composer ?? defaultNextActionComposer;
  const newId = opts.newId ?? randomUUID;
  const priority = opts.priority ?? DEFAULT_PRIORITY;

  return {
    key: NEXT_ACTION_PROVIDER_KEY,
    surfaces: ['orb_wake', 'orb_turn_end'],
    async produce(ctx: ContinuationDecisionContext): Promise<ProviderResult> {
      const t0 = Date.now();

      const inputs = readInputs(ctx);
      if (!inputs) {
        return {
          providerKey: NEXT_ACTION_PROVIDER_KEY,
          status: 'skipped',
          latencyMs: Math.max(0, Date.now() - t0),
          reason: 'no_next_action_inputs',
        };
      }

      if (!ctx.userId || !ctx.tenantId) {
        return {
          providerKey: NEXT_ACTION_PROVIDER_KEY,
          status: 'skipped',
          latencyMs: Math.max(0, Date.now() - t0),
          reason: 'anonymous_caller',
        };
      }

      const surface = ctx.surface;
      if (surface !== 'orb_wake' && surface !== 'orb_turn_end') {
        return {
          providerKey: NEXT_ACTION_PROVIDER_KEY,
          status: 'skipped',
          latencyMs: Math.max(0, Date.now() - t0),
          reason: 'unsupported_surface',
        };
      }

      // Always invoke the composer, even with zero sources — it returns
      // a typed `no_sources_registered` suppression in that case which
      // the Command Hub Inspector can render.
      let result: NextActionComposeResult;
      try {
        result = await composer.compose(surface, {
          userId: ctx.userId,
          tenantId: ctx.tenantId,
          lang: inputs.lang ?? 'en',
          nowIso: new Date().toISOString(),
          decisionContext: inputs.decisionContext,
          supabase: inputs.supabase,
        });
      } catch (err) {
        return {
          providerKey: NEXT_ACTION_PROVIDER_KEY,
          status: 'errored',
          latencyMs: Math.max(0, Date.now() - t0),
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      // VTID-03066 (Xi): emit per-source candidate rows BEFORE returning
      // to the framework, so the Inspector sees the full slate even when
      // the winner has higher-priority competitors. compose_id groups
      // sibling rows; decision_id linkage happens at the framework's
      // emit-telemetry layer (separate event family).
      const composeId = newId();
      emitPerSourceCandidates({
        composeId,
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        surface,
        candidates: result.candidates,
        winnerSource: result.chosen?.source ?? null,
      });

      if (!result.chosen) {
        return {
          providerKey: NEXT_ACTION_PROVIDER_KEY,
          status: 'suppressed',
          latencyMs: Math.max(0, Date.now() - t0),
          reason: result.suppressReason ?? 'no_chosen_candidate',
        };
      }

      // VTID-03108 (Item 1, "no hardcoding when it comes to intelligence"):
      // wrap with the SOURCE's own context-aware priority, not the legacy
      // fixed `priority` (which was hardcoded at 90 and made every
      // next-action source — including soft nudges like life_compass at
      // 80, pillar at 68, diary at 78 — beat the Teacher at 85). The
      // source's `priority` already reflects context-aware signals
      // (reminder minutes-until-fire, calendar minutes, match stage,
      // autopilot confidence band). Pass it through so the ladder among
      // providers is data-driven by each source's own ranking:
      //   - Urgent sources (reminder_due 95, calendar up-to-95, autopilot
      //     high-confidence 88, promise overdue 88, match pending 85)
      //     stay ABOVE the Teacher's priority (85).
      //   - Nudge sources (life_compass 80, diary 78, continuity-thread
      //     75, vitana_index_pillar 68) drop BELOW the Teacher.
      // The legacy fixed `priority` arg is now treated as a CEILING only:
      // if the source's own priority exceeds it (unlikely; max source
      // priority is 95), we clamp. Keep `opts.priority` injectable in
      // tests for explicit-override scenarios; default ceiling = 100.
      const effectivePriority = Math.min(result.chosen.priority, priority);
      const candidate = renderCandidateAsContinuation(result.chosen, surface, effectivePriority, newId);
      return {
        providerKey: NEXT_ACTION_PROVIDER_KEY,
        status: 'returned',
        latencyMs: Math.max(0, Date.now() - t0),
        candidate,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readInputs(ctx: ContinuationDecisionContext): NextActionInputs | null {
  const extra = ctx.extra;
  if (!extra || typeof extra !== 'object') return null;
  const raw = (extra as Record<string, unknown>)[NEXT_ACTION_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const supabase = obj.supabase;
  // Best-effort duck-typing of the Supabase client — it MUST have .from
  // and .rpc methods for sources to query their tables.
  if (
    !supabase ||
    typeof supabase !== 'object' ||
    typeof (supabase as Record<string, unknown>).from !== 'function' ||
    typeof (supabase as Record<string, unknown>).rpc !== 'function'
  ) {
    return null;
  }
  return {
    supabase: supabase as SupabaseClient,
    decisionContext: obj.decisionContext,
    lang: typeof obj.lang === 'string' ? obj.lang : undefined,
  };
}

function renderCandidateAsContinuation(
  c: ScoredCandidate,
  surface: 'orb_wake' | 'orb_turn_end',
  priority: number,
  newId: () => string,
): AssistantContinuation {
  // Per-language pick. The composer already picked the line for the
  // caller's lang in normal flow, so userFacingLine is authoritative.
  const userFacingLine = c.userFacingLine.trim();
  return {
    id: `next-action-${newId()}`,
    surface,
    // The continuation kind is `next_step` per the framework enum — the
    // composite "B0d-real" winner is, by definition, a next-step
    // recommendation.
    kind: 'next_step',
    priority,
    userFacingLine,
    cta: c.cta ?? { type: 'explain' },
    evidence: [
      {
        kind: `source:${c.source}`,
        detail: `priority=${c.priority} confidence=${c.confidence}`,
        weight: c.confidence === 'high' ? 1 : c.confidence === 'medium' ? 0.6 : 0.3,
      },
      ...c.reasons.map((r) => ({
        kind: r.kind,
        detail: r.detail,
      })),
    ],
    dedupeKey: c.dedupeKey,
    privacyMode: 'safe_to_speak',
  };
}
