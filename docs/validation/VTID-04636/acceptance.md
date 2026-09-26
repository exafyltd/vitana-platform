# VTID-04636 — self-healing reconciler judges a VTID by its fix-mode lineage

Live defect (staging, 2026-09-26): VTID-04608 (Task D, PR #3730) and VTID-04614
(Task B, PR #3736) were closed `failed` by `self-healing-reconciler` at
09:24 / 09:31 UTC, the moment the parent execution turned `reverted` at its first
red CI. Fix mode continued on the same PR; the children (e8118eb9, 489a1de2)
merged and completed at 09:51 / 10:08, parents became `self_healed` — but the
ledger could no longer change (`is_terminal=true`).

## Acceptance criteria
- AC-1: a VTID whose linked execution is `reverted` with a child still in flight stays open.
  TEST: services/gateway/test/vtid-04636-reconciler-lineage.test.ts
- AC-2: `self_healed` parent + `completed` child closes the VTID `success` with the child's PR.
  TEST: services/gateway/test/vtid-04636-reconciler-lineage.test.ts
- AC-3: several generations are followed; the newest descendant decides.
  TEST: services/gateway/test/vtid-04636-reconciler-lineage.test.ts
- AC-4: a reverted row with no child still closes `failed` (unchanged).
  TEST: services/gateway/test/self-healing-reconciler-autopilot-link.test.ts
- AC-5: a failed child lookup never terminalizes on a partial view.
  TEST: services/gateway/test/vtid-04636-reconciler-lineage.test.ts
- AC-6: end to end over the operator pipeline (real watcher, bridge, executor, reconciler).
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

The two wrongly closed rows are terminal and are NOT rewritten here (CLAUDE.md IF-THEN 3).
