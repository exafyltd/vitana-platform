# VTID-05007 — production record

The ledger metadata update for this was cancelled twice in session, so the record lives here.

**Owner approvals (2026-10-09):**
- Gate 2 "yes" for `4bc87f36`.
- Staging then moved on, so `4bc87f36` could no longer be promoted. The owner approved option 1 instead: an env-only flip on the current production image. No code ships.

## Production flip
- Run: [37985283918](https://github.com/exafyltd/vitana-platform/actions/runs/37985283918), `deploy_mode=env-only`, `env_overrides={"MEMORY_ORB_RECALL_ENABLED":"true"}`.
- Started 20:11 UTC, finished 20:15 UTC. The smoke check and the read-only post-deploy verification passed; no rollback.
- The image at the flip was `f77ca459`, shipped earlier by run #393 from another session.
- `AWS-PROD-DEPLOY-GATEWAY.yml` pins the flag to `true` since `4bc87f36`, so later deploys keep it. Run #395 (another session, 20:19 UTC) moved production to `c230bb71` with the pin applied.

## Verified on real traffic (read-only)
`scripts/memory/recall-shadow-report.sh /vitana/gateway-awsdr 14`, run 2026-10-10 about 09:10 UTC as `claude-code-aws-agent`:

```
sessions compared: 44   shadow read failed: 0   shadow not ok: 0
served by legacy: 1
served by recall: 43
facts identical: 44 / 44 (100.0%)
avg facts served/shadow: 47.8 / 47.8
avg only_served 0.00  only_shadow 0.00  value_diff 0.00
avg prompt chars served/shadow: 2760 / 2774
latency ms served p50 180 p95 547 | shadow p50 129 p95 409
```

The one legacy session is from before the flip inside that window. Since the flip, the shadow is the legacy read, so recall's p95 is still above it (547 vs 409 ms). The owner accepted that at Gate 1; the planned latency fix is phase 4 (snapshot).

## Rollback
- An env-only dispatch with `env_overrides={"MEMORY_ORB_RECALL_ENABLED":"false"}`.
- For a lasting off, also revert the pin in the workflow, or the next ordinary deploy turns recall back on.

## Next
Watch for 2 weeks, until about 2026-10-23. Then delete the legacy six-table read in `orb-memory-bridge.ts` (plan §8.4 phase 7) under its own VTID.
