# VTID-03940 — Fix buildContextSignalFromMemory() always returning empty recent_topics

## Context

Rung 2 of a 5-rung staged trust-building exercise for the Operator/autopilot
execution plane, executed directly by this Claude Code session per explicit
platform-owner instruction (proxying the task itself — no exafy_admin
credentials to invoke the real `autopilot_execute_task` on-ramp). Rung 2's
purpose specifically: a task where the touched code has weak/no existing
test coverage, proving the ability to build correct new test infrastructure
from scratch, not just extend an already-tested module (which Rung 1 did).

## Bug

`buildContextSignalFromMemory()`
(`services/gateway/src/services/intent-detection-engine.ts`) is a real, live
call site — imported and invoked by `routes/orb-live.ts` to build
`context_bundle` for every ORB intent-classification turn — not dead code.
Its `recent_topics` field was hardcoded to `[]` with a `// TODO: Could
extract from conversation items` comment, silently dropping real signal on
every call, while the adjacent `personal_facts` field correctly extracted
from the same items array.

This module had **zero pre-existing test coverage** (confirmed: no
`intent-detection-engine*.test.ts` existed anywhere under
`services/gateway/test` before this VTID).

## Fix

Extended the existing item-iteration loop to also collect
`category_key === 'conversation' || 'notes'` items into `recentTopics`,
truncated to 100 chars and capped at 5 — matching the exact conventions
already used for `personal_facts` in the same function, and matching the
sibling `buildMemoryHints()` in `services/navigator-consult.ts` (which
already uses the identical `'conversation' || 'notes'` category
convention for the same purpose, just with a cap of 3 there).

## Acceptance Criteria

AC-1 — `recent_topics` is populated from `conversation`/`notes`-category
memory items instead of always being `[]`.

TEST (new file, written from scratch):
`services/gateway/test/intent-detection-engine.test.ts` — "VTID-03940:
extracts recent_topics from conversation/notes items instead of always
returning []".

AC-2 — No regression: `recent_topics` stays `[]` when no conversation/notes
items are present, and `personal_facts`/`memory_categories`/
`memory_item_count` are unaffected.

TEST: same file — "recent_topics stays empty when no conversation/notes
items are present (no regression)", "extracts personal_facts from
personal/relationships items, unchanged", "memory_categories and
memory_item_count are unaffected by the recent_topics fix".

AC-3 — `recent_topics` follows the same capping (5 items) and truncation
(100 chars) discipline as `personal_facts`.

TEST: same file — "caps recent_topics at 5, same as personal_facts",
"truncates each recent_topics entry to 100 characters, same as
personal_facts".

## Verification

- `tsc --noEmit`: clean (`outputs/tsc-noemit.txt`).
- New suite (written from scratch, no pre-existing coverage to extend):
  `outputs/jest-new-suite.txt` — 8/8 passing.
- Full gateway suite (regression check): `outputs/jest-full-suite.txt` —
  915/916 suites (1 pre-existing skip), 15,076/15,111 tests passing, 0
  failures. (Suite/test counts are higher than Rung 1's snapshot because
  `main` has continued advancing from other concurrent work in this
  shared repo between rungs — this run reflects the current `main` plus
  this fix, not a regression baseline drift.)

## What this does NOT do

- Does not touch `orb-live.ts` (the only call site) — it consumes
  `context_bundle.recent_topics` as-is; no caller-side change needed or
  made.
- Does not touch `navigator-consult.ts`'s own `buildMemoryHints()` — that
  function already worked correctly and was used only as a precedent to
  follow, not a file to edit.
- Does not change the `'personal' || 'relationships'` → `personal_facts`
  branch at all.

## OASIS impact

OASIS_IMPACT: no — a pure-function bug fix, no schema/event changes.
