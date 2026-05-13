/**
 * VTID-02941 (B0b-min) — compileAssistantDecisionContext.
 * VTID-02950 (F2)     — adds conceptMastery provider.
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
import {
  distillContinuityForDecision,
} from './providers/continuity-decision-provider';
import {
  distillConceptMasteryForDecision,
} from './providers/concept-mastery-decision-provider';
import type {
  AssistantDecisionContext,
  DecisionConceptMastery,
  DecisionContinuity,
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
  }>;
  /**
   * Source-health reporter override for tests — when the provider
   * returns null, this lets a test stub a reason without monkey-patching
   * the default fetcher.
   */
  reasons?: Partial<{ continuity: string; conceptMastery: string }>;
}

export async function compileAssistantDecisionContext(
  input: CompileAssistantDecisionContextInputs,
): Promise<AssistantDecisionContext> {
  const [continuityRun, conceptMasteryRun] = await Promise.all([
    runContinuityProvider(input),
    runConceptMasteryProvider(input),
  ]);

  return {
    continuity: continuityRun.value,
    concept_mastery: conceptMasteryRun.value,
    source_health: {
      continuity: continuityRun.health,
      concept_mastery: conceptMasteryRun.health,
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
