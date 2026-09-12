# VTID-03823 — Command Hub Tasks board hygiene UI

## Report

The Tasks board had no way to triage a growing backlog: no filters beyond
free-text search/date, no visibility into how old a task was, no bulk
action for cleaning out stale scheduled tasks, and no way to move a card
between columns except opening the drawer and clicking a button. This
VTID adds four independent hygiene features, and a real, pre-existing bug
found while verifying the second one.

**AC-5's bug in full:** `.task-card-status-row` had `overflow: hidden`
on `origin/main` before this VTID touched the file. Per the CSS Flexbox
spec, a flex item's automatic minimum size resolves to 0 once its
`overflow` is anything but `visible` — inside the flex-column `.task-card`,
that made this row (and only this row, since sibling rows lack
`overflow: hidden`) collapse to a MEASURED 0px real height, hiding the
status pill and role badge that already lived there, on every card,
before this VTID shipped anything. Adding a third item (the new age
badge) to that same collapsed row would have shipped a data-correct but
completely invisible feature. Fixed at the root: `flex-shrink: 0` on the
row (so it no longer collapses) plus raising `.task-card-enhanced`'s
`max-height` from 100px to 148px (the measured natural height of a fully
populated Scheduled card, so the fix doesn't just relocate the same
collapse onto the next-least-resistant row — confirmed by measuring, not
assuming, via `getBoundingClientRect()` on each row before and after).

## Acceptance Criteria

AC-1 — Combinable filter chips for Age (Today / This week / Stale >7d),
Owner (Claimed / Unclaimed), and Source (Session / Autonomous — reusing
VTID-03516's existing `metadata.source === 'self-healing'` /
`metadata.autonomous_execution === true` distinction rather than inventing
a new one). Clicking an active chip clears it (toggle, not radio-lock).

TEST: `test/vtid-03823-tasks-board-hygiene.test.ts` — "Filter chips wired
into the board filter chain" (4 tests) + "Source filter reuses the
VTID-03516 session/autonomous distinction" (1 test).

REAL-BROWSER VERIFICATION: seeded 5 tasks (one deliberately >7 days old)
and rendered the real `renderTasksView()`/`createTaskCard()` in headless
Chromium. Clicking the real "Stale (>7d)" chip narrowed the board to
exactly the one stale task, across all three columns — confirmed both by
querying the DOM for visible VTIDs and by screenshot
(`vtid03823-board-stale-filter.png`, sent to the user).

AC-2 — An age/staleness badge on every card: a plain age label (`5h`,
`3d`, `20d`) normally, or a highlighted `STALE · <age>` badge when a
non-terminal task has had no activity signal (`createdAt`) in over 7 days.

TEST: same file — "Age/staleness computation" (2 tests).

REAL-BROWSER VERIFICATION + MANDATORY VISUAL VERIFICATION (CLAUDE.md
Part 1 rule 26): confirmed via screenshot that the badge is not just
present in the DOM but actually visible and legibly distinguishes the
stale task (red "STALE · 12d") from normal ones (gray "5h"/"1d"/"3d"/"20d")
— see AC-5 below for why this needed a real fix, not just a DOM check.

AC-3 — Scheduled-column-only multi-select with a bulk "Archive selected"
action that reuses VTID-01052's existing, governed
`DELETE /api/v1/oasis/tasks/:vtid` semantics per task (soft-delete, void
the VTID, log an OASIS event) — never a new bulk endpoint, and never the
VTID-03818-fixed reaper path.

TEST: same file — "Bulk-select + archive" (3 tests), including an
explicit assertion that no `/tasks/bulk`-style or reaper endpoint appears
anywhere in `bulkArchiveSelectedTasks()`.

REAL-BROWSER VERIFICATION: checked a real checkbox via `page.click()`;
confirmed the bulk-action bar appears with the correct count and that
`state.taskMultiSelectIds` updates — screenshotted at both 1400×900 and
390×844 (`vtid03823-board-bulk-select.png` equivalent view is visible in
`vtid03823-board-mobile.png`, sent to the user — desktop unchecked state
in `vtid03823-board-desktop.png`).

AC-4 — Drag-and-drop from Scheduled into In Progress, wired to the exact
same governed transition "Manual Start" already uses: `PATCH
/api/v1/oasis/tasks/:vtid {status:'in_progress'}`, gated on
`spec_status === 'approved'` (refusing with the same toast message Manual
Start already shows otherwise) and behind the same `confirm()` prompt.
Dropping onto Completed is explicitly not wired to anything (no existing
manual "mark completed" endpoint to reuse — see "Deliberately NOT
attempted").

TEST: same file — "Drag-and-drop Scheduled -> In Progress" (3 tests).

REAL-BROWSER VERIFICATION (this is the one piece a source-text test alone
cannot prove — real HTML5 drag events, a real gate, a real network call):
using Playwright's real `dragTo()` (native HTML5 drag-and-drop, not a
synthetic click), dragging a Scheduled card with `spec_status: 'draft'`
into the In Progress column produced **zero** PATCH calls — the gate held.
Dragging a Scheduled card with `spec_status: 'approved'` produced the
real `confirm()` dialog with the exact expected text, and on accepting it,
issued exactly one `PATCH /api/v1/oasis/tasks/VTID-20001` with body
`{"status":"in_progress"}` — confirmed via a stubbed `fetch` that recorded
the real call the real code made, not a mock of the drop handler itself.

AC-5 — Pre-existing bug, found and fixed while verifying AC-2, not
introduced by this VTID: `.task-card-status-row`'s `overflow: hidden`
made it collapse to a measured 0px real height inside the flex-column
`.task-card` (CSS Flexbox auto-min-size-to-0 rule), hiding the status
pill and role badge on every card before this VTID shipped anything —
see the Report section above for the full mechanism. Fixed at the root
(`flex-shrink: 0` on the row, `.task-card-enhanced`'s `max-height` raised
from 100px to 148px) rather than shipping the new age badge into the same
invisible row.

TEST: same file — "Pre-existing zero-height status-row bug…" (2 tests).

REAL-BROWSER VERIFICATION: measured `getBoundingClientRect()` on the
status row, its three children, and the sibling spec-row/stage-timeline
rows, on both `origin/main` (0px height, bug reproduced) and this branch
(18px height, all three badges individually visible AND their shared
parent row visible) — see commands.log for the exact before/after numbers.

## Deliberately NOT attempted

- **No drop target for Completed.** There is no existing manual "mark
  task completed" endpoint to reuse (completion is normally
  OASIS/executor-driven), and inventing one would be new backend surface
  this VTID's own scope doesn't call for. The column still accepts a
  dragover (consistent drop cursor) but the drop itself is a no-op.
- **No "Activate (Auto)" via drag.** Only the safer "Manual Start"
  transition (no autonomous execution triggered) is wired to drag-and-drop.
  Triggering autonomous execution from a drag, without the existing
  execution-approval modal, would be a real behavior change beyond "move
  this card," not a hygiene feature.
- **Owner filter is claimed/unclaimed, not a per-user dropdown.** The
  board API surfaces `claimed_by` as a free-text worker id with no
  enumerable set of values visible client-side; a binary claimed/unclaimed
  split is the meaningful hygiene signal ("is anyone even looking at
  this") without inventing a fake enum.
- **No live `/api/v1/oasis/tasks/:vtid` DELETE/PATCH calls were exercised
  against a real backend** — this session has no live gateway/Supabase
  credentials. The bulk-archive loop and the drag-and-drop PATCH call were
  verified against a stubbed `fetch` that captured the real call the real
  code made (confirming the URL/method/body), not a live round trip.
