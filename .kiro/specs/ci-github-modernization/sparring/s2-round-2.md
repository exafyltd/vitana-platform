# Sparring round 2 — in_progress

Session: `747f12ec-e8df-4e28-ad15-1d2b781fa355` · plan hash `f40a6be700d10f4c7ffda476c808df7cdbfa0e948eed38008b83110e3ebaa0c8`

## Summary

Round 2. All four round-1 findings were accepted and I verified their fixes landed in the revised plan (R1-F1 migration removed; R1-F2 shard correction; R1-F3 run-in-band rationale dropped; R1-F4 bug narrowed to ci-plan-spar). One new material gap remains: the plan (and the accepted R1-F1) still asserts that deleting VCAOP-CICD.yml "loses no gate," but VCAOP-CICD.yml runs `npm run build` (tsc with emit) at :46-48, which is NOT covered by VCAOP-GUARDRAILS-CI.yml (typecheck/test:guardrails/test only) nor by TEST-SUITE's vcaop matrix entry (`npm test` only, no build). Since `build` (tsc) is distinct from `typecheck` (tsc --noEmit), this is a live build gate that would be silently lost. Everything else in the revised plan is well-sourced and internally consistent.

## Findings

### R2-F1 [major]

Lane 1 (and the accepted R1-F1) asserts that deleting VCAOP-CICD.yml 'loses no gate' because VCAOP-GUARDRAILS-CI.yml already runs typecheck, test:guardrails and npm test. This misses the `npm run build` step: VCAOP-CICD.yml:46-48 runs `npm run build`, which per package.json is `tsc` (with emit), distinct from `typecheck` (tsc --noEmit). VCAOP-GUARDRAILS-CI.yml does not build (its steps end at `npm test`), and TEST-SUITE's vcaop matrix entry runs only `npm test` (TEST-SUITE.yml:111-114). So deleting VCAOP-CICD.yml silently drops the only CI build gate for the vcaop service.

- `exafyltd/vitana-platform:.github/workflows/VCAOP-CICD.yml:46` — - name: Build
  working-directory: services/vcaop
  run: npm run build
- `exafyltd/vitana-platform:.github/workflows/VCAOP-GUARDRAILS-CI.yml:36` — - name: Typecheck ... run: npm run typecheck
- name: Guardrail tests ... run: npm run test:guardrails
- name: Unit tests (full suite) ... run: npm test
- `exafyltd/vitana-platform:services/vcaop/package.json:7` — "build": "tsc",
"typecheck": "tsc --noEmit",
"test": "jest"
- `exafyltd/vitana-platform:.github/workflows/TEST-SUITE.yml:111` — - service: vcaop
  install: npm install --no-audit --no-fund
  test: npm test
  runner: jest

Suggestion: Before deleting VCAOP-CICD.yml, either (a) add `npm run build` to VCAOP-GUARDRAILS-CI.yml or to TEST-SUITE's vcaop matrix entry so the build gate survives, or (b) correct lane 1 to acknowledge it is intentionally dropping the vcaop build gate and record that decision explicitly (with owner sign-off) rather than asserting 'loses no gate.' Do not silently delete the only vcaop build check.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
