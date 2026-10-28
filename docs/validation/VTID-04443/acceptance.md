# VTID-04443 — Conversation rebuild WS-4.4: the conversation replay test set

This is Plan v1 (Conversation Intelligence Rebuild), Phase 4, workstream WS-4.4. It ships in PR #3614 as a companion to VTID-04339.

## Why

Every earlier workstream pinned its own piece: the golden opening snapshots, tool selection, turn candidates, scoring and personal weights. Nothing replayed **a whole conversation** through the brain end to end, so a change could keep each piece's unit tests green and still change what a member actually gets:
- which opening fires;
- whether the provider that won is spoken;
- which tools the screen gets;
- which lead comes first after a screen change;
- whether the advisor wakes on small talk.

The plan asks for "consented or synthetic conversation recordings, run as a check before any conversation-logic change is merged".

## Change

- **`services/conversation/replay/conversation-replay.ts`** (pure: no I/O, no clock, no model).
  - `replayConversation(case)` runs:
    - the opening through `decideConversationFlow`;
    - the provider outcome through `resolveCandidateOutcome`;
    - the shadow ranking with the user's personal weights;
    - then each turn: `context_update` → the route's tool selection on the real signed-in catalog and Nova budget → `find_tool` → next-step leads → advisor eligibility.

    It returns one transcript.
  - `checkReplayExpectations` compares the transcript with the case's `expect` block. It always fails an opening that asks the model to recite (NEVER-rule 41).
  - `caseSkeletonFromInspector` turns a saved brain-inspector summary into a case. It **refuses without a consent reference** and keeps no user id, session id or spoken text. A spoken override gets a synthetic placeholder line.
- **Nine synthetic cases** in `test/fixtures/conversation-replay/cases/`. They cover:
  - openings `override_v2`, `legacy_default`, `silent_reconnect` and `safe_fast_first_time_welcome`;
  - a spoken winner, an outranked one and a silent one;
  - the wallet and health screens;
  - `find_tool` reaching a deferred wallet tool;
  - small talk not waking the advisor;
  - a screen change reordering the leads;
  - personal weights changing the shadow pick and the live leads.
- **The gate:** `test/services/conversation/vtid-04443-conversation-replay.test.ts` runs in the normal Gateway Jest CI, where `--ci` is on, so a changed or missing snapshot fails. It checks, per case:
  - the expectations;
  - determinism;
  - a transcript snapshot.

  It also checks the case set itself: ids match files, the schema is current, no personal data, and the coverage floor. `npm run test:replay` runs it alone.
- **`scripts/record-replay-case.ts`** records a consented case from a saved inspector JSON. It makes no network call and reads no database. `test/fixtures/conversation-replay/README.md` gives the rules.

## Acceptance

AC-1: Every case meets its reviewed expectations, is deterministic, and matches its recorded transcript.
TEST: services/gateway/test/services/conversation/vtid-04443-conversation-replay.test.ts

AC-2: The case set holds no personal data (synthetic or consented; no UUIDs, emails or id keys) and covers the named openings, spoken, outranked and silent winners, `find_tool`, the advisor gate and personal weights.
TEST: services/gateway/test/services/conversation/vtid-04443-conversation-replay.test.ts

AC-3: The gate catches a real behaviour change. With a one-line mutation (the screen feature's "already on this screen" value, 0.2 → 0.9), the replay failed the `screen-change-leads` expectation and its snapshot in CI mode (2 failed, 1 snapshot failed); restored, all 34 pass.
TEST: services/gateway/test/services/conversation/vtid-04443-conversation-replay.test.ts

AC-4: Broken expectations are reported one by one, and a recital directive always fails.
TEST: services/gateway/test/services/conversation/vtid-04443-conversation-replay.test.ts

AC-5: Recording refuses without consent and keeps only what the brain decided from. The recorded skeleton replays to its recorded opener.
TEST: services/gateway/test/services/conversation/vtid-04443-conversation-replay.test.ts
