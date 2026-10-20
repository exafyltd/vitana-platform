# Sparring round 2 — in_progress

Session: `34600078-d771-4cbc-9010-d1e9434536f6` · plan hash `e402a1787490ab1a33f35991886614356e929beeef216df1855e9b2c47d09eb9`

## Summary

The core fix is sound: the stale pin `20261120-vtid-05148` at test line 212 is confirmed; `index.html:32` and every sibling test already carry `20261121-vtid-05082`. R1-F1 rejection is upheld (kind `"existing"` is a live runner kind at `lib.cjs:169`). R1-F2 acceptance is addressed (plan now covers `acceptance.md`). One new finding: the revised plan still omits `commands.log` and `outputs/` from the evidence pack, both of which are mandatory for every VTID directory under VALIDATOR-CHECK.yml lines 149–150, and both of which are present in the directly comparable VTID-05082 validation directory. The PR will fail the Evidence Pack Gate (exit 32/33) as written.

## Findings

### R2-F1 [major]

The revised plan's evidence-pack inventory is incomplete. VALIDATOR-CHECK.yml requires four artefacts: the directory itself, `acceptance.md` (exit 31), `commands.log` (exit 32), and an `outputs/` subdirectory (exit 33). The plan now mentions `acceptance.md`, `plan-sparring.md`, and `scope.json`, but says nothing about `commands.log` or `outputs/`. Because the PR touches `services/gateway/test/**` (VALIDATOR-CHECK trigger path, line 36), the Evidence Pack Gate will run and fail at exit 32 or 33.

- `exafyltd/vitana-platform:.github/workflows/VALIDATOR-CHECK.yml:149` — test -f "$EVID/commands.log"  || (echo "REJECTED: missing $EVID/commands.log" && exit 32)
            test -d "$EVID/outputs"       || (echo "REJECTED: missing $EVID/outputs/" && exit 33)
- `exafyltd/vitana-platform:.github/workflows/VALIDATOR-CHECK.yml:32` — paths:
        - 'services/gateway/src/**'
        - 'services/gateway/dist/**'
        - 'services/gateway/openapi/**'
        - 'services/gateway/test/**'
        - 'docs/validation/**'
- `exafyltd/vitana-platform:docs/validation/VTID-05082:1` — PR-BODY.md
acceptance.md
commands.log
outputs
staging-tests.json

Suggestion: Add `commands.log` (the terminal output of `npx jest test/vtid-05077-planner-fallback-and-thinking.test.ts` showing the suite green) and an `outputs/` directory (containing at minimum the Jest JSON report or a screenshot) to `docs/validation/<VTID>/`. This matches what VTID-05082 supplies for the identical gate.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Rationale holds. kind: "existing" is confirmed at lib.cjs:169–180 with its own validation branch and error messages. The planner correctly notes that a test-only fix has nothing new on staging to probe over HTTP, making an existing-suite entry the appropriate choice.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
