# Sparring round 3 — escalated

Session: `c48d3889-2318-40ca-bc26-b143274fd7b5` · plan hash `16b1eae137c2b7b039af2f5df23dbf8569054ae3ab440610731640ec1ce1d73f`

## Summary

Round 3 review. Both R2-F1 and R2-F2 were accepted; the revised plan addresses R2-F2 correctly (option A, conditional steps) and resolves the ambiguity from R2-F1 by committing to posting a commit status. However, the commit-status mechanism introduced to resolve R2-F1 has two new defects: (1) the PLAN-SPAR.yml workflow's explicit `permissions:` block does not include `statuses: write`, so the new step will fail with a 403 at runtime — a blocker; (2) the consumer side of the mechanism (the PM/land step that reads the `plan-spar/needs-rebase` status and calls `gh pr update-branch`) is not named in the lane 5 files list and no code exists for it anywhere in the repo — a major gap. No other new defects found in this round.

## Findings

### R3-F1 [blocker]

PLAN-SPAR.yml has an explicit workflow-level `permissions:` block (lines 30-34) that lists only `contents: write`, `pull-requests: write`, and `actions: read`. Under GitHub Actions semantics, once a `permissions:` block is explicitly declared at the workflow or job level, ALL unlisted permissions are set to `none`. `statuses: write` is absent from the block, so the new lane 5 step that calls `POST /repos/{owner}/{repo}/statuses/{sha}` via `gh api` will receive HTTP 403 at runtime. The plan's claim that 'GITHUB_TOKEN carries `statuses: write` by default (statuses are not checks), so this is within the token's capability with no owner config' is true only when NO explicit `permissions:` block exists — it is false for this workflow.

- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:30` — permissions:
    contents: write
    pull-requests: write
    actions: read # VTID-05272: the slot step lists PLAN-SPAR runs (read-only)

Suggestion: Lane 5 must add `statuses: write` to the PLAN-SPAR.yml `permissions:` block, e.g.:
```yaml
permissions:
  contents: write
  pull-requests: write
  actions: read
  statuses: write   # lane 5: post plan-spar/needs-rebase on bot-head commit
```
The lane spec and the lane's proof test must assert this addition is present. The claim 'no owner config needed' is correct for the secret, but the workflow permissions change is required code.

### R3-F2 [major]

Lane 5's mechanism is half-built: it posts a `plan-spar/needs-rebase` commit status on the bot head but never consumes it. The plan says 'The PM / land step reads this status context on the PR head and, when present and `pending`, runs `gh pr update-branch`… The land-step read is a non-gate `scripts/ci/**` concern tracked here as part of this lane's acceptance.' However: (a) the lane 5 files list is `.github/workflows/PLAN-SPAR.yml`, two test files, and docs — no `scripts/ci/**` consumer file is listed; (b) a code search for 'plan-spar needs-rebase commit status update-branch' returns zero hits, confirming no such consumer exists anywhere in the repo; (c) a search for 'gh pr update-branch land step merge PR' returns `services/gateway/src/services/project-manager/act.ts` — a TypeScript gateway service file, not a `scripts/ci/**` shell script — as the PM/land step location, meaning any change to it would require a gateway service change and staging deploy, contradicting the plan's 'CI/GitHub-only change deploys nothing' premise. Without the consumer the posted status is never read, `gh pr update-branch` is never called, and the false positive (GITHUB_TOKEN push producing no `pull_request` checks) is not fixed.

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
- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:30` — permissions:
    contents: write
    pull-requests: write
    actions: read # VTID-05272: the slot step lists PLAN-SPAR runs (read-only)

Suggestion: Lane 5 must either: (A) name the exact file that implements the consumer side and add it to the lane's files list — if the PM land step lives in `act.ts` (gateway service) this is a gateway service change that requires a staging deploy and cannot be characterised as CI-only; or (B) acknowledge the consumer side is deferred to Gate 2 alongside the PAT secret, explicitly state that until the consumer is built the status signal has no effect, and narrow lane 5's stated benefit accordingly. The lane's proof test must assert both the producer (status posted on bot head) and the consumer (update-branch called when status is present and pending) — if the consumer is deferred the test must assert only the producer contract and the lane's acceptance criterion must be corrected.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — The planner accepted R2-F1 and the revised plan commits to exactly one mechanism (POST /repos/{owner}/{repo}/statuses/{sha}) and rejects the two alternatives. The ambiguity from R2-F1 is resolved. However, the accepted mechanism introduces a new defect (missing `statuses: write` in the explicit permissions block) raised as R3-F1, and the consumer side is unspecified, raised as R3-F2.
- R2-F2: acknowledged — The planner accepted R2-F2 and the revised plan correctly specifies option A: add `typecheck`/`guardrails` keys to the vcaop matrix entry only, and add two shared-body steps with `if: matrix.typecheck != ''` / `if: matrix.guardrails != ''` guards. The TEST-SUITE.yml shared steps block was re-verified (lines 126-139) and has exactly two run-steps (Install, Run tests), confirming option A is structurally sound. No new defect here.
