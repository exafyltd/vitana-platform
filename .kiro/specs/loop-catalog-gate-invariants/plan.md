---
change_class: standard
---
# plan(loop-catalog-gate-invariants): own GATE-INVARIANTS under the loop catalog

Owner, 12 Nov 2026: the VTID-05084 coverage test (`services/gateway/test/loop-catalog.test.ts`) fails on `main`
(`ef17f7ed70`): the scheduled workflow `GATE-INVARIANTS.yml` is not owned by any loop, so the test reports 28 of 29
scheduled workflows owned. This blocks every gateway PR that runs the shard, including `kiro/live-room-edit-cohost/gateway-cohost`
(PR #4741).

<!-- plan:begin -->
## Goal
Make the loop catalog own every scheduled workflow, so the coverage test passes on `main`, without changing any workflow
or loop behaviour beyond recording the owner.

## Today (file:line evidence on origin/main, ef17f7ed70)
- `services/gateway/specs/loop-catalog-v1.json`: loop `L5` ("Guard") owns `sensors.workflows = ["ALERT-OASIS-LEDGER-INTEGRITY"]`.
- `.github/workflows/GATE-INVARIANTS.yml` is scheduled (`schedule: cron '17 4 * * *'`) and runs the mechanical gate invariants
  against `main` (VTID-05763). It is the only scheduled workflow with no owner.
- `services/gateway/test/loop-catalog.test.ts` (`registry('workflows')`) counts 29 scheduled workflows; the catalog owns 28.
- Main's own gateway shard 4 fails on the same test (run for `ef17f7ed70`), so this is not caused by any open PR.

## Change
One line in `services/gateway/specs/loop-catalog-v1.json`: add `"GATE-INVARIANTS"` to the `workflows` list of loop `L5`.
No other file changes. No workflow file changes. The JSON keeps its formatting.

## Interfaces
None. The catalog is read by the test and by `services/gateway/src/services/loop-catalog.ts`; both read the list by name.

## Decisions taken
- **L5 "Guard"**: the gate invariants check the gates themselves, which is what L5 is about (it already owns the alert on the
  OASIS ledger integrity). Alternative considered: a new loop. Rejected: a new loop is a design change, not a fix.

## Tests and commands
- `services/gateway` Jest: `test/loop-catalog.test.ts` — the three failing assertions pass ("workflows: no orphans",
  "the service reports the same clean coverage", and the workflows row of the coverage table). Red on base: the same
  assertions fail with `Expected: 29, Received: 28` on `ef17f7ed70`.
- CI: the gateway shards on the PR head.

## Risks
- None beyond the test itself. The list is data; a wrong owner would only change which loop reports the workflow.

## Unchanged
Every workflow, every loop, the gate invariants script, production workflows and deploys.
<!-- plan:end -->
