# VTID-04043 — Dev Autopilot verification window ignores the autopilot plane's own lifecycle events

**Defect (live, 2026-09-18, execution f8d79e6c / VTID-04038, PR #3412):** while f8d79e6c sat in its
5-minute verification window, a chat cancel of a sibling execution (ff10f8ea / VTID-04040) emitted
`vtid.lifecycle.failed` (status error). `analyzeVerificationWindow` counted it as production blast
radius (`1 unrelated error events during verification window`), failed the execution, terminalized
VTID-04038 `failed` and escalated it to human review — with PR #3412 open and 18/18 checks green.

**Fix:** `vtid.lifecycle.*` and `operator.execution_onramp.*` topics are excluded from blast radius
alongside the `dev_autopilot.*` / `self_healing.*` / `cicd.*` exclusions VTID-02699 already made:
they are task-plane bookkeeping about OTHER VTIDs, never a user-facing runtime error.

AC-1 — `vtid.lifecycle.failed` / `operator.execution_onramp.*` error events about other VTIDs inside the window do not fail it.
TEST: services/gateway/test/dev-autopilot-watcher.test.ts

AC-2 — a real runtime error event next to a lifecycle event still fails the window, and only the runtime event is reported as blast radius.
TEST: services/gateway/test/dev-autopilot-watcher.test.ts

AC-3 — every pre-existing verification rule (pending until elapsed, pass when clean, own-lineage ignored, pre-window ignored, non-error ignored) is unchanged.
TEST: services/gateway/test/dev-autopilot-watcher.test.ts
