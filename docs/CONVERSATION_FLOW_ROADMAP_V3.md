# Conversation Flow — v3 Execution Roadmap (consolidate-first)

**Audience:** a fresh session's agent, tasked with **executing** this plan.
**Status:** APPROVED by the operator (2026-06-29). Build in order. Start at Step 1a.
**Companion docs:** `docs/CONVERSATION_FLOW_HANDOFF.md` (engine asset inventory, exact
paths/exports/lines, Command-Hub build recipe) and `docs/CONVERSATION_FLOW_ARCHITECTURE.md`
(the "one brain, many mouths" architecture). This doc is the **order of operations and
the guardrails**; the companion docs are the **reference**.

---

## 0. Thesis & the rule that orders everything

The conversation flow is **structurally fragmented**: Vertex's `routes/orb-live.ts` owns
its own greeting ladder (9 `wake_opener` branches + duplicated recency), the pure
decision functions exist but are **not authoritative**, there is **no transport-parity
enforcement**, and the CI flow-guard is **blind to the most-churned file**
(`routes/orb-live.ts`). Adding tenant knobs on top of this makes regressions cheaper,
not safer.

**We consolidate and contract-harden first. We do not expose tenant knobs until the
flow is a single, enforced, replay-tested brain.**

> **Ordering rule (do not violate):** no step that adds configurability or surface area
> may land before the step that makes the underlying behavior single-sourced and
> provable. Hub UI = Step 4 (read-only first). Tenant overrides = Step 6 (last).

---

## 1. Mandate & non-negotiable invariants

- **One brain, every surface.** `decideConversationFlow()` is the ONLY place a
  conversation decision is made. **Vertex, LiveKit, future provider, and text** are thin
  adapters: *gather context → call brain → render*. A surface is "done" only when it has
  **zero** independent decision logic — enforced by the parity scanner (Step 1a).
- **Globally non-overridable invariants** (never tenant-tunable; the validator in Step 6
  must reject attempts to override them):
  1. **Character/voice** — Vitana's persona, du-form German, brand voice.
  2. **Safety.**
  3. **Truthfulness** — no fabricated numbers/data; the **speakable-tool contract**
     (every tool result is presentable, never raw JSON/empty/nav-only, never invents a
     value it didn't compute).
  4. **Continuity** — recency-first; never re-greet a returning user as first-time;
     greeting language == turn-2 language.

---

## 2. Verified current state (evidence — re-confirm before trusting)

| Gap | Where / evidence |
|---|---|
| No single brain | `grep decideConversationFlow` → empty. `routes/orb-live.ts` has 9 `wake_opener` branches + its own recency. |
| No parity scanner | `scripts/ci/scanners/` has none. |
| CI guard blind to hotspot | `scripts/ci/impact-rules/conversation-flow-change-needs-test.mjs` `FLOW_SOURCE_RE` lists `orb/live/session/live-session-controller.ts` but **NOT** `routes/orb-live.ts`. |
| Tool output not a contract | `OrbToolResult` = `{ ok; result?; text?; }` (orb-tools-shared.ts ~L93) — `text` optional; absent → Vertex arms send `result: ''`. |
| Acceptance binding weak | `acceptance-gate.ts` `maybeBindAcceptance` clears `pending_cta` **before** execution (L148); only `navigate_to_screen` is the wired runtime consumer; mid-conversation offers aren't bound. |
| Coupling hub | `buildResumeDirective()` (decide-opening.ts) joins register × NBA × screen-completion → validate at **scenario** level, not unit. |
| Churn proves fragmentation | conversation paths 39 commits/9 days; `orb-live.ts` ×15, `orb-tools-shared.ts` ×14; PR #2814 rewrote the same greeting assembly hours after the v2 handoff. |

Engine asset inventory (paths/exports/lines) is in `CONVERSATION_FLOW_HANDOFF.md` §3 — do
not duplicate; read it.

---

## 3. Method — applies to EVERY step (this is how we avoid #2814-style churn)

1. **Characterize before touching.** The decision is a pure function of a context bundle
   → golden-snapshot it first. Nothing refactors until the golden set is green on current `main`.
2. **Strangler-fig, not big-bang.** Move ONE branch per PR; each proven golden-equal;
   each individually revertable. The 9 Vertex branches → ~9 small PRs, never one rewrite.
3. **`move ≠ improve`.** Extraction commits must produce **zero golden diff** (reproduce
   today exactly, bugs and all). Behavior fixes are SEPARATE commits, each an explicit
   reviewed diff against the golden/scenario set.
4. **Every flow PR ships a flow test** (CI guard, extended in 1a to cover `orb-live.ts`).
5. **No prod observability available** (GCP/OASIS logs are gated for this identity) → all
   proof is the offline golden/scenario suite, not live logs.

---

## 4. The sequence (build in this order)

### STEP 1 — Single transport-independent brain + parity enforcement

**1a — FIRST PR (cheap, zero behavior change, fully reversible). Build this first:**
- **Golden characterization harness** over today's decision across the matrix
  `{transport (vertex|livekit) × lang (de|en) × role (community|admin|developer) ×
  current_screen × recency bucket × first-time|returning}`. For each fixture record the
  observable decision: `wake_opener`, register, NBA key, and the composed first-turn
  directive text. Store as committed golden snapshots. Implement as a jest suite under
  `services/gateway/test/services/conversation/` (so the CI guard recognizes it).
  - Drive it through whatever entry today produces the decision; if the decision is
    currently entangled in `sendGreetingPromptToLiveAPI`, first extract a **pure,
    side-effect-free `computeGreetingDecision(ctx)`** that returns the decision object
    WITHOUT speaking/emitting — and snapshot THAT. (This extraction is itself zero-behavior:
    the live path calls it and then does exactly what it did before.)
- **Extend the CI flow-guard:** add `^services/gateway/src/routes/orb-live\.ts$` (and
  `orb-livekit.ts`) to `FLOW_SOURCE_RE` in `conversation-flow-change-needs-test.mjs`.
- **Transport-parity scanner:** new `scripts/ci/scanners/` (or impact-rule) that FAILS
  when a transport file (`routes/orb-live.ts`, `routes/orb-livekit.ts`) contains its own
  register/recency/`wake_opener` decision logic instead of delegating to the brain.
  - **Severity: `warning` for now** (report fragmentation, don't block in-flight work);
    flip to **`blocker` at the end of Step 1c** when delegation is complete. Register it
    + seed migration per the impact-rule pattern (see `conversation-flow-change-needs-test`
    + `dev_autopilot_impact_rules` seed).
- **Exit 1a:** golden set green on `main`; CI guard now covers `orb-live.ts`; parity
  scanner live (warning) and correctly flags the 9 branches. **No runtime behavior change.**

**1b — Define the typed brain, extract by wrapping, prove equivalence:**
- `ConversationContext` (normalized input: transport, lang, role, surface/current_route,
  recency bucket, first-time|returning, the `OverviewPayload` bundle, recent_nbas, **plus
  the two post-v2 context layers — the assembled `AssistantMemoryContext` from the memory
  orchestrator (#2830) and the `SocialContextPack` from social memory (#2832); see
  `CONVERSATION_FLOW_HANDOFF.md` §3.1**) and `ConversationDecision` (typed output:
  register, opener_kind, nba, directive spec, + the offer contract stub for Step 2). Put
  in `services/gateway/src/services/conversation/`.
  - The memory orchestrator's mandatory-injection guard (`assertMemoryContextInjected`)
    becomes an expressible invariant of the brain; the social pack feeds NBA/offer ranking
    (matches/messages are already in `OverviewPayload`; the pack is the superset).
- `decideConversationFlow(ctx): ConversationDecision` — **first commit delegates to the
  existing logic and is proven byte-equal to the golden set.** Zero behavior change.

**1c — Strangle the 9 branches, one PR each:**
- Route Vertex's ladder through `decideConversationFlow()` one `wake_opener` branch at a
  time; each PR proves the golden set unchanged, then deletes the dead duplicate.
- Then point **LiveKit** at the same brain. Build the **text-adapter seam now** (the
  brain is transport-agnostic by construction) but only wire Vertex + LiveKit; wire the
  text surface when it exists.
- **Flip the parity scanner to `blocker`** once all surfaces delegate.
- **Exit Step 1:** every surface routes through `decideConversationFlow()`; the 9
  branches are gone; parity scanner green at blocker; golden set unchanged throughout.

### STEP 2 — Typed contracts: offer / confirmation / tool-outcome / next-turn
- **ToolOutcome contract:** make tool output speakable-by-type — status
  `done | nothing_yet | needs_confirmation | failed`, always a presentable rendering,
  never raw JSON/empty/nav-only. Tighten `OrbToolResult` so `text` is effectively
  required (or derived). This generalizes the per-tool speakable fixes (#2811/#2813)
  into an enforced contract.
- **Offer + confirmation:** every offer Vitana makes writes a `pending_cta`; acceptance
  executes the EXACT bound action and **consumes only after success** (fix consume-before-
  execute); `needs_confirmation` gates consequential writes (the "du musst doch erst mit
  mir…" fix — present the plan, get yes, THEN write).
- **Exit:** speakable-tool contract is type-enforced; offer→accept→execute is universal
  (not navigate-only); confirm-before-write exists for consequential tools.

### STEP 3 — Versioned multi-turn scenario / replay suite
- Promote 1a's golden harness into a **multi-turn** scenario suite with **before/after
  blast-radius diff** across transports, languages, roles, screens, recency states. This
  gates every later change (would have caught #2814). Cover `buildResumeDirective`
  coupling at scenario level.
- **Exit:** every flow PR shows a reviewed behavior diff; the suite is the merge gate.

### STEP 4 — Workbench, READ-ONLY first
- Command Hub "Conversation" section (sidebar: Assistant → Conversation → Voice),
  **read-only**: causal trace viewer, simulator (dry-run `decideConversationFlow` for a
  user — no speaking), contract-violation feed, tool-outcome/tool-failure feed.
  Build recipe (exact app.js edits, auth, CSP, endpoints) is in `CONVERSATION_FLOW_HANDOFF.md`
  §7–§9 — but **read-only; no editing controls yet.**
- **Canon carve-outs (add to `CLAUDE.md` in this step):** (1) the "exactly 10 sidebar
  items / never change sidebar navigation" rule governs the **community-app** end-user
  sidebar (`vitana-v1`), NOT the Command Hub admin nav — adding an admin section is
  allowed; (2) Command Hub styling goes in `styles.css` — **no inline CSS** (do not rely
  on the CSP's `style-src-attr` allowance).
- **Exit:** operators can see and explain every decision; still no editing.

### STEP 5 — Config revisions (immutable, governed)
- `draft → validate (Step 3 suite) → stage/canary → publish → rollback`, immutable
  versioned revisions. No live knob write without this lifecycle.
- **Exit:** any config change is reviewable, validatable, reversible.

### STEP 6 — Bounded tenant overrides (LAST)
- `tenant_conversation_config` (mirror `tenant_settings`, NOT the global impact-rules
  table) + resolver = `global defaults ⊕ tenant overrides`, threaded into the pure brain
  functions; default behavior unchanged when a tenant has no row. Design detail in
  `CONVERSATION_FLOW_HANDOFF.md` §6.
- Only bounded **surface** behavior is tunable. The Step-1 invariants
  (character/safety/truthfulness/continuity) are **globally non-overridable** and the
  validator rejects override attempts.
- **Exit:** tenants customize within guardrails; core invariants cannot be overridden.

---

## 5. Decisions already made (don't re-litigate)
- Parity scanner: **warning** through Step 1b, **blocker** at end of 1c.
- Text surface: build the adapter **seam** now; wire Vertex+LiveKit; wire text when it exists.
- Canon carve-out edits: deferred to **Step 4** (not before).
- Replay/scenario harness: the **read-only golden half lands in Step 1a** (before any
  extraction); the full multi-turn suite is Step 3.

---

## 6. Explicitly NOT yet
Tenant knobs (Step 6), any editable hub control (Step 5), behavior "improvements" bundled
into extraction commits (never — separate, diffed commits). The four shipped staging
fixes (#2810/#2811/#2813 + #2807) stay and become **golden-pinned** in Step 1a.

---

## 7. Risks & rollback
- **Drift during extraction** → golden-equal gate + one-branch-per-PR revertability.
- **Concurrent edits to the same ladder** (e.g. another session, as #2814 did) → the
  parity scanner (1a, warning) surfaces new local logic immediately; small PRs limit collision.
- **No live prod observability** → proof is offline golden/scenario, not logs.

---

## 8. THE FIRST PR (start here)
**Step 1a only:**
1. Extract a pure `computeGreetingDecision(ctx)` from `sendGreetingPromptToLiveAPI` that
   returns the decision object with **no** side effects; the live path calls it then
   behaves exactly as before.
2. Golden characterization jest suite over `computeGreetingDecision` across the §4 matrix,
   under `services/gateway/test/services/conversation/`.
3. Extend `FLOW_SOURCE_RE` to include `routes/orb-live.ts` + `routes/orb-livekit.ts`.
4. Add the transport-parity scanner (severity **warning**) + registry entry + seed migration.

**Acceptance:** `tsc` clean; golden suite green; CI guard now trips on `orb-live.ts`
changes; parity scanner reports the 9 branches; **zero runtime behavior change**
(diff is extraction + tests + CI only). Ship as one PR, flow test included.

---

## 9. Change log
| Date | Change |
|---|---|
| 2026-06-30 | Step 1a shipped (PR #2825): pure `computeGreetingDecision` seam + golden suite + CI flow-guard extension (now covers `routes/orb-live.ts`/`orb-livekit.ts`) + `transport-flow-parity` scanner (warning). Reconciled the plan with two post-v2 layers that landed on `main` — the **memory orchestrator** (#2830/#2831, mandatory memory step) and the **social context pack** (#2832/#2833) — as first-class `ConversationContext` inputs + Hub observables (see `CONVERSATION_FLOW_HANDOFF.md` §3.1). Neither touched the greeting ladder, so the Step-1a seam is unaffected. |
| 2026-06-29 | v3 roadmap authored + approved: consolidate-first ordering, every-surface mandate, non-overridable invariants, characterization-first strangler-fig method, demote hub to Step 4 (read-only) and tenant overrides to Step 6, first-PR = Step 1a. Supersedes the build-order in `CONVERSATION_FLOW_HANDOFF.md` (which remains the asset/Command-Hub reference). |
