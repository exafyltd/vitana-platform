/**
 * Conversation Flow — the ONE transport-independent brain (roadmap Step 1b).
 *
 * `decideConversationFlow(ctx)` is the single place a conversation decision is
 * made. Every transport — Vertex (`routes/orb-live.ts`), LiveKit
 * (`routes/orb-livekit.ts`), a future provider, and text — is a thin adapter:
 * gather context → call THIS → render. A surface is "done" only when it has zero
 * independent decision logic (enforced by the transport-parity scanner).
 *
 * FIRST COMMIT (this file) DELEGATES and is proven byte-equal to the Step-1a
 * golden set: for an OPENING decision it calls the already-golden-characterized
 * `computeGreetingDecision` and maps its result into the typed
 * `ConversationDecision`. It introduces ZERO new behaviour — it is the seam the
 * Step-1c strangler-fig pass will route the live paths through, one `wake_opener`
 * branch at a time, each proven golden-equal.
 *
 * `ConversationContext` is the normalized, transport-agnostic input. It carries
 * the opening inputs (the Step-1a `GreetingDecisionContext`) PLUS the two post-v2
 * context layers so the brain is memory- and social-aware by construction:
 *   - `memory`  — the assembled `AssistantMemoryContext` (memory orchestrator,
 *                 #2830); its mandatory-injection guard becomes a brain invariant.
 *   - `social`  — the `SocialContextPack` (social memory, #2832); the superset of
 *                 the matches/messages already in `OverviewPayload`, for NBA/offer
 *                 ranking in later steps.
 * These are declared now (so the contract is stable) but the opening decision does
 * not read them yet — the greeting ladder never did, and this commit changes no
 * behaviour. See docs/CONVERSATION_FLOW_ROADMAP_V3.md §4 (Step 1b) and
 * docs/CONVERSATION_FLOW_HANDOFF.md §3.1.
 */

import type { AssistantMemoryContext } from '../memory-orchestrator';
import type { SocialContextPack } from '../social-memory/social-memory-types';
import type { OpeningRegister } from './decide-opening';
import type { NextBestAction } from './next-best-action';
import {
  computeGreetingDecision,
  type GreetingDecision,
  type GreetingDecisionContext,
  type GreetingEffects,
  type WakeOpener,
} from './compute-greeting-decision';

/** The transports the brain serves. Vertex + LiveKit exist today; text is the
 *  seam built by construction (the brain is transport-agnostic) and wired when
 *  the surface exists. */
export type ConversationTransport = 'vertex' | 'livekit' | 'text';

/** What kind of decision the brain was asked for. Only 'opening' exists in Step
 *  1b; 'turn' / 'offer' arrive with the Step-2 contracts. Discriminated so the
 *  output union can grow without breaking callers. */
export type ConversationDecisionKind = 'opening';

/**
 * The offer/confirmation contract stub (roadmap Step 2). Every offer Vitana makes
 * will write a `pending_cta`, acceptance will execute the EXACT bound action and
 * consume only after success, and consequential writes will gate on
 * `needs_confirmation`. Declared here so `ConversationDecision` is shape-stable
 * from 1b; populated in Step 2. Null until then.
 */
export interface OfferContract {
  /** The durable pending-CTA key this offer writes (bind acceptance to it). */
  pending_cta_key: string | null;
  /** The exact action acceptance must execute (an ORB tool / nav target). */
  bound_action: string | null;
  /** Whether accepting triggers a consequential write that must be confirmed first. */
  needs_confirmation: boolean;
}

/**
 * Normalized, transport-agnostic input to the brain. Adapters populate this from
 * their session state (Vertex/LiveKit/text) and call `decideConversationFlow`.
 */
export interface ConversationContext {
  transport: ConversationTransport;
  /** Target role, when known (community | admin | developer | …). The opening
   *  decision is role-invariant today; carried for later role-aware surfaces. */
  role: string | null;
  /** The opening-decision inputs (Step-1a seam). Present for an opening decision. */
  greeting: GreetingDecisionContext;
  /** Assembled memory context (memory orchestrator, #2830). Optional handle. */
  memory?: AssistantMemoryContext | null;
  /** Social context pack (social memory, #2832). Optional handle. */
  social?: SocialContextPack | null;
}

/**
 * The single typed decision the brain returns. For an opening it mirrors the
 * Step-1a `GreetingDecision` observable fields, in the transport-independent
 * vocabulary the adapters render from.
 */
export interface ConversationDecision {
  kind: ConversationDecisionKind;
  transport: ConversationTransport;
  /** Which opener fired (the 9 named rungs + legacy default). */
  opener_kind: WakeOpener;
  /** The opening register, when one was computed (else null). */
  register: OpeningRegister | null;
  /** The chosen next-best-action, when one was selected (else null). */
  nba: NextBestAction | null;
  /** The composed first-turn directive text, or null for a silent opening. */
  directive: string | null;
  /** The telemetry payload the adapter emits (byte-faithful to the live emit). */
  diag: Record<string, unknown>;
  /** Side effects the adapter must perform to stay byte-equal (data, not actions). */
  effects: GreetingEffects;
  /** Offer/confirmation contract (Step 2). Null in Step 1b. */
  offer: OfferContract | null;
  /**
   * VTID-04416 (Plan v1 WS-1.4): the full opening decision the transport
   * renders today. Carried so the live paths can go through this entry point
   * without changing what they render (the golden snapshots pin it).
   */
  greeting: GreetingDecision;
}

/**
 * Map a Step-1a `GreetingDecision` into the transport-independent
 * `ConversationDecision`. Pure, lossless for the observable decision.
 */
function greetingToConversationDecision(
  transport: ConversationTransport,
  g: GreetingDecision,
): ConversationDecision {
  return {
    kind: 'opening',
    transport,
    opener_kind: g.wakeOpener,
    register: g.register ?? null,
    nba: g.nba ?? null,
    directive: g.directive,
    diag: g.diag,
    effects: g.effects,
    offer: null, // Step 2
    greeting: g,
  };
}

/**
 * THE brain. Given a normalized context, return the one conversation decision.
 * Step 1b: delegates the opening decision to `computeGreetingDecision` (already
 * golden-characterized) and maps it — zero behaviour change, provably byte-equal.
 */
export function decideConversationFlow(ctx: ConversationContext): ConversationDecision {
  const greeting = computeGreetingDecision(ctx.greeting);
  return greetingToConversationDecision(ctx.transport, greeting);
}

/**
 * VTID-04416 (Plan v1 WS-1.4): the opening decision for a live transport.
 * Every voice opening goes through `decideConversationFlow` — the one brain
 * entry point — and gets back the same `GreetingDecision` it rendered before,
 * so this is behaviour-identical by construction. Transports must call this,
 * never `computeGreetingDecision` directly (the transport-flow-parity rule
 * enforces it, VTID-04417).
 */
/**
 * VTID-04420 (Plan v1 WS-2.1): the continuation providers are the brain's
 * candidate sources (WHAT to say); the greeting rungs are the phrasing layer
 * (HOW to say it). A higher rung can outrank the ranker's winner — a day
 * close, a new-day briefing, a tapped topic — and until now nothing recorded
 * that, so "the provider won but the user never heard it" was invisible.
 *
 * Returns, for one opening, which provider's candidate won the ranker and
 * whether the rung that fired actually spoke it. Pure; the transport adds the
 * result to its `greeting_sent` diag.
 */
export interface CandidateOutcome {
  /** Provider whose candidate won the ranker, or null when none returned one. */
  candidate_provider: string | null;
  /** The winning candidate's kind (wake_brief, check_in, feature_discovery …). */
  candidate_kind: string | null;
  /** The winning candidate's dedupe key (rotation / outcome tracking). */
  candidate_key: string | null;
  /** True when the rung that fired speaks the winning candidate's line. */
  candidate_spoken: boolean;
  /** The rung that fired instead of the candidate, when one outranked it. */
  candidate_outranked_by: WakeOpener | null;
  /** How many providers returned a candidate for this opening. */
  candidates_returned: number;
}

/** Rungs that render the ranker's selected candidate as the opening. */
const CANDIDATE_RENDERING_OPENERS: ReadonlySet<string> = new Set(['override_v2']);

interface CandidateDecisionLike {
  selectedContinuation: { id?: string; kind: string; dedupeKey?: string } | null;
  sourceProviderResults: Array<{ providerKey: string; status: string; candidate?: { id?: string } }>;
}

export function resolveCandidateOutcome(
  wakeOpener: WakeOpener | string | null | undefined,
  decision: CandidateDecisionLike | null | undefined,
): CandidateOutcome {
  const results = decision?.sourceProviderResults ?? [];
  const returned = results.filter((r) => r.status === 'returned').length;
  const selected = decision?.selectedContinuation ?? null;
  if (!selected || selected.kind === 'none_with_reason') {
    return {
      candidate_provider: null,
      candidate_kind: null,
      candidate_key: null,
      candidate_spoken: false,
      candidate_outranked_by: null,
      candidates_returned: returned,
    };
  }
  const winner = results.find(
    (r) => r.candidate && (r.candidate === selected || (selected.id && r.candidate.id === selected.id)),
  );
  const spoken = CANDIDATE_RENDERING_OPENERS.has(String(wakeOpener ?? ''));
  return {
    candidate_provider: winner?.providerKey ?? null,
    candidate_kind: selected.kind,
    candidate_key: selected.dedupeKey ?? null,
    candidate_spoken: spoken,
    candidate_outranked_by: spoken ? null : ((wakeOpener as WakeOpener | null | undefined) ?? 'legacy_default'),
    candidates_returned: returned,
  };
}

export function decideOpeningFlow(
  greeting: GreetingDecisionContext,
  meta: { transport: ConversationTransport; role?: string | null },
): GreetingDecision {
  return decideConversationFlow({ transport: meta.transport, role: meta.role ?? null, greeting }).greeting;
}
