# Requirements — collab-throughput

1. THE queue SHALL produce the same rows as today with a fixed number of git processes per repo, independent of
   the branch count. A two-repo run on the owner's machine SHALL take under 10 s.
2. WHEN `responses-<n>.md` is malformed or does not answer exactly the findings of round n, PLAN-SPAR SHALL send
   nothing to the gateway, SHALL comment on the PR naming each offending or missing finding id, and SHALL fail
   the run.
3. THE gateway SHALL expose a read-only, authenticated sparring code-access health route that reports per repo
   whether `PLAN_SPARRING_GITHUB_TOKEN` can read it.
4. WHEN that route reports `ok: false`, PLAN-SPAR SHALL start no sparring session or round, and SHALL comment the
   reason on the PR.
5. A scheduled workflow SHALL check the route on the staging gateway at least every 30 minutes and fail visibly
   when code access is broken.
