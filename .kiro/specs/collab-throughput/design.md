# Design — collab-throughput

- **A (queue):** `collect()` = one `git log --remotes=origin --not <main> --since --source --name-only` pass that
  maps changed spec paths to source refs. `git ls-tree` on main supplies main's spec files. One
  `git cat-file --batch` child reads every `ref:path`. `consider()` and `buildQueue()` are unchanged.
- **B (answer check):** a pure function `checkResponses(findingIds, responses)` returns
  `{ unknown, duplicate, missing }`, mirroring `submitPlannerRound`. `step()` calls it before `client.round`.
  The CLI writes the comment file and the summary. PLAN-SPAR.yml's `Comment` step runs `always()` and prefers the
  comment file.
- **C (health):** `checkCodeAccess()` in `github-tools.ts` (one GET `/repos/<repo>/contents/README.md` per repo,
  default branch) backs `GET /api/v1/plans/spar/health`. `gatewayClient.health()` in `plan-spar.mjs` is called
  first in `step()`. The ALERT workflow follows `ALERT-PUSH-DISPATCH-HEALTH.yml`, pointed at staging with the
  service token.
