# Sparring round 2 — in_progress

Session: `2eacb48d-7f1f-43af-9d7f-d25383d7f654` · plan hash `82107da648022a6729f000eeaa00535478e2a1df16c09dc7282820b795c28ba0`

## Summary

All three R1 findings were accepted and are genuinely addressed in the revision. Two new major gaps arise from Change A's specification of the replacement `git log` command: the date-filter argument is missing its `.ago` suffix, and the `%S` source-ref format produced by `--source --remotes=origin` is the full `refs/remotes/origin/…` form, while the plan's filtering logic (skip `collab-claim/*`, `origin/HEAD`) is written for the short `origin/…` form that the current `for-each-ref` approach returns.

## Findings

### R2-F1 [major]

`--since=<days>.days` in the proposed `git log` command is not a valid git relative-date expression and will silently misbehave. Git's approxidate parser requires the `ago` qualifier to trigger relative subtraction: the documented forms are `30 days ago` and `30.days.ago`. Without `.ago`, `30.days` is not a recognized token; depending on the git version it may be treated as an absolute date (effectively the epoch), returning all history, or be rejected and return nothing. Either way the `--since` window — the only guard preventing a full-history scan — stops working, negating the entire performance goal of Change A and potentially returning wrong results.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:259` — const since = Math.floor((now - days * 86400000) / 1000);
    const refs = (gitOk(repo, ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/remotes/origin']) || '')
      .split('\n').filter(Boolean).map((l) => l.split('\t'))
      .filter(([r, ts]) => r !== main && r !== 'origin/HEAD' && r !== 'origin' && !r.startsWith(`origin/${CLAIM_PREFIX}`) && Number(ts) >= since);

Suggestion: Change the plan's `git log` invocation to `--since=${days}.days.ago` (or the shell-quoted form `--since="${days} days ago"`). The test for Change A should assert that the spawned git process receives the correctly formed `--since` argument, not just that the output rows match a fixture.

### R2-F2 [major]

`git log --source --remotes=origin` reports `%S` as the full refname (`refs/remotes/origin/<branch>`), not the short form (`origin/<branch>`) that the current `collect()` filtering logic expects. The existing guards — `r !== 'origin/HEAD'`, `r !== 'origin'`, `!r.startsWith('origin/collab-claim/')` — were written for the `%(refname:short)` output of `for-each-ref`. Against full refnames these string comparisons all fail: `refs/remotes/origin/collab-claim/slug/lane` does not start with `origin/collab-claim/`, so claim refs would NOT be skipped. Any claim branch that shares a commit touching `.kiro/specs` with its parent spec branch would appear in the output attributed to a `refs/remotes/origin/collab-claim/…` source ref, injecting spurious entries into the queue and causing the `branch` column to show the claim ref rather than the spec branch. The plan says 'Skip `collab-claim/*` and `origin/HEAD`, as today' but provides no normalization step.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:260` — const refs = (gitOk(repo, ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/remotes/origin']) || '')
      .split('\n').filter(Boolean).map((l) => l.split('\t'))
      .filter(([r, ts]) => r !== main && r !== 'origin/HEAD' && r !== 'origin' && !r.startsWith(`origin/${CLAIM_PREFIX}`) && Number(ts) >= since);
    for (const [ref] of refs) {
      const changed = gitOk(repo, ['diff', '--name-only', `${main}...${ref}`, '--', '.kiro/specs']);
      if (!changed) continue;
      for (const p of changed.split('\n')) if (classifyPath(p)) consider(ref, p);

Suggestion: The plan must specify one of: (a) strip the `refs/remotes/` prefix from each `%S` value before filtering (e.g. `ref.replace(/^refs\/remotes\//, '')`) so the existing filter strings still work; or (b) update all filter predicates to match the full-ref form. The fixture test for Change A must include a collab-claim branch and assert it does not appear in the output rows.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Plan now explicitly requires `router.get('/health', …)` to be registered before `router.get('/:id', …)` and adds a Jest test covering that `GET /api/v1/plans/spar/health` reaches the health handler. The current code confirms `/:id` is at line 66 with no preceding `/health` route. Rationale is sound.
- R1-F2: acknowledged — Plan now specifies an in-process semaphore around `runPartnerPass`, per gateway process, with ceiling 2·N tasks, no 429 (held open), pass deadline starting at slot acquisition, and recovery via the existing `waitFor` poll. The code confirms `runPartnerPass` is the right boundary (called at line 370 of `submitPlannerRound`, after the session row already exists). Rationale is sound.
- R1-F3: acknowledged — Plan now keeps `step()` free of writes outside the spec directory and has `main()` write the report to `--comment-file <path>` (PLAN-SPAR.yml passes `$RUNNER_TEMP/plan-spar-comment.md`). The Comment step gains `always()` and uses `--body-file` when the file exists. Confirmed: current `main()` at lines 296–309 always returns 0 and has no `--comment-file` support, so all stated changes are still needed and the rationale is sound.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
