# Sparring round 1 — in_progress

Session: `0b4e3562-119e-4eb3-ba4b-7e56caa8118a` · plan hash `c42250848e06674e7ad23cb4e242e0615d7ad6fca111353ff3708af0a7344677`

## Summary

The plan is ambitious and well-structured, covering a complex transition from human-in-the-loop to autonomous staging delivery. Most premises about the existing codebase are accurate — line references, code behavior, and architectural constraints check out against the pinned commit. I have four findings: two major gaps in the self-protecting gate mechanism and two minor interface/permission issues.

## Findings

### R1-F1 [major]

gate-invariants.mjs must be loaded from the merge-base for PR-level checks, not HEAD. The plan says the invariant check 'reads its expectations from the merge-base' and 'cannot be changed in the same PR that changes the files it protects,' but does not specify that the SCRIPT ITSELF runs from the merge-base. If the HEAD version of gate-invariants.mjs runs, a PR could modify the script's checking logic (e.g., short-circuit a structural check to always pass) while the merge-base expectations data is unchanged. The whole value of the invariant check as a mechanical backstop to the two-model gate is lost if the checking logic itself is modifiable in the same PR.

- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:167` — - name: Lane scope
  run: |
    git show "$BASE:scripts/collab/queue.mjs" > "$RUNNER_TEMP/queue.mjs"
    if git cat-file -e "$BASE:scripts/collab/protected-gate-files.json" 2>/dev/null; then
      git show "$BASE:scripts/collab/protected-gate-files.json" > "$RUNNER_TEMP/protected-gate-files.json"
    fi
    node "$RUNNER_TEMP/queue.mjs" scope-check ...

Suggestion: Specify explicitly that the gate-invariants check in PR-level CI loads gate-invariants.mjs from the merge-base (the same pattern PR-GATE.yml already uses for queue.mjs at line 169: `git show "$BASE:scripts/collab/gate-invariants.mjs" > "$RUNNER_TEMP/gate-invariants.mjs"`). This ensures the checking logic cannot be weakened in the same PR that weakens the files it protects. The post-merge GATE-INVARIANTS.yml on main can safely run the HEAD version (it is checking main against itself).

### R1-F2 [major]

After machine-gate-protected lands, nothing at the GitHub platform level enforces that a merge of protected gate files actually went through land-guard.mjs merge (the two-model path). The plan confirms no CODEOWNERS and no environment reviewers exist. The bootstrap itself demonstrates a direct `gh api -X PUT .../merge` call that bypasses land-guard.mjs. The gate-invariants CI check verifies the CODE is correct (mergeDecision requires two accepts), but it does not verify that the MERGE COMMIT was authorized by two models. GATE-INVARIANTS.yml on main runs after the code is already on main. A bypass merge of a protected gate file would be caught only after the fact.

- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:107` — export function mergeDecision({ review, checks, behindBy, protectedFiles = [] }) {
  if (protectedFiles.length) return { ok: false, code: 1, reason: `protected gate file(s) changed ...` };
  if (!review.ok) return { ok: false, code: 1, reason: `review: ${review.reason}` };
  if (checks.state === 'fail') return { ok: false, code: 1, reason: `checks: ${checks.detail}` };
  if (checks.state === 'pending') return { ok: false, code: 2, reason: `checks: ${checks.detail}` };
  if (behindBy > 0) return { ok: false, code: 1, reason: `PR is ${behindBy} commit(s) behind its base: update it, then re-check` };
  return { ok: true, code: 0, reason: 'review current, checks green, up to date' };

Suggestion: Add a post-merge verification to GATE-INVARIANTS.yml (the push-to-main + daily run): for every merge commit on main that touches a protected gate file, verify the commit message or trailers contain evidence of two-model acceptance (e.g., two distinct Collab-Reviewer trailers from different chain models). If the evidence is missing, the check fails loudly. This turns the after-the-fact detection into a hard signal within minutes of the merge, before further work builds on the commit.

### R1-F3 [minor]

The plan conflates script-level and workflow-level parameters for aurora-apply-migration.sh. It says 'the script refuses vitana-aurora-prod unless --target aurora,' but --target is a RUN-MIGRATION.yml workflow input (line 14: type: choice), not a script argument. The script currently accepts only --file, --dry-run, and --allow-non-transactional. The plan proposes adding --cluster to the script, but the refusal condition references --target which is a different layer.

- `exafyltd/vitana-platform:scripts/aws/aurora-apply-migration.sh:37` — CLUSTER=vitana-aurora-prod
DB=vitana
...
while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --allow-non-transactional) ALLOW_NONTX=1; shift ;;
    *) echo "::error::unknown argument: $1" >&2; exit 2 ;;
  esac
done
- `exafyltd/vitana-platform:.github/workflows/RUN-MIGRATION.yml:11` — target:
  description: 'Target database (default = repo variable MIGRATION_TARGET, unset = supabase)'
  required: false
  type: choice
  options: [default, supabase, aurora]
  default: default

Suggestion: Clarify the exact new interface: aurora-apply-migration.sh gains `--cluster <name>` (required, no default) and the script itself refuses the value `vitana-aurora-prod` unconditionally (no override flag) — the production path stays in the existing hardcoded code path, dispatch-only after PUBLISH. The workflow's `target: staging` resolves to `--cluster vitana-aurora-staging`. Drop the `--target aurora` phrasing from the plan.

### R1-F4 [minor]

The plan adds a `pull_request` trigger to VTID-ALLOCATE.yml that 'commits the VTID into scope.json as ci-vtid-allocate.' The current workflow has `permissions: contents: read` (line 29), which is insufficient for committing to the PR branch. Additionally, for `pull_request` events, GitHub runs the workflow definition from the PR HEAD, meaning a PR that modifies VTID-ALLOCATE.yml runs its own modified version with access to GATEWAY_SERVICE_TOKEN.

- `exafyltd/vitana-platform:.github/workflows/VTID-ALLOCATE.yml:15` — on:
  workflow_dispatch:
    inputs:
      title: ...
      module: ...
permissions:
  contents: read
jobs:
  allocate:
    ...
    env:
      GATEWAY_URL: ...
      GATEWAY_SERVICE_TOKEN: ${{ secrets.GATEWAY_SERVICE_TOKEN }}

Suggestion: Use `workflow_dispatch` triggered by a label or the PR-GATE workflow (which already runs from the base branch's definition) rather than a direct `pull_request` trigger, or use `pull_request_target` with an explicit checkout of the PR at the merge commit (never running untrusted workflow YAML). Either way, upgrade permissions to `contents: write` for the commit-back step. Consider adding VTID-ALLOCATE.yml to the protected gate files list since it controls VTID allocation.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
