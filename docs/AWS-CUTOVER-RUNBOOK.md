# GCP → AWS Full Production Cutover Runbook

**VTID:** VTID-03412
**Status:** Living document — governance artifact, not an execution authorization.
**Last updated:** 2026-07-24

---

## 0. What this document is (and isn't)

This runbook exists because none did before it: this week's AWS-DR
buildout (VTID-03398, VTID-03409, VTID-03410, VTID-03411) stood up
parallel AWS infrastructure for `gateway`, `community-app`, and
`oasis-operator`, and hardened `oasis-projector`/`worker-runner`/
`vitana-verification-engine` — but no document anywhere described how to
actually **cut traffic over**, how to **roll back** if that goes wrong,
or when it's safe to **decommission GCP**.

**This document does not authorize a cutover.** Per CLAUDE.md §1b, GCP
(`lovable-vitana-vers1`) remains canonical production; AWS
(`472838866351`/`eu-central-1`) is additive DR capacity. Flipping that —
making AWS the sole production target and turning GCP off — is a
materially larger, harder-to-reverse action than any individual
per-service DR build, and requires:

1. Every item in the **Go/No-Go Checklist** (§2) to be true, and
2. A **separate, explicitly-approved execution VTID** that references
   this runbook and is itself gated on spec_status=approved, and
3. Explicit user sign-off before any change to `gateway.vitanaland.com`
   or the `vitanaland.com` apex DNS records — those are live,
   customer-facing production hostnames.

---

## 1. Current-state summary (as of 2026-07-23)

Sourced from `docs/AWS-PRODUCTION-BUILD-LOG.md` and a live read-only AWS
CLI + Cloudflare DNS audit performed under this VTID.

| Area | State |
|---|---|
| DNS | **Unmoved.** `gateway.vitanaland.com` and the `vitanaland.com` apex both resolve live to GCP today. Only `dr-*` hostnames (`dr-gateway`, `dr-app`, `dr-oasis-operator`) point at AWS. |
| gateway | AWS-DR built (VTID-03398), autoscaled, alarmed, dual-publish wired. Healthy. |
| community-app | AWS-DR built (VTID-03409). **Bakes the GCP `gateway.vitanaland.com` URL into its static Vite bundle at build time, by design** — it was built as a same-backend hot-standby, not a fully independent stack. Will break if GCP disappears without either repointing `gateway.vitanaland.com` to AWS or rebuilding against `dr-gateway.vitanaland.com`. See open decision §4.1. |
| oasis-operator | AWS-DR built (VTID-03410) from a 9-month-old dead backup (`main.py.backup-20251101-111126`) with zero prior AWS production traffic history. No burn-in yet. |
| oasis-projector / worker-runner / verification-engine | Bug-fixed + ECS health-checked + alarmed (VTID-03411). Deliberately **not** autoscaled or made public — `oasis-projector`'s ledger writer has no cross-instance locking (CLAUDE.md: "Never run parallel VTID executions"). **`worker-runner` has since been reviewed (2026-07-24) and found CONDITIONALLY SAFE for N>1**: its claim mechanism is a genuine server-side compare-and-swap (`SELECT ... FOR UPDATE` + conditional `UPDATE` inside one Postgres transaction, `claim_vtid_task` RPC in `supabase/migrations/20260413000000_fix_claim_accepts_scheduled.sql`), not a client-side read-then-write race, and no other shared mutable state exists between instances. The one real N>1-specific risk: an idle sibling instance will legitimately re-claim a VTID whose 60-minute claim lease expired due to sustained heartbeat failure on the active instance, causing double execution — condition for safety is that heartbeats reliably survive transient network hiccups; recommend alerting on sustained heartbeat failure before actually enabling autoscaling. Autoscaling itself has **not** been enabled — this is a documentation finding only, pending a decision on whether to act on it. |
| orb-agent | Deploy path **now exists** — `AWS-PROD-DEPLOY-ORB-AGENT.yml` (VTID-03414). But the running ECS service `vitana-orb-agent` is a **false-green**: reports `healthStatus: HEALTHY` while running health-endpoint-only, because `AGENT_ENABLE_WORKER` and `GATEWAY_SERVICE_TOKEN` are absent from its task definition. The workflow swaps *image only* and carries env/secrets forward, so **deploying through it will faithfully redeploy a still-inert service**. See §4.2. |
| autopilot job | Parity **now exists** — `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` plus a real AWS RunTask dispatch path in the gateway (`dev-autopilot-execute.ts`, VTID-03415). `JOB_CLOUD=aws\|gcp` selects the target per gateway instance, with in-process fallback if dispatch fails. This closes what was previously flagged as needing an undecided application-design change. |
| Database sync | RDS Aurora `vitana-aurora-prod` via DMS task `vitana-supabase-to-aurora` (full-load-and-cdc): 495/495 tables under live CDC from the same Supabase project GCP prod uses. `autopilot_recommendations`'s dedicated CDC task (`vitana-autopilot-cdc`), which was `FATAL_ERROR` for ~26h, was fixed 2026-07-24 via a clean restart — both tasks confirmed `running`. **Note:** the specific update that was stuck at the time of the original failure did not replicate (the fix restarts CDC capture from "now", not from the stale position) — a one-row historical drift, not an ongoing gap. |
| Secrets | `vitana/supabase/prod/*` (4 secrets) current as of 2026-07-14/21; RDS-managed master credential rotates automatically. |
| Alarms | 47 `vitana-*` CloudWatch alarms, all `OK`/`INSUFFICIENT_DATA`. `community-app-awsdr` and `oasis-operator-awsdr` now have the same 4-alarm set (cpu-high, memory-high, target-5xx, unhealthy-hosts) gateway-awsdr already had — closed 2026-07-24. A `vitana-dms-task-failure` EventBridge rule (source `aws.dms` → SNS topic `vitana-alarms-prod`) was also added the same day so a future DMS task failure isn't silent for 26+ hours again like `vitana-autopilot-cdc` was. **Resolved 2026-07-24: `vitana-alarms-prod` now has a confirmed subscriber** — `j.tadic@exafy.io` (email), confirmed via `aws sns list-subscriptions-by-topic` (`SubscriptionsConfirmed: 1`). All 47 alarms and the DMS-failure rule now notify a real endpoint. User explicitly confirmed single-email alerting is sufficient to close this item — no Slack/PagerDuty channel requested. |
| ALB naming | `vitana-tg-gateway-prod` / `vitana-tg-community-prod` **actually serve AWS staging traffic**, not prod — confirmed live via `/api/v1/admin/health` returning `env:"staging"` through those target groups. Both are `ManagedBy=terraform`-tagged (Terraform state not found in this repo) — not a stray hand-created leftover, part of some external IaC. Tagged 2026-07-24 with `ActualEnvironment=staging` to reduce confusion; not renamed (immutable name, rename requires recreation + ALB rule reattachment, risks a traffic blip). A real cutover must not confuse these with the `-awsdr` target groups. |
| Legacy/mystery services | ~22 of the 29 (now 31) ECS services in `Vitana-ECS-Cluster` from the 2026-07-09 bulk-provisioning event remain unexplained — flagged, not investigated. Out of scope for cutover unless one turns out to be load-bearing. |
| Cutover/rollback docs | **Did not exist before this VTID.** No DNS-repoint runbook, no rollback/TTL plan, no GCP decommission checklist. |
| Governance | **No execution VTID exists yet for a full cutover.** Every AWS VTID this week is scoped to one service's DR build. |

**Bottom line:** AWS is a real, growing, increasingly-verified hot standby.
It is not yet a safe sole-production target. The gaps below are concrete
and closeable, not hypothetical.

---

## 2. Go/No-Go Checklist

Every item must be checked before an execution VTID for the actual
cutover can reach `spec_status=approved`. This list is deliberately
objective — each item has a clear done/not-done state.

- [x] **DMS replication healthy.** Fixed 2026-07-24. `vitana-autopilot-cdc`
      was stuck `FATAL_ERROR`; `resume-processing` from its stale checkpoint
      hit a *different* failure (`An internal WAL conversational protocol
      error`, likely from the 2-day-old checkpoint's LSN position no
      longer being valid on the source), so a clean restart
      (`start-replication-task-type=start-replication`) was used instead —
      accepts losing the one historical row's update in exchange for
      restored currency. Confirmed stable `running` for 5+ minutes
      post-restart with zero new failure events, both `vitana-autopilot-cdc`
      and `vitana-supabase-to-aurora` `running`. This checklist item is
      about *current* health, not a point-in-time fix — re-verify via
      `aws dms describe-replication-tasks` before actually cutting over,
      don't assume this stays true.
- [x] **DMS alerting exists.** EventBridge rule `vitana-dms-task-failure`
      (source `aws.dms` → SNS topic `vitana-alarms-prod`) created
      2026-07-24; topic now has a confirmed subscriber (see next item) —
      the ~26h silent gap this audit found is no longer repeatable.
- [x] **`vitana-alarms-prod` SNS topic has a real subscriber.** Resolved
      2026-07-24: `j.tadic@exafy.io` (email) confirmed via
      `aws sns list-subscriptions-by-topic`
      (`SubscriptionsConfirmed: 1`).
- [x] **Every alarm can actually reach that subscriber.** Fixed
      2026-07-26 — and this was the *other* half of the same gap.
      Independently of the missing subscriber, **21 of 47 alarms had no
      `AlarmActions` whatsoever**: they would evaluate and change state
      while publishing to nothing, so subscribing an endpoint alone
      would not have made them notify. Affected every alarm created
      during VTID-03398/03409/03410/03411 (`put-metric-alarm` silently
      accepts an alarm with no actions). All 47 now target
      `vitana-alarms-prod` for both `AlarmActions` and `OKActions`;
      verified `MetricAlarms[?length(AlarmActions)==\`0\`]` → `[]`.
- [~] **Google Chat as a second alerting channel** (VTID-03413). The
      user asked for AWS alerts to reuse the Google Chat channel
      already working for health checks, *in addition to* the email
      subscriber above. Code is shipped —
      `POST /api/v1/aws-alerts/sns` bridges SNS → the existing
      `notifyGChat()` webhook with SNS signature verification — but it
      is **not yet delivering**, blocked on two operator actions:
    - [ ] **Chat webhook secret has a value.** Both
          `vitana/google-chat/webhook-url` and `…-url-2` exist as names
          with **zero versions** — no value was ever stored. Wiring one
          into `gateway-awsdr` broke task startup and was rolled back
          (see build log). Needs the real URL stored as a secret
          version, then the task-def change re-applied.
    - [ ] **An HTTPS subscription to the topic** pointing at that
          route. `sns:Subscribe` is denied for this session's IAM user.
    *Email alerting is unaffected by both and works today — this item
    is additive, not a regression risk.*
- [ ] **Every service has a *functional* probe, not just ECS health.**
      Added 2026-07-26 after `vitana-orb-agent` was found `HEALTHY` on
      ECS while running health-endpoint-only and doing no actual work
      (§4.2). `healthStatus: HEALTHY` only means the container's health
      command exited 0. Before cutover, each service needs one check
      that proves it's doing its job — e.g. gateway
      `/api/v1/admin/health` returning `env=production`, worker-runner
      logging a successful registration, oasis-projector logging
      `Database connected`, orb-agent registering a LiveKit worker.
      *(gateway, community-app, oasis-operator, oasis-projector,
      worker-runner and verification-engine were each functionally
      verified when built/fixed; orb-agent is the known failure. This
      item is about re-confirming all of them at cutover time, since
      "was verified once" is not "is working now.")*
- [x] **Frontend gateway-URL decision made** (§4.1) — DECIDED
      2026-07-26: **DNS-first**. Hostnames don't change; cutover
      repoints `gateway.vitanaland.com` + apex to AWS. The existing
      `community-app-awsdr` build already targets
      `gateway.vitanaland.com`, so **no frontend rebuild is needed** —
      this stops being a blocker and becomes a property of the DNS
      sequence in §3.
- [ ] **`oasis-operator-awsdr` burn-in complete** — minimum 72 hours of
      healthy `ACTIVE`/`HEALTHY` status under real (not synthetic-only)
      traffic via the dual-publish path, zero unplanned restarts.
- [ ] **`community-app-awsdr` burn-in complete** — same 72h bar, verified
      via the AWS-PROD-DEPLOY-FRONTEND smoke checks passing on at least
      2 consecutive real deploys.
- [x] **CloudWatch alarms exist for `community-app-awsdr` and
      `oasis-operator-awsdr`** — done 2026-07-24, same 4-alarm pattern as
      `gateway-awsdr` (cpu-high, memory-high, target-5xx, unhealthy-hosts),
      notifying a confirmed subscriber (see SNS-subscriber item above).
- [~] **ALB naming cleanup done or explicitly waived.** *(Partially
      mitigated 2026-07-24: both target groups tagged
      `ActualEnvironment=staging` + a `NamingWarning` explaining they
      actually serve AWS staging traffic despite the `-prod` name — not
      renamed, since target group names are immutable in AWS and a
      rename requires recreating the resource + reattaching the ALB rule,
      which risks a brief traffic blip and wasn't done without asking
      first. **New finding:** both are tagged `ManagedBy=terraform`,
      `Environment=prod`, `Phase=5-compute` — this naming is not a random
      leftover, it's part of some Terraform-managed stack not present in
      this repo (no matching `.tf` files found under `infra/` or
      elsewhere in `vitana-platform`). A proper fix likely needs to go
      through whatever external IaC actually owns these resources, not
      hand-editing via aws-cli.)* Full rename or an explicit sign-off that
      the tag-only mitigation is sufficient still needed before cutover.
- [~] **`orb-agent` / autopilot-job AWS parity** (§4.2) — DECIDED
      2026-07-26: build parity for both. Scoping done; **neither is
      built yet**, and each has a complication:
    - [ ] **`orb-agent`** — ⚠️ an ECS service already exists, reports
          `HEALTHY`, and is **functionally inert** (health-endpoint-only:
          `AGENT_ENABLE_WORKER` and `GATEWAY_SERVICE_TOKEN` both absent).
          Needs config completion, the `http://`→`https://` fix, a
          decision on reaching Vertex AI from AWS, and a deploy that
          stops the old task before the new one registers with LiveKit.
          See §4.2 — this is the clearest example of ECS-green ≠ working.
    - [ ] **autopilot-job** — BLOCKED on an application-design
          decision: it's dispatched by the gateway via the GCP Cloud
          Run Admin API, so AWS parity needs a second dispatch path
          (`aws ecs run-task`) plus a rule for choosing between them.
          See §4.2.
- [x] **`worker-runner` N>1 safety reviewed** — done 2026-07-24, verdict
      CONDITIONALLY SAFE (see §1 table row for detail + code citations).
      Autoscaling has **not** been enabled based on this finding — that
      remains a separate decision, not automatically implied by "reviewed."
- [ ] **Rollback plan rehearsed** — §3 below has been dry-run at least
      once (e.g., against a non-critical hostname) so the revert sequence
      isn't being executed for the first time under pressure.
- [ ] **Execution VTID allocated and spec-approved**, referencing this
      runbook, with an explicit "why now" and a named approver.
- [ ] **Explicit user sign-off obtained** for the specific DNS change
      window — this is the one step that cannot be automated away by any
      checklist.

---

## 3. DNS Repoint Sequence (for the execution VTID to follow)

Two independent hostnames need to move; do not repoint both
simultaneously on a first cutover.

### 3.1 `gateway.vitanaland.com` (canonical API/backend)

1. Confirm `dr-gateway.vitanaland.com` (`vitana-gateway-awsdr`) is
   healthy and has been serving the dual-publish path successfully for
   the burn-in period.
2. **Lower the DNS TTL** on the `gateway.vitanaland.com` A record well
   in advance (recommend ≥24h before the cutover window) so a rollback
   propagates fast if needed. Cloudflare zone `859c786db63e634e0ee36065e8a06e20`.
3. During a low-traffic window, repoint `gateway.vitanaland.com` from
   the GCP anycast IP to the AWS ALB (same target `vitana-alb-prod`
   already used by `dr-gateway.vitanaland.com`, or a dedicated
   CNAME — decide at execution-VTID time based on Cloudflare's handling
   of apex-style A records vs CNAME flattening).
4. Immediately verify: `curl https://gateway.vitanaland.com/api/v1/admin/health`
   returns `env:"production"` with a `cloud_run_service` or ECS-equivalent
   field indicating AWS, not GCP — mirrors the existing Deployment
   Verification Protocol (CLAUDE.md §15) content-type/JSON check.
5. Watch the 39 `vitana-*` CloudWatch alarms and GCP-side monitoring in
   parallel for at least one full traffic cycle (recommend 1h minimum)
   before considering the gateway leg done.

### 3.2 `vitanaland.com` apex (frontend)

1. **Must happen after §3.1**, and only once the frontend's
   gateway-URL open decision (§4.1) is resolved — otherwise the
   AWS-hosted frontend will call a now-repointed-but-unverified backend,
   or a stale build will call the old GCP URL that may still exist as
   `dr-gateway` only.
2. Lower TTL on the apex CNAME the same way as §3.1.
3. Repoint to the AWS ALB target group serving `community-app-awsdr`.
4. Verify the served bundle's baked gateway URL matches the intended
   post-cutover backend (reuse the existing bundle-content assertion
   pattern from `AWS-PROD-DEPLOY-FRONTEND.yml`).
5. Manually load the app, sign in, and exercise one read + one write
   path before declaring this leg done.

---

## 4. Open Decisions (must be resolved by the user, not assumed)

### 4.1 Frontend gateway-URL strategy

Two options, mutually exclusive for a given cutover attempt:

- **(A) DNS-first:** Repoint `gateway.vitanaland.com` to AWS (§3.1)
  before touching the frontend. The existing `community-app-awsdr`
  build already points at `gateway.vitanaland.com`, so once that
  hostname resolves to AWS, the existing frontend build becomes correct
  automatically — no rebuild needed. Simpler, but means the gateway DNS
  cutover has to be irreversible-enough before the frontend cutover can
  even be attempted safely.
- **(B) Rebuild-first:** Redeploy `community-app-awsdr` with
  `gateway_url=https://dr-gateway.vitanaland.com` (the
  `AWS-PROD-DEPLOY-FRONTEND.yml` workflow already supports overriding
  this input), decoupling the frontend from the `gateway.vitanaland.com`
  DNS state entirely. More independent, but means AWS frontend and AWS
  gateway have to be cut over as a coupled pair later anyway if you want
  to retire the `dr-*` naming.

**DECIDED 2026-07-26 — Option (A), DNS-first.** The user confirmed
there is no new AWS production URL: `vitanaland.com` and
`gateway.vitanaland.com` stay exactly as they are, and cutover means
repointing those same hostnames from GCP to the AWS ALB.

Consequence: `community-app-awsdr`'s existing build — which already
bakes `https://gateway.vitanaland.com` — becomes correct automatically
the moment the gateway DNS flips. **No frontend rebuild is required for
cutover**, which removes what was previously listed as a blocker. The
`dr-*` hostnames remain as pre-cutover verification endpoints only.

### 4.2 `orb-agent` / autopilot-job AWS parity

CLAUDE.md §16 IF-THEN rule 24 already treats these two alongside
`worker-runner` as things needing prod updates post-staging-cutover, but
neither has any AWS deploy path today. Options:

- Build AWS-DR parity for both before the platform cutover (extends
  scope, needs its own VTID(s), pushes the timeline out).
- Explicitly decide they stay GCP-only indefinitely, i.e., a full
  cutover is **not** actually "GCP off" but "GCP off except these two
  services" — which changes what "decommission GCP" even means in
  §5 below.

**DECIDED 2026-07-26 — build parity for both. Largely DONE already**,
by parallel work that landed while this section still said "no AWS
deploy path": `AWS-PROD-DEPLOY-ORB-AGENT.yml` (VTID-03414) and
`AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` + the gateway's AWS RunTask
dispatch path (VTID-03415, `JOB_CLOUD` env var selects GCP vs AWS).

⚠️ **Deploy pipeline existing ≠ service working.** That distinction is
the whole point of what follows — for autopilot the parity is real, for
orb-agent it is not:

**`orb-agent`** — ⚠️ **an AWS ECS service already exists and is a
false-green.** `vitana-orb-agent` (task def rev 10) is `ACTIVE`,
`runningCount=1`, and ECS reports `healthStatus: HEALTHY` — but its
logs show it is running in **health-endpoint-only mode**, doing none of
its actual work:

```
{"event": "orb_agent.ready_health_only", ...}
INFO:src.orb_agent.registry_client:registry_heartbeat.disabled
  — GATEWAY_SERVICE_TOKEN not set
```

Config diff against what `DEPLOY-ORB-AGENT.yml` passes on GCP:

| Needed | Present on AWS? |
|---|---|
| `AGENT_ENABLE_WORKER=1` | ❌ **missing — this is why it's health-only** |
| `GATEWAY_SERVICE_TOKEN` | ❌ missing → can't register with the gateway |
| `GOOGLE_CLOUD_PROJECT` / `VERTEX_AI_LOCATION` | ❌ missing |
| `ORB_AGENT_TEXT_ONLY` / `AGENT_LOG_LEVEL` | ❌ missing |
| `LIVEKIT_URL` / `_API_KEY` / `_API_SECRET` | ✅ present (real values) |
| `GATEWAY_URL` | ⚠️ `http://` — same scheme bug fixed under VTID-03408 |

It also carries `DB_HOST`/`DB_READER_HOST`/`REDIS_HOST`/`SUPABASE_*`
that the GCP deployment doesn't pass at all — consistent with the
2026-07-09 bulk-provisioning template rather than a considered config.

**The generalizable warning for cutover:** `healthStatus: HEALTHY` on
ECS means *the container's health command returned 0*, not *the service
is doing its job*. This service would have passed every automated gate
in the cutover checklist while being functionally inert. Any
"AWS is healthy, we're ready" claim needs at least one
service-specific functional probe, not just ECS health.

**Unresolved architectural question:** orb-agent's LLM path is
Vertex AI (Google). Running it on AWS Fargate needs GCP credentials
for Vertex, which the task definition has no provision for. Genuine
cross-cloud parity here is not just env vars — it needs a decision on
how (or whether) Vertex is reached from AWS.

Other caveats:
- Its own `README.md` states it is a **skeleton that does not run a
  real conversation yet** — it's the standby alternative to the Vertex
  Live pipeline (`orb-live.ts`), and exactly one of {vertex, livekit}
  is active via `system_config.voice.active_provider`. Building AWS
  parity ships a correct deployment of a non-functional service.
- **Deploy-shape gotcha:** every warm instance registers itself with
  LiveKit Cloud and receives room dispatches at random. GCP's deploy
  workflow explicitly deletes older revisions for this reason
  (`DEPLOY-ORB-AGENT.yml` lines ~141-170). A default ECS rolling
  update would leave old and new tasks both registered and dispatching
  — the AWS workflow must drain/stop the old task *before* the new one
  registers, not after.

**autopilot-job** — ✅ **DONE (VTID-03415).** It is a Cloud Run *Job*
(`autopilot-executor`, built from `services/gateway/Dockerfile.job`),
deliberately a job rather than a service because its LLM calls run
3-5 min and get killed by Cloud Run service container recycling. There
is no scheduler — the gateway dispatches each execution itself, so AWS
parity genuinely required a gateway code change, not just a workflow.

That change now exists: `dev-autopilot-execute.ts` has
`dispatchExecutorJobAws()` alongside the GCP `dispatchExecutorJob()`,
selected by a **`JOB_CLOUD`** env var (`'aws'` → ECS RunTask, otherwise
GCP Cloud Run Job), with the existing in-process path as fallback when
either dispatch fails. Both write results back through the same
`job-entry.ts` / `applyExecutionResult` route, so caller-side handling
is identical.

Remaining for cutover: set `JOB_CLOUD=aws` on the AWS gateway task
definition (it is not set today, so an AWS-hosted gateway would still
dispatch to GCP), and run the executor once end-to-end on AWS to
confirm — per the functional-probe rule, the dispatch path existing is
not evidence it works.

---

## 5. GCP Decommission Checklist (later phase — do not action yet)

This section is intentionally last and separate: it must not be started
until AWS has run as sole production for an agreed burn-in period
**after** a successful cutover (§3), not as part of the cutover itself.

- [ ] AWS has served 100% of production traffic for ≥7 days with no
      rollback triggered.
- [ ] All GCP Cloud Run services for cut-over components are scaled to
      zero (not deleted) for a further observation window before any
      deletion.
- [ ] Confirm no other GCP-only consumer depends on the services being
      decommissioned (check `orb-agent`/autopilot-job decision from §4.2
      first — if they're staying GCP-only, GCP is not fully decommissioned,
      only partially).
- [ ] Final decision + explicit user sign-off to actually delete (not
      just scale down) GCP resources — this is a distinct, later action
      from the traffic cutover and should get its own VTID.

---

## 6. Rollback Plan

- **Trigger conditions:** elevated 5xx rate on the ALB, DMS replication
  lag/failure post-cutover, any `vitana-*` CloudWatch alarm firing within
  the first hour, or a manual call by whoever owns the cutover window.
- **Mechanism:** revert the DNS record(s) changed in §3 back to their
  pre-cutover GCP targets. This is why TTL is lowered *before* the
  cutover window (§3.1 step 2, §3.2 step 2) — a same-TTL-as-normal
  record can take hours to fully propagate a revert.
- **GCP must stay warm.** Per §5, GCP services are not touched (scaled
  down or deleted) until well after a successful, un-rolled-back cutover
  — so a rollback is always "repoint DNS back," never "redeploy GCP from
  scratch under pressure."
- **Post-rollback:** any writes that landed on Aurora during the AWS
  window need reconciliation back through the DMS pipeline direction
  Supabase already uses, or a manual diff — this needs to be spelled out
  precisely by whoever runs the execution VTID, informed by how long the
  AWS window actually lasted.

---

## 7. Relationship to other VTIDs

| VTID | What it built | Relationship to this runbook |
|---|---|---|
| VTID-03398 | gateway AWS-DR | Prerequisite infra — done |
| VTID-03407 | Command Hub dual-publish | Prerequisite infra — done |
| VTID-03408 | Mystery-service investigation + 3 bug fixes | Informs §1 current-state |
| VTID-03409 | community-app AWS-DR | Prerequisite infra — done, but see §4.1 open decision |
| VTID-03410 | oasis-operator AWS-DR | Prerequisite infra — done, but see §2 burn-in checklist item |
| VTID-03411 | Backend services hardening | Prerequisite infra — done |
| VTID-03412 | **This runbook** | Governance artifact — does not execute anything |
| *(not yet allocated)* | Actual cutover execution | Must reference this runbook, gated on §2 checklist |
