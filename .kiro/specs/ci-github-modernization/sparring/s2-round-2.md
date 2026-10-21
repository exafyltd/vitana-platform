# Sparring round 2 — in_progress

Session: `c48d3889-2318-40ca-bc26-b143274fd7b5` · plan hash `bfa5b7acdb20c3a18242c919474af334bd78dccceb861a5fd4b93148335b6699`

## Summary

All six R1 findings were accepted by the planner. Five are genuinely resolved in the revised plan (R1-F1, R1-F2, R1-F3, R1-F5, R1-F6). R1-F4 was accepted but the revised text still delegates the mechanism decision to the implementing agent. One new major finding: the TEST-SUITE.yml `services` job has a fixed two-step structure (Install + Run tests) shared across all matrix entries; the plan instructs lane 6 to "add a typecheck step and a run-in-band test:guardrails step to the vcaop entry" without specifying how to do so without breaking the oasis-projector and openclaw-bridge entries that lack those commands.

## Findings

### R2-F1 [major]

R1-F4 was accepted but the revised plan still does not commit to a single dispatch mechanism for lane 5. The plan says 'this lane takes the dispatch path, unambiguously' and then immediately presents two options: '(a) re-run the PR's required workflows through `gh api .../runs/{run_id}/rerun`… or (b) make the commit itself with a PAT when present and, when absent, post a PR check via the Checks API'. The plan then explicitly says 'The lane must commit to one of these' — delegating the decision to the implementing agent. The defect from R1-F4 (ambiguous mechanism, no specified target workflows, no specified detection logic) is still present verbatim in the revised lane 5 spec.

- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:103` —         - name: Commit the round
          if: steps.guard.outputs.skip != 'true'
          env:
            HEAD_REF: ${{ github.event.pull_request.head.ref }}
          run: |
            cd head
            git add .kiro/specs
            if git diff --cached --quiet; then echo "nothing to commit"; exit 0; fi
            ...
            git push origin "HEAD:${HEAD_REF}"
- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:55` —           token: ${{ secrets.PLAN_SPAR_PUSH_TOKEN || github.token }}

Suggestion: The plan must select exactly one mechanism before the lane is implemented. Option (a) — re-running prior-head workflow runs via `gh api .../runs/{id}/rerun` — does not start new checks on the newly-pushed head commit; it re-runs the old run against an old SHA, which does not satisfy the intent. Option (b) — posting a Checks API status — requires an installation token with `checks:write` permission, which `GITHUB_TOKEN` in a `pull_request_target` context does not have by default, and the approach would also require the PM/land step to interpret that synthetic status. The cleanest durable option is to have the post-push step call `gh api repos/{owner}/{repo}/statuses/{sha}` or use a `repository_dispatch` to a workflow that uses `workflow_run` as its trigger; the plan must pick one, name the target workflows, describe the token capability needed, and assert that the test pins the chosen contract. The implementing agent must not be left to make this architectural decision.

### R2-F2 [major]

Lane 6's instruction to 'add a typecheck step and a run-in-band test:guardrails step to the vcaop matrix entry' is not implementable as written against the existing `services` job structure. The `services` job has a single shared `steps:` block with exactly two run-commands: `run: ${{ matrix.install }}` and `run: ${{ matrix.test }}`. Adding a `typecheck` or `guardrails` key to the vcaop matrix entry does not create new steps — it creates new matrix variables. For those variables to execute, new steps must be added to the shared `steps:` block. When those steps use `run: ${{ matrix.typecheck }}`, the expression evaluates to an empty string for oasis-projector and openclaw-bridge (which have no `typecheck` matrix key), and GitHub Actions fails the job with 'Required property is missing: run' or equivalent for an empty `run:` field.

- `exafyltd/vitana-platform:.github/workflows/TEST-SUITE.yml:103` —   services:
    name: ${{ matrix.service }} (${{ matrix.runner }})
    runs-on: ubuntu-latest
    ...
    strategy:
      matrix:
        include:
          - service: vcaop
            install: npm install --no-audit --no-fund
            test: npm test
            runner: jest
          - service: oasis-projector
            install: npm ci --no-audit --no-fund
            test: npx jest --silent
            runner: jest
          - service: openclaw-bridge
            install: pnpm install --frozen-lockfile
            test: npx vitest run
            runner: vitest
    steps:
      ...
      - name: Install
        run: ${{ matrix.install }}
      - name: Run tests
        run: ${{ matrix.test }}
- `exafyltd/vitana-platform:services/vcaop/package.json:9` —       "typecheck": "tsc --noEmit",
      "test": "jest",
      "test:guardrails": "jest --runInBand test/guardrails",

Suggestion: Lane 6 must specify the exact structural change to TEST-SUITE.yml needed to host per-service optional steps. Three viable approaches — the plan must pick one: (A) Add `if: matrix.typecheck` conditional steps to the shared `services` job body and add `typecheck: npm run typecheck` and `guardrails: npm run test:guardrails --runInBand` to the vcaop matrix entry only (relying on GitHub's behaviour of treating an absent matrix key as an empty/falsy expression); (B) Extract vcaop into its own dedicated job outside the shared matrix so the shared structure is unmodified; (C) Expand the `test` matrix key for vcaop to run `npm run typecheck && npm run test:guardrails --runInBand && npm test` in sequence in a single step (simplest, no structural change, but loses step-level granularity). The plan's lane 6 test assertion ('red on base where the vcaop matrix runs only npm test') is also currently unprovable unless the test can observe which commands the matrix step runs — specify what the failing test actually checks.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Revised plan correctly narrows the deletion to lines 113-118 (the commented-out Gateway Tests step) and explicitly preserves the live Report Validation Success step at 119-137. Verified against code.
- R1-F2: acknowledged — Revised plan correctly identifies CICDL ↔ ENFORCE as the real build-duplication pair, re-targets lane 2 accordingly, and correctly notes that ENFORCE (no path filter) and CICDL (gateway-path filter) serve different triggers — so the de-dup may legitimately resolve as 'record and drop'. ENFORCE is correctly kept out of lane scope.
- R1-F3: acknowledged — Revised plan assigns the vcaop typecheck and --runInBand guardrails migration to lane 6 (owner of TEST-SUITE.yml) and makes lane 1 depend on lane 6 before deleting VCAOP-CICD.yml. The dependency chain prevents silent loss of either gate.
- R1-F4: disputed — Planner accepted R1-F4 and stated 'Lane 5 now commits to the dispatch path... with a concrete mechanism and named target workflows.' The revised plan text contradicts this: it still says 'either (a)... or (b)' and ends with 'The lane must commit to one of these.' No concrete mechanism is named, no target workflows are listed, and no detection logic is specified. The finding is re-raised as R2-F1.
- R1-F5: acknowledged — Citation corrected in the revised plan to PLAN-SPAR.yml:61 (token selector), :116 (push), and :17-19 (behaviour comment).
- R1-F6: acknowledged — Citation corrected to queue.mjs:590-599 (scopeCheck reviewer-seat equality) and lane 3 test cases now target the scopeCheck() path at :587-600.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
