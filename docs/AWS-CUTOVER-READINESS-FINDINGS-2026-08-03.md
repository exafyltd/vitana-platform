# GCP→AWS Cutover Readiness — Investigation Findings, 2026-08-03

**Status: investigation only. No infrastructure was changed. No VTID authorizes a
full GCP cutover, and none was allocated by this work.**

This document records a readiness-testing pass against the open items in
`docs/AWS-CUTOVER-RUNBOOK.md` §2 and the preconditions in
`docs/vtids/VTID-PENDING-GCP-FULL-CUTOVER-SPEC.md`.

## 0. Scope limitation — READ THIS FIRST

This pass was commissioned on the assumption that the session had **real AWS
credentials**. It did not. The environment exposes:

```
AWS_ACCESS_KEY_ID   = "proxy-injected"   (14 chars — real AWS keys are 20, AKIA*/ASIA*)
AWS_SECRET_ACCESS_KEY = "proxy-injected" (14 chars)
AWS_SESSION_TOKEN   = <unset>
~/.aws/config       = s3 payload_signing_enabled only; no credentials, no profile
```

`proxy-injected` is a placeholder written by the agent HTTP proxy so tooling
does not crash on startup. The proxy sets `AWS_CA_BUNDLE` for TLS trust only —
it does **not** substitute real credentials on relay. AWS endpoints are
reachable (`sts.eu-central-1` → 302, `ecs.eu-central-1` → 400 — the network path
is healthy), but every SigV4-signed call fails:

```
$ aws sts get-caller-identity --region eu-central-1
An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity
operation: The security token included in the request is invalid.
```

This is the **same blocker the previous session hit** (`aws sts
get-caller-identity` → `InvalidClientTokenId`, recorded in CLAUDE.md's
2026-07-31 changelog row). It is not resolved.

**Consequence:** every check specified as an `aws ...` CLI call — DMS table
statistics, ECS service inventory, ALB target health, CloudWatch alarm state,
the `vitana-gateway-awsdr` task-definition env vars, and `terraform plan`
against live state — **could not be run and is not answered below.** Nothing in
this document is a substitute for those calls; where a conclusion is
analytically derived rather than directly measured, it says so explicitly.

What *was* reachable: the Supabase project `inmkhvwdcuyhnxkgfvsb` (the CDC
**source** database) and the repo. That turned out to be enough to resolve
Priority 1 analytically and to establish Nova Sonic's live production status
empirically.

---

## 1. Priority 1 — the DMS 154k vs 809 discrepancy: RESOLVED (analytically)

### The question

VTID-03419 measured `vitana-supabase-to-aurora` "silently dropping ~154k row
applies." A separate user-run check found "507 tables match on both sides, 191
rows behind on 3 vector-column tables + 618 rows on 5 new `watcher_*` tables"
— 809 rows. A ~190× gap that nobody had explained.

### Answer: the two numbers measure different quantities and are not in conflict

**They are a flow and a stock.** The 809 figure is a *point-in-time row-count
delta* (stock: how many rows differ right now). The 154k figure is a
*cumulative change-event counter over the task's lifetime* (flow: how many
apply operations were processed/dropped since the task started). For a CDC
pipeline over a high-churn OLTP database these differ by orders of magnitude by
construction, and a 190× ratio is unremarkable.

### The mechanism, quantified from the live source database

`pg_stat_user_tables` on the Supabase source shows the platform is dominated by
**tiny, extremely high-churn state/heartbeat tables** — the exact shape that
makes a row-count diff blind to CDC loss:

| Table | Live rows | Lifetime UPDATEs | Ratio |
|---|---:|---:|---:|
| `admin_insights` | 393 | 295,168 | 751× |
| `thread_presence` | 45 | 185,775 | 4,128× |
| `agents_registry` | 30 | 117,513 | 3,917× |
| `worker_registry` | 81 | 110,809 | 1,368× |
| `autopilot_loop_state` | **1** | **60,464** | **60,464×** |
| `tenant_kpi_current` | 3 | 41,745 | 13,915× |
| `tenant_health_index_daily` | 217 | 41,475 | 191× |

`autopilot_loop_state` is the clearest demonstration: **one row, 60,464 lifetime
updates.** If DMS dropped *every single apply* to that table, a row-count
reconciliation would report a difference of **zero** (1 row on each side) while
a cumulative dropped-applies counter would report 60,464. Six such tables
comfortably exceed 154k on their own.

So the answer to the question as posed — *"was the 154k figure a bad read of a
cumulative metric, or is there a real gap the 809-row fix didn't touch?"* — is:
**it is a cumulative metric, and it is not evidence of 154k missing rows.** The
809-row fix and the 154k figure are not competing measurements of the same
thing, and the 809-row fix was never expected to move the 154k number.

### Corroboration of the user's 809 figure

The source side matches the user's report exactly. There are precisely **5
`watcher_*` tables totalling 618 rows**:

| Table | Rows |
|---|---:|
| `watcher_steps` | 591 |
| `watcher_rules` | 25 |
| `watcher_observer_state` | 2 |
| `watcher_lessons` | 0 |
| `watcher_reminder_feedback` | 0 |
| **Total** | **618** |

618 + 191 = 809. The user's count is confirmed against the source. Table count
also lines up: 511 public tables total (vs. "507 match on both sides"),
1,284,161 estimated live rows across 131 non-empty tables.

### The more important finding: row-count reconciliation is the wrong test here

The handover flagged this narrowly for vector columns ("row counts matching
doesn't rule out truncated/corrupted embedding vectors"). **The churn table
above shows the concern is far broader than vectors.** `admin_insights` has 393
rows and 295,168 lifetime updates: Aurora could hold *entirely stale content*
in every one of those 393 rows and a row-count diff would report a clean match.
The same is true of `agents_registry`, `worker_registry`, `tenant_kpi_current`
and every other low-row/high-update table.

**A row-count reconciliation cannot validate this database for cutover.** Any
go/no-go check must be content-based (checksum/digest per row, or at minimum
`max(updated_at)` skew per table) on the high-churn tables, not `count(*)`.

For reference, the 11 tables carrying `vector` columns with live data are
`mem_facts` (11,888, dim 1536), `memory_facts` (10,513, dim 768),
`calendar_events` (1,386), `products` (794), `memory_items` (162),
`mem_episodes` (161), `user_intents` (1), `feedback_tickets` (1), plus
`ai_memory` / `memory_embeddings` (0 rows). Whichever 3 were reconciled, the
same caveat applies — a count match says nothing about vector integrity.

### What still requires AWS access to close

This resolves the *arithmetic* discrepancy. It does **not** close the runbook
§2 checklist item, which needs:

1. `aws dms describe-table-statistics --replication-task-arn <arn>` — per-table
   `Inserts`/`Updates`/`Deletes`/`FullLoadErrorRows`/`ValidationFailedRecords`,
   to confirm the 154k is concentrated in the high-churn tables predicted above.
   **If it is not — if the drops sit on low-churn business tables — this
   analysis does not apply and the item is a genuine blocker.**
2. CloudWatch DMS metrics/logs for the failure pattern behind the drops.
3. A **content-level** (not row-count) comparison on the high-churn and
   vector-bearing tables.

---

## 2. Priority 3 — Nova Sonic live scope: PARTIALLY ANSWERED (empirically)

The task-def env vars (`NOVA_SONIC_ENABLED`, `NOVA_SONIC_CANARY_TENANT_IDS`,
`NOVA_SONIC_CANARY_USER_IDS`, `BEDROCK_ROLE_ARN`) could not be read — AWS
blocked. But production telemetry in `oasis_events` answers the underlying
question more directly than the env var would.

### Nova Sonic is live in production right now and has been continuously since 2026-07-27

Production ORB voice sessions by day (`topic like 'orb.live%'`, `env=production`):

| Day | Nova Sonic sessions | Legacy-path sessions | Nova share |
|---|---:|---:|---:|
| 2026-07-27 | 13 | 37 | 26% |
| 2026-07-28 | 13 | 40 | 25% |
| 2026-07-29 | 21 | 42 | 33% |
| 2026-07-30 | 9 | 31 | 23% |
| 2026-07-31 | 9 | 50 | 15% |
| 2026-08-01 | 7 | 36 | 16% |
| 2026-08-02 | 1 | 28 | 3% |
| 2026-08-03 | 3 | 13 | 19% |

First Nova production session: **2026-07-27 09:46:23 UTC**. Most recent:
**2026-08-03 13:24:30 UTC** (i.e. live today). 76 Nova sessions total, all
`env: production`, carrying real audio and real token usage.

**Methodological note (this trap was checked, not assumed):** the `provider`
field is emitted *only* on the Nova code path. Sessions with no `provider` key
are the legacy Vertex path — 784 such sessions going back to 2026-03-01. An
early read of "Nova is the only provider present" would have been wrong; the
"legacy" column above is that null-provider population. Nova is a genuine
minority canary at roughly 15–33% of sessions, **not** a full flip.

### Scope identity remains unknown

`oasis_events.tenant`, `.vitana_id` and `.actor_id` are **null on all 76 Nova
sessions**, so the canary allowlist cannot be recovered from telemetry. The
handover's "Maxina tenant + 4 canary users + internal dev tenant" is neither
confirmed nor contradicted here. Reading the task-def env vars is still required.

### Pinned config, from source (`AWS-PROD-DEPLOY-GATEWAY.yml`, `nova-sonic-config.ts`)

| Setting | Value |
|---|---|
| `NOVA_SONIC_MODEL_ID` | `amazon.nova-2-sonic-v1:0` |
| `NOVA_SONIC_REGION` | **`eu-north-1`** — note: *not* `eu-central-1`, unlike all other Vitana AWS infra |
| Enable gate | `NOVA_SONIC_ENABLED === 'true'` (exact string) |
| Canary allowlists | `NOVA_SONIC_CANARY_USER_IDS` / `NOVA_SONIC_CANARY_TENANT_IDS` (UUID lists) |
| Supported languages | `en`, `de`, `fr`, `es` |

The deploy workflow **preserves** existing `NOVA_SONIC_*` task-def values when
its optional inputs are left empty, and only overwrites when explicitly
supplied. So the live canary scope is whatever the last explicit dispatch set —
it is not visible in, nor recoverable from, the repo.

### Flagged: Nova error rate has regressed in the last 48 hours

Session close reasons (`orb.live.diag` / `upstream_closed`):

| Day | `nova_stream_error` | `nova_validation` | Total Nova sessions |
|---|---:|---:|---:|
| 2026-07-27 | 5 | 4 | 13 |
| 2026-07-28 | 0 | 0 | 13 |
| 2026-07-29 | 0 | 0 | 21 |
| 2026-07-30 | 0 | 1 | 9 |
| 2026-07-31 | 2 | 0 | 9 |
| 2026-08-01 | 0 | 0 | 7 |
| 2026-08-02 | **1** | 0 | **1** |
| 2026-08-03 | **1** | 0 | **3** |

2026-07-27's 9-of-13 failure rate is the emergency the handover describes, and
the 07-28 → 08-01 stretch is the fix holding. But **2 of the last 4 Nova
sessions ended in `nova_stream_error`**, and the single most recent Nova event
in the database is one. Volumes are small enough that this may be noise, but it
is not a clean burn-in, and it is happening while Nova is live in production.
This should be checked before Nova's scope is widened.

---

## 3. Priority 2 — ECS service inventory: NOT ANSWERED (AWS-blocked)

Requires `aws ecs list-services` / `describe-services`. Additionally
`exafyltd/vitana-infra` could not be added to the session (the GitHub MCP
server disconnected mid-pass), so the 28-service Terraform list could not be
re-read either. **No inventory is provided — do not treat this item as
progressed.**

## 4. Priority 4 — infra hygiene: NOT ANSWERED (AWS-blocked)

All five sub-items (`terraform plan` on `phase8-data-prod`, ALB target-group
health for the `-prod`/`-awsdr` groups, the 47 CloudWatch alarms + DMS rule,
`oasis-projector` `desiredCount`, `oasis-operator-awsdr` burn-in) require live
AWS API access. None were run. **All remain open and unverified.**

---

## 5. What is needed to finish this work

A session with real AWS credentials for account `472838866351` — an IAM role or
user with read access to `dms:Describe*`, `ecs:Describe*`/`List*`,
`elbv2:Describe*`, `cloudwatch:Describe*`, `logs:FilterLogEvents`, and
`ecs:DescribeTaskDefinition`. Read-only is sufficient for every outstanding
item. The GitHub MCP connection also needs to be up in order to attach
`exafyltd/vitana-infra`.

## 6. GCP spend — where the money actually goes (added 2026-08-05)

Investigated because "shut down GCP to save cost" was raised as an urgent
action. **Conclusion: the cost is idle always-on Cloud Run standby, not AI, and
it can be removed without shutting anything down.**

### Measured: AI spend is negligible

Every LLM call logs `cost_estimate_usd` (`oasis_events`, topic
`llm.call.completed`):

| Window | Vertex AI spend |
|---|---:|
| Last 30 days | **$5.42** |
| Last 90 days | **$15.72** |
| All-time (logging since 2026-01-23) | **$19.95** |

~$0.18/day, and 94% is `dev-autopilot-planning` on `gemini-3.1-pro-preview` —
internal tooling, not user traffic. **The entire AI/voice provider-replacement
programme (Nova Sonic, Polly, Bedrock, Titan) targets roughly $5/month of
spend.** Cost is not a valid argument for accelerating it.

Caveat: this covers the text LLM router path only. Vertex **Live** (ORB voice)
does not emit `llm.call.completed`; `orb.live.upstream.usage` exists but is
Nova-only, so the legacy Vertex Live voice path is **unmeasured** — it is not
included above and is not known to be zero.

### Estimated: always-on Cloud Run standby

Services pinned `min-instances>=1`, billing 24/7 regardless of traffic:

| Service | Config | Est. $/mo | Load-bearing? |
|---|---|---:|---|
| `orb-agent` | 2 vCPU / 4 GiB, min=1 | ~$150 | **YES** — the livekit-agents worker connects *outbound* to LiveKit Cloud; at min=0 it deregisters and receives no job dispatches at all. Do not change. |
| `gateway` (GCP) | min=1, max=1 | ~$70–150 | **NO** — zero production traffic since 2026-07-27. Addressed by VTID-03491. |
| `gateway-staging` | 1 vCPU / 1 GiB, min=1 | ~$69 | **YES** — BOOTSTRAP-ORB-STAGING-WARM: cold `/orb/live/session/start` measured ~9.4s vs the widget's 8s abort. |
| `worker-runner` | min=1 | ~$65 | **YES** — VTID-01206, constant polling for the canonical pipeline. |
| Memorystore | `PROVISION-MEMORYSTORE.yml`, min=2 | ~$35–70 | Not assessed. |

Basis: us-central1 always-allocated CPU at $0.000024/vCPU-s and
$0.0000025/GiB-s → ~$62/mo per always-on vCPU, ~$6.50/mo per GiB. **These are
estimates derived from deploy config plus public list pricing, not billing
data** — no GCP billing access was available. `gateway` and `worker-runner`
CPU/memory are not pinned in config, so those rows carry the widest error bars.
The authoritative figure is GCP Console → Billing → Reports, grouped by service.

### Action taken

Only `gateway` had a warm instance with no justification behind it, so only
`gateway` was changed (VTID-03491). The other three are each load-bearing for a
documented, previously-diagnosed reason and were deliberately left alone.

**This is a config change — it takes effect on the next GCP gateway deploy and
does not retroactively resize the running service.** To realise the saving
immediately, an operator with `gcloud` access must run:

```
gcloud run services update gateway --min-instances=0 \
  --region=us-central1 --project=lovable-vitana-vers1
```

### Bottom line on the shutdown question

Scaling the unjustified standby to zero captures most of the saving while GCP
stays fully intact and re-activatable. A full GCP shutdown saves perhaps
another $100–200/month beyond that, and costs: ORB voice for the ~70–85% of
sessions still on the Vertex path, all TTS (5 Google Cloud TTS call sites, no
Polly), all cover-image generation (Vertex Imagen, no Titan adapter), five
GCP-canonical services, and the only rollback from a cutover whose data layer
is still unverified (§1). That is a poor trade at this price point.

## 7. Governance note (recorded, not re-litigated)

`vtid_ledger` shows VTID-03398 and VTID-03420 as `status=rejected` /
`terminal_outcome=failed`. Per the prior session's tracing this is a false
negative from an autopilot bug that misattributed unrelated failure events to
those VTIDs after their work had already succeeded. Recorded here only so the
next reader does not mistake it for missing authorization; the underlying
autopilot misattribution is worth its own fix VTID.
