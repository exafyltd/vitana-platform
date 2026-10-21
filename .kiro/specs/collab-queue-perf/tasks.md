# Tasks — collab-queue-perf
<!-- lane: queue-batch-read -->
- [ ] T1 `queue.mjs`: `catFileBatch(repo, queries)` → `Map<query, string|null>` over one `git cat-file --batch`
      (Buffer output, `maxBuffer: 256 MiB`; the same limit on the `rev-list` / `log` calls of T2).
- [ ] T2 `collect()`: main spec contents through T1; branch → changed spec files from one `rev-list --parents` +
      one pathspec'd `log --cc --name-status`, walked as in `plan.md` §Changes 3; all `(ref, path)` contents and
      the claim commit messages through the same T1 batch.
- [ ] T3 Claims: internal `claimsFrom(refLines, messages)`; `collect()` reuses its one `for-each-ref`; the exported
      `listClaims(repo)` keeps signature and output (its own `for-each-ref` + one T1 batch); `claim`, `release` and
      the `claims` command are not edited.
- [ ] T4 `loadPrograms(repo, ref)`: `program.md` contents through one T1 batch; signature unchanged.
- [ ] T5 `queue.test.mjs`: fixture repo per `plan.md` §Tests; equivalence with `collectReference` (the old code,
      kept in the test file); spawn counts per `plan.md` §Tests.
- [ ] T6 Verify: `node --test scripts/collab/*.test.mjs`; timing before/after on vitana-platform + vitana-v1 in the
      lane log.
Acceptance: requirements 1–4 hold and all `scripts/collab` tests are green.
