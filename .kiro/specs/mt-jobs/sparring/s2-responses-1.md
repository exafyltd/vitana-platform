# Session 5871c575 — round 1 responses (mt-jobs)

Partner raised two major and three minor findings against plan hash
`f3d5470b3c42f70cf855ec9c163cd64d5ebcffa226c6c84379c2a3ba2fb2d53a`. Each premise re-verified against the
current branch tip `a545958` (parented on `d4bc696`); dispositions below. `plan.md`, `tasks.md` and the four
lane files were updated accordingly (lane front-matter paths unchanged, so the queue validators stay green).

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified at tip a545958: the EventBridge tenant is NOT in a schedule target Input. setup-eventbridge-whats-new.sh:270-276 TARGET has only Arn/RoleArn/RetryPolicy; TENANT_ID is a shell var (whats-new.sh:42) baked into the Lambda --environment Variables (whats-new.sh:204, :218) and the inline handler body JSON.stringify({ tenant_id: process.env.TENANT_ID }) (whats-new.sh:158, daily-feature-tip.sh:190). setup-eventbridge-cron-migration.sh instead bakes {\"tenant_id\":\"$TENANT_ID\"} into the schedule Input body of ~26 jobs (:156-188, incl. night-push :188, daily-pace :187, morning-briefing :157, memory-embedding-backfill :173), TENANT_ID from DEFAULT_TENANT_ID at :98. setup-eventbridge-push-dispatch.sh pins no tenant at all. Rewrote Problem 7, Fix lane 1, tasks E1/E2 and the E acceptance to the three real mechanisms: drop TENANT_ID from the Lambda env block + change the handler body to JSON.stringify({}) for whats-new/daily-feature-tip, drop the tenant_id from the ~26 cron-migration Input bodies, leave push-dispatch untouched; Lambda config AND code both re-applied by Claude/owner. jobs-env-prepare lane body reworded to match.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "rejected",
    "rationale": "The file exists; the partner's search missed the guide/ subpath. ls-tree at tip a545958 lists services/gateway/src/services/guide/morning-brief-scheduler.ts. Re-read: :130-131 '// Look up user_name + tenant_id in a single query' then repo.fetchUsersForMorningBrief(supabase, todo); the per-user tenant_id is carried through at :140 (tenant_id: u.tenant_id) and :152. So the scheduler layer is already tenant-correct and correctly out of scope. Fixed the plan to cite the full path services/gateway/src/services/guide/morning-brief-scheduler.ts:130-131 (+ :140,:152) and the repo helper :38-42, and noted the /morning-briefing ROUTE (scheduled-notifications.ts:478) is the getTenantId-driven path lane 2 covers. No scope change; the premise stands, now with a locatable citation.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified groups-events-tools.ts:357-360: const tenantId = id.tenant_id || process.env.DEFAULT_TENANT_ID; — the session-resolved tenant is tried first, Maxina only when absent, unlike the six direct pins (community.ts:274,382,482, match-feedback.ts:280, matchmaking.ts:576, admin-signups.ts:205). Reclassified Problem 6 as six direct-pin sites + one fallback; lane 3 and tasks A1/A2 now annotate the fallback separately and add a dedicated Vitest asserting an id.tenant_id-present dispatch is not regressed on either flag state. Same resolveActorTenant fix, lower risk, explicit no-regression pin.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Verified autopilot-recommendations.ts:2299-2309: the /community-scan route emits one emitOasisEvent({ type: 'community_autopilot.scan.completed' }) after each runCommunityScan. Wrapping the call in a per-tenant loop would fire N events per hourly tick. Chose aggregation (the more conservative, single-state-transition option, consistent with one schedule tick): the route collects each tenant's ScanRunSummary and emits ONE aggregated event after the full loop. Recorded in Fix lane 4, lane body and tasks C1/C3 (C3 asserts exactly one event per tick).",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "Verified index.ts:1840-1866: the heartbeat setInterval is registered once at startup (:1848) with heartbeatTenantId read once at :1844. If the flag/tenant set were read at init it could not represent a per-tenant gate. Clarified across plan Fix lane 2, the lane body and tasks L3 that isJobsTenantLoopEnabled + activeTenantIds are evaluated INSIDE each tick (per-tenant tenant_settings fetched on that tick), never at init, so a mid-flight flip takes effect on the next tick with no restart; added a Vitest (L5) that flips the flag off between two ticks and asserts the loop stops next tick.",
    "deferred_to": null
  }
]
```
