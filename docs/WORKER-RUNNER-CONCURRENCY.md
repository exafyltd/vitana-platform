# Two worker-runners are polling concurrently (VTID-03526)

**Status:** partially answered from the event log. The remaining question needs
one `aws ecs describe-services` call, which this session had no AWS credentials
for (`aws` CLI not installed).

Raised by VTID-03508, which observed two worker-runners heartbeating seconds
apart and could not attribute the second one, and noted it cuts against
`CLAUDE.md`'s *"Never run parallel VTID executions"*.

---

## What the data settles

**No VTID has ever been claimed by two workers.** Over 60 days, zero VTIDs have
more than one distinct `worker_runner.claimed` event:

```sql
select vtid, count(distinct substring(message from 'claimed by (worker-runner-[a-f0-9]+)'))
from oasis_events
where topic='worker_runner.claimed' and created_at > now() - interval '60 days'
group by vtid having count(distinct ...) > 1;   -- 0 rows
```

So `claim_vtid_task`'s atomicity holds, and the per-VTID mutual exclusion that
matters most is intact. VTID-03516 additionally added an ownership check on the
claim write path, which narrows the pool further.

## What the data does NOT settle

**Two workers are alive and claiming different VTIDs concurrently.**

| worker_id | claims (60d) | distinct VTIDs | first claim | last claim |
|---|---|---|---|---|
| `worker-runner-a1846580` | 41 | 39 | 2026-07-31 10:11 | 2026-08-07 00:18 |
| `worker-runner-447859c2` | 9 | 8 | 2026-08-05 09:08 | 2026-08-06 22:23 |
| `worker-runner-0dcf922a` | 17 | 17 | 2026-07-31 14:00 | 2026-08-04 12:30 |
| `worker-runner-581106eb` | 40 | 6 | 2026-07-04 20:39 | 2026-08-06 20:33 |

`a1846580` and `447859c2` are both `active` in `worker_registry` with heartbeats
~11s apart. Nothing stops VTID *A* executing on one while VTID *B* executes on
the other.

Whether that violates *"Never run parallel VTID executions"* depends on whether
the rule means **one VTID at a time per worker** (§5 rule 4 says exactly that,
and it is satisfied) or **one VTID at a time globally** (the Never-rule's
wording, which is not). Those two readings disagree today, in production.
`CLAUDE.md` should say which it means.

## The open question

`worker_registry` records **no cloud attribution**, so the DB cannot say whether
the second poller is:

- the AWS ECS twin (`vitana-worker-runner`, VTID-03411), or
- a second GCP Cloud Run revision.

VTID-03508 declined to scale `worker-runner` for exactly this reason: guessing
wrong stops the canonical autopilot pipeline **silently** (VTID-01206 pinned
`min-instances=1` precisely to keep polling alive).

**Next step:**

```bash
aws ecs describe-services --cluster Vitana-ECS-Cluster \
  --services vitana-worker-runner --region eu-central-1 \
  --query 'services[0].{desired:desiredCount,running:runningCount}'
```

If `runningCount >= 1`, the AWS twin is the second poller and GCP's revision is
redundant standby — decide which cloud owns the autopilot pipeline post-cutover.
If it is `0`, both pollers are GCP and one is an orphaned revision.

## Recommended fix regardless of the answer

Add cloud/runtime attribution to worker registration
(`POST /api/v1/worker/orchestrator/register`) — e.g. `metadata.cloud`,
`metadata.revision`. A registry that cannot say where its workers run is why
this question needed an out-of-band AWS call at all.
