# Tasks — collab-queue-perf
<!-- lane: queue-batch-read -->
- [ ] T1 `queue.mjs`: `catFileBatch(repo, queries)` → `Map<query, string|null>` over one `git cat-file --batch`.
- [ ] T2 `collect()`: main spec contents through T1; branch → changed spec files from one `rev-list --parents` +
      one pathspec'd `log --name-only` (design option a); all `(ref, path)` contents through the same T1 batch.
- [ ] T3 `listClaims()`: claim commit messages through T1; reuse the `for-each-ref` call from `collect()`.
- [ ] T4 `queue.test.mjs`: fixture repo per `plan.md` §Tests; equivalence with `collectReference` (the old code,
      kept in the test file); spawn count ≤ 6 per repo.
- [ ] T5 Verify: `node --test scripts/collab/*.test.mjs`; timing before/after on vitana-platform + vitana-v1 in the
      lane log.
Acceptance: requirements 1–4 hold and all `scripts/collab` tests are green.
