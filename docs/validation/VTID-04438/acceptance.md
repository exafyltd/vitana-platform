# VTID-04438 — Conversation rebuild WS-4.1: the broader nightly profile

This is Plan v1 (Conversation Intelligence Rebuild), Phase 4, workstream WS-4.1. It ships in PR #3614 as a companion to VTID-04339.

## Why

The nightly synthesis (AP-0911, `user-model-synthesis.ts`) wrote one prose narrative from four inputs: memory facts, routines, the Life Compass goal and the Vitana Index. It never saw:
- what the user talked about with Vitana;
- what they wrote in their diary;
- which suggestions they take up.

There were two further gaps:
- **Unstructured output.** The narrative had no separate preferences, open threads or "what works for this person".
- **Missing from brain sessions.** Only the legacy profiler path injected it. `buildBrainSystemInstruction`, which every brain voice session uses and which the core snapshot stores (VTID-04399), never read the profile.

## Change

- **Inputs** (each best-effort; a failed read leaves that input empty):
  - the last 8 conversation summaries from `user_session_summaries`, 30 days, 400 characters each, with themes;
  - the last 8 diary entries from `diary_entries`, 14 days, 300 characters each;
  - suggestion outcomes per provider from `conversation_offer_outcomes`, 90 days.

  All three are part of the inputs hash, so new material re-synthesizes. That also means every existing profile re-synthesizes once after deploy: one `memory`-stage call per active user.
- **Enough to say:** 3 facts as before, **or** at least 5 items across facts, conversations and diary.
- **Output:** JSON with `summary` (4–6 sentences), `preferences`, `routines`, `open_threads` and `what_works`, each list at most 6 items of 160 characters.
  - A prose answer is still accepted (the previous shape), so the synthesis never degrades to nothing.
  - `suggestion_fit` is **computed from counts, not by the model**: at least 3 settled offers, with ≥ 60 % taken up counting as "takes up" and ≤ 20 % as "turns down". Providers get plain-English labels.
- **Storage:** the same `user_assistant_state` row (`user_profile_narrative_v1`). `narrative` is the summary, so every existing reader keeps working. The row adds `schema_version: 2`, `structured`, `inputs_counts` and `sections_filled` (0–6).
- **Where it is used:**
  - **Brain core instruction:** `readUserProfileBlock` runs on the community surface only, with an 800 ms bound. It returns '' on anything but a fresh (VTID-04340 max age) stored profile. It is placed after the identity guardrail, so the per-user **core snapshot carries it too**. Kill switch: `BRAIN_PROFILE_BLOCK=false`.
  - **Legacy profiler:** a structured profile renders as the same block; a prose-only one keeps the VTID-04340 line.
  - **The block itself** is data only: a header, the summary and labelled lists, with no imperatives and no quoted lines (Nova filter, VTID-04124). It is bounded to 2,400 characters, dropping list items first.
  - **Packer:** the bootstrap packer gives it its own section, `user_profile`, at priority 2 (kept before memory items), inside the same 12 KB budget.
- **Command Hub → Assistant → Metrics (Learning health):**
  - a Structured profiles tile (count, average parts filled out of 6);
  - an Inputs seen tile (profiles built with conversations · diary · suggestion outcomes).
  - The read selects stamps and counts only, never the text.

## Acceptance

AC-1: The model's structured answer is parsed, bounded and de-duplicated. A prose answer still yields a narrative. Empty, short or broken output is refused.
TEST: services/gateway/test/services/conversation/vtid-04438-structured-profile.test.ts

AC-2: Suggestion fit is computed from counts (3 settled minimum, 60 % / 20 % thresholds), with plain-English provider names.
TEST: services/gateway/test/services/conversation/vtid-04438-structured-profile.test.ts

AC-3: The rendered block has the packer header and labelled lists. It contains no recitation directive and no imperatives, stays within its bound, and the packer keeps it at priority 2.
TEST: services/gateway/test/services/conversation/vtid-04438-structured-profile.test.ts

AC-4: The synthesis:
- has enough inputs with 3 facts, or with conversations and diary;
- carries conversations, diary and suggestion history in its prompt;
- changes the hash on new material;
- stores `structured` beside `narrative` with the computed fit and input counts;
- survives failing input reads.

TEST: services/gateway/test/services/conversation/vtid-04438-structured-profile.test.ts, services/gateway/test/services/user-model-synthesis.test.ts

AC-5: The block reaches the brain's core instruction (community only), and therefore the core snapshot. It is empty when stale, absent, disabled, slow or failing. The reader keeps the pre-VTID shape for prose rows (the VTID-04340 suite passes unchanged).
TEST: services/gateway/test/services/conversation/vtid-04438-structured-profile.test.ts, services/gateway/test/services/vtid-04340-profile-narrative-freshness.test.ts

AC-6: Learning health shows profile quality and input coverage from stamps and counts only. Verified at 1400×900 and 390×844 (`outputs/`).
TEST: services/gateway/test/services/conversation/vtid-04438-structured-profile.test.ts

AC-7 (post-deploy, staging): after the next AP-0911 pass, Learning health shows structured profiles above 0, and a signed-in brain session logs `profile=on` in `[VITANA-BRAIN] System instruction built`.
BLOCKED: staging ECS cannot place tasks (AWS account block); the nightly jobs have not run since 2026-07-12 (WS-0.2, owner action).

## Flagged for the owner

- **Diary entries now reach the `memory` routing stage** (Bedrock under policy v17) as synthesis input. The plan names them as an input. The prompt asks to keep sensitive details general, and the profile is private context only. This is the same boundary question the plan raises for the advisor.
- **One re-synthesis per active user after deploy**, because the inputs hash changed.
