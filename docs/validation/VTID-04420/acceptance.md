# VTID-04420 — Conversation rebuild WS-2.1: providers as candidate sources, greeting steps as the phrasing layer

This is Plan v1 (Conversation Intelligence Rebuild), Phase 2, workstream WS-2.1.
It ships in PR #3614 as a companion to VTID-04339.

## What was actually true (measured, read-only)

The full 30-day measurement is in `outputs/reach-report.md`. Its main findings:

- **13 continuation providers produce candidates.** The ranker (`decideContinuation`) picks one. The greeting steps in `compute-greeting-decision.ts` then decide what is actually said.
- **Only one step speaks the ranker's winner.** That step is `override_v2`, and it fired 15 times in 30 days. Other steps outranked the winner on most of the ~233 openings that had one, and nothing recorded when that happened.
- **Two greeting steps still handed the model a finished sentence to recite** (`Say exactly: "…"`):
  - `safe_fast_first_time_welcome`: a per-language welcome speech from `greeting-pools.ts`.
  - `safe_fast_newday`: a `Record<lang, string>` of greetings covering five languages, so pt/pl/ru/tr/ar/zh sessions were greeted in English.

  Both break NEVER-rule 41, and both use the verbatim-recitation shape the Nova guardrail blocked 93/93 times in VTID-03797.

## Fix

### One phrasing rule (`services/conversation/phrasing-rule.ts`)

- **`PHRASING_RULE`**: one positive-only rule. The model composes the words itself, in the user's language, fresh every time.
- **`buildOpeningIntentDirective(intent, shape)`**: every rung that needs a new directive builds it from an intent plus this rule.
- **`isVerbatimRecitationDirective`**: detects the forbidden shape. It still allows "do not recite the lead word for word".
- **The two verbatim rungs are now intents.** They keep the same content: welcome, introduce Vitana, and offer the first session; or greet by name for the time of day.

### Candidate outcome per opening (`decideConversationFlow`)

- **`resolveCandidateOutcome(wakeOpener, wakeBriefDecision)`** returns:
  - which provider's candidate won;
  - its kind and key;
  - whether the rung that fired spoke it;
  - which rung outranked it;
  - how many providers returned a candidate.
- **Both `greeting_sent` emits in `orb-live.ts`** add these fields through `withGreetingMonitorFields`'s new `candidate` option.
- **The golden rung fields are untouched.** The candidate columns are added next to them.

### Brain inspector (Command Hub › Conversation › Simulator / Journey Context)

- **New Candidates section.** It shows each provider's result, latency and reason, plus the ranker's pick.
- **Where it reads from.** It reads the session's `orb_wake_timelines` row, a single-row primary-key lookup. A failed read leaves the section empty and the rest of the summary unchanged.
- **The Decision table gains a Candidate column**, showing the provider and whether it was spoken or outranked.

### Reach report for the owner

`outputs/reach-report.md` lists the providers and steps that are never or almost never reached.

- **Nothing was removed** (plan: "listed for your decision").
- **One correction to the plan's candidate list:** `silent_reconnect` and `silenced_on_cadence` are silent by design. They emit no `greeting_sent`, so a zero count is not evidence that they are dead.

## Acceptance criteria

AC-1: No greeting step, across 5 languages × 8 recency buckets × 8 context variants × both ladders, asks the model to recite a finished sentence.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts

AC-2: The former verbatim steps carry the shared phrasing rule and the user's name, and contain no hardcoded greeting text. Their 4 golden snapshots were re-recorded deliberately; the diff is reviewed in `commands.log`.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts

AC-3: `resolveCandidateOutcome` names the winning provider, says whether `override_v2` spoke it, names the outranking rung otherwise, and reports nothing when no candidate was picked.
TEST: services/gateway/test/services/conversation/vtid-04420-brain-candidates.test.ts

AC-4: Both `greeting_sent` emits carry the candidate columns, and omitting them adds nothing.
TEST: services/gateway/test/services/conversation/vtid-04420-brain-candidates.test.ts

AC-5: The inspector reads the wake timeline by session id (one keyed row), summarizes the provider results, and survives a failed read.
TEST: services/gateway/test/services/conversation/vtid-04419-session-brain-inspector.test.ts

AC-6: The Candidates section renders on desktop (1400×900) and mobile (390×844) with no page overflow. The table scrolls inside its own wrapper, as the existing tables do.
TEST: docs/validation/VTID-04420/outputs/shoot-report.json

## Not verified live

- **Staging deploy.** Staging ECS could not place tasks at the time of writing (see the VTID-04332 row). The first real signal is a `greeting_sent` event on staging carrying `candidate_provider`, and the inspector's Candidates section filled for that session.
- **The Nova content-filter effect of the two rewritten steps.** Neither step fired more than once in 30 days, so there is no rate to compare. They are fixed on shape-class grounds (VTID-03797 / VTID-04124), not on a measured rate of their own.
