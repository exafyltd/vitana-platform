/**
 * VTID-02941 (B0b-min) — compileAssistantDecisionContext.
 * VTID-02950 (F2)     — adds conceptMastery provider.
 * VTID-02954 (F3)     — adds journeyStage provider.
 * VTID-02955 (B5)     — adds pillarMomentum provider.
 * VTID-02962 (B6)     — adds interactionStyle provider.
 *
 * The orchestrator. Calls each registered provider, collects their
 * distilled output, and produces ONE `AssistantDecisionContext` the
 * instruction layer can read.
 *
 * Providers run in parallel via `Promise.all`. Each runs in its own
 * try/catch boundary. A thrown error or a Supabase failure becomes
 * `source_health.<source>.ok = false` with a reason; the field on the
 * context becomes `null`. The orchestrator NEVER throws upward — a
 * broken provider must not block prompt assembly.
 *
 * Pure with respect to clock side-effects (now is injected) but does
 * call providers (which may do IO). Providers are responsible for
 * their own retries; the orchestrator just passes results through.
 */

import { defaultContinuityFetcher } from '../../services/continuity/continuity-fetcher';
import { compileContinuityContext } from '../../services/continuity/compile-continuity-context';
import { defaultConceptMasteryFetcher } from '../../services/concept-mastery/concept-mastery-fetcher';
import { compileConceptMasteryContext } from '../../services/concept-mastery/compile-concept-mastery-context';
import { defaultJourneyStageFetcher } from '../../services/journey-stage/journey-stage-fetcher';
import { compileJourneyStageContext } from '../../services/journey-stage/compile-journey-stage-context';
import { defaultPillarMomentumFetcher } from '../../services/pillar-momentum/pillar-momentum-fetcher';
import { compilePillarMomentumContext } from '../../services/pillar-momentum/compile-pillar-momentum-context';
import { defaultInteractionStyleFetcher } from '../../services/interaction-style/interaction-style-fetcher';
import { compileInteractionStyleContext } from '../../services/interaction-style/compile-interaction-style-context';
import {
  distillContinuityForDecision,
} from './providers/continuity-decision-provider';
import {
  distillConceptMasteryForDecision,
} from './providers/concept-mastery-decision-provider';
import {
  distillJourneyStageForDecision,
} from './providers/journey-stage-decision-provider';
import {
  distillPillarMomentumForDecision,
} from './providers/pillar-momentum-decision-provider';
import {
  distillInteractionStyleForDecision,
} from './providers/interaction-style-decision-provider';
import type {
  AssistantDecisionContext,
  DecisionConceptMastery,
  DecisionContinuity,
  DecisionInteractionStyle,
  DecisionJourneyStage,
  DecisionPillarMomentum,
} from './types';

export interface CompileAssistantDecisionContextInputs {
  userId: string;
  tenantId: string;
  /** Injected for testability. Production passes Date.now(). */
  nowMs?: number;
  /**
   * Provider overrides for tests. Production passes nothing and we use
   * the defaults wired into the per-feature services.
   */
  providers?: Partial<{
    continuity: () => Promise<DecisionContinuity | null>;
    conceptMastery: () => Promise<DecisionConceptMastery | null>;
    journeyStage: () => Promise<DecisionJourneyStage | null>;
    pillarMomentum: () => Promise<DecisionPillarMomentum | null>;
    interactionStyle: () => Promise<DecisionInteractionStyle | null>;
  }>;
  /**
   * Source-health reporter override for tests — when the provider
   * returns null, this lets a test stub a reason without monkey-patching
   * the default fetcher.
   */
  reasons?: Partial<{
    continuity: string;
    conceptMastery: string;
    journeyStage: string;
    pillarMomentum: string;
    interactionStyle: string;
  }>;
}

export async function compileAssistantDecisionContext(
  input: CompileAssistantDecisionContextInputs,
): Promise<AssistantDecisionContext> {
  const [
    continuityRun,
    conceptMasteryRun,
    journeyStageRun,
    pillarMomentumRun,
    interactionStyleRun,
  ] = await Promise.all([
    runContinuityProvider(input),
    runConceptMasteryProvider(input),
    runJourneyStageProvider(input),
    runPillarMomentumProvider(input),
    runInteractionStyleProvider(input),
  ]);

  return {
    continuity: continuityRun.value,
    concept_mastery: conceptMasteryRun.value,
    journey_stage: journeyStageRun.value,
    pillar_momentum: pillarMomentumRun.value,
    interaction_style: interactionStyleRun.value,
    source_health: {
      continuity: continuityRun.health,
      concept_mastery: conceptMasteryRun.health,
      journey_stage: journeyStageRun.health,
      pillar_momentum: pillarMomentumRun.health,
      interaction_style: interactionStyleRun.health,
    },
  };
}

interface ProviderRun<T> {
  value: T | null;
  health: { ok: boolean; reason?: string };
}

async function runContinuityProvider(
  input: CompileAssistantDecisionContextInputs,
): Promise<ProviderRun<DecisionContinuity>> {
  const override = input.providers?.continuity;
  if (override) {
    try {
      const value = await override();
      return { value, health: { ok: true } };
    } catch (e) {
      return {
        value: null,
        health: { ok: false, reason: (e as Error).message },
      };
    }
  }

  try {
    const [threadsResult, promisesResult] = await Promise.all([
      defaultContinuityFetcher.listOpenThreads({
        tenantId: input.tenantId,
        userId: input.userId,
        limit: 50,
      }),
      defaultContinuityFetcher.listPromises({
        tenantId: input.tenantId,
        userId: input.userId,
        limit: 50,
      }),
    ]);

    // If BOTH fetchers failed, treat the source as degraded. If one
    // succeeded, the compiler builds a partial-but-typed view and the
    // adapter can still distill it.
    const anyOk = threadsResult.ok || promisesResult.ok;
    if (!anyOk) {
      const reason =
        threadsResult.reason || promisesResult.reason || 'continuity_unavailable';
      return { value: null, health: { ok: false, reason } };
    }

    const continuity = compileContinuityContext({
      threadsResult,
      promisesResult,
      nowMs: input.nowMs,
    });

    const decisionView = distillContinuityForDecision({ continuity });
    return { value: decisionView, health: { ok: true } };
  } catch (e) {
    const reason = input.reasons?.continuity ?? (e as Error).message;
    return { value: null, health: { ok: false, reason } };
  }
}

async function runConceptMasteryProvider(
  input: CompileAssistantDecisionContextInputs,
): Promise<ProviderRun<DecisionConceptMastery>> {
  const override = input.providers?.conceptMastery;
  if (override) {
    try {
      const value = await override();
      return { value, health: { ok: true } };
    } catch (e) {
      return {
        value: null,
        health: { ok: false, reason: (e as Error).message },
      };
    }
  }

  try {
    const fetchResult = await defaultConceptMasteryFetcher.listConceptState({
      tenantId: input.tenantId,
      userId: input.userId,
      limit: 500,
    });

    if (!fetchResult.ok) {
      const reason = fetchResult.reason ?? 'concept_mastery_unavailable';
      return { value: null, health: { ok: false, reason } };
    }

    const conceptMastery = compileConceptMasteryContext({
      fetchResult,
      nowMs: input.nowMs,
    });

    const decisionView = distillConceptMasteryForDecision({ conceptMastery });
    return { value: decisionView, health: { ok: true } };
  } catch (e) {
    const reason = input.reasons?.conceptMastery ?? (e as Error).message;
    return { value: null, health: { ok: false, reason } };
  }
}

async function runJourneyStageProvider(
  input: CompileAssistantDecisionContextInputs,
): Promise<ProviderRun<DecisionJourneyStage>> {
  const override = input.providers?.journeyStage;
  if (override) {
    try {
      const value = await override();
      return { value, health: { ok: true } };
    } catch (e) {
      return {
        value: null,
        health: { ok: false, reason: (e as Error).message },
      };
    }
  }

  try {
    // B4's fetcher exposes three separate read methods. Run them in
    // parallel and feed the results into the compiler; degraded
    // sub-sources still produce a partial-but-typed context.
    const [appUserResult, activeDaysResult, indexHistoryResult] = await Promise.all([
      defaultJourneyStageFetcher.fetchAppUser({ userId: input.userId }),
      defaultJourneyStageFetcher.fetchUserActiveDaysAggregate({ userId: input.userId }),
      defaultJourneyStageFetcher.fetchVitanaIndexHistory({
        tenantId: input.tenantId,
        userId: input.userId,
        limit: 60,
      }),
    ]);

    // If ALL three fetches failed, treat the source as degraded. If
    // any succeeded, the compiler builds a partial-but-typed view.
    const anyOk = appUserResult.ok || activeDaysResult.ok || indexHistoryResult.ok;
    if (!anyOk) {
      const reason =
        appUserResult.reason ||
        activeDaysResult.reason ||
        indexHistoryResult.reason ||
        'journey_stage_unavailable';
      return { value: null, health: { ok: false, reason } };
    }

    const journeyStage = compileJourneyStageContext({
      appUserResult,
      activeDaysResult,
      indexHistoryResult,
      nowMs: input.nowMs,
    });

    const decisionView = distillJourneyStageForDecision({ journeyStage });
    return { value: decisionView, health: { ok: true } };
  } catch (e) {
    const reason = input.reasons?.journeyStage ?? (e as Error).message;
    return { value: null, health: { ok: false, reason } };
  }
}

async function runPillarMomentumProvider(
  input: CompileAssistantDecisionContextInputs,
): Promise<ProviderRun<DecisionPillarMomentum>> {
  const override = input.providers?.pillarMomentum;
  if (override) {
    try {
      const value = await override();
      return { value, health: { ok: true } };
    } catch (e) {
      return {
        value: null,
        health: { ok: false, reason: (e as Error).message },
      };
    }
  }

  try {
    const fetchResult = await defaultPillarMomentumFetcher.fetchVitanaIndexHistory({
      tenantId: input.tenantId,
      userId: input.userId,
      limit: 21,
    });

    if (!fetchResult.ok) {
      const reason = fetchResult.reason ?? 'pillar_momentum_unavailable';
      return { value: null, health: { ok: false, reason } };
    }

    const pillarMomentum = compilePillarMomentumContext({ fetchResult });
    const decisionView = distillPillarMomentumForDecision({ pillarMomentum });
    return { value: decisionView, health: { ok: true } };
  } catch (e) {
    const reason = input.reasons?.pillarMomentum ?? (e as Error).message;
    return { value: null, health: { ok: false, reason } };
  }
}

async function runInteractionStyleProvider(
  input: CompileAssistantDecisionContextInputs,
): Promise<ProviderRun<DecisionInteractionStyle>> {
  const override = input.providers?.interactionStyle;
  if (override) {
    try {
      const value = await override();
      return { value, health: { ok: true } };
    } catch (e) {
      return {
        value: null,
        health: { ok: false, reason: (e as Error).message },
      };
    }
  }

  try {
    const fetchResult = await defaultInteractionStyleFetcher.fetchInteractionStyleRow({
      tenantId: input.tenantId,
      userId: input.userId,
    });

    if (!fetchResult.ok) {
      const reason = fetchResult.reason ?? 'interaction_style_unavailable';
      return { value: null, health: { ok: false, reason } };
    }

    const interactionStyle = compileInteractionStyleContext({ fetchResult });
    const decisionView = distillInteractionStyleForDecision({ interactionStyle });
    return { value: decisionView, health: { ok: true } };
  } catch (e) {
    const reason = input.reasons?.interactionStyle ?? (e as Error).message;
    return { value: null, health: { ok: false, reason } };
  }
}
