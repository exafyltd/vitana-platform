/**
 * B0b (orb-live-refactor): context-compiler skeleton.
 *
 * Orchestrates the per-session context build:
 *
 *   1. compileSituationalCore() — Tier 0 fast signals from the envelope (B0a)
 *   2. compileMatchJourneyContext() — match-journey seam (returns 'none')
 *   3. resolveTruth() — envelope vs stored conflict policy
 *   4. timeSource() wraps every adapter call for source-health reporting
 *   5. Build CompiledContext (raw, for inspection) + AssistantDecisionContext
 *      (distilled, for the prompt) — strictly validated.
 *
 * This is the **skeleton**. The full compiler wires memory-broker /
 * context-pack / context-window adapters when B0c lands. For B0b the
 * minimum surface is: envelope → situational core → match-journey-seam
 * → strict decision context. The acceptance checks #2, #3, #7 all
 * gate on this skeleton.
 *
 * Hard guardrail: no direct memory queries here. All eventual context
 * source reads happen through `orb/context/adapters/*` modules that
 * B0c ships.
 */

import type { ClientContextEnvelope } from './client-context-envelope';
import {
  compileSituationalCore,
  type SituationalCore,
} from './situational-awareness-core';
import {
  compileMatchJourneyContext,
  type MatchJourneyContext,
} from './providers/match-journey-context-provider';
import {
  timeSource,
  summarizeSourceHealth,
  type SourceHealthReport,
  type SourceTiming,
} from './context-source-health';
import {
  resolveTruth,
  type TruthPolicyResolution,
} from './context-truth-policy';
import {
  parseAssistantDecisionContext,
  type AssistantDecisionContext,
  type DecisionMatchJourney,
} from './assistant-decision-context';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ContextCompilerInput {
  userId: string | null;
  tenantId: string | null;
  envelope: ClientContextEnvelope | null;
  /** Values loaded from app_users / memory_facts. B0b accepts an empty object. */
  storedFacts?: {
    timezone?: string;
    privacyMode?: 'private' | 'shared_device' | 'unknown';
    lang?: string;
  };
  /** Injected for testability. Production callers pass Date.now(). */
  nowMs?: number;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * Raw, structured context — for inspection / debug / downstream tools.
 * The Journey Context screen + the `/preview` endpoint render this.
 *
 * **Not pasted into the LLM system prompt.** Only `decision` reaches
 * the prompt.
 */
export interface CompiledContext {
  envelope: ClientContextEnvelope | null;
  situationalCore: SituationalCore;
  matchJourney: MatchJourneyContext;
  truth: TruthPolicyResolution;
  sourceHealth: SourceHealthReport;
}

/**
 * The compiler's full output: both the raw `CompiledContext` (for
 * inspection) and the distilled `AssistantDecisionContext` (for the
 * prompt), plus a list of any guards that fired.
 */
export interface ContextCompilationResult {
  compiled: CompiledContext;
  decision: AssistantDecisionContext;
  /** Reasons surfaced to the source-health panel + warnings array. */
  diagnostics: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile the per-session context.
 *
 * **Acceptance check #2 enforced here:** when no match context exists,
 * `compiled.matchJourney` is `{ journeyStage: 'none' }` (typed, never
 * `undefined`). The compiler propagates the seam's output verbatim into
 * `CompiledContext` and into `decision.matchJourney` (after schema-guard).
 *
 * **Acceptance check #3 enforced here:** `decision` is run through
 * `parseAssistantDecisionContext()` before return. Strict schema
 * rejects any extra fields — raw match rows / chat text / profile
 * payloads cannot pass.
 */
export async function compileContext(
  input: ContextCompilerInput,
): Promise<ContextCompilationResult> {
  const nowMs = input.nowMs ?? Date.now();
  const timings: SourceTiming[] = [];

  // ---- Source 1: situational core (Tier 0, synchronous) ----
  const sit = await timeSource('situational_core', () =>
    compileSituationalCore(input.envelope, nowMs),
  );
  timings.push(sit.timing);
  const situationalCore = sit.value ?? compileSituationalCore(null, nowMs);

  // ---- Source 2: match-journey provider (B0b: returns 'none') ----
  const mj = await timeSource('match_journey_context', () =>
    compileMatchJourneyContext({
      userId: input.userId,
      tenantId: input.tenantId,
      envelope: input.envelope,
    }),
  );
  timings.push(mj.timing);
  const matchJourney: MatchJourneyContext =
    mj.value ?? { journeyStage: 'none' };

  // ---- Truth policy (envelope vs stored conflicts) ----
  const truth = resolveTruth({
    envelope: input.envelope,
    stored: input.storedFacts,
  });

  // ---- Source health summary ----
  const sourceHealth = summarizeSourceHealth(timings);

  // ---- Build CompiledContext (raw) ----
  const compiled: CompiledContext = {
    envelope: input.envelope,
    situationalCore,
    matchJourney,
    truth,
    sourceHealth,
  };

  // ---- Build AssistantDecisionContext (distilled) ----
  const decisionCandidate = buildDecisionContext(compiled);

  // ---- Acceptance check #3: strict-parse before returning ----
  const guard = parseAssistantDecisionContext(decisionCandidate);
  if (!guard.ok) {
    // This is a programming error — the compiler produced something the
    // schema rejects. Surface it loudly; do NOT silently degrade.
    throw new Error(
      `B0b compiler produced an invalid AssistantDecisionContext: ${guard.error}`,
    );
  }

  // ---- Diagnostics ----
  const diagnostics: string[] = [];
  for (const t of sourceHealth.degradedSources) {
    diagnostics.push(`source_degraded:${t.source}:${t.status}`);
  }
  for (const c of truth.conflicts) {
    diagnostics.push(`truth_conflict:${c.field}:winner=${c.winner}`);
  }

  return {
    compiled,
    decision: guard.decision,
    diagnostics: Object.freeze(diagnostics),
  };
}

// ---------------------------------------------------------------------------
// Internal: distill CompiledContext → AssistantDecisionContext
// ---------------------------------------------------------------------------

function buildDecisionContext(c: CompiledContext): AssistantDecisionContext {
  // Greeting policy + explanation depth get real signals in B1/B6. For
  // B0b skeleton we pick conservative defaults.
  const decision: AssistantDecisionContext = {
    greetingPolicy: 'fresh_intro',
    explanationDepth: 'standard',
    privacyMode: c.truth.privacyMode,
    situationalFit: {
      timeAppropriateness: 'good',
      locationConfidence: c.situationalCore.locationFreshnessConfidence,
      daylightPhase: mapDaylightPhase(c.situationalCore.daylightPhase),
    },
    opportunitiesToMention: [],
    warnings: [],
  };

  // Distill match-journey if present and stage !== 'none'. The strict
  // schema (assistant-decision-context.ts) rejects extras — the compiler
  // here mirrors that boundary by ONLY copying fields the schema
  // declares, never reaching into matchJourney for raw rows/text.
  if (c.matchJourney.journeyStage !== 'none') {
    const mj: DecisionMatchJourney = {
      stage: c.matchJourney.journeyStage,
    };
    if (c.matchJourney.activityKind !== undefined) mj.activityKind = c.matchJourney.activityKind;
    if (c.matchJourney.partyShape !== undefined) mj.partyShape = c.matchJourney.partyShape;
    if (c.matchJourney.pendingUserDecision !== undefined) mj.pendingUserDecision = c.matchJourney.pendingUserDecision;
    if (c.matchJourney.recommendedNextMove !== undefined) mj.recommendedNextMove = c.matchJourney.recommendedNextMove;
    if (c.matchJourney.warnings !== undefined) mj.warnings = c.matchJourney.warnings.slice();
    decision.matchJourney = mj;
  }

  return decision;
}

/**
 * Map situational daylight phases → AssistantDecisionContext daylight phases.
 * The situational set includes 'unknown' which the decision context does
 * NOT — we collapse 'unknown' to 'midday' as a neutral default.
 */
function mapDaylightPhase(
  phase: SituationalCore['daylightPhase'],
): AssistantDecisionContext['situationalFit']['daylightPhase'] {
  return phase === 'unknown' ? 'midday' : phase;
}
