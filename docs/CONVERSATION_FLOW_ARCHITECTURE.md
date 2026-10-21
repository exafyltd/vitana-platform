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

---

## 10. The journey-continuity spine (every conversation IS the journey)

### Product invariant

> Every conversation — the opener AND every ongoing turn — is one continuous
> narration of the user's longevity journey.

The user has started a trip. Vitana is the guide. So the **default** shape of any
opener is journey-framed, e.g.:

> "Today is June 26th — day 9 of your longevity journey. You've completed 2 of
> your guided sessions so far; let's do the next one together."

This is **not** a greeting variant. It is the **spine**: the baseline opener and
the standing frame for every turn. Other things (an urgent reminder, a tapped
topic, a new community match) may briefly own turn 1, but they are interruptions
*of* the journey thread, and the next turn returns to it.

### It is a provider, not a special case

Implement it as the `journey_continuity` provider in the brain — evolve the
existing `login_briefing` provider, which already gathers sessions-completed,
next-session title, Index delta, and Life Compass goal (it was ~80% there). It
sits at the **high baseline** of the ladder: it wins turn 1 unless something
genuinely more urgent pre-empts it, and everything generic yields to it.

It must **scale across the two product surfaces automatically**, using the
journey-maturity model that already exists (`login_briefing`'s
`orient → building → momentum → returning → graduated`):

- **Guided-journey user** (still learning the 94 sessions / 254 topics):
  narrate learning progress + recommend the next session.
- **Full-app / graduated user** (Life Compass set, fluent with Index / Autopilot):
  narrate *longevity* progress (Index direction, Life Compass goal, autopilot)
  framed as the *continuing* journey. Same spine, different clauses.

### Data sources (all already stored)

- `user_guided_journey_state.current_session` + `completed_topic_ids` → "2 of N sessions learned"
- `user_journey.started_at` → "day 9" (days since journey start)
- the guided-session catalog → "your next session is …"
- `life_compass` + `vitana_index_scores` → the graduated-user clauses

### Render + interruptions

- Emits a **server-composed, speakable line** (the option-A pattern shipped for
  `new_day_return`), so Vertex and LiveKit say the *same* journey narration.
- Higher-priority providers (urgent reminder, explicit tap, new match) pre-empt
  turn 1; the `ConversationStateMachine` carries the thread so turn 2 returns to
  "…now, back to your journey — ready for session 3?"
- **Ongoing turns, not just the opener:** the same journey context the provider
  used is injected into the standing system instruction, so *every* answer
  relates back to the journey and nudges the next session. The provider and the
  standing instruction read the SAME journey context, so they can never disagree.

### Completeness: the briefing carries EVERY signal, not just journey + calendar

> A morning briefing that names the journey day and today's calendar but omits
> the Vitana Index move, new community matches, unread messages, due reminders,
> and the autopilot/proactive next step is **half-baked**. The first turn of the
> day is the one moment the user is most receptive to the full picture — it must
> be the *complete* picture.

The complete signal set is the **rich** `gatherOverviewPayload`
(`new-day-overview-payload.ts`), which reads the SAME sources the My Journey
screen renders **plus** the voice-only time-sensitive signals:

- journey (day-in-journey, plan_phase, wave / goal arc)
- Vitana Index **with pillar + 7-day-trend interpretation** (never a bare number)
- Life Compass goal (verbatim, as the North Star)
- calendar today + passed-since-last-session
- **autopilot `today_checkpoint`** — the proactive next step, which OWNS the
  named close (this is the proactive-assistant layer surfacing in voice)
- **new community matches** (`matches_unread`)
- **unread messages** (`messages_unread`, count only)
- reminders due today
- diary streak (7-day)

The narrow `aggregateNewDayOverview` (calendar + Index + goal only) is **not**
sufficient for the opener — wiring it into the spoken turn drops seven signals
and is what produced the half-baked briefing (the PR #2790 regression).

### One brain, MANY MOUTHS — the rendering differs by transport, the payload does not

The single-rich-payload is the **brain**. The mistake was forcing ONE
*rendering* (a single server-composed line) onto BOTH transports: a deterministic
line cannot carry nine signals without reading like a dashboard (the exact tone
the briefing prompt forbids). So the mouths differ by capability:

- **Vertex (LLM mouth):** hand the model the full structured block
  `buildNewDayOverviewBlock` (carries the wake-brief override marker + a
  per-payload coverage checklist). The model composes the natural two-paragraph
  briefing that covers every applicable signal. **Wording is 100% model-composed
  from the payload — nothing is hardcoded, and the block is language-agnostic
  (`Respond in {lang}`), so German is first-class.** This is what the Vertex
  SAFE-FAST new-day rung now sends (`orb-live.ts`, `wake_opener:
  safe_fast_newday_overview`) — the path real users are on today.
- **LiveKit (deterministic `say()` mouth):** has no LLM to compose the opener, so
  it speaks `userFacingLine` verbatim. It gets a **bounded** composed line. A
  fully-rich deterministic line is a separate renderer; until LiveKit is actually
  activated (Vertex-only today) it keeps the bounded line.

**Therefore:** the `new_day_return` provider must carry the rich payload, and the
render step is chosen per transport — LLM transports get the structured block,
deterministic transports get the bounded line. The provider is transport-agnostic
today (no transport flag in `ContinuationDecisionContext`), so threading that
flag through `decideWakeBriefForSession` so the heavy Vertex path ALSO emits the
rich block is the tracked Phase-2 follow-up. **The user-facing path (Vertex
SAFE-FAST) is complete now; the brain-level completion rides Phase 2.**

### Trigger: durable once-per-day flag, NOT the session-start heuristic

> A rich briefing nobody hears is worse than no briefing. The *content* being
> complete is meaningless if the rung never fires.

The morning briefing originally gated on the most-recent `vtid.live.session.start`
telemetry (`describeTimeSince` → "first session of a new day"). That heuristic is
**fragile**: an active user opens many sessions a day and the app auto-creates
sessions, so any earlier same-day session (or a silent auto-session) flips the
temporal bucket to "same-day" and the briefing is skipped. In practice it almost
never fired — which is exactly the "the morning summary disappeared" complaint.

The trigger is now a **durable per-user flag**: `user_journey.last_full_briefing_date`
(user-tz `YYYY-MM-DD`). The SAFE-FAST rung fires the rich briefing on the FIRST
session of a day where that date is stale, then stamps today so same-day reopens
fall through to the short proactive opener (`computeFastProactiveOpener`). This is
the **"full once/day, short after"** contract. First-time / not-yet-onboarded
users are excluded (the first-time-welcome rung owns them — never "welcome back").

Rule: **never re-gate the briefing on transient session telemetry.** Whether the
briefing is due is a function of durable per-user state, not of how many sessions
or reconnects happened.

---

## 11. Memory is a first-class input (read every turn, write every session)

### Product invariant

> Vitana must consider what the user has told it BEFORE it answers — every turn,
> every session. A journey that forgets is not continuous.

Memory is **not** a side system bolted onto the flow. It is:

- a **READ** input assembled in Layer 1 and available to the brain + the standing
  instruction on every turn (`memory_facts` — name, goal, disclosed people,
  preferences — plus the relevant `memory_items`), and
- a **WRITE** step at session end that turns the conversation into durable facts
  (extraction → `memory_facts` / `memory_items` / `relationship_nodes`).

Both halves must be **transport-agnostic** — the same "one implementation, thin
per-transport call" rule as tool dispatch.

### The current break (investigated — this is why memory "doesn't work")

- **READ works on both** transports: the bootstrap context pack loads memory and
  injects it at session start (`context-pack-builder.ts` →
  `buildBootstrapContextPack`, surfaced on Vertex via `session.contextInstruction`
  and on LiveKit via `/orb/context-bootstrap`).
- **WRITE is forked.** Vertex extracts + persists at session end
  (`live-session-controller.ts:~1965-1983` fires Cognee + dedup extraction). The
  **LiveKit agent's `_teardown()` (`orb-agent/session.py ~974-1043`) extracts
  NOTHING** — no Cognee, no dedup, no `write_fact`. There is no extraction code
  anywhere in `orb-agent`. So on the LiveKit pipeline **every conversation is
  heard and thrown away** — cross-session memory never accumulates. This is the
  amnesia.
- **Two more, smaller:** memory is injected only ONCE at session start (no
  per-turn refresh on either transport), and `search_memory` is an *optional*
  tool the model rarely calls — so even mid-session, "I told you earlier" can
  fail. And there is **no `memory_hits` telemetry**, so the gap was invisible.

### The fix, in this architecture

1. **READ (Layer 1):** the context assembler loads `memory_facts` + relevant
   `memory_items` once at start AND keeps them available to the brain and the
   standing instruction every turn — not just turn 1. The journey spine composes
   *over* this memory ("day 9, 2 sessions — and last time you mentioned your
   knee; how is it?").
2. **WRITE (unify the fork):** there must be **one** transport-agnostic "commit
   session memory" step (extraction → persistence) that BOTH transports invoke
   at session end. Today Vertex calls it inline and LiveKit calls nothing.
   Expose it as a single gateway path/endpoint that the LiveKit agent hits on
   teardown (before it closes the gateway client), so extraction **cannot** be
   forked again — mirroring the shared tool dispatcher.
3. **PER-TURN consideration:** ensure memory is consulted each turn — re-surface
   the relevant facts into the standing instruction (cheap) and/or make
   `search_memory` a reliable step — so mid-session recall is not left to chance.

### Enforcement (same guarantee as the flow)

- **`memory_hits` in the unified telemetry (§4):** every session's decision event
  records how many memory facts were loaded and whether the session committed
  memory at the end. "Memory considered" becomes *queryable*, not assumed — the
  same way the greeting `wake_opener` is now queryable.
- **Parity guard extends to the memory loop:** a transport that ends a session
  WITHOUT committing memory, or answers WITHOUT the Layer-1 memory input, is
  drift the parity scanner / contract suite flags. The READ assembler and the
  WRITE commit are shared code; a transport may only *call* them, never re-implement
  or skip them.

---

## 12. "Done" ritual — so it is EXPERIENCED, not just built

Every conversation-flow OR memory change is **not done** until all three hold.
This is the rule that breaks the "built a continuation/memory solution several
times, never experienced it" pattern — because the failure was always
*decision/extraction computed but not wired to the live experience*, deferred
behind a flag or a second path.

1. **You heard it** — a real staging session on the **LiveKit** pipeline (the one
   real users are on), not just a unit test or the Vertex path.
2. **Telemetry proves it** — `oasis_events` shows the expected `wake_opener`
   (e.g. `journey_continuity`), a non-zero `memory_hits`, and a session-end
   memory-commit for that session.
3. **A test locks it** — the spoken line is pinned in the transport-agnostic
   contract suite; for memory, a test asserts that a session's facts are
   persisted and retrievable on the next session.

"Built" is not "done." **Done = heard + proven + locked.**
