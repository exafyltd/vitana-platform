# Conversation Flow Architecture — One Brain, Many Mouths

**CANONICAL REFERENCE. Read before touching any voice greeting / wake / turn-flow code.**

Status: target architecture + migration plan. Phases 1–4 below track the rollout.

---

## 0. The rule (non-negotiable)

> **All conversation-flow DECISIONS live in one transport-agnostic module.**
> Each voice provider (Vertex, LiveKit, and any future voice-to-voice provider)
> is a thin **render adapter** that may only *read and emit* the decision —
> never make one.

A change to conversation flow is a change to **the brain** or to a **provider
registered in the brain**, and therefore reaches **every** transport at once,
by construction. If you find yourself adding a greeting ladder, a `wake_opener`,
a `fetchLastSessionInfo`, a temporal-bucket branch, or a "speak vs silent"
decision inside a transport file (`orb-live.ts`, `orb-livekit.ts`, the
`orb-agent` Python), **stop** — that logic belongs in the brain. CI enforces
this (see §5).

This is the same pattern already proven for **tool dispatch**
(`ORB_TOOL_REGISTRY` + `dispatchOrbTool` + per-transport adapter +
`orb-tools-lift-scanner` CI gate). Conversation flow mirrors it.

---

## 1. Why this exists

We run multiple voice transports and will add more. Without a single seam, each
transport grows its own copy of the greeting/wake logic and they silently drift:
a fix lands in one pipeline and misses the others. This actually happened — the
morning new-day overview was built only on the Vertex path and never reached
LiveKit users; new-day detection and greeting telemetry forked the same way.

The fix is architectural: one decision engine, transport-specific rendering only.

**This is not a new invention — it finishes an extraction the codebase already
started.** The shared brain's pieces already exist (`decideWakeBriefForSession`,
`decideContinuation`, the `ContinuationProvider` registry, `decideOpening`,
`ConversationStateMachine`, `temporal-bucket`), and LiveKit already routes
through them. The remaining work is to pull Vertex's still-transport-local flow
decisions into that shared layer — its SAFE-FAST branches and `wake_opener`
labels, a private `fetchLastSessionInfo` (with the `user_journey` fallback), a
duplicate `describeTimeSince`, and direct `aggregateNewDayOverview` calls — and
then lock it so it cannot re-fork.

---

## 2. Layers

```
            ┌───────────────────────────────────────────────┐
   inputs → │  LAYER 1 — Context assembler (does ALL fetches)│
 identity,  │  /orb/context-bootstrap, buildClientContext,   │
 signals,   │  memory/identity facts, cadence signals, AND   │
 timezone   │  the ONE fetchLastSessionInfo (+user_journey)  │
            │  + describeTimeSince → lastInteraction/bucket. │
            │  Owns Supabase/SDK access. Emits plain data.   │
            └───────────────────────────────────────────────┘
                              │  transport-neutral context (no SDK handles)
                              ▼
            ┌───────────────────────────────────────────────┐
            │  LAYER 2 — THE BRAIN  decideConversationFlow() │
            │  THIN ORCHESTRATOR (not a god-brain). Sequences│
            │  existing authorities — composes no text, does │
            │  no fetching:                                  │
            │   1. decideContinuation() — the provider ladder│
            │      (incl. the new_day_return provider)       │
            │   2. decideOpening() — speak / silent authority│
            │   3. ConversationStateMachine.transition()     │
            │   4. build (NOT emit) one telemetry payload    │
            │  returns →  ConversationFlowDecision (wraps     │
            │            AssistantContinuationDecision)       │
            └───────────────────────────────────────────────┘
                  │                │                │
                  ▼                ▼                ▼
          Vertex render     LiveKit render    Provider #3 render
          (client_content/  (return line →    (implement render()
           system instr.)    agent session.say) only)
        one outer orchestrator emits the telemetry exactly once (§4)
```

- **Layer 1 — Context assembler.** Does ALL the DB/SDK work: identity, memory,
  cadence signals, AND the single `fetchLastSessionInfo` (+`user_journey`
  fallback) → `describeTimeSince` → `lastInteraction`/`bucket`. Hands the brain
  **plain transport-neutral data** — no `SupabaseClient`, no SDK handles. This
  is what keeps the decision function pure.
- **Layer 2 — The brain.** A **thin orchestrator** over the smaller authorities
  that already exist (`decideContinuation`, `decideOpening`,
  `ConversationStateMachine`). It owns no fetching and no text composition of
  its own. See §3 for the contract.
- **Layer 3 — Render adapters.** Per transport. They take the brain's
  `ConversationFlowDecision` and physically deliver it. This is the **only**
  place transport differences are allowed.

### Legitimate transport differences (stay in the adapter)

Rendering genuinely differs and that is correct:

- **Vertex**: the LLM speaks the first turn from the system instruction
  (`client_content` / `Say exactly` framing over the Gemini Live WebSocket).
- **LiveKit**: the Python `orb-agent` speaks the decided line deterministically
  via `session.say(user_facing_line)`; the LLM is suppressed on turn 1
  (BOOTSTRAP-ORB-RCV-DOUBLEGREET).
- **Provider #3**: whatever its SDK requires.

The brain does not know or care how the line is voiced. It only decides
*what* and *whether*.

---

## 3. The contract: `ConversationFlowDecision` (WRAPS the existing decision)

**Do not invent a parallel decision universe.** Reuse the existing
`AssistantContinuationDecision` — it already carries `userFacingLine`, the
selected provider key, `providerResults`, `suppressionReason`, timing, and
evidence. The brain's output is a thin WRAPPER that adds the opening mode +
render metadata around it:

```ts
interface ConversationFlowDecision {
  // Opening-contract authority (decideOpening): speak vs stay silent.
  mode: 'speak' | 'silent';
  // The EXISTING decision, reused verbatim — NOT re-modelled. Carries
  // userFacingLine, the winning provider key, providerResults,
  // suppressionReason, timing, evidence.
  continuation: AssistantContinuationDecision;
  // Render metadata adapters need but the brain composes no text for
  // (dedupe key, pending CTA, optional tts hints, "structured-block vs
  // verbatim-line" hint).
  render?: { dedupeKey?: string; pendingAction?: PendingCta; ttsHints?: Record<string, unknown> };
  // ONE telemetry payload the brain BUILDS but does NOT emit (see §4).
  telemetry: ConversationFlowTelemetry;
}
```

`decideConversationFlow()` is a **thin orchestrator**, not a god-brain. It owns
no fetching and composes no text — it sequences the smaller authorities that
already exist:

1. take the **transport-neutral context** assembled in Layer 1
   (`lastInteraction`, `bucket`, cadence, timezone, lang, identity — already
   resolved; no SDK handles),
2. call `decideContinuation()` on the `orb_wake` surface (the provider ladder),
3. call `decideOpening()` for the speak/silent authority,
4. advance the `ConversationStateMachine`,
5. **build** (not emit) the telemetry payload.

Inputs are plain values only. **No `SupabaseClient`, no `ws`, no `session.say`,
no provider SDK types cross the seam** — the Layer-1 context assembler does the
DB/SDK work and hands the brain data. (This is the rule that keeps the decision
function unit-testable without mocking Supabase.)

---

## 4. Telemetry (built once, emitted once)

**The brain BUILDS one telemetry payload; it does not emit. Exactly one outer
orchestrator emits it exactly once.** Render adapters never emit greeting
telemetry of their own — "brain emits AND adapters emit" is a double-event bug
waiting to happen, so the responsibility is singular and explicit: the
orchestrator that drives `decideConversationFlow()` → `render()` is the sole
emitter. This supersedes the forked emissions (`orb.live.diag` greeting events
on Vertex; only `wake_brief_selected` on LiveKit), so "which opener fired and
why" is answerable identically for Vertex, LiveKit, and #3.

`ConversationFlowTelemetry` carries at least: `decision_id`, `surface`,
`bucket`, `mode`, `kind` (the winning provider), `suppression_reason`,
`lang`, `provider_results` (per-provider latency + outcome).

---

## 5. The guarantee: every change covers every provider

Two enforcement mechanisms, both already proven here:

1. **Conversation-flow parity scanner** —
   `scripts/conversation-flow-lift-scanner.mjs` + a CI gate, modeled 1:1 on
   `scripts/orb-tools-lift-scanner.mjs`. It fails the build if a transport file
   contains conversation-flow *decision* logic (a greeting ladder, a
   `wake_opener`, a `fetchLastSessionInfo`, a bucket branch, a speak/silent
   decision) instead of calling `decideConversationFlow`. An allowlist covers
   the genuinely transport-specific render bits. This makes re-forking
   **un-mergeable**, not merely discouraged.
2. **Transport-agnostic contract tests** — extend
   `test/orb/conversation-flow.contract.test.ts` (RULE 0 snapshots),
   `test/orb/live/instruction/opening-contract.test.ts`, and
   `test/services/wake-brief-wiring.test.ts` to run against the brain and assert
   each adapter renders the brain's decision faithfully. One snapshot suite =
   parity across all transports.

Net effect: a new opener, suppression rule, or overview clause is one edit to a
provider or the brain. The scanner guarantees no transport diverged; the
snapshots guarantee identical rendering.

---

## 6. Adding a new voice provider (the payoff test)

To add the third (or Nth) voice-to-voice provider:

1. Extend the transport resolver
   (`orb/live/upstream/active-provider-resolver.ts`) with the new gate + a new
   route mirroring `orb-livekit.ts`, plus the standby guard
   (`provider_standby` 503 when not active).
2. Implement **one** `render()` adapter that consumes `ConversationFlowDecision`.

It inherits the entire conversation flow — overview, new-day detection, cadence,
suppression, telemetry — for free. **If it needs anything more than `render()`,
the architecture failed and the scanner will say so.**

---

## 7. Current state → target (what already exists vs what leaks)

**Already shared (build on these, do not reinvent):**

- `services/wake-brief-wiring.ts` → `decideWakeBriefForSession` (the seed of the brain; both transports already call it)
- `services/assistant-continuation/` → `ContinuationProvider` registry, `decideContinuation` ranker, `ContinuationSurface`
- `orb/live/instruction/opening-contract.ts` → `decideOpening` (speak/silent authority)
- `orb/live/.../conversation-state-machine.ts` → `ConversationStateMachine`
- `services/guide/temporal-bucket.ts` → `describeTimeSince`
- Tool dispatch: `services/orb-tools-shared.ts` (`ORB_TOOL_REGISTRY` + `dispatchOrbTool`) — the unification template

**The four leaks this plan closes:**

| # | Leak | Fixed in |
|---|------|----------|
| A | `aggregateNewDayOverview` bolted into Vertex's SAFE-FAST ladder, not a provider | Phase 1 |
| B | Vertex's private SAFE-FAST greeting ladder (`wake_opener`) bypasses the shared providers | Phase 2 |
| C | `fetchLastSessionInfo` forked (only Vertex has the `user_journey` fallback); `describeTimeSince` duplicated | Phase 1 (resolver) / Phase 2 (bucket) |
| D | Greeting telemetry forked (`orb.live.diag` vs `wake_brief_selected`) | Phase 3 |

---

### Canonical naming (pick one, use everywhere)

- **Provider key: `new_day_return`** — the existing `ContinuationProvider` that
  owns the morning greeting. There is NO separate `new_day_overview` provider;
  do not introduce one.
- **`aggregateNewDayOverview`** — the data **aggregator** the `new_day_return`
  provider consumes (calendar / Index / Life Compass). It is a data source, not
  a provider.

### Migration roadmap (each phase is a complete vertical, never a half-state)

**Sequencing is deliberate: tests first, scanner last.** Lock current behavior
with contract tests BEFORE moving code; turn the parity scanner into a hard gate
ONLY after Vertex's ladder is migrated — otherwise the gate is ceremonial (it
would block on drift that hasn't been removed yet).

- **Phase 0 — Contract tests first.** Extend the transport-agnostic contract
  suite (§5.2) to pin today's spoken/silent decisions for representative
  scenarios, on BOTH transports, before any code moves. This is the safety net
  every later phase runs against.
- **Phase 1 — `new_day_return` speaks on both transports + unify the resolver.**
  The overview is ALREADY the `new_day_return` provider, reached by both
  transports via `decideWakeBriefForSession`. The work is: make it emit a
  **server-composed, speakable line** (so LiveKit's deterministic `session.say`
  can render it, not just the Vertex LLM) and rank it to own a genuine new-day
  turn 1; then collapse the two `fetchLastSessionInfo` into the one Layer-1
  resolver (with the `user_journey` fallback). Closes leak A + half of C.
  **Status: the composed-line + ranking change is done (PR #2790); the resolver
  unification is the tracked follow-up.**
- **Phase 2 — Retire Vertex's private SAFE-FAST ladder onto the brain.** Every
  `wake_opener` rung becomes / maps to a provider; `orb-live.ts` becomes a pure
  render adapter calling `decideConversationFlow`. Delete the duplicate ladder,
  the duplicate `fetchLastSessionInfo`, and the duplicate `describeTimeSince`.
  Closes leak B + rest of C.
- **Phase 3 — Unify telemetry.** One greeting-decision payload built by the
  brain, emitted exactly once by the orchestrator (§4); remove the forked
  events. Closes leak D.
- **Phase 4 — Lock it.** Land the conversation-flow parity scanner as a hard CI
  gate and document the render-adapter interface. Re-forking becomes
  un-mergeable. (Hard gate goes on LAST — after Phase 2 removes the drift it
  would otherwise flag.)

Each phase ships green through staging behind a flag, against the Phase-0
contract suite. No big-bang.

---

## 9. Change-control rule (put this in PR review)

Any PR that touches greeting / wake / turn-flow behavior must:

1. Change a **provider** or the **brain** — never a transport file's decision logic.
2. Pass the conversation-flow parity scanner (once Phase 4 lands).
3. Update / approve the contract snapshots.

If a reviewer sees flow logic in `orb-live.ts`, `orb-livekit.ts`, or the
`orb-agent` Python that is not pure rendering, the PR is rejected.
