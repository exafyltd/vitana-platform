# Sparring round 1 — in_progress

Session: `c48d3889-2318-40ca-bc26-b143274fd7b5` · plan hash `9d2f407a29f89c202b156d9072579f9f60f9932e299246836f79764942445f07`

## Summary

The plan correctly identifies the main CI problems (fake required check, dead VCAOP workflow, report-only gates, permanently-red suites, Windows-path issues) and the governance constraints that shape the lane split are accurately described. Three of the four false-positive identifications check out, and the protected-gate / cross-repo fetch mechanics are correctly described. However, four material defects need correction before implementation: the dead-block line range in lane 2 spans live YAML (would break the file), the build-duplication premise misidentifies which workflow is the actual duplicate, lane 1 drops `test:guardrails --runInBand` and vcaop typecheck without a migration plan, and lane 5's code change is left unspecified between two mutually exclusive options. Two minor citation errors are also raised.

## Findings

### R1-F1 [blocker]

Lane 2 instructs deletion of 'CICDL-GATEWAY-CI.yml:113-133' but line 120 begins the live `Report Validation Success` step — deleting lines 113-133 produces broken YAML.

- `exafyltd/vitana-platform:.github/workflows/CICDL-GATEWAY-CI.yml:113` — # TESTS DEFERRED TO DEV-CICDL-0035
        # - name: Gateway Tests
        #   working-directory: services/gateway
        #   run: pnpm test
        #   env:
        #     DATABASE_URL: ...

        - name: Report Validation Success
          if: success()
          run: |
            echo "✅ **DEV-CICDL-0034 Gateway Minimal CI PASSED**"
            ...
            echo "⏭️  **Tests deferred to VTID DEV-CICDL-0035**"

Suggestion: The actual dead block is only lines 113–118 (the six commented-out test-step lines). Lines 120–137 are the live `Report Validation Success` step. Lane 2 must specify deletion of only lines 113–118 (and optionally update the echo string at line 133 in that same live step). The range ':113-133' must be corrected to ':113-118' in the lane spec and in any test that asserts the dead block is gone.

### R1-F2 [major]

The plan's stated build+typecheck duplication is between CICDL-GATEWAY-CI.yml and 'TEST-SUITE/PR-GATE paths', but neither TEST-SUITE.yml nor the platform PR-GATE.yml run a gateway build or typecheck. The real duplicate build is in ENFORCE-FRONTEND-CANONICAL-SOURCE.yml, which is the required check and is not addressed by any lane.

- `exafyltd/vitana-platform:.github/workflows/TEST-SUITE.yml:63` — - name: Install
          run: pnpm install --frozen-lockfile
        - name: List tests
          run: npx jest --listTests > "list-${{ matrix.shard }}.txt"
          ...
        - name: Run Jest suite
          run: npx jest --silent ...
- `exafyltd/vitana-platform:.github/workflows/CICDL-GATEWAY-CI.yml:86` — - name: Install gateway dependencies
          working-directory: services/gateway
          run: npm ci --no-audit --no-fund

        - name: Gateway Build Check
          working-directory: services/gateway
          run: pnpm run build
        ...
        - name: Gateway Type Check
          working-directory: services/gateway
          run: pnpm run typecheck
- `exafyltd/vitana-platform:.github/workflows/ENFORCE-FRONTEND-CANONICAL-SOURCE.yml:16` — - name: Install gateway dependencies
          working-directory: services/gateway
          run: npm ci

        - name: Build gateway
          working-directory: services/gateway
          run: npm run build

        - name: Validate frontend canonical source
          run: node services/validators/frontend-canonical-source.js
- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:77` — - name: Gateway deps (only when a VTID in the title is a "fix")
          run: |
            for v in ...; do
              if ... kind ... = "fix" ]; then
                (cd services/gateway && npm ci ...) ...
              fi
            done
            echo "no fix VTID — red→green will skip"

Suggestion: TEST-SUITE.yml runs only `pnpm install` + Jest for the gateway (no typecheck, no build). Platform PR-GATE.yml installs gateway deps only conditionally for fix-VTIDs. The genuine build duplication is between CICDL-GATEWAY-CI.yml and ENFORCE-FRONTEND-CANONICAL-SOURCE.yml (both run `npm/pnpm run build` for services/gateway). Lane 2's de-dup goal must be re-targeted: either remove the build step from CICDL-GATEWAY-CI.yml and rely on ENFORCE-FRONTEND-CANONICAL-SOURCE.yml, or accept that the builds serve different triggers (path filters differ) and remove the 'de-dup' goal from lane 2 scope. The plan's line citation 'CICDL-GATEWAY-CI.yml:84-91' for the build+typecheck is also wrong (build is at :94-97, typecheck at :103-106).

### R1-F3 [major]

Lane 1 deletes VCAOP-CICD.yml wholesale, but VCAOP-CICD.yml runs `npm run test:guardrails --runInBand` and `npm run typecheck` for vcaop — neither of which is present in the TEST-SUITE.yml vcaop matrix entry, which runs only `npm test`.

- `exafyltd/vitana-platform:.github/workflows/VCAOP-CICD.yml:37` — - name: Typecheck
          working-directory: services/vcaop
          run: npm run typecheck
        - name: Guardrails (REQUIRED gate — blocks on failure)
          working-directory: services/vcaop
          run: npm run test:guardrails
        - name: Unit + integration + iam + privacy + e2e
          working-directory: services/vcaop
          run: npm test
- `exafyltd/vitana-platform:services/vcaop/package.json:10` — "test": "jest",
    "test:guardrails": "jest --runInBand test/guardrails",
- `exafyltd/vitana-platform:.github/workflows/TEST-SUITE.yml:110` — - service: vcaop
              install: npm install --no-audit --no-fund
              test: npm test
              runner: jest

Suggestion: `test:guardrails` deliberately runs with `--runInBand` (sequential, single-process) because the guardrails suite is designed to fail under parallel Jest workers. `npm test` = `jest` (parallel by default) will exercise the same test files but without the ordering guarantee — a test that requires `--runInBand` may pass or flake under parallel execution. Before deleting VCAOP-CICD.yml, lane 1 must either (a) add `test:guardrails --runInBand` and `typecheck` to the vcaop matrix entry in TEST-SUITE.yml, or (b) confirm with evidence that the guardrails suite is safe under parallel Jest. The lane spec and its pre-deletion test must assert both guardrails and typecheck remain exercised in CI.

### R1-F4 [major]

Lane 5 (plan-spar-checks) specifies two mutually exclusive code changes ('either dispatch the checks after the push, or require/provision PLAN_SPAR_PUSH_TOKEN') without choosing one. The PLAN_SPAR_PUSH_TOKEN fallback already exists in the workflow; the token provisioning is deferred to Gate 2. If the agent chooses the dispatch path, no specification of the dispatch mechanism is given. If the agent chooses the token path, there is no code change to make — the lane would change a protected gate file (PLAN-SPAR.yml) to write nothing meaningful.

- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:55` — - name: PR head checkout (data only)
          uses: actions/checkout@v4
          with:
            ref: ${{ github.event.pull_request.head.ref }}
            path: head
            fetch-depth: 0
            token: ${{ secrets.PLAN_SPAR_PUSH_TOKEN || github.token }}
- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:103` — - name: Commit the round
          if: steps.guard.outputs.skip != 'true'
          env:
            HEAD_REF: ${{ github.event.pull_request.head.ref }}
          run: |
            cd head
            git add .kiro/specs
            if git diff --cached --quiet; then echo "nothing to commit"; exit 0; fi
            ...
            git push origin "HEAD:${HEAD_REF}"

Suggestion: The PLAN_SPAR_PUSH_TOKEN || github.token fallback already exists (line 61). The only missing piece when the secret is absent is that GITHUB_TOKEN pushes do not trigger `pull_request` checks. Lane 5 must commit to one specific code change: the most durable option is to add a `gh workflow run` or `gh api repos/.../actions/workflows/.../dispatches` call after the push when `PLAN_SPAR_PUSH_TOKEN` is absent, explicitly re-triggering checks on the new head. The lane spec must describe this dispatch step precisely, including which workflows to re-trigger and how to detect the GITHUB_TOKEN vs PAT case, so an implementing agent has an unambiguous implementation target.

### R1-F5 [minor]

The plan cites 'PLAN-SPAR.yml:84-98, header 23-26' as the location of the push-token false-positive mechanism. Lines 84-101 are the 'Spar' step (calls plan-spar.mjs); lines 23-26 are the `on: pull_request_target` trigger. The actual token selection is at line 61 (checkout step) and the push is at line 116.

- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:23` — on:
    pull_request_target:
      types: [opened, synchronize, reopened]
      paths:
- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:84` — - name: Spar
          if: steps.guard.outputs.skip != 'true'
          env:
            GATEWAY_URL: ...
          run: |
            git -C head diff ...
            V1_SHA=...
            node base/scripts/collab/plan-spar.mjs ...

Suggestion: Correct the plan's evidence citation for false positive #1 to: push token at PLAN-SPAR.yml:61 (`token: ${{ secrets.PLAN_SPAR_PUSH_TOKEN || github.token }}`); push call at PLAN-SPAR.yml:116 (`git push origin "HEAD:${HEAD_REF}"`). The header note about the token behavior is at lines 17–19 (the inline comment block), not lines 23–26. Fix the citation so lane 5's implementing agent locates the correct lines.

### R1-F6 [minor]

The plan cites 'queue.mjs scopeCheck reviewer-seat equality at ~:466-470'. Lines 466-474 are inside the `validate()` function (checking whether a commit's Collab-Lane matches the file being changed). The reviewer-seat equality check inside `scopeCheck()` is at lines 590-599.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:464` — // VTID-05214: PLAN-SPAR.yml writes the allocated VTID into a lane...
        if (c.kind === 'lane' && k.session === CI_PLAN_SPAR && k.lane === `${c.slug}/${PLAN_LANE}`
          && parseFrontMatter(...)?.state === 'ready') continue;
        if (c.kind === 'lane' && k.review === key && !frontMatterChanged(repo, k.sha, f)) continue;
        errors.push(`${short}: changes ${f} but its Collab-Lane is...`)
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:590` — if (k.review === key && k.lane !== key) {
        const ok = fm.reviewer_seat === 'claude' ? /^session_/.test(k.session)
          : isReviewerAgent(fm.reviewer_seat) ? agentOf(k.session) === fm.reviewer_seat
            : !fm.reviewer_seat || seat === fm.reviewer_seat;
        if (!ok) errors.push(`${short}: review entry on ${key} from ${k.session || 'no session'}, but reviewer_seat is ${fm.reviewer_seat}`);
      } else if (fm.seat && seat && seat !== fm.seat) {
        errors.push(`${short}: ${k.session} (seat ${seat}) edits lane ${key}, which belongs to seat ${fm.seat}`)

Suggestion: Correct the plan citation to 'queue.mjs scopeCheck reviewer-seat equality at :590-599'. The lane 3 test cases that encode the wrongly-rejected PR shapes should point to and cover the scopeCheck() code path at lines 587-600, not the validate() loop at lines 446-474.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
