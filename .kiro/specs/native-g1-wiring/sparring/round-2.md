# Sparring round 2 — in_progress

Session: `2d48c240-26ae-4ed6-99da-f843e1ec59c9` · plan hash `18b85e11e8d7d6de078c71078b5f6b1796c43ae9ca721484570327a221f55644`

## Summary

Round 2 review of `ci-plan-spar.native-g1-wiring`. R1-F2 through R1-F6 are all genuinely addressed; acknowledged. R1-F1 is disputed: the plan documented the inability to add a vitana-v1 checkout but PLAN-SPAR.yml is unchanged at the pinned commit and the deferred fix exists only as a prose note in plan.md — not a lane file — which is not a tracked artefact under collaboration §1. Two new findings: every lane's declared scope omits the `docs/validation/<VTID>/` paths the test plan says each lane will commit (R2-F1, major, would cause Lane-scope PR-GATE failures on all six lanes); and Decision 8 simultaneously says "workflow_dispatch-only" and "(and native-path push)", a self-contradiction whose resolution determines whether NATIVE-CI.yml adds automatic runner cost (R2-F2, minor).

## Findings

### R2-F1 [major]

The test plan states 'Each lane adds read-only `docs/validation/<VTID>/{scope.json,staging-tests.json,plan-sparring.md}`', but none of the six lane scope tables include a `docs/validation/<VTID>/**` glob. For vitana-v1 lanes, `docs/validation/` sits at the repository root — not inside `apps/mobile/` — as confirmed by the health-native handoff which references `vitana-v1 docs/validation/VTID-05021/plan-sparring.md` as a root-level path. The PR-GATE Lane scope check fails any PR that touches a file outside the lane's declared paths. Every one of the six lane PRs will therefore fail Lane scope the moment a validation-docs commit is included, because `docs/validation/VTID-xxxxx/` is not listed as an exception in any lane's scope and is not covered by the `real-g1-switch` exception `docs/validation/g1/**` (which is a different subdirectory). The path-ownership section (added in response to R1-F3) lists only four non-`apps/mobile` exceptions; validation-doc paths for the five implementation lanes are absent from that list and from every lane's `paths:` field.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:54` — paths:                       # the only files the lane may change (Lane scope); required from executing on
    - src/pages/messages/**
...
The PR-GATE check **Lane scope** fails a lane PR that changes anything else
- `exafyltd/vitana-platform:.kiro/specs/health-native/handoff.md:22` — | Native Maxina app (Expo / React Native, `apps/mobile/` in vitana-v1, replaces the Appilix wrapper) | VTID-05021 | vitana-v1 `docs/programs/native-app/NATIVE-APP-PLAN.md` | vitana-v1 `docs/validation/VTID-05021/plan-sparring.md`

Suggestion: Add `docs/validation/<VTID>/**` (or a concrete glob such as `docs/validation/VTID-05NNN/**`) to every lane's `paths:` list, and add it to the path-ownership exceptions table. Since VTIDs are assigned by CI after sparring converges, use a placeholder glob (`docs/validation/**`) scoped to the specific subdirectory the lane will create, or defer the validation-doc commit to a post-VTID update step that is explicitly accounted for in the scope. The `real-g1-switch` lane's `docs/validation/g1/**` glob appears to be G1-outcome-specific and does not cover that lane's own VTID validation docs either — it needs the same fix.

### R2-F2 [minor]

Decision 8 states 'NATIVE-CI.yml is `workflow_dispatch`-only (and native-path push), so it adds no automatic macOS-runner cost and does not overlap `MOBILE-DEVICE-E2E.yml`'s triggers.' The parenthetical '(and native-path push)' directly contradicts 'workflow_dispatch-only': a workflow with a push trigger is not dispatch-only by any definition. The comparison file `MOBILE-DEVICE-E2E.yml` makes the distinction explicit with its comment 'Dispatch-only by design: macOS runners are expensive … No push/schedule trigger.' If NATIVE-CI.yml has a push trigger and uses macOS runners for any step, the 'no automatic macOS-runner cost' claim is false. The plan never specifies which runner type (ubuntu/macOS) NATIVE-CI.yml will use for its bundling and test steps, so the cost claim cannot be confirmed or denied from the plan text alone.

- `exafyltd/vitana-platform:.github/workflows/MOBILE-DEVICE-E2E.yml:12` — # Dispatch-only by design: macOS runners are expensive and the run hits a
# deployed environment. No push/schedule trigger.
- `exafyltd/vitana-platform:.github/workflows/MOBILE-DEVICE-E2E.yml:23` — on:
  workflow_dispatch:

Suggestion: Resolve the contradiction in Decision 8 by picking one of two explicit positions: (a) 'NATIVE-CI.yml is `workflow_dispatch`-only — no push trigger — matching MOBILE-DEVICE-E2E.yml's pattern; cost is zero until manually dispatched'; or (b) 'NATIVE-CI.yml has a `push` trigger on `apps/mobile/**` and a `workflow_dispatch` trigger; all steps run on `ubuntu-latest`, so there is no macOS-runner cost.' Whichever is chosen, state the runner type explicitly so the implementer cannot accidentally write `runs-on: macos-15`.

## Acknowledgements of earlier responses

- R1-F1: disputed — The planner correctly identified that kiro/exafyltd cannot modify PLAN-SPAR.yml (governance path, executor: claude required — confirmed at collaboration.md lines 101-102). However, the stated mitigation — 'tracked in plan.md Repo note' — does not satisfy collaboration §1 ('A plan, a status change, a review or a result that is not pushed to origin does not exist'). A prose note in plan.md is not a lane file in any spec; there is no executor: claude lane with a slug, branch, or VTID anywhere in the repository tracking the PLAN-SPAR.yml change. PLAN-SPAR.yml is unchanged at the pinned commit. The partner still cannot read any vitana-v1 file:line premise, and the plan is proceeding to converged-auto-v1 approval on the basis of premises the governance gate has explicitly declared it cannot check. CLAUDE.md rule 52 ('deferred (where tracked)') requires the tracking to be a durable artefact in the repository, not plan text. The fix must be a pushed executor: claude lane in a spec — or this plan's approved→executing transition must be blocked until that lane merges — before the premises are ratified.
- R1-F2: acknowledged — All governance-doc citations are now repo-qualified (vitana-v1: or vitana-platform: prefix on every file:line reference). Addressed as described.
- R1-F3: acknowledged — The path-ownership section now explicitly lists every non-apps/mobile path by lane. The self-check claim has been corrected. Note that R2-F1 (this round) identifies a remaining gap in that same section — docs/validation paths — which is a new finding not a re-raise of R1-F3.
- R1-F4: acknowledged — build-profiles is correctly split into eas-profiles (executor: kiro, vitana-v1, apps/mobile/eas.json) and native-ci-workflow (executor: claude, vitana-platform, .github/workflows/NATIVE-CI.yml), each with its own branch/PR/VTID and preserved dependency order.
- R1-F5: acknowledged — The fabricated heading is removed; the citation now correctly reads 'vitana-platform:CLAUDE.md rule 31 (VTID-03506)'. Verified at CLAUDE.md lines 599-606.
- R1-F6: acknowledged — Decision 8 is added. MOBILE-DEVICE-E2E.yml confirmed at lines 3-7 and 23-24: dispatch-only, web frontend in Safari. The distinction is valid. However, Decision 8's language about NATIVE-CI.yml's own triggers is internally contradictory — that is raised as new finding R2-F2.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
