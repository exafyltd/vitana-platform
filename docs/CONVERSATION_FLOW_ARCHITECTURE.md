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

---

## 2. Layers

```
            ┌───────────────────────────────────────────────┐
   inputs → │  LAYER 1 — Context assembly (already shared)   │
 identity,  │  /orb/context-bootstrap, buildClientContext,   │
 signals,   │  memory/identity facts, cadence signals        │
 timezone   └───────────────────────────────────────────────┘
                              │  transport-neutral context
                              ▼
            ┌───────────────────────────────────────────────┐
            │  LAYER 2 — THE BRAIN  decideConversationFlow() │
            │  (evolution of decideWakeBriefForSession)      │
            │  owns, for ALL transports:                     │
            │   • one fetchLastSessionInfo (+user_journey)   │
            │   • one describeTimeSince / temporal bucketing │
            │   • greeting policy (speak / silent, cadence)  │
            │   • the FULL provider ladder, incl. the        │
            │     new_day_overview provider                  │
            │   • ConversationStateMachine transitions       │
            │   • ONE unified decision-telemetry event       │
            │  returns →  ConversationFlowDecision            │
            └───────────────────────────────────────────────┘
                  │                │                │
                  ▼                ▼                ▼
          Vertex render     LiveKit render    Provider #3 render
          (client_content/  (return line →    (implement render()
           system instr.)    agent session.say) only)
```

- **Layer 1 — Context assembly.** Already shared via `/orb/context-bootstrap`,
  `buildClientContext`, `buildBootstrapContextPack`, identity/memory fetches.
  Produces a transport-neutral context object. (Keep consolidating duplicated
  fetches here over time, but it is not the source of the fork.)
- **Layer 2 — The brain.** The single decision engine. Everything that is
  *logic* lives here. See §3 for the contract.
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

## 3. The contract: `ConversationFlowDecision`

The brain returns one transport-neutral object. Adapters may read it and emit
its telemetry; they may not re-decide any field.

```ts
interface ConversationFlowDecision {
  mode: 'speak' | 'silent';        // opening-contract authority (speak/silent)
  kind: string;                    // which provider/rung won (e.g. new_day_overview)
  line: string | null;            // the user-facing line, already localized
  lines?: string[];               // optional multi-clause (e.g. morning overview)
  pending_action?: PendingCta;     // bound CTA (navigate / run_tool / ask_permission…)
  tts_hints?: Record<string, unknown>; // optional voice hints, adapter-honored
  telemetry: ConversationFlowTelemetry; // unified event payload (§4)
}
```

Inputs to `decideConversationFlow()` are transport-neutral: identity, client
context (timezone, time-of-day), language, cadence signals, supabase client.
No `ws`, no `session.say`, no provider SDK types cross the seam.

---

## 4. Telemetry (unified)

The brain emits **one** decision-telemetry schema for every transport, so
"which opener fired and why" is answerable identically for Vertex, LiveKit, and
#3. It supersedes the forked emissions (`orb.live.diag` greeting events on
Vertex; only `wake_brief_selected` on LiveKit).

`ConversationFlowTelemetry` carries at least: `decision_id`, `surface`,
`bucket`, `mode`, `kind` (the winning provider), `suppression_reason`,
`lang`, `provider_results` (per-provider latency + outcome). Adapters emit it;
they do not invent their own greeting events.

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

## 8. Migration roadmap (each phase is a complete vertical, never a half-state)

- **Phase 1 — Overview becomes a provider + unify the last-session resolver.**
  Convert `aggregateNewDayOverview` into a `new_day_overview`
  `ContinuationProvider` at the correct priority; collapse the two
  `fetchLastSessionInfo` into one (with the `user_journey` fallback) used by
  both transports. Result: the morning summary flows through the shared
  decision and reaches **LiveKit and Vertex both**. Closes leak A + half of C.
  *(This is also the phase that puts the morning summary on the LiveKit
  pipeline real users are on.)*
- **Phase 2 — Retire Vertex's private SAFE-FAST ladder onto the brain.** Every
  `wake_opener` rung becomes / maps to a provider; `orb-live.ts` becomes a pure
  render adapter calling `decideConversationFlow`. Delete the duplicate ladder,
  the duplicate `fetchLastSessionInfo`, and the duplicate `describeTimeSince`.
  Closes leak B + rest of C.
- **Phase 3 — Unify telemetry.** One greeting-decision event emitted by the
  brain; both adapters emit it; remove the forked events. Closes leak D.
- **Phase 4 — Lock it.** Land the conversation-flow parity scanner as a CI gate
  and document the render-adapter interface. Re-forking becomes un-mergeable.

Each phase ships green through staging behind a flag, with the contract suite
extended **first**. No big-bang.

---

## 9. Change-control rule (put this in PR review)

Any PR that touches greeting / wake / turn-flow behavior must:

1. Change a **provider** or the **brain** — never a transport file's decision logic.
2. Pass the conversation-flow parity scanner (once Phase 4 lands).
3. Update / approve the contract snapshots.

If a reviewer sees flow logic in `orb-live.ts`, `orb-livekit.ts`, or the
`orb-agent` Python that is not pure rendering, the PR is rejected.
