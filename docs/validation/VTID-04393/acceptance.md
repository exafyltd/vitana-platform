# VTID-04393 — Conversation rebuild WS-1.1: priority packer for the voice bootstrap context

Plan v1 (Conversation Intelligence Rebuild), Phase 1, workstream WS-1.1.
Ships in PR #3614 as a companion to VTID-04339.

## What was wrong

- **The 12 KB cap kept the head, and the most important blocks are at the tail.**
  - `capBootstrapContext()` keeps the first 12 000 characters of the voice
    bootstrap context.
  - The ORB session builder (`orb-live.ts`) appends the session-owning blocks
    to the END of that string, after memory, profile and social context:
    - the wake-brief override;
    - Teacher Mode;
    - the journey-guide and guided-topic blocks;
    - the swap-back welcome;
    - the persona behavioural rules.
  - So for a heavy user, the cap cut exactly the blocks that decide what the
    session is about, and kept the oldest memory bullets.
- **Found while testing: the whole tail was quoted a second time, uncapped.**
  - The Activity Awareness Override re-quotes the user context profile. It
    located the profile with a lazy regex that ended at `\n\n##`, `\n\n**` or
    the END OF THE STRING.
  - The blocks after the profile are joined without such a boundary, so the
    match ran to the end of the bootstrap.
  - It re-appended the persona rules, the wake-brief override and Teacher Mode
    a second time, outside the cap. The override could appear twice, and the
    12 KB budget was bypassed for every session with a profile.

## Fix

- **New `orb/live/instruction/bootstrap-packer.ts`** (pure).
  - It splits the bootstrap at the headers the builders really emit:
    `=== X ===`, `## X`, the wake-brief sentinel, `<social_context>`,
    `[SWAP-BACK WELCOME`, `[BEHAVIORAL RULES` and `ENVIRONMENT CONTEXT:`.
  - Each section gets a priority and a tier (core / situational / deep):

    | Priority | Sections |
    |---|---|
    | Pinned | Identity, the override, Teacher and guide modes, swap-back welcome, persona rules, the memory self-check, `=== END … ===` lines |
    | Next | Recent utterances, verified facts, Life Compass goal |
    | Then | Proactive opener |
    | Then | Memory items and specialist context |
    | Then | Profile |
    | Last | Social context |

  - The budget is filled in that order. A large low-priority section is cut at
    a line boundary rather than dropped.
  - Kept sections are emitted in their original order, with one sentinel that
    names what was shortened or omitted.
  - Under budget the input is returned byte-for-byte, so only users whose
    bootstrap was already being cut see any change.
- **`buildLiveSystemInstruction` uses the packer in place of the head-slice.**
  - `BRAIN_CONTEXT_PACKER=false` restores the head-slice.
  - A new optional last parameter, `onContextPacked`, hands the pack report to
    the caller.
- **The profile re-quote takes exactly the `context_profile` section** found
  by the same splitter.
- **`orb-live.ts` records a `brain_context_built` diag** per distinct build:
  - chars before and after;
  - whether anything was packed;
  - section count and pinned chars;
  - the kept, shortened and dropped keys.

## Deliberate scope (the rest of WS-1.1 lands with WS-1.2/1.3)

- **Not yet a new brain API.** Plan v1's `brain.buildContext()` (tiers with a
  per-tier budget, deep context only through tools) needs the per-user core
  snapshot (WS-1.2) and every path routed through one builder (WS-1.3).
- **What this VTID delivers:**
  - the priority packer the plan asks for;
  - the telemetry;
  - the fix for the duplicated tail.
- **The event is an `orb.live.diag` stage (`brain_context_built`),** not a new
  topic. It then flows into the WS-0.7 rollup path and the Monitor without a
  new union type.

## Acceptance criteria

AC-1: Splitting is lossless (sections concatenate back to the input) and classifies the headers the builders really emit; the Teacher and guide-mode headers in their source files are pinned.
TEST: services/gateway/test/orb/live/instruction/vtid-04393-bootstrap-packer.test.ts

AC-2: Under budget the bootstrap is unchanged; over budget the wake-brief override, Teacher Mode, memory self-check, recent utterances and verified facts survive where the head-slice cut them, the result fits 12 000 chars, and the sentinel names what was shortened or omitted.
TEST: services/gateway/test/orb/live/instruction/vtid-04393-bootstrap-packer.test.ts

AC-3: Lowest priority is dropped first, a large memory block is shortened at a line boundary, and the kept sections keep their original order.
TEST: services/gateway/test/orb/live/instruction/vtid-04393-bootstrap-packer.test.ts

AC-4: The real instruction builder keeps Teacher Mode for a heavy user and hands the report to the caller; `BRAIN_CONTEXT_PACKER=false` restores the head-slice and calls no callback.
TEST: services/gateway/test/orb/live/instruction/vtid-04393-bootstrap-packer.test.ts

AC-5: The Activity Awareness Override quotes only the profile; Teacher Mode and the behavioural rules appear once.
TEST: services/gateway/test/orb/live/instruction/vtid-04393-bootstrap-packer.test.ts

AC-6: The LiveKit first-turn directive still survives a heavy bootstrap; the head-slice regression guard still holds on the kill-switch path; no other ORB suite changes.
TEST: services/gateway/test/orb/routes/livekit-first-turn-heavy-context.test.ts, services/gateway/test/orb

AC-7 (post-deploy, staging): `orb.live.diag` rows with `metadata.stage = 'brain_context_built'` appear for voice sessions; for any with `packed = true`, `dropped` never contains `wake_brief_override`, `teacher_mode` or `guide_mode`.
TEST: services/gateway/test/orb/live/instruction/vtid-04393-bootstrap-packer.test.ts

## Not verified live

- No staging voice session has run with the packer yet (AC-7).
- It is not known how many real sessions pack; the first day of
  `brain_context_built` rows answers that.
