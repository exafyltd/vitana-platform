# Vitana Conversational Flow — Architecture Specification & Change-Control Contract

> Status: **BINDING** (VTID-03273). This document governs the ORB voice conversational
> flow: how Vitana opens a conversation, holds a turn, survives a reconnect, and how
> any future change to that flow must be proven safe before it ships.
>
> Read order: §0 Diagnosis → §1 Target Architecture → §2 Acceptance → §3 Migration →
> **§4 Change-Control Contract (MANDATORY, every change)** → §5 Command Hub cockpit.

---

## 0. Diagnosis — why months of fixes never held

Two structural faults, both proven in the code, produce the recurring failures
("disconnect mid-greeting", "what can I help you with after reconnect", "same summary
every 2 minutes", "vague opener"):

**Fault 1 — there is no single authority over Vitana's first spoken line.**
An audit of the gateway found **~10 independent opener authorities + 2 reconnect-recovery
paths**, deduplicated only by one boolean (`session.greetingSent`):

- the 7-provider wake-brief ranker: `first_time_welcome` (95), `goal_completion_inquiry`
  (92), `journey_guide` (91), `new_day_return` (90), `next_action` (90),
  `feature_discovery_teacher` (85), `voice_wake_brief` (80);
- the greeting-policy gatekeeper (`skip` / `brief_resume` / `warm_return` / `fresh_intro`);
- the base system-instruction **baseline register** (the line that historically sanctioned
  "how can I help");
- the short-gap greeting pools;
- the **reconnect-recovery "intros"** (`orb-live.ts` — the "I'm back / I am here" lines);
- the **teacher-mode recovery** path.

Each historical fix patched one of these; a later failure surfaced from a *different* one.
**While N authorities can each emit a first line, this is unwinnable whack-a-mole.**

**Fault 2 — the conversation is not durable; the connection is.**
Gemini Live caps a single connection at ~10 minutes and then drops it. The gateway uses
**no native Gemini session resumption** (no `sessionResumption` in the setup message, no
`GoAway` handling — confirmed by grep). Instead it tears down and rebuilds a *fresh model
session*, re-injecting the last ~20 transcript turns as text into a new prompt. A fresh
model session has no native continuity, so it improvises a new greeting and loses the
thread — exactly "disconnect → listening → *what can I help you with*".

References (industry standard): Gemini Live
[session management](https://ai.google.dev/gemini-api/docs/live-session) and
[best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices);
[OpenAI Realtime voice agents](https://developers.openai.com/api/docs/guides/voice-agents);
[the voice-AI stack](https://www.assemblyai.com/blog/the-voice-ai-stack-for-building-agents).

---

## 1. Target architecture — four pillars

### Pillar A — ONE First-Utterance Authority (the "Opening Contract")
Exactly one function may produce the first spoken line:
`decideOpening(conversationState) → { mode: 'speak' | 'silent', line, source }`.
The 7 providers, recovery paths, and journey context become **inputs** to it — never
independent emitters.

- The base system instruction must contain **no** sanctioned generic greeting (no baseline
  register, no "speak first with a warm greeting"). The model speaks the contract's line or
  stays silent. This must be **structurally impossible to violate**, not patched per-line.
- Reconnect feeds state into the same `decideOpening`, which on a *resumed* connection
  returns `silent` — it never re-greets.

### Pillar B — Conversation is the durable unit (native session resumption)
- Enable Gemini `sessionResumption` in the setup message; store the rolling
  `resumptionToken` on the **Conversation**, not the connection.
- Handle `GoAway`: when the server signals `timeLeft`, **reconnect proactively before the
  limit** using the token — the user perceives nothing, context is restored natively.
- On any drop, reconnect with the token. No transcript-blob re-injection, no fresh greeting,
  no thread loss.
- A `Conversation` owns: `conversation_id`, `resumptionToken`, `openingDelivered` (replaces
  the scattered `greetingSent` boolean), `phase`. Connections are ephemeral children.

### Pillar C — Explicit, testable conversation state machine
States: `PREWARM → OPENING → (LISTENING ⇄ THINKING ⇄ SPEAKING)`, with an **orthogonal**
`RECONNECTING → RESUMED` that always returns to the *prior* state — **never to OPENING**.
`openingDelivered` is a property of the state, not a flag at six call sites. The opener
fires **exactly once, in OPENING, for the life of the conversation**, no matter how many
connections it spans.

### Pillar D — Stability + content quality
- **No mid-greeting drop:** pre-warm the upstream so first audio is fast; the greeting
  watchdog must not kill a greeting whose audio is *actively streaming*; handle `GoAway`
  proactively (reconnect ~1–2 min before the 10-min cap, not after an abrupt close).
- **No contentless openers:** the contract rejects vague lines ("introduce you something").
  For a non-graduated user it prefers `journey_guide`'s concrete next step over the Teacher's
  abstract invitation, and never emits an opener without a named value/step.

---

## 2. Acceptance criteria — the golden scenarios (device-level gate)

These MUST pass on a real device, per transport (Vertex + LiveKit), per language (de/en),
before any conversational-flow change ships:

1. **Fresh open** → one concrete, leading opener (named next step); audio reaches the phone.
2. **Reopen < 10 min** → short "let's continue", never the full-summary repeat.
3. **Reconnect mid-greeting** → resumes the *same* line/thread; never re-greets; never generic.
4. **Reconnect after a user turn** → continues the answer; never "what can I help you with".
5. **Silent-mode iPhone** → audible (Web Audio ignores the mute switch — VTID-03272).
6. **Exactly one `[opening-decision]` log per conversation**, naming the single source +
   speak/silent + fresh/resumed.

---

## 3. Migration — phased, low-risk, highest-leverage first

- **Phase 0 (do first — biggest win): native session resumption + `GoAway`.** Fixes the
  disconnect / thread-loss / generic-greeting class at the root. Contained (does not touch
  the 10 authorities) and measurable.
- **Phase 1: collapse to one Opening Contract.** Make `decideOpening` the sole emitter;
  remove the reconnect intros + baseline register + legacy blocks as independent paths.
- **Phase 2: the explicit state machine** (`openingDelivered` as state; OPENING reachable
  once per conversation).
- **Phase 3: content-quality guard + the golden-scenario acceptance suite as a CI gate**, so
  a regression can never reach a user without a red test first.

---

## 4. CHANGE-CONTROL CONTRACT — MANDATORY for every future change

> **RULE.** Every future extension, improvement, or change to the assistant / voice / flow —
> however small — MUST be proven against the *entire* list below before merge. "It's a small
> change" is exactly when the flow breaks silently. A change is **not shippable** until the
> full matrix (Tier 0–4) is green and the §4.1 assembly order + §4.2 runtime stages are
> proven unchanged except where the change explicitly intends.
>
> The reviewer MUST paste the §4.1 table into the PR with each row marked
> `unchanged` / `← the only change`, and confirm the §4.4 test scope ran green.

### 4.1 System-instruction chapters (assembly order) — preserved/trimmable

Any change states, per row, whether it is `unchanged` or the intended change. Anything not
explicitly marked as the change MUST render byte-identical.

| #  | Chapter | Preserved/Trimmable |
|----|---------|---------------------|
| 1  | AUTHORITATIVE USER ROLE | scaffold |
| 2  | AUTHORITATIVE VITANA ID | scaffold |
| 3  | IDENTITY LOCK | scaffold |
| 4  | LANGUAGE directive | scaffold |
| 5  | VOICE STYLE | scaffold |
| 6  | USER ROLE + role section | scaffold |
| 7  | GENERAL BEHAVIOR | scaffold |
| 8  | PROACTIVE LEADERSHIP (VTID-03256) | scaffold |
| 9  | GREETING RULES / RECONNECT SILENCE | scaffold |
| 10 | INTERRUPTION HANDLING | scaffold |
| 11 | REPETITION PREVENTION | scaffold |
| 12 | TOOLS: (config summary) | scaffold |
| 13 | IMPORTANT: | scaffold |
| 14 | PREVIOUS CONVERSATION CONTEXT | scaffold |
| 15 | `<!--BOOTSTRAP_CONTEXT_START-->` | marker |
| 16 | Bootstrap (brain/awareness/opener candidate) | bootstrap (trim 2nd) |
| 17 | `<conversation_history>` | history (trim 3rd) |
| 18 | VITANA NAVIGATOR mode | scaffold |
| 19 | TEMPORAL & JOURNEY CONTEXT (tone, journey awareness) | scaffold |
| 20 | PROACTIVE OPENER OVERRIDE (matrix) | scaffold |
| 21 | ACTIVITY AWARENESS OVERRIDE | specialist (trim 4th) |
| 22 | `## AVAILABLE TOOLS` (prose catalog, ~45KB) | scaffold → `tool_catalog` (trim 1st, Vertex only) |
| —  | turn-1 wake-brief override / GUIDE-MODE block | override (preserved) |

### 4.2 Runtime stages — proven unchanged unless intended

1. Session start / auth / identity
2. Context bootstrap assembly
3. Wake-brief decision (journey_guide 91 > new_day 90 > teacher 85 …)
4. Vertex setup + budget guard (`orb-live.ts:6256`)
5. Greeting send (override / cadence-silence / legacy)
6. Audio stream / `model_start_speaking` / `turn_complete`
7. User turn + tool calls (Vertex: structured declarations; LiveKit: prose catalog)
8. Reconnect / recovery
9. Teardown / extraction

### 4.3 Worked example — the Vertex `tool_catalog` budget trim (the canonical surgical change)

The model of a correctly-scoped change. The `## AVAILABLE TOOLS` prose catalog (chapter 22,
~45–68KB) is, on **Vertex only**, 100% redundant with the structured
`tools[0].function_declarations` (name + description + parameter schema) already in the setup
message. LiveKit genuinely needs the prose and has no budget guard, so it is untouched.

Three small edits, **all in the budget layer, zero edits to any conversation-flow code**:

1. `decomposeInstructionSections` (`instruction-budget.ts`): anchor on the `## AVAILABLE
   TOOLS` header → new section kind `tool_catalog`.
2. `DROP_ORDER = ['tool_catalog', 'bootstrap', 'history', 'specialist']` (tool prose dropped
   before anything else).
3. Nothing else.

Effect: Vertex over-budget → prose trimmed → ~68KB → ~23KB → under the 30,720 cap → Vertex
reliably emits audio. Structured tools stay intact → Vertex tool-calling unchanged. **Not one
chapter is reordered; nothing is removed from the model's capabilities — only a redundant text
mirror is dropped on one transport when over budget.** User-visible effect is only positive:
turn-1 reliably produces greeting + summary + foundation checklist instead of going silent.

### 4.4 Test scope — Tier 0–4 (run in full for every change)

The risk of any flow change collapses to one question: *does the change degrade tool-calling,
and does anything else in the prompt shift?* The scope answers it chapter-by-chapter and
stage-by-stage, on **both** transports.

**Tier 0 — the change itself**
- **Gate 1 budget regression:** assert the assembled authenticated instruction (every
  role/surface) ≤ 30,720 with headroom — RED before, GREEN after. *The test that would have
  caught the silent-turn-1 bug.*
- `instruction-budget.test.ts` extended: `tool_catalog` decomposed correctly, dropped first,
  scaffold + override still preserved, no over-trim.

**Tier 1 — instruction integrity (all 22 chapters)**
- `system-instruction.characterization.test.ts` across the full matrix (anonymous / community
  / developer / admin × de / en × reconnect on/off × journey-user × teacher-mode × command-hub
  surface). Chapters 1–21 + override render **byte-identical** to today; chapter 22 is the
  only diff, and only on the Vertex-over-budget path.
- tool-catalog characterization (existing mode/role cells) unchanged — the prose content is
  not edited, only its budget classification.

**Tier 2 — tool-calling parity (highest-risk area)**
- **Vertex:** assert `tools[0].function_declarations` from `buildLiveApiTools` still contains
  all declarations after the prose is trimmed (declaration-count + per-tool name/param
  assertion). Prose and schema come from the same source; trimming prose cannot touch the
  schema.
- **LiveKit:** assert `buildLiveSystemInstruction` (LiveKit path) still embeds the full prose
  catalog (no regression — it does not run the budget guard).
- `ORB_TOOLS_PARITY_GATE=1` lift-scanner (every registry tool has a Vertex case) — re-run.

**Tier 3 — runtime stages (all 9)**
- Reuse existing suites: wake-state-machine acceptance, wake-cross-provider-parity,
  journey-guide, voice-greeting-policy, greeting-block-resolver, strip-brain-opener-sections,
  reconnect/recovery, teardown/extraction. All stay green.

**Tier 4 — build + live acceptance (proves the user actually hears it)**
- `npm run build`.
- Live, on a session minted per transport, across the matrix (de/en, community/developer,
  reconnect, journey-user) — **not a single happy path**:
  - **Vertex:** production log flips `[voice.instruction.budget_overflow] stillOverBudget:true`
    → `[voice.instruction.budget_ok] bytes<30720`; diag shows `model_spoke=1` / `audio_out>0`;
    a tool-call smoke (say "open my profile" → `navigate_to_screen` fires) proves tool-calling
    survives the trim.
  - **LiveKit:** greeting + a tool-call smoke still fire (prose retained).

### 4.5 Definition of done

A conversational-flow change is **done** only when: §4.1 table is in the PR with every row
marked; Tiers 0–3 are green in CI; Tier 4 device acceptance is recorded per transport; and the
§2 golden scenarios pass. No exceptions for "small" changes.

---

## 5. Command Hub — manage & trace the conversation flow

Everything above must be **observable and tunable** from the Command Hub, not buried in code
and logs. Today's relevant surfaces:

- `/command-hub/assistant/overview/` — assistant overview
- `/command-hub/voice/` — voice section
- `/command-hub/testing-qa/unit-tests/` — test status
- `/command-hub/diagnostics/latency/` — latency diagnostics

### 5.1 Where to add the screen

Add a new screen **`/command-hub/voice/conversation-flow/`** as a sub-screen of the existing
`/command-hub/voice/`. Rationale: it is voice-pipeline governance and `voice/` already exists,
so it inherits that section's auth/role gating and navigation. Cross-link it from the other
three surfaces rather than duplicating:

- `/command-hub/assistant/overview/` → a "Conversation Flow health" tile (current single
  opener authority + last-24h opener-drift / silent-turn-1 counts) linking into the new screen.
- `/command-hub/testing-qa/unit-tests/` → surfaces the **§4 Tier 0–4 matrix** status and links
  back here.
- `/command-hub/diagnostics/latency/` → adds reconnect / session-resumption metrics (token age,
  GoAway lead time, time-to-first-audio) that this screen also reads.

### 5.2 Screen design — "Conversation Flow Control"

Six panels, top to bottom:

1. **Flow Map (live assembly order).** The 22 chapters as a vertical list; each row shows
   present/absent, byte size, trim classification
   (`scaffold` / `bootstrap` / `history` / `specialist` / `tool_catalog` / `override`), and
   per-transport (Vertex / LiveKit) budget headroom vs the **30,720** cap. Red when over
   budget; shows what `DROP_ORDER` would trim. This is the §4.1 table, live.

2. **Opener Authority.** The single source that owns the first line today, plus a live
   `[opening-decision]` feed (last N sessions: winner provider, the spoken line, speak/silent,
   fresh/resumed). A **drift alarm** if more than one authority can emit a first line (the §1
   Pillar A invariant) — this is the early-warning the audit would have given for the
   "10 authorities" disease.

3. **Runtime State Machine.** Per active session: the live state (`PREWARM` / `OPENING` /
   `LISTENING` / `THINKING` / `SPEAKING` / `RECONNECTING` / `RESUMED`), reconnect/resume
   events, and **session-resumption status**: enabled? last token age? `GoAway` lead-time
   handled? — the Pillar B/C health.

4. **Policy Knobs (`decision_policy`, versioned).** Editable, with `effective_from` / `version`:
   watchdog timeouts (greeting / turn / forwarding-ack), cadence thresholds (recency, greet-once
   window), `DROP_ORDER`, `sessionResumption` on/off, budget cap. Writes go through the existing
   `decision_policy` versioning so changes are auditable and revertible.

5. **Regression Matrix (§4).** Tier 0–4 green/red with last-run timestamps, linked to the test
   suites and to the §2 golden-scenario device-acceptance results per transport/language. A
   change cannot be marked shippable here unless this is green — the cockpit enforces §4.5.

6. **Session Inspector / Replay.** Pick a live or recent `session_id` → a timeline of stages
   (wake-decision → budget → greeting send → audio → turns → reconnect), with the actual
   assembled instruction bytes, the `[opening-decision]`, and any `budget_overflow` /
   `budget_ok` lines. This is the "follow and manage the conversation flow setup" capability —
   one place to see exactly why Vitana said (or didn't say) what she said.

---

## Appendix — provenance

- Diagnosis + architecture: VTID-03273 (this document).
- Related ships: VTID-03256 (proactive-lead doctrine), VTID-03270 (residual preference-asking
  + teach-mode write guard), VTID-03271 (baseline register must lead), VTID-03272 (iOS
  mute-switch audio + journey_guide recency gate).
- The `tool_catalog` trim (§4.3) is the canonical worked example of a correctly-scoped change;
  implement it under its own VTID following §4.4 in full.
