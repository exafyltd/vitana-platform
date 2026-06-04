/**
 * VTID-03257 (Fix-1) — Journey Guide provider.
 *
 * THE PRODUCT CONTRACT: for users who are still on the onboarding journey
 * (not yet graduated from the Journey Foundation), Vitana is a PROACTIVE,
 * hand-holding guide — NOT a passive assistant. She drives the Foundation
 * checklist ONE step at a time, states the step as a DIRECTIVE (never "what do
 * you want?"), does the task WITH the user, and verifies completion against
 * real data before advancing.
 *
 * This provider makes that real at turn 1. It outranks new_day_return (90) and
 * Teacher (85) so the journey leads; it SUPPRESSES once the user has graduated,
 * handing the floor back to the normal ladder. The directive line is the
 * step's own `execute_prompt`; a GUIDE-MODE block (bundled on the candidate)
 * governs turns 2+.
 */

import type {
  AssistantContinuation,
  ContinuationDecisionContext,
  ContinuationProvider,
  ProviderResult,
} from '../types';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JourneyFoundationSnapshot } from '../../journey-foundation/types';

export const JOURNEY_GUIDE_PROVIDER_KEY = 'journey_guide';
export const JOURNEY_GUIDE_EXTRA_KEY = 'journey_guide';

// Above new_day_return (90) + Teacher (85): the checklist leads. Below
// first_time_welcome (95, the one-time intro) + goal_completion (92).
const JOURNEY_GUIDE_PRIORITY = 91;

/** Bundled GUIDE-MODE content the controller reads off the winning candidate. */
export interface JourneyGuideContent {
  step_key: string;
  step_title: string;
  /** The step's directive execute_prompt (what Vitana leads with). */
  execute_prompt: string;
  /** One-line "why this matters now". */
  benefit: string;
  /** action = do-it-together task; teacher = walk-through explanation. */
  step_type: string;
  navigation_route: string | null;
  /**
   * VTID-03268 (Fix-7): the key used to pick the localized opener LINE. Usually
   * == step_key, but for the dual-axis gate when the health goal is already set
   * and only the economic stance is missing, this is 'life_compass_economy' so
   * Vitana leads the MONEY beat instead of re-asking the goal the user already
   * set (the "I already did that → how can I help?" revert spiral).
   */
  opener_key: string;
  /**
   * VTID-03268: titles of the next steps after this one (not yet satisfied), so
   * the GUIDE-MODE block can tell the model what to advance to — it must NEVER
   * say "I have no suggestions" or ask "how can I help"; there is always a next.
   */
  upcoming_steps: string[];
  /**
   * VTID-03300 (follow-up): true when the user tapped a step they've ALREADY
   * completed. The opener + GUIDE-MODE block switch to "enrich / build on it"
   * framing instead of "let's set it up" (which feels broken for a done step).
   */
  focus_done?: boolean;
}

const GATE_KEY = 'life_compass';

interface JourneyGuideInputs {
  supabase: SupabaseClient;
  userId: string;
  isReconnect?: boolean;
  lang: string;
  /**
   * VTID-03300: the Foundation step key the user tapped in "My Journey" to open
   * the orb. When set, the provider LEADS with this step instead of the
   * sequentially-computed `current_next_step` — even if the step is already
   * `done` or the user has graduated (an explicit tap must never open cold; a
   * done step switches the opener to "enrich" framing, see `focusStepDone`).
   */
  focusStep?: string | null;
  /**
   * VTID-03300 (follow-up): resolved spoken first name, so the opener can greet
   * by name ("Hey Dragan, …"). Null when unknown → opener omits the name.
   */
  firstName?: string | null;
}

function readInputs(ctx: ContinuationDecisionContext): JourneyGuideInputs | null {
  const raw = ctx.extra?.[JOURNEY_GUIDE_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!obj.supabase || typeof obj.userId !== 'string' || !obj.userId) return null;
  return {
    supabase: obj.supabase as SupabaseClient,
    userId: obj.userId,
    isReconnect: obj.isReconnect === true,
    lang: typeof obj.lang === 'string' && obj.lang ? obj.lang : 'en',
    focusStep: typeof obj.focusStep === 'string' && obj.focusStep ? obj.focusStep : null,
    firstName: typeof obj.firstName === 'string' && obj.firstName ? obj.firstName : null,
  };
}

export function makeJourneyGuideProvider(): ContinuationProvider {
  return {
    key: JOURNEY_GUIDE_PROVIDER_KEY,
    surfaces: ['orb_wake'],
    async produce(ctx: ContinuationDecisionContext): Promise<ProviderResult> {
      const inputs = readInputs(ctx);
      if (!inputs) {
        return { providerKey: JOURNEY_GUIDE_PROVIDER_KEY, status: 'skipped', latencyMs: 0, reason: 'no_journey_guide_inputs' };
      }
      // Transparent reconnect: the previous turn is still alive — don't open.
      if (inputs.isReconnect) {
        return { providerKey: JOURNEY_GUIDE_PROVIDER_KEY, status: 'suppressed', latencyMs: 0, reason: 'forced_skip_reconnect' };
      }

      let snapshot: JourneyFoundationSnapshot;
      let stepDef: { execute_prompt: string; benefit: string } | undefined;
      // VTID-03300: the step to lead with. Defaults to the computed next step,
      // but a user-tapped focus step overrides it (see below).
      let leadStep: JourneyFoundationSnapshot['current_next_step'] = null;
      let isFocusOverride = false;
      // VTID-03300 (follow-up): the user tapped a step they've ALREADY completed.
      // We still lead with it (an explicit tap must never open cold), but switch
      // the opener + GUIDE-MODE to "enrich/build-on-it" framing instead of
      // "let's set it up", which would feel broken for a done step.
      let focusStepDone = false;
      try {
        const [{ buildJourneyFoundationSnapshot }, { getStepDef }] = await Promise.all([
          import('../../journey-foundation/journey-foundation-state'),
          import('../../journey-foundation/foundation-steps'),
        ]);
        snapshot = await buildJourneyFoundationSnapshot(inputs.supabase, inputs.userId);

        // VTID-03300: when the user tapped a specific step in "My Journey", lead
        // with THAT step instead of the sequentially-computed next step — even
        // when it's already done or the user has graduated. An explicit tap is a
        // direct request to talk about that step, so Vitana focuses on what they
        // asked (a done step flips to "enrich" framing via focusStepDone).
        leadStep = snapshot.current_next_step;
        if (inputs.focusStep) {
          const focused = snapshot.foundation_steps.find((v) => v.key === inputs.focusStep);
          if (focused) {
            leadStep = focused;
            isFocusOverride = true;
            focusStepDone = focused.status === 'done';
          }
        }

        const key = leadStep?.key;
        stepDef = key ? getStepDef(key) : undefined;
      } catch (err) {
        return {
          providerKey: JOURNEY_GUIDE_PROVIDER_KEY,
          status: 'errored',
          latencyMs: 0,
          reason: `journey_guide_snapshot_failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Graduated → the journey is done; hand the floor to the normal ladder.
      // Exception: an explicit user tap on a still-open step (e.g. an optional
      // economy-activation step) overrides graduation so Vitana still leads it.
      if (snapshot.graduated && !isFocusOverride) {
        return { providerKey: JOURNEY_GUIDE_PROVIDER_KEY, status: 'suppressed', latencyMs: 0, reason: 'journey_graduated' };
      }
      const step = leadStep;
      if (!step || !stepDef) {
        return { providerKey: JOURNEY_GUIDE_PROVIDER_KEY, status: 'suppressed', latencyMs: 0, reason: 'no_next_step' };
      }

      // VTID-03268 (Fix-7): dual-axis gate nuance. If the health goal is already
      // set and only the economic stance is missing, DON'T re-ask the goal —
      // lead the MONEY beat. This is what caused the "I already set my goal →
      // Vitana asks how can I help" revert. Data-driven, not model-dependent.
      const goalSet = !!snapshot.active_goal?.primary_goal;
      const economicIntentSet = snapshot.economic_intent != null;
      const openerKey =
        step.key === GATE_KEY && goalSet && !economicIntentSet
          ? 'life_compass_economy'
          : step.key;

      // The forward chain: the next not-yet-satisfied steps, so the GUIDE-MODE
      // block can tell the model exactly what to advance to (it must never run
      // out of a concrete next step and fall back to "no suggestions").
      const upcoming = snapshot.foundation_steps
        .filter((v) => v.key !== step.key && v.status !== 'done' && v.status !== 'active')
        .slice(0, 3)
        .map((v) => v.title);

      const guide: JourneyGuideContent = {
        step_key: step.key,
        step_title: step.title,
        execute_prompt: stepDef.execute_prompt,
        benefit: stepDef.benefit,
        step_type: step.type,
        navigation_route: step.navigation_route,
        opener_key: openerKey,
        upcoming_steps: upcoming,
        // VTID-03300 (follow-up): the user tapped an already-done step — the
        // controller's GUIDE-MODE block reads this to lead with "enrich it"
        // framing instead of "set it up".
        focus_done: focusStepDone,
      };

      // VTID-03266 (Fix-6): the spoken opener is an ALREADY-LOCALIZED short
      // directive line — NOT the raw English execute_prompt. On LiveKit the
      // agent plays this verbatim via session.say() (no translation step); on
      // Vertex it is wrapped "speak verbatim". So it MUST be in the session
      // language. The whole-session "never ask what-do-you-want / lead / verify"
      // contract lives in the GUIDE-MODE block (buildJourneyGuideBlock), which
      // is injected as a system instruction on BOTH transports (turns 2+).
      const { buildJourneyGuideOpenerLine } = await import('../../../orb/live/instruction/journey-guide-prompt');
      const openerLine = buildJourneyGuideOpenerLine(openerKey, step.title, inputs.lang, {
        firstName: inputs.firstName ?? null,
        done: focusStepDone,
      });
      const candidate = {
        id: `journey-guide-${step.key}`,
        surface: 'orb_wake',
        kind: 'wake_brief',
        priority: JOURNEY_GUIDE_PRIORITY,
        userFacingLine: openerLine,
        // VTID-03264 (Fix-5 hotfix): MUST be a KNOWN_CTA_TYPES value or
        // validateContinuationCandidate rejects the candidate (the provider
        // then errors out and never wins — which is exactly what happened with
        // the invented 'guide_step' type: journey_guide errored every session
        // and Teacher (priority 85) led turn 1). 'explain' carries no required
        // fields; the actual lead-the-step behavior comes from userFacingLine +
        // the bundled GUIDE-MODE block, not this cta. step_key/route ride along
        // in payload for the client/telemetry.
        cta: { type: 'explain', payload: { step_key: step.key, route: step.navigation_route } },
        evidence: [
          { kind: 'source:journey_guide', detail: step.key },
          { kind: 'journey_step_tier', detail: String(step.tier) },
        ],
        dedupeKey: `journey_guide:${step.key}`,
        privacyMode: 'safe_to_speak',
        // Bundled — controller reads candidate.journeyGuide (cast), like teacherMode.
        journeyGuide: guide,
      } as unknown as AssistantContinuation;

      return { providerKey: JOURNEY_GUIDE_PROVIDER_KEY, status: 'returned', latencyMs: 0, candidate };
    },
  };
}
