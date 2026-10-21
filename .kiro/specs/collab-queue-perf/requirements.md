# Requirements — collab-queue-perf
1. `queue.mjs` output (table, `--json`, `--mine`, `--seat`, `validate`) is identical to today's for the same refs,
   except the accepted, guarded revert case in `plan.md`.
2. `collect()` + `listClaims()` start at most 6 `git` processes per repo, whatever the number of branches, spec
   files or claims.
3. A two-repo run (vitana-platform + vitana-v1) finishes in under 10 s on the owner's Windows machine.
4. `collect(repo, { days, now })` keeps its signature and stays synchronous; `--days` keeps its meaning (branch tip
   committer date).
