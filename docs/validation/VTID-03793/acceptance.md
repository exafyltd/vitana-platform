# VTID-03793 — Acceptance (Daily Diary voice dictation splitting fix)

Reported: a single continuous voice dictation to Vitana ("log my diary: I had
mashed potatoes with two eggs, which wasn't enough, half a liter of water, ...")
landed in the Daily Diary as 7-8 separate `diary_entries` rows — one per
clause/fact — instead of one entry, screenshotted live on
`https://preview-aws.vitanaland.com/memory/diary`.

Root cause: the `save_diary_entry` tool's system-instruction rule (rule M,
`live-system-instruction.ts`) and its own tool description
(`live-tool-catalog.ts`) told Nova Sonic to call the tool whenever the user
reports "something they did or want to track", with no instruction to batch
multiple facts from one continuous turn into a single call — so the model
called the tool once per reportable fact. The frontend (`DiaryEntryList.tsx`
in `exafyltd/vitana-v1`) does no write-time or read-time merging; it renders
whatever rows exist, so the fix has to be server-side.

Two changes, both scoped to `services/gateway/src/`:
1. Prompt-side: strengthened rule M and the tool description with an explicit
   "ONE CALL PER DICTATION" instruction to accumulate everything reported in
   one turn and call the tool once.
2. Deterministic backstop (does not depend on model compliance with (1)):
   `tool_save_diary_entry` now coalesces a voice diary fragment into the
   user's most recent voice `diary_entries` row if that row is younger than
   `DIARY_VOICE_COALESCE_WINDOW_MS` (default 60s), instead of always
   inserting a new row.

Verification tokens: TEST = jest suite (run against this branch).

AC-1 — A second `save_diary_entry` voice call landing within the coalesce
window appends to the existing recent row instead of inserting a new one.
  TEST: services/gateway/test/save-diary-entry-shared.test.ts ("12. a second voice call within the coalesce window UPDATES the recent row instead of inserting a new one")

AC-2 — A voice call landing OUTSIDE the coalesce window inserts a new row
rather than merging into a stale one.
  TEST: services/gateway/test/save-diary-entry-shared.test.ts ("13. a voice call OUTSIDE the coalesce window inserts a new row instead of merging")

AC-3 — The very first voice diary call for a user (no recent row at all)
still inserts correctly; the coalescing lookup does not crash on a null
recent entry.
  TEST: services/gateway/test/save-diary-entry-shared.test.ts ("14. no prior voice entry at all inserts a fresh row (no crash on null recent entry)")

AC-4 — A failure in the coalesce-update path is non-fatal: the health
extractor / Vitana Index recompute still runs and the tool still returns
`ok:true`, matching the existing non-fatal-insert-failure contract.
  TEST: services/gateway/test/save-diary-entry-shared.test.ts ("15. a coalesce-update failure is non-fatal — RPC still runs, result still ok")

AC-5 — The `save_diary_entry` tool description now instructs the model to
batch one dictation into a single call (the prompt-side half of the fix).
  TEST: services/gateway/test/orb/live/characterization/tool-catalog.characterization.test.ts (updated snapshot includes the "ONE CALL PER DICTATION" text)

AC-6 — Every pre-existing `save_diary_entry` behavior (happy-path insert,
bare-consent rejection, entry_date handling, index-delta announcement, ORB
tool registry wiring) is unchanged when no recent voice entry exists to
coalesce into.
  TEST: services/gateway/test/save-diary-entry-shared.test.ts (tests 1-11, unmodified assertions, all still passing)

SCOPE_ALLOWLIST:
  services/gateway/src/orb/live/instruction/live-system-instruction.ts
  services/gateway/src/orb/live/tools/live-tool-catalog.ts
  services/gateway/src/services/orb-tools-shared.ts
  services/gateway/test/save-diary-entry-shared.test.ts
  services/gateway/test/orb/live/characterization/__snapshots__/system-instruction.characterization.test.ts.snap
  services/gateway/test/orb/live/characterization/__snapshots__/tool-catalog.characterization.test.ts.snap
  docs/validation/VTID-03793/**

No route was added or removed by this PR (no changes under
`services/gateway/src/routes/`), so the Route Mount Evidence Gate does not
apply.

OASIS_IMPACT: no — this changes an ORB voice tool's prompt wording and adds
a coalescing branch to an existing tool handler's DB write path; it does not
touch VTID lifecycle state, OASIS event emission, or governance tables.
