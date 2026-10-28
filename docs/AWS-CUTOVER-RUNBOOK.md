# GCP → AWS Full Production Cutover Runbook

**VTID:** VTID-03412
**Status:** Living document — governance artifact, not an execution authorization.
**Last updated:** 2026-07-29 (§1 DNS row + §3 EXECUTION RECORD corrected to
reflect VTID-03419's completed gateway+frontend cutover — the file had
drifted out of sync with reality after that execution)

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

> **Draft spec for that execution VTID:**
> `docs/vtids/VTID-PENDING-GCP-FULL-CUTOVER-SPEC.md` (drafted 2026-07-31,
> at user request, investigation/documentation only). It is a draft, not
> an allocated VTID — no ledger row exists and `spec_status` is not
> `approved`. It exists so review and allocation can happen quickly once
> someone with sign-off authority decides to proceed. Its preconditions
> mirror this runbook's §2 checklist plus what the 2026-07-31 investigation
> found (the `exafyltd/vitana-infra` reconciliation gap, the reopened DMS
> item, and several GCP-only dependencies — Cloud Scheduler, the fine-tune
> pipeline, ORB voice's Vertex/TTS dependencies — not previously tracked
> anywhere in this runbook).
>
> **Readiness-testing pass, 2026-08-03:**
> `docs/AWS-CUTOVER-READINESS-FINDINGS-2026-08-03.md`. Explains the DMS
> 154k-vs-809 discrepancy (§2's reopened item — arithmetic resolved, item
> still open, and it establishes that row-count reconciliation is the
> wrong go/no-go test for this database) and establishes empirically that
> **Nova Sonic has been live in production ORB voice continuously since
> 2026-07-27**, at 15–33% of sessions, with an error-rate regression in
> the 48h to 2026-08-03. That pass had **no working AWS credentials**
> (`AWS_ACCESS_KEY_ID` was the literal placeholder `proxy-injected`), so
> the ECS inventory, ALB/alarm/target-group checks, `terraform plan`, and
> the Nova canary allowlist itself all remain unrun and unverified.
   customer-facing production hostnames.

---

## 1. Current-state summary (as of 2026-07-23)

Sourced from `docs/AWS-PRODUCTION-BUILD-LOG.md` and a live read-only AWS
CLI + Cloudflare DNS audit performed under this VTID.

| Area | State |
|---|---|
| DNS | **Moved for 2 hostnames.** As of **VTID-03419** (executed 2026-07-27), `gateway.vitanaland.com` and the `vitanaland.com` apex (+`www`) both resolve live to AWS (`vitana-alb-prod`) — see §3's EXECUTION RECORD blocks for the exact sequence. This was a deliberately narrow cutover of these two hostnames only; it did **not** touch Aurora-dependent services, `oasis-projector`, `orb-agent`, `autopilot-cdc`, or decommission GCP (GCP remains fully running as the standing rollback target — see VTID-03419's own out-of-scope list, mirrored in §3). Everything else in this table (oasis-operator burn-in, mystery services, DB sync divergence, full GCP decommission) is still open and still gated on this runbook's §2 checklist + a separate, larger execution VTID. |
| gateway | AWS-DR built (VTID-03398), autoscaled, alarmed, dual-publish wired. Healthy. |
| community-app | AWS-DR built (VTID-03409). **Bakes the GCP `gateway.vitanaland.com` URL into its static Vite bundle at build time, by design** — it was built as a same-backend hot-standby, not a fully independent stack. Will break if GCP disappears without either repointing `gateway.vitanaland.com` to AWS or rebuilding against `dr-gateway.vitanaland.com`. See open decision §4.1. |
| oasis-operator | AWS-DR built (VTID-03410) from a 9-month-old dead backup (`main.py.backup-20251101-111126`) with zero prior AWS production traffic history. No burn-in yet. |
| oasis-projector / worker-runner / verification-engine | Bug-fixed + ECS health-checked + alarmed (VTID-03411). Deliberately **not** autoscaled or made public — `oasis-projector`'s ledger writer has no cross-instance locking (CLAUDE.md: "Never run parallel VTID executions"). **`worker-runner` has since been reviewed (2026-07-24) and found CONDITIONALLY SAFE for N>1**: its claim mechanism is a genuine server-side compare-and-swap (`SELECT ... FOR UPDATE` + conditional `UPDATE` inside one Postgres transaction, `claim_vtid_task` RPC in `supabase/migrations/20260413000000_fix_claim_accepts_scheduled.sql`), not a client-side read-then-write race, and no other shared mutable state exists between instances. The one real N>1-specific risk: an idle sibling instance will legitimately re-claim a VTID whose 60-minute claim lease expired due to sustained heartbeat failure on the active instance, causing double execution — condition for safety is that heartbeats reliably survive transient network hiccups; recommend alerting on sustained heartbeat failure before actually enabling autoscaling. Autoscaling itself has **not** been enabled — this is a documentation finding only, pending a decision on whether to act on it. |
| orb-agent | Deploy path **now exists** — `AWS-PROD-DEPLOY-ORB-AGENT.yml` (VTID-03414). But the running ECS service `vitana-orb-agent` is a **false-green**: reports `healthStatus: HEALTHY` while running health-endpoint-only, because `AGENT_ENABLE_WORKER` and `GATEWAY_SERVICE_TOKEN` are absent from its task definition. The workflow swaps *image only* and carries env/secrets forward, so **deploying through it will faithfully redeploy a still-inert service**. See §4.2. |
| autopilot job | Parity **now exists** — `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` plus a real AWS RunTask dispatch path in the gateway (`dev-autopilot-execute.ts`, VTID-03415). `JOB_CLOUD=aws\|gcp` selects the target per gateway instance, with in-process fallback if dispatch fails. This closes what was previously flagged as needing an undecided application-design change. |
| Database sync | RDS Aurora `vitana-aurora-prod` via DMS task `vitana-supabase-to-aurora` (full-load-and-cdc): 495/495 tables under live CDC from the same Supabase project GCP prod uses. `autopilot_recommendations`'s dedicated CDC task (`vitana-autopilot-cdc`), which was `FATAL_ERROR` for ~26h, was fixed 2026-07-24 via a clean restart — both tasks confirmed `running`. **Note:** the specific update that was stuck at the time of the original failure did not replicate (the fix restarts CDC capture from "now", not from the stale position) — a one-row historical drift, not an ongoing gap. **Superseding finding (2026-07-27, VTID-03419): `vitana-supabase-to-aurora` was separately measured silently dropping ~154k row applies** — a much larger, distinct problem from the one-row gap above, and the explicit reason Aurora-dependent services stayed excluded from that cutover. Not yet root-caused as of 2026-07-31 — see the reopened §2 checklist item. Aurora is **not** a valid source of truth for any service beyond DR until this is resolved. **Further update (2026-08-10, VTID-03517): DMS replication has been fully dead since 2026-07-27** — `vitana-supabase-to-aurora` stopped, its successor `vitana-supabase-to-aurora-v3` hit `FATAL_ERROR` after 7 recovery attempts. There is no CDC task running at all; Aurora has received nothing from Supabase for roughly two weeks. See `scripts/db-i18n/seed-aurora.sh`'s PR description for the full finding. |
| Secrets | `vitana/supabase/prod/*` (4 secrets) current as of 2026-07-14/21; RDS-managed master credential rotates automatically. |
| Alarms | 47 `vitana-*` CloudWatch alarms, all `OK`/`INSUFFICIENT_DATA`. `community-app-awsdr` and `oasis-operator-awsdr` now have the same 4-alarm set (cpu-high, memory-high, target-5xx, unhealthy-hosts) gateway-awsdr already had — closed 2026-07-24. A `vitana-dms-task-failure` EventBridge rule (source `aws.dms` → SNS topic `vitana-alarms-prod`) was also added the same day so a future DMS task failure isn't silent for 26+ hours again like `vitana-autopilot-cdc` was. **Resolved 2026-07-24: `vitana-alarms-prod` now has a confirmed subscriber** — `j.tadic@exafy.io` (email), confirmed via `aws sns list-subscriptions-by-topic` (`SubscriptionsConfirmed: 1`). All 47 alarms and the DMS-failure rule now notify a real endpoint. User explicitly confirmed single-email alerting is sufficient to close this item — no Slack/PagerDuty channel requested. |
| ALB naming | `vitana-tg-gateway-prod` / `vitana-tg-community-prod` **actually serve AWS staging traffic**, not prod — confirmed live via `/api/v1/admin/health` returning `env:"staging"` through those target groups. **Resolved 2026-07-31: the owning Terraform state was found** — `exafyltd/vitana-infra` (private repo, TMC migration team's handover, not previously cross-referenced from this repo). `terraform/phase5-compute/alb.tf` creates the ALB + both target groups; that repo's own README documents the naming drift as deliberate (`phase5` applied with `environment="prod"`, `phase4-ecs` with `"staging"`, staging wired to the "prod"-named TGs as a 2026-07-16/17 outage fix; renaming would recreate the ALB/TGs so it stays until a planned window). **New finding, more urgent than the naming itself: that repo's README says "DO NOT terraform apply YET"** — the checked-in state is stale vs. live infra and applying it would revert the ECS↔ALB attachments, the gateway health-check path, and live task-def env vars (`SUPABASE_JWT_SECRET` included). `phase8-data-prod` (Aurora prod) additionally shows "11 add, no state" as of the last recorded plan (2026-07-20) — never reconciled against live Aurora at all. Anyone touching AWS infra for cutover work must reconcile `vitana-infra`'s state first, the same way phase4/phase5 already were — this is a live landmine, not a paperwork gap. |
| Legacy/mystery services | ~22 of the 29 (now 31) ECS services in `Vitana-ECS-Cluster` from the 2026-07-09 bulk-provisioning event remain unexplained — flagged, not investigated. Out of scope for cutover unless one turns out to be load-bearing. **Partially resolved 2026-07-31**: `vitana-infra/terraform/phase4-ecs/variables.tf` defines all 28 intended services — this is the TMC handover's planned architecture, not an unowned event. Cross-checked against this repo's `services/` tree: 6 (`conductor`, `validator-core`, `mcp-gateway`, `cognee-extractor`, `memory-indexer`, `orb-agent`) have real source here but are marked "non-deployable, in-process" in CLAUDE.md §2 — worth confirming whether AWS actually runs them as independent services (a real behavioral difference, not just naming). The other ~14 (`worker-core`, `planner-core`, `crewai-prompt-synth`, `qa-agent`, `auth-proxy`, `cloudshell-relay`, `dev-console-ui`, etc.) have no corresponding source anywhere in this repo — likely TMC-internal tooling or unbuilt placeholders. Still needs live AWS confirmation of which have actual running tasks (`desiredCount > 0`) before ruling out load-bearing risk entirely — this session had no live AWS credentials to check. |
| Cutover/rollback docs | **Did not exist before this VTID.** No DNS-repoint runbook, no rollback/TTL plan, no GCP decommission checklist. |
| Governance | **No execution VTID exists yet for the *full* cutover** (all services, GCP decommission). VTID-03419 executed a narrower, explicitly-scoped DNS repoint for gateway + frontend only, gated by its own approved spec — see §3 EXECUTION RECORD. Every other AWS VTID remains scoped to one service's DR build, not traffic movement. |

**Bottom line:** Gateway + frontend are live on AWS today (VTID-03419) —
that part is no longer hypothetical, it's the current production
architecture for those two hostnames. Everything else — Aurora as a
valid failover target, oasis-projector/orb-agent/autopilot parity, the
mystery services, and GCP decommission — is still open, still concrete,
and still closeable, not hypothetical either.

---

## 2. Go/No-Go Checklist

Every item must be checked before an execution VTID for the actual
cutover can reach `spec_status=approved`. This list is deliberately
objective — each item has a clear done/not-done state.

- [ ] **DMS replication healthy — REOPENED 2026-07-31.** Was marked `[x]`
      fixed 2026-07-24 (see original note below), but VTID-03419's own
      changelog entry (2026-07-27, 3 days later) found `vitana-supabase-to-aurora`
      silently dropping **~154k row applies** — the explicit, stated reason
      every Aurora-dependent service was excluded from that cutover. That is
      a categorically different, much larger problem than the one-row gap
      the 2026-07-24 fix addressed, and it was never reflected back into
      this checklist. **This item is not done; treat it as blocking until
      root-caused.** No IaC covers the DMS task (not part of
      `exafyltd/vitana-infra` — it was set up out-of-band via console/CLI),
      and requires live DMS access to diagnose: run
      `aws dms describe-table-statistics --replication-task-arn <arn>` for
      per-table applied/failed counts, and check CloudWatch DMS metrics /
      task logs for the actual failure pattern behind the 154k figure.
      **Update 2026-08-03 — the 154k vs 809 arithmetic is explained; the
      item stays open.** See `docs/AWS-CUTOVER-READINESS-FINDINGS-2026-08-03.md`
      §1. Short version: 154k is a *cumulative lifetime change-event*
      counter and 809 is a *point-in-time row-count delta* — a flow and a
      stock, not two readings of one quantity, so they were never in
      conflict and the 809-row fix was never going to move the 154k.
      Measured on the live source DB, the platform is dominated by tiny
      high-churn state tables (`autopilot_loop_state`: **1 row, 60,464
      lifetime updates**; `admin_insights`: 393 rows / 295,168 updates;
      `thread_presence`: 45 / 185,775) — six such tables exceed 154k on
      their own, and dropping *every* apply to them would show a row-count
      difference of **zero**. The user's 809 is corroborated exactly
      against the source (5 `watcher_*` tables = 618 rows; 618 + 191 = 809).
      **Two reasons this does not close the item:** (a) confirming the
      drops actually sit on those high-churn tables still needs
      `describe-table-statistics` — if they sit on low-churn business
      tables instead, the explanation collapses and this is a real gap;
      (b) more importantly, **row-count reconciliation is the wrong test
      for this database** — `admin_insights` could hold entirely stale
      content in all 393 rows and still "match". The go/no-go check must be
      content-based (per-row checksum, or at minimum per-table
      `max(updated_at)` skew), not `count(*)`. That generalizes the
      vector-column concern to every low-row/high-update table.
      *Original 2026-07-24 note, now superseded by the above:* `vitana-autopilot-cdc`
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

> **EXECUTION RECORD — VTID-03419, 2026-07-27 (live):**
>
> - **Gateway leg: DONE, verified externally.** ~13:38 UTC:
>   `gateway.vitanaland.com` A `34.111.235.0` → CNAME
>   `vitana-alb-prod-1579322953.eu-central-1.elb.amazonaws.com`
>   (DNS-only). Pre-flight added the REQUIRED ALB host rules at
>   priority 3 (`gateway.vitanaland.com` → `vitana-tg-gateway-awsdr`)
>   and 4 (apex+`www` → `vitana-tg-community-awsdr`) — without these,
>   flipped traffic silently lands on **staging** via the path rules at
>   priority 10. Verified AWS-served via an external fetch:
>   `cloud_run_service: null` + `booted_at` matching the ECS task
>   (both clouds report `env=production`, so that field alone proves
>   nothing; a sandbox egress proxy also cached the old A record for
>   30+ min — use an external vantage).
> - **Frontend version-skew guard:** AWS build was 4 days behind GCP
>   live; `AWS-PROD-DEPLOY-FRONTEND.yml` (run 30273712730) rebuilt from
>   `main` @ fc9bc0f → bundle `index-CqFaw389.js`, verified on
>   `dr-app` **before** touching apex DNS.
> - **Apex leg: DNS changed 14:14:52Z, BLOCKED at the Cloudflare edge.**
>   Apex+`www` records verified pointing at the ALB, yet the edge kept
>   serving the GCP origin 15+ min later. Control experiment: a fresh
>   proxied record to the same ALB served through Cloudflare in ~20 s
>   (hit the ALB default rule → staging JSON, as the rule table
>   predicts). Fresh record = instant, edited records = pinned ⇒ a
>   zone-level **origin override** (Origin Rule / Page Rule / Worker
>   route) from the original Cloud Run setup pins apex+`www` to
>   `community-app-…run.app`. The session's API token is DNS-scoped
>   (rulesets/pagerules/workers reads all return auth errors), so
>   removing it needs the dashboard or a `Zone → Rulesets` token.
> - **User impact during the block: none** — visitors get the same GCP
>   frontend as before, now calling the AWS-served gateway. Consistent
>   hybrid state.
> - Rollback values unchanged (see §6); GCP untouched and serving.
>
> **COMPLETION (2026-07-27, ~15:0x UTC): BOTH LEGS LIVE ON AWS.** The apex
> "pinned origin" was neither DNS nor an Origin Rule: Cloudflare Worker
> routes `vitanaland.com/*` + `www.vitanaland.com/*` → Worker
> **`vitanaland-proxy`** (source in NO repo — dashboard-deployed), a bare
> reverse proxy hard-coding `https://community-app-q74ibpv6ia-uc.a.run.app`.
> **The apex never followed DNS, even on GCP.** Fix: user updated the
> Worker's origin to `https://dr-app.vitanaland.com` (same-zone, no Worker
> route → no loop; ALB cert valid) and deployed. Flip was instant.
>
> **Apex rollback is therefore a Worker edit, not a DNS revert:** set
> ORIGIN/ORIGIN_HOST back to `community-app-q74ibpv6ia-uc.a.run.app` in
> the `vitanaland-proxy` Worker and Deploy (~30 s). The DNS records for
> apex/`www` are currently cosmetic while those Worker routes exist.
>
> Post-cutover verification (all through AWS): gateway `env=production`
> with `cloud_run_service:null` from an external vantage; frontend serving
> `index-CqFaw389.js` (fresh `main` build); authenticated READ
> (notifications 200) and WRITE (mark-read 200) as the e2e test user; ORB
> WebSocket `101` + `connected` session frame via `/api/v1/orb/live/ws`
> (**probe must force `--http1.1`** — an h2 probe degrades to GET and
> 404s, which is a probe artifact, not a fault); 60-min alarm watch armed.
> Known-firing alarm: `vitana-oasis-projector-running-count-low`
> (deliberate desiredCount=0; DisableAlarmActions denied to this session).
>
> Follow-ups this surfaced: `vitanaland-og-proxy` Worker (subpaths
> `/shorts|profiles|events|products/*`) still hard-codes the **GCP
> gateway** raw URL for OG-tag fetches — works while GCP lives, must be
> repointed before any GCP shutdown. `vitanaland-proxy` source should be
> brought into the repo. Cloudflare rules/workers tokens used today should
> be revoked.

Two independent hostnames need to move; do not repoint both
simultaneously on a first cutover.

### 3.1 `gateway.vitanaland.com` (canonical API/backend)

1. Confirm `dr-gateway.vitanaland.com` (`vitana-gateway-awsdr`) is
   healthy and has been serving the dual-publish path successfully for
   the burn-in period.
2. ~~Lower the DNS TTL ≥24h in advance.~~ **Not required — verified
   2026-07-26.** Every record in Cloudflare zone
   `859c786db63e634e0ee36065e8a06e20` is already at `ttl=1`
   (Cloudflare "Automatic" = 300s for DNS-only records; irrelevant for
   proxied ones, which change at the edge near-instantly). **This
   removes what was the single longest lead-time prerequisite in this
   runbook** — no 24h pre-stage is needed, and rollback propagates in
   ≤5 min worst case.

   Live record state:

   | Record | Type | Proxied? | Currently points to |
   |---|---|---|---|
   | `gateway.vitanaland.com` | **A** | **DNS-only** | `34.111.235.0` (GCP) |
   | `vitanaland.com` (apex) | CNAME | proxied | `community-app-…run.app` (GCP) |
   | `www.vitanaland.com` | CNAME | proxied | `community-app-…run.app` (GCP) |

3. During a low-traffic window, repoint `gateway.vitanaland.com` to the
   AWS ALB. **Note the record-type change:** it is currently an **A**
   record to a GCP anycast IP, but an ALB has no static IP — so this
   becomes a **CNAME** to
   `vitana-alb-prod-1579322953.eu-central-1.elb.amazonaws.com` (the
   same target `dr-gateway.vitanaland.com` already uses). CNAME is
   valid here because `gateway` is a subdomain, not the apex.
   Sub-decision at execution time: leave it **DNS-only** (direct TLS to
   the ALB's existing `*.vitanaland.com` ACM cert — closest to today's
   behavior) or switch to **proxied** (Cloudflare terminates TLS; also
   fine, and makes rollback instant). DNS-only is the smaller change.
   Either way the ALB cert already covers the hostname, so no new
   certificate is needed.
4. Immediately verify: `curl https://gateway.vitanaland.com/api/v1/admin/health`
   returns `env:"production"` with a `cloud_run_service` or ECS-equivalent
   field indicating AWS, not GCP — mirrors the existing Deployment
   Verification Protocol (CLAUDE.md §15) content-type/JSON check.
5. Watch the 39 `vitana-*` CloudWatch alarms and GCP-side monitoring in
   parallel for at least one full traffic cycle (recommend 1h minimum)
   before considering the gateway leg done.

> **EXECUTION RECORD (VTID-03419, 2026-07-27):**
> - Pre-flight: added ALB host-header rules on `vitana-alb-prod` at
>   priority 3 (`gateway.vitanaland.com` → `vitana-tg-gateway-awsdr`) —
>   below the existing path-based `/api/*`/`/ws/*` rules at priority 10,
>   which otherwise match first regardless of `Host` and would have
>   silently routed to AWS **staging**.
> - Pre-change value captured: `gateway.vitanaland.com` was an **A**
>   record → `34.111.235.0` (GCP anycast), DNS-only, Cloudflare zone
>   `859c786db63e634e0ee36065e8a06e20`.
> - Changed to a **CNAME** (record-type change — an ALB has no static
>   IP) → `vitana-alb-prod-1579322953.eu-central-1.elb.amazonaws.com`,
>   DNS-only (not proxied). Automatic TTL, so this was live within
>   minutes.
> - Verified functionally, not by status field: `/api/v1/admin/health`
>   returning `env:"production"` was not sufficient on its own (both
>   clouds report `production`) — confirmed via external vantage
>   (`cloud_run_service:null` + boot timestamp matching the ECS task,
>   i.e. absence of Cloud-Run-specific fields rather than presence of
>   AWS-specific ones), an authenticated read **and** write, and a
>   forced-HTTP/1.1 WebSocket handshake (HTTP/2 strips the `Upgrade`
>   header, which degrades to a false-failing plain GET).
> - Gateway leg confirmed live ~13:38Z. 60-minute post-cutover alarm
>   watch: clean, zero new `vitana-*` alarms.
> - Rollback (never invoked): revert to the A record above — must be
>   recreated as an **A** record, not a CNAME edit of the same name.

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

> **EXECUTION RECORD (VTID-03419, 2026-07-27):**
> - Version-skew guard caught a real problem before the flip: the AWS
>   frontend build was 4 days stale (`index-C0lN9CoO` vs GCP's live
>   `index-C7igpqcB`). Rebuilt from `main@fc9bc0f9` first
>   (`index-CqFaw389`) rather than flip apex traffic to a stale build.
> - Pre-change value captured: apex + `www` were CNAME →
>   `community-app-q74ibpv6ia-uc.a.run.app`, **proxied** (orange-cloud)
>   through Cloudflare.
> - Changed to CNAME → the same `vitana-alb-prod` ALB, kept **proxied**.
> - **Found mid-cutover, not anticipated by this runbook:** a
>   Cloudflare Worker (`vitanaland-proxy`, dashboard-managed, not in any
>   repo) has route rules on `vitanaland.com/*` + `www.vitanaland.com/*`
>   that override DNS entirely — Worker routes match before the DNS
>   record is ever consulted. Its origin was hard-coded to the GCP
>   Cloud Run URL, so the DNS change alone had **no effect**; apex
>   traffic stayed on GCP until the Worker's own `ORIGIN` constant was
>   patched to `https://dr-app.vitanaland.com`. This is the actual
>   reason the apex leg does not complete atomically with the DNS
>   change — record that anywhere else in the org that assumes a
>   Cloudflare DNS edit alone controls `vitanaland.com/*` traffic.
> - Verified: authenticated read + write, both viewports, plus the same
>   external-vantage fingerprint check used for the gateway leg.
> - Rollback (never invoked): apex leg — CNAME back to
>   `community-app-q74ibpv6ia-uc.a.run.app`; **or**, since the Worker is
>   what actually controls routing, reverting the Worker's `ORIGIN`
>   constant back to the Cloud Run URL is the effective/faster rollback
>   regardless of what DNS says.

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
  pre-cutover GCP targets. **Verified 2026-07-26:** every zone record is
  already at Cloudflare "Automatic" TTL, so a revert propagates in
  ≤5 min for the DNS-only `gateway` record and near-instantly for the
  proxied apex/`www` records. No TTL pre-staging is required, and there
  is no multi-hour propagation tail to plan around.
  *(Record the exact pre-cutover values before changing anything —
  `gateway.vitanaland.com` A → `34.111.235.0`; apex and `www` CNAME →
  `community-app-q74ibpv6ia-uc.a.run.app` — since reverting a
  type-changed record means restoring an A record, not just editing a
  CNAME target.)*
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
| VTID-03419 | Actual cutover execution (gateway + apex DNS) | Executed 2026-07-27 — see §3's EXECUTION RECORD blocks |
| VTID-03420 | AWS staging→prod publish path | Post-cutover follow-up: the Command Hub PUBLISH button promotes AWS staging (`vitana-gateway`) → AWS prod (`vitana-gateway-awsdr`) by exact-image promotion when `PUBLISH_TARGET_CLOUD=aws`; `AWS-PROD-DEPLOY-GATEWAY.yml` gained `promote-staging` (default) vs `rebuild-main` modes with an `expected_commit` pin. Closes the gap where the only AWS-prod path was a manual dispatch that rebuilt `main` HEAD — reported live 2026-07-28 (PUBLISH popover showed "Could not load: staging 500" on the ECS-served gateway, and AWS staging/prod had already drifted 0c72cfc vs 53cfb71). |
