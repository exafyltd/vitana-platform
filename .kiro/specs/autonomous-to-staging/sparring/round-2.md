# Sparring round 2 — in_progress

Session: `01e8f715-215c-4c57-a081-651f835939e4` · plan hash `983c925ca7b3de1517fe73e0fadd8e1b88219ead4100d57f68f1b5f1115f38c0`

## Summary

Round 2 review of the revised plan. All seven R1 findings were accepted; the plan was revised to address them. I verified the key revisions against the code and found that the bootstrap merge mechanism (§3a) is sound — `land-guard.mjs review` and `checks` subcommands don't block on protected files, and the driver's direct `gh api` merge call bypasses the `mergeDecision` refusal while replicating its validations individually. The engineering account premise (841276716213 = GitLab only) is confirmed by the eng-gitlab-m1 plan. I raise two new findings from the revision and one from the original plan that the revision partially but not fully addressed.

## Findings

### R2-F1 [major]

The plan says `gate-invariants.mjs` 'reads its expectations from the merge-base' to prevent a PR from weakening both the check and the gate. But the plan places the script in 'Collab tests' (the UNIT.yml node --test runner), which runs the PR head's version of the script. A PR that changes `gate-invariants.mjs` would run its own modified code — reading expectations from the merge-base is not enough if the script itself is modified to ignore them. The existing Lane scope check already solves this: PR-GATE.yml lines 168-173 run the merge-base version of `queue.mjs`, not the PR head's. `gate-invariants.mjs` needs the same treatment: the CI step must execute the merge-base version of the script (falling back to a no-op or hard-fail when it doesn't exist on the base). Without this, the 'cannot be changed in the same PR' claim is false — a PR touching both a protected gate file and `gate-invariants.mjs` would run its own weakened check.

- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:168` — - name: Lane scope
          run: |
            git show "$BASE:scripts/collab/queue.mjs" > "$RUNNER_TEMP/queue.mjs"
            if git cat-file -e "$BASE:scripts/collab/protected-gate-files.json" 2>/dev/null; then
              git show "$BASE:scripts/collab/protected-gate-files.json" > "$RUNNER_TEMP/protected-gate-files.json"
            fi
            node "$RUNNER_TEMP/queue.mjs" scope-check --repo . --base "$BASE" --head "$HEAD" --branch "$HEAD_REF" --plan-repo "${{ github.repository }}" --summary "$GITHUB_STEP_SUMMARY"

Suggestion: Run `gate-invariants.mjs` in PR-GATE (not UNIT/Collab tests) using the same merge-base extraction pattern: `git show "$BASE:scripts/collab/gate-invariants.mjs" > "$RUNNER_TEMP/gate-invariants.mjs"` and execute that copy. When the file doesn't exist on the base (the very first PR introducing it), either skip the check or hard-fail as a policy choice. This makes the 'cannot be changed in the same PR' guarantee mechanical.

### R2-F2 [major]

`land-guard.mjs` is not in the protected gate files list (governance.ts:48-61, queue.mjs:94-98), yet after `machine-gate-protected` lands it becomes the enforcement mechanism for the two-model merge rule (`mergeDecision`). The plan's gate-invariants check mechanically verifies `mergeDecision`'s behaviour, but that coverage is only as thorough as the test fixtures. A change to `land-guard.mjs` that passes the invariant tests but subtly weakens the merge logic (e.g. altering the `merge` subcommand's control flow around `mergeDecision`, or changing how `protectedTouched` is called at line 284) would need only a single reviewer-agent accept (governance-path rule), not the two-model review. `land-guard.mjs` is at least as critical as `queue.mjs` (which IS protected), since it is the final gate before the GitHub merge API call.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:48` — export const PROTECTED_GATE_GLOBS: readonly string[] = Object.freeze([
  'CLAUDE.md',
  'scripts/collab/plan-spar.mjs',
  'scripts/collab/queue.mjs',
  'scripts/collab/protected-gate-files.json',
  'services/gateway/src/services/plan-sparring/**',
  'services/gateway/src/services/project-manager/governance.ts',
  '.github/workflows/PLAN-SPAR.yml',
  '.github/workflows/PR-GATE.yml',
  '.github/workflows/AWS-PROD-*.yml',
  '.kiro/agents/vitana-lane-reviewer.md',
  'supabase/migrations/*vtid_ledger*.sql',
  'supabase/migrations/*plan_sparring*.sql',
]);
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:268` — if (cmd === 'merge') {
        need(o, 'gh', 'pr', 'reviewed-head', 'title');
        const pr = prHead(o.gh, o.pr);
        if (pr.merged) return say(0, `already merged (${pr.merge_commit_sha})`);
        const head = pr.head.sha;
        const key = o.lane || laneKeyOf(pr.title);
        const { after, prDiffSame } = reviewWalk(o, o['reviewed-head'], head, key);
        const review = reviewCurrent(o['reviewed-head'], head, after, key, prDiffSame);
        const checks = review.ok ? await waitChecks(o.gh, head, Number(o.wait || 0)) : { state: 'pending', detail: 'not read' };
        const cmp = ghJson(`repos/${o.gh}/compare/${pr.base.ref}...${head}`);
        const files = [];
        for (let page = 1; page < 31; page++) {
          const f = ghJson(`repos/${o.gh}/pulls/${o.pr}/files?per_page=100&page=${page}`) || [];
          files.push(...f.map((x) => x.filename));
          if (f.length < 100) break;
        }
        const d = mergeDecision({ review, checks, behindBy: cmp.behind_by, protectedFiles: protectedTouched(files, PROTECTED_GATE_PATHS) });
        if (!d.ok) return say(d.code, d.reason);
        const res = JSON.parse(run('gh', ['api', '-X', 'PUT', `repos/${o.gh}/pulls/${o.pr}/merge`, '-f', 'merge_method=squash', '-f', `sha=${head}`, '-f', `commit_title=${o.title}`]));
        return say(0, `merged ${res.sha} (${d.reason})`);

Suggestion: Add `scripts/collab/land-guard.mjs` to the protected gate files list in both `protected-gate-files.json` and the compiled-in constants in `queue.mjs` and `governance.ts`, as part of the `machine-gate-protected` lane. Also add an invariant expectation in `gate-invariants.mjs` that `land-guard.mjs` is on the list. This gives it the same two-model review requirement as `queue.mjs`.

### R2-F3 [minor]

The staging PostgREST-Aurora proxy workflow (`AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml` line 30) currently hard-codes the production secret `vitana/aurora/prod/postgrest-authenticator-uri` as its `PGRST_DB_URI` source. The plan says this proxy will be 'repointed at' the new staging Aurora cluster, but does not mention that the staging workflow itself references a production secret by name. The `staging-db-isolation` lane should create a staging-specific secret (e.g. `vitana/aurora/staging/postgrest-authenticator-uri`) and update the workflow — and the staging prod-ref guard script should also flag production secret ARNs in workflow files, not just config files.

- `exafyltd/vitana-platform:.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml:28` — # Required Secrets Manager entries (eu-central-1), both pre-existing:
#   vitana/aurora/prod/postgrest-authenticator-uri  -> PGRST_DB_URI
#   vitana/gateway/staging/supabase-jwt-secret      -> PGRST_JWT_SECRET

Suggestion: Explicitly list the staging PostgREST proxy secret repointing in the `staging-db-isolation` lane scope, and ensure the staging prod-ref guard script scans workflow YAML files for production secret names and ARNs, not just application config.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — §3a adequately specifies the bootstrap mechanism: the driver runs `land-guard.mjs review` and `checks` individually (both pass for protected-file PRs), then calls the merge API directly with sha-pinned squash, bypassing `mergeDecision`. The authority chain (owner instruction + reviewer-agent accept) is explicit and logged. Verified that the `review` subcommand does not block on protected files (it only checks review currency).
- R1-F2: acknowledged — The plan correctly explains that lane files declare `executor: claude` (so queue.mjs:1032 skips the protected-file scope check), while a Kiro seat builds them on the exceptions path. The `rules-platform` lane removes the blocking sentence at collaboration.md:228. The scope check passes, and the owner instruction is the review authority.
- R1-F3: acknowledged — Explicit Deny statements on exact production ARNs plus an IAM permissions boundary the role cannot remove is a meaningful improvement. The plan correctly notes that 472838866351 is the Organizations management account where SCPs don't apply, and defers a separate staging account as a strategy decision. Reasonable.
- R1-F4: acknowledged — The mechanical invariant check is a good compensating control. However, I raise R2-F1 (the script must run from the merge-base, not the PR head) and R2-F2 (land-guard.mjs should be a protected gate file) as follow-up findings on the implementation details.
- R1-F5: acknowledged — Citation corrected.
- R1-F6: acknowledged — OASIS events for quarantine transitions adequately specified.
- R1-F7: acknowledged — Confirmed eng-gitlab-m1/plan.md:13-14 documents account 841276716213 as the engineering platform (GitLab EE, runners, backups, CI cache). The inventory step and explicit denies on deleting critical resources are reasonable controls.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
