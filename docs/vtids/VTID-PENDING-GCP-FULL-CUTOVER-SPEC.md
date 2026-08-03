# VTID: PENDING ALLOCATION — DRAFT SPEC, NOT AN ISSUED VTID
# Title: Full operational cutover from GCP to AWS (staging + production, all services)
# Status: draft — awaiting review and explicit sign-off before allocation
# Drafted: 2026-07-31
# Drafted By: Claude (at user request — investigation/documentation only, no execution)
# References: docs/AWS-CUTOVER-RUNBOOK.md (VTID-03412), CLAUDE.md §1b

---

## ⚠️ Governance status of this document

**This is a draft spec, not an allocated VTID.** No `VTID-XXXXX` number has
been assigned, no ledger row exists, and `spec_status` is not `approved`.
Per `CLAUDE.md` Never-rule 1 and the cutover runbook's own framing:

> "Full production cutover (GCP→AWS) is a separate, larger action from any
> per-service DR build above — never assume it's authorized by this
> section... That document does not itself authorize a cutover."

This spec exists so a real VTID can be allocated and reviewed quickly once
someone with the authority to sign off decides to proceed — allocating it,
approving it, and scheduling the actual cutover window are all separate,
later, human decisions. Nothing in this document executes anything.

**Per `CLAUDE.md` §4.1 (self-service VTID allocation, VTID-03448):** ordinary
tasks get a VTID self-allocated immediately and unconditionally. This VTID
is the documented exception — the runbook (§0) requires it to reach
`spec_status=approved` only after (a) every item in the Go/No-Go Checklist
is true, and (b) explicit user sign-off, before any DNS or traffic-routing
change executes. Self-allocating it prematurely would not skip that gate —
`spec_status` would still sit at `draft`/`pending_approval` until both
conditions are met — but the runbook asks for the sign-off conversation to
happen first, so allocation is left to whoever has that conversation.

---

## 🎯 OBJECTIVE

Move Vitana's **active operational dependency** — staging and production
traffic, deploys, and every service's live provider selection — from GCP
(`lovable-vitana-vers1`) to AWS (`472838866351`/`eu-central-1`) for every
service in `CLAUDE.md` §1b's table, plus the services this investigation
found are not yet in that table (`openclaw-bridge`, the Cloud Scheduler
automations, the fine-tune training pipeline).

**This is explicitly NOT the runbook's §5 "GCP Decommission" phase.** Per
the user's own framing: GCP must remain intact and re-activatable — this
VTID's desired outcome is "AWS is what we rely on," not "GCP no longer
exists." Decommission (deleting GCP resources) is out of scope and would
need its own later VTID, gated on the runbook's separate §5 checklist and
a sustained trial period.

---

## 📋 SCOPE

### In scope
- Every service in `CLAUDE.md` §1b's table reaching AWS-sole-production the
  way gateway + community-app already did under VTID-03419: `oasis-operator`,
  `oasis-projector`, `worker-runner`, `verification-engine`, `orb-agent`,
  `autopilot-executor`.
- Aurora becoming a trustworthy primary datastore (not just DR) for every
  service that needs it.
- Every GCP-only control-plane dependency (Cloud Scheduler, Vertex AI as
  default LLM/TTS provider, the fine-tune pipeline) gaining a working AWS
  path or an explicit, written exception.
- `openclaw-bridge` gaining real AWS deploy coverage and appearing in
  `CLAUDE.md`'s tracked tables.
- `exafyltd/vitana-infra` reconciled so its checked-in Terraform state
  matches live infra (it currently does not — see Non-Goals and
  Preconditions).
- **Decided 2026-08-01, at explicit user request — the AI/voice provider
  question is no longer "migrate or accept an exception," it's a
  concrete build:**
  - ORB voice: promote **Amazon Nova Sonic** out of canary for all
    active languages/tenants (replaces Vertex Live entirely — no GCP
    fallback retained).
  - TTS: replace Google Cloud TTS with **Amazon Polly** across all 4
    call sites.
  - Non-voice text AI (recommendations, fact extraction, session
    summaries): default to **Claude via the Bedrock adapter**.
  - Vision + forced tool-calling features (e.g. Shorts auto-metadata,
    `anthropic-vision-client.ts`): **extend the Bedrock adapter**
    (`services/gateway/src/providers/bedrock.ts`) to support `images`
    and `tools`/`forceTool` before migrating these specific stages —
    real engineering, not a config flip.
  - Cover-image generation (`cover-image-outpaint.ts`, Vertex Imagen):
    Claude has no image-generation capability at all, so this needed
    its own answer — replace with **Amazon Titan Image Generator via
    Bedrock** (a new, separate adapter from the Claude one).

### Non-goals (explicit exclusions)
- **GCP resource deletion or decommission.** GCP stays running, dormant,
  and re-activatable — this is a trial ("rely on AWS for August"), not a
  migration off GCP permanently. The runbook's §5 checklist and its own
  execution VTID remain the gate for that later, separate decision.
- **`terraform apply` against `exafyltd/vitana-infra` as currently
  checked in.** That repo's own README says "DO NOT terraform apply YET" —
  its state is stale vs. live infra. Reconciling it is a precondition of
  this VTID (see below), not something this VTID does by running `apply`.
- **Extending AWS-DR to any service not already named in scope above**
  without its own new VTID, per `CLAUDE.md`'s standing rule.
- **Flipping AI/voice provider defaults before their replacement is built
  and validated at parity.** Decided 2026-08-01: Nova Sonic (voice),
  Polly (TTS), Bedrock/Claude (text AI), Bedrock/Titan Image Generator
  (cover-image generation), with the Bedrock adapter's vision/tool-calling
  gap closed first for the features that need it. This VTID's precondition
  4 tracks that build; this VTID itself does not flip any routing default
  until each replacement is validated.
- **Autoscaling `oasis-projector`, `worker-runner`, or
  `verification-engine`** beyond what's already running, absent the
  concurrency-safety review `CLAUDE.md`'s hard rules already require.

---

## 🔒 PRECONDITIONS (must all be true before `spec_status` can move to `approved`)

These map directly to `docs/AWS-CUTOVER-RUNBOOK.md` §2's Go/No-Go
Checklist, plus what this investigation (2026-07-31) added to it:

1. **Aurora DMS row-drop root-caused.** The runbook's §2 "DMS replication
   healthy" item was reopened 2026-07-31 after discovering it had been
   marked done for an unrelated, smaller 2026-07-24 fix while a separate,
   much larger ~154k-row-drop finding from VTID-03419 (2026-07-27) was
   never reflected back into it. Needs live DMS access this investigation
   did not have.
2. **`oasis-projector` concurrency-safety decision.** Either implement
   real cross-instance locking in the Ledger Writer, or get an explicit,
   written risk-acceptance from the user to keep it single-instance
   permanently.
3. **ORB voice: Nova Sonic promoted out of canary.** Decided 2026-08-01 —
   Amazon Nova Sonic (AWS-native, `services/gateway/src/orb/live/upstream/
   nova-sonic-config.ts`) replaces Vertex Live entirely, not just as a
   fallback. Currently canary-only, gated to 4 languages and an identity
   allowlist. Must be validated at parity and promoted for every active
   language/tenant — no GCP voice-LLM path retained after this closes.
4. **TTS: Google Cloud TTS replaced with Amazon Polly.** Decided
   2026-08-01. Wired independently into 4 files (`orb-live.ts`,
   `reminder-tts.ts`, `greeting-bridge-tts.ts`, `voice-config.ts`) —
   all 4 call sites need to move to Polly, validated for voice quality
   and latency parity before cutover.
5. **Non-voice AI: default to Claude via the Bedrock adapter.** Decided
   2026-08-01. Of the 18 files currently defaulting to Vertex
   (recommendations, fact extraction, session summaries, cover-image
   generation), split into three tracks:
   - Plain-text stages → Bedrock/Claude directly, no adapter changes needed.
   - Vision + forced tool-calling stages (e.g. `anthropic-vision-client.ts`'s
     Shorts auto-metadata) → blocked on precondition 5a below.
   - Cover-image generation (`cover-image-outpaint.ts`, currently Vertex
     Imagen) → blocked on precondition 5b below; Claude cannot do this,
     it needs a different Bedrock model entirely.
5a. **Extend the Bedrock adapter for vision + tool-calling.**
    `services/gateway/src/providers/bedrock.ts` currently errors on
    `images`/`tools`/`forceTool` (`CLAUDE.md` §2b). This is real
    engineering — add real support, verify against at least the Shorts
    auto-metadata use case, before migrating any vision/tool-calling
    stage off its current provider.
5b. **Build a Bedrock Titan Image Generator adapter for cover-image
    outpainting.** Separate from the Claude/Bedrock text adapter — a new
    adapter class for Amazon Titan Image Generator, wired into
    `cover-image-outpaint.ts` in place of the Vertex Imagen call. Validate
    output quality against the existing Imagen outpaint results before
    cutover; the code's existing letterbox-blur fallback remains the
    safety net if Titan's output quality doesn't hold up.
6. **AWS equivalent for Cloud Scheduler.** Autopilot cron automations and
   the daily feature-tip job currently only exist as `gcloud scheduler
   jobs create` — no EventBridge Scheduler equivalent exists yet. Without
   this, cutting GCP reliance breaks these outright.
7. **`openclaw-bridge` AWS deploy pipeline exists** and the service is
   added to `CLAUDE.md` §1b/§2's tracked tables.
8. **`exafyltd/vitana-infra` reconciled.** `phase4-ecs` and `phase5-compute`
   were already reconciled against live infra (2026-07-16/17); `phase8-data-prod`
   (Aurora prod) has not — it showed "11 add, no state" as of the last
   recorded plan (2026-07-20), meaning it was never even applied through
   this IaC. Reconcile before this VTID references any `vitana-infra`
   phase as authoritative.
9. **Fine-tune training pipeline has a working AWS path**, or an explicit
   accepted exception to leave this one function on GCP for the trial
   (`STAGE-ARTIFACTS-GCS.yml` stays canonical, `MIRROR-ARTIFACTS-S3.yml`
   stays dormant).
10. **Burn-in complete** for every AWS-DR service that hasn't had one yet
    (`oasis-operator-awsdr` explicitly named in the runbook as still
    needing this; re-check the others before treating them as ready).
11. **Rollback rehearsal performed** at least once, per runbook §2 — not
    yet done for anything beyond gateway/community-app's own live cutover.
12. **Explicit user sign-off**, recorded, naming the specific cutover
    window and confirming the "GCP stays dormant, not deleted" framing
    above — the runbook treats this as a distinct gate from the technical
    checklist, and so does this spec.

---

## 🔧 TECHNICAL DETAILS

### Primary references
- `docs/AWS-CUTOVER-RUNBOOK.md` (VTID-03412) — Go/No-Go checklist, DNS
  repoint sequence, rollback/TTL plan.
- `CLAUDE.md` §1b — current AWS-DR inventory and hard rules.
- `exafyltd/vitana-infra` — the Terraform stack for ALB/ECS/Aurora/network,
  found and cross-referenced 2026-07-31 (see this repo's CLAUDE.md
  changelog entry for that date).

### Rollback posture (per the "keep GCP dormant" framing)
Unlike VTID-03419's DNS-only cutover, this VTID's rollback plan must
account for **every service's** traffic and data path, not just two
hostnames. Concretely: GCP Cloud Run services should be scaled to keep
serving (not deleted or scaled to zero) for the duration of the trial, so
a DNS revert is still "point back," not "redeploy from scratch under
pressure" — matching the existing runbook §6 rollback mechanism.

### Files/services likely touched (non-exhaustive — actual PRs will scope precisely)
- `services/gateway/src/orb/live/**` (voice provider defaults)
- `services/gateway/src/providers/bedrock.ts`, `llm-router.ts` (default
  provider routing)
- `services/gateway/src/services/aws-ecs-admin.ts`,
  `aws-gateway-admin.ts` (already exist, likely extended)
- `.github/workflows/AWS-PROD-DEPLOY-*.yml` (new ones for services not
  yet covered)
- `exafyltd/vitana-infra/terraform/phase8-data-prod/**` (reconciliation)
- New: an AWS EventBridge Scheduler equivalent for
  `scripts/setup-cloud-scheduler.sh`'s jobs

---

## VTID SPEC (canonical template v1 — for validation once allocated)

```yaml
identity:
  vtid: "VTID-XXXXX"                    # PENDING ALLOCATION — placeholder only, not issued
  title: "Full operational cutover GCP to AWS, GCP kept dormant"
  owner_role: "admin"
  tenant_scope: "multi"

classification:
  primary_domain: "integration"
  secondary_domains: ["backend", "ai", "workflow"]
  system_surface:
    - "vitana_dev"
    - "vitana_admin"
    - "vitana_community"
    - "vitana_professional"
  execution_mode: "manual"

intent:
  problem_statement: |
    Vitana currently splits operational reliance across two clouds: GCP
    (lovable-vitana-vers1) remains canonical for every service except
    gateway and community-app (cut to AWS sole-production under
    VTID-03419). This split-brain state carries real cost and risk already
    observed in production — e.g. the 2026-07-31 ORB_FAST_START config-drift
    incident, caused specifically by the two-stack setup diverging silently.
    The user wants to rely on AWS 100% for staging and production across
    all services for a trial period (August), while keeping GCP intact and
    re-activatable, not decommissioned.
  desired_outcome: |
    Every service in CLAUDE.md §1b's table (plus openclaw-bridge, Cloud
    Scheduler-driven automations, and the fine-tune pipeline) MUST be
    reachable and correct with GCP receiving zero active production or
    staging traffic. GCP resources MUST remain running and redeployable —
    not deleted — so traffic can be reverted within the runbook §6
    rollback mechanism's existing RTO. Every precondition in this spec's
    Preconditions section MUST be satisfied and explicitly verified before
    the cutover window, not assumed from documentation alone.
  non_goals:
    - "GCP resource deletion or decommission (runbook §5, separate VTID, separate gate)"
    - "terraform apply against exafyltd/vitana-infra's current stale state"
    - "Extending AWS-DR to services not already named in CLAUDE.md §1b without their own new VTID"
    - "Flipping any AI/voice provider default before its replacement (Nova Sonic, Polly, Bedrock/Claude, Bedrock/Titan Image Generator) is built and validated at parity"
    - "Autoscaling oasis-projector/worker-runner/verification-engine beyond current desiredCount"

surfaces:
  frontend:
    screens: []
    components: []
  backend:
    services:
      - "gateway"
      - "community-app"
      - "oasis-operator"
      - "oasis-projector"
      - "worker-runner"
      - "verification-engine"
      - "orb-agent"
      - "autopilot-executor"
      - "openclaw-bridge"
    endpoints: []
  ai:
    agents:
      - "orb-agent"
      - "autopilot-executor"
  integrations:
    - "AWS ECS / ALB / Aurora / ElastiCache (472838866351/eu-central-1)"
    - "GCP Cloud Run / Cloud Scheduler / Vertex AI (lovable-vitana-vers1) — dormant target, not decommissioned"
    - "exafyltd/vitana-infra (Terraform)"
    - "Amazon Bedrock (Claude, text AI + vision/tools once adapter is extended)"
    - "Amazon Bedrock (Titan Image Generator, cover-image generation)"
    - "Amazon Nova Sonic (ORB voice, promoted out of canary)"
    - "Amazon Polly (TTS, replaces Google Cloud TTS)"

memory:
  reads:
    - "vtid_ledger"
    - "oasis_events"
  writes:
    - "vtid_ledger"
    - "oasis_events"
  categories:
    - "system"
    - "governance"
    - "workflow"
  retention: "permanent"

workflow:
  triggers:
    - "manual_request"
  autopilot:
    enabled: false
    requires_spec_snapshot: true
  verification:
    acceptance_assertions: true

constraints:
  csp: "strict"
  additive_only: true
  breaking_change: false
  governance_rules:
    - "GOV-AGENT-002"                   # VTID Required for All Tasks
    - "GOV-AGENT-003"                   # No Direct Push to Main
    - "GOV-AGENT-004"                   # Command Hierarchy (CEO/CTO sign-off)
    - "GOV-API-003"                     # Deployment Version Recording

acceptance:
  - type: "condition"
    description: "docs/AWS-CUTOVER-RUNBOOK.md §2 Go/No-Go checklist has every item checked, including the reopened DMS item"
  - type: "manual_verification"
    description: "Aurora DMS ~154k row-drop root-caused and re-verified via aws dms describe-table-statistics with zero unexplained failed applies"
  - type: "manual_verification"
    description: "oasis-projector concurrency-safety redesigned, or explicit written risk-acceptance recorded"
  - type: "test"
    description: "Amazon Nova Sonic validated at parity and promoted out of canary for every active language/tenant, replacing Vertex Live entirely"
  - type: "condition"
    description: "Amazon Polly replaces Google Cloud TTS across all 4 call sites (orb-live.ts, reminder-tts.ts, greeting-bridge-tts.ts, voice-config.ts)"
  - type: "condition"
    description: "Plain-text AI stages (recommendations, fact extraction, session summaries) default to Claude via the Bedrock adapter"
  - type: "test"
    description: "Bedrock adapter extended to support images/tools/forceTool, verified against the Shorts auto-metadata (anthropic-vision-client.ts) use case"
  - type: "test"
    description: "Bedrock Titan Image Generator adapter built and wired into cover-image-outpaint.ts, output quality validated against existing Imagen outpaint results"
  - type: "condition"
    description: "AWS EventBridge Scheduler equivalents exist for every current GCP Cloud Scheduler job"
  - type: "condition"
    description: "openclaw-bridge has a working AWS deploy pipeline and is listed in CLAUDE.md's tracked service tables"
  - type: "condition"
    description: "exafyltd/vitana-infra phase8-data-prod (and any other stale phase) reconciled against live infra"
  - type: "condition"
    description: "Fine-tune training pipeline has a working AWS path, or written exception recorded"
  - type: "test"
    description: "Burn-in complete for every AWS-DR service without one yet (oasis-operator-awsdr named explicitly)"
  - type: "test"
    description: "Rollback rehearsal performed at least once across the full service set in scope"
  - type: "manual_verification"
    description: "Explicit user sign-off recorded naming the cutover window and confirming GCP stays dormant, not deleted"
```

---

## Next steps (for whoever picks this up)

1. Review this draft against the current state of each precondition —
   several may have moved since 2026-07-31.
2. Where a precondition can't reasonably close before the desired trial
   start, decide explicitly: delay the cutover, or accept the risk in
   writing. The AI/voice provider path (precondition 3–5b) no longer has
   a "stay on GCP" branch — Nova Sonic, Polly, Bedrock/Claude, and
   Bedrock/Titan Image Generator were decided 2026-08-01 as the concrete
   replacements; what remains open is *when* each is built and validated,
   not *whether*.
3. Once ready, allocate the real VTID (`POST /api/v1/vtid/allocate` or
   the `allocate_global_vtid` RPC), replace every `VTID-XXXXX` placeholder
   above with the issued number, and only then move `spec_status` toward
   `approved` — which itself still requires the explicit sign-off in
   precondition 12.
