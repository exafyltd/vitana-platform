---
slug: bridge-drift-fix
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-12T20:55Z
---
# Handoff — bridge-drift-fix

Plan: `plan.md`. Tasks: `tasks.md`. One lane (`fix`): four independent fixes for the four suites `#5021` and `#5027`
broke on `main`.

## Log

### 2026-11-12T20:55Z · kiro-exafyltd-202611122052-a6df · drafted
Owner instruction 2026-11-12 ("FIX MAIN (unblocks everything)"), quoted in `plan.md`. Pushed as a `plan(` PR for
PLAN-SPAR. No VTID before convergence; CI allocates it.

Decisions taken:
1. C1 (catalog) duplicates the content of open PR #5050 (same bot identity, not merged). Rather than depend on or
   merge that PR, this lane makes the identical one-line, data-only edit itself, so the owner's "one PR" instruction
   is met without a cross-PR dependency; if #5050 lands first, the hunk is dropped as a no-op before this lane
   merges.
2. C3 and C4 are widen-the-tolerance / add-a-reasoned-comment fixes, not reverts of #5021's content — the bridge
   period wording and the migration's logic both stay as the owner's 2026-11-12 instruction set them.
3. The migration stays unapplied; this PR only edits its text.
