# Sparring round 3 — converged

Session: `d6caa531-0937-42b4-a6c3-9085af2f4e46` · plan hash `43544c949aaf4e71e79efa4b2edfbb8e050062efdf992cfaf18264b738850a6d`

## Summary

The revised plan is materially stronger: R2-F1 (APPLY-FB061 code-patch misclassified as a migration) is correctly addressed — "Today 3" and B.6 now exclude it and classify it as a one-shot self-deleting code-patch workflow. R2-F2 (MIGRATION_FREEZE gap on vitana-v1 appliers) is addressed with option (b): the plan now states the freeze is platform-only and constrains vitana-v1 dispatch to owner-approval-in-the-same-conversation plus a documented cutover-window check. Premises I verified against the pinned code all hold except one residual governance gap and one change-class discrepancy. Two new findings remain: (1) the review header declares change class "standard" while the plan body and lanes declare "governance"; (2) the vitana-v1 migration freeze is still enforced only by a human reading a runbook, not a machine check — the deferred freeze-guard leaves a real window where a migration could be applied during a cutover freeze.

## Findings

### R3-F1 [minor]

The review header declares 'Declared change class: standard', but the plan body declares 'Change class: governance (rule text and the seat automations only)' and both lanes are set `governance: true`. These two classes are materially different: governance lanes are subject to the per-PR owner merge instruction (§7b) and the PR-GATE Lane scope check treats `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `CLAUDE.md` as governance paths a standard lane may not touch. The plan itself is internally consistent as 'governance' (lanes are governance:true and rely on #4210 `scope-rules` making `governance: true` Kiro lanes valid), but the declared class submitted for this review is 'standard', a contradiction that could lead the reviewer/gate to mis-handle the merge authority and Lane-scope governance treatment.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:100` — any change to a governance path (`.github/**`, `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`, `CLAUDE.md`, `docs/programs/areas.yaml`) from a lane that is not `executor: claude`.

Suggestion: Reconcile the declared change class to 'governance' (matching the plan body and the `governance: true` lanes), or if the review header 'standard' is authoritative, explain why a plan whose lanes are explicitly `governance: true` and which rewrites `CLAUDE.md`, `.claude/rules/*`, `.kiro/steering/**` and `.kiro/automations/**` is being treated as 'standard'.

### R3-F2 [minor]

The B.6 freeze protection for the 21 vitana-v1 `apply-*.yml` appliers remains purely procedural and non-mechanical. The plan states 'the session does not dispatch during an Aurora cutover freeze window recorded in the cutover runbook or the aurora-cutover programme'. That window is recorded in a human-authored document (runbook/programme) the session must remember to consult; no repo variable, CI check, or workflow guard mechanically prevents a dispatch. By contrast RUN-MIGRATION.yml enforces `MIGRATION_FREEZE` in code (exit 1 when true). The deferral of a real freeze guard to a separate plan leaves a genuine window where, if the session forgets to consult the runbook (or the runbook is not updated in time), a migration could be applied to production during the cutover freeze — the exact incident class VTID-05023's MIGRATION_FREEZE was built to prevent, only on the vitana-v1 path with no such mechanism.

- `exafyltd/vitana-platform:.github/workflows/RUN-MIGRATION.yml:55` — if [ "${MIGRATION_FREEZE:-}" = "true" ]; then echo "::error::MIGRATION_FREEZE=true..."; exit 1; fi
- `exafyltd/vitana-v1:.github/workflows/apply-comment-reactions-replies-migration.yml:16` — on:
  workflow_dispatch:
...
      env:
        PROJECT_REF: inmkhvwdcuyhnxkgfvsb

Suggestion: Either (a) accept that the deferred freeze-guard leaves a bounded risk and elevate the owner-approval-in-same-conversation as the compensating control (already present), or (b) require that the session also gate the dispatch on a mechanically-readable marker on the cutover programme's lane state (e.g. refuse to dispatch any vitana-v1 `apply-*.yml` while the `aurora-cutover` programme lane is not `done`), which is checkable via `queue.mjs` without a repo variable. Do not rely solely on recalling a runbook window.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Verified in the revised plan: APPLY-FB061-DEBOUNCER-FIX.yml is removed from 'Today 3' and B.6's applier list, and reclassified as a one-shot self-deleting code-patch workflow (pushes to a feature branch, no database). The rationale is sound.
- R2-F2: acknowledged — Option (b) is correctly adopted: B.6 now states MIGRATION_FREEZE is platform-only (RUN-MIGRATION.yml), vitana-v1 appliers have no freeze, and dispatch is gated on owner approval in the same conversation. The deferral of a real freeze guard to a separate non-rule plan is reasonable; the residual non-mechanical reliance on a runbook window is captured as R3-F2.
- R1-F1: acknowledged — B.6 now covers every vitana-v1 apply-*.yml applier with per-file owner approval naming the workflow file and SQL path; the activation clause (Activation R1-F1) requires the owner's explicit Gate 1 'yes'. Addressed.
- R1-F2: acknowledged — The CLAUDE.md flat 'Kiro never merges' sentence is now replaced, and collaboration.md §7/§7b body merge references are rewritten to point at §7d (interactive sessions) with automations stopping at verified. Addressed.
- R1-F3: acknowledged — The workflow inventory test now reads each apply-*.yml (and APPLY-*.yml) `on:` block and asserts workflow_dispatch-only, recorded in acceptance. Addressed.
