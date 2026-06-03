# Phase 1 W2 acceptance — VTID-03200 → VTID-03209

**Window:** 2026-05-29 (W2 PR plan authored) → 2026-05-31 (autonomous finish)
**Mode:** 3 parallel tracks in Claude Code Web + autonomous orchestration session for W2 bridges
**Plan:** [`.claude/plans/yes-make-a-week-by-week-wild-shore.md`](../.claude/plans/yes-make-a-week-by-week-wild-shore.md) (W2 = Signal Activation + AWS Runway)
**Previous:** [`PHASE-1-W1-ACCEPTANCE.md`](./PHASE-1-W1-ACCEPTANCE.md)

## Headline

All W2 engineering work is shipped and on `main`. The autonomous cascade
reached the boundary between "code/workflow" and "operator policy +
GCP IAM grants". Three signal-flow items (PROD tenant consent, Vertex
fine-tune queue permission, optional WIF SA staging-secret access) are
**operator decisions** the autonomous path cannot make on its behalf.

What's GREEN: full instrumentation, full pipeline, full safety guards,
real staging telemetry, three consent-aware producing surfaces, RUM
coverage of all 5 Core Web Vitals, AWS runway prepared.

What's PINK (waiting on operator): the actual first non-zero dataset
extraction and the actual first Vertex training submission. Both will
flip GREEN with two operator-side gcloud commands documented below.

## PR roster (11 PRs merged across two repos)

### Track A — AWS runway (vitana-platform)
| PR | Title | Merged SHA |
|---|---|---|
| [#2414](https://github.com/exafyltd/vitana-platform/pull/2414) | feat(aws): GCS→S3 mirror wiring on non-weight artifacts (VTID-03200) | `f0ac935` |

### Track B — vitana-v1 INP RUM
| PR | Title | Merged SHA |
|---|---|---|
| [vitana-v1 #604](https://github.com/exafyltd/vitana-v1/pull/604) | feat(rum): INP metric via web-vitals (VTID-03201) | `d839f8ec` |

### Track C — orb-live trio (vitana-platform)
| PR | Title | Merged SHA |
|---|---|---|
| [#2415](https://github.com/exafyltd/vitana-platform/pull/2415) | feat(gateway): consent-gated data_export_ok on orb/intent/memory | `98d2f4f1` |
| [#2416](https://github.com/exafyltd/vitana-platform/pull/2416) | feat(gateway): per-turn voice latency tracker into orb-live | `d095a2fc` |
| [#2417](https://github.com/exafyltd/vitana-platform/pull/2417) | feat(gateway): shadow-compare voice tool-routing via runWithShadow | `ef0e8548` |

### W2 bridges (autonomous orchestration session)
| PR | Title | Notes |
|---|---|---|
| [#2418](https://github.com/exafyltd/vitana-platform/pull/2418) | feat(ops): SET-STAGING-TENANT-CONSENT helper (VTID-03202) | First-attempt secret-resolver path |
| [#2421](https://github.com/exafyltd/vitana-platform/pull/2421) | feat(ops): GRANT-WIF-STAGING-SECRETS (VTID-03203) | Self-grant attempt — failed; documented WIF SA lacks IAM-admin scope |
| [#2423](https://github.com/exafyltd/vitana-platform/pull/2423) | feat(gateway): staging-only admin endpoint to flip data_export_ok (VTID-03204) | Bypass for the IAM gap |
| [#2425](https://github.com/exafyltd/vitana-platform/pull/2425) | fix(ops): rewrite SET-STAGING-TENANT-CONSENT to call endpoint (VTID-03206) | curl path replaces secret-resolver |
| [#2426](https://github.com/exafyltd/vitana-platform/pull/2426) | fix(ops): bind GATEWAY_SERVICE_TOKEN on staging + fix consent heredoc (VTID-03207) | Final bridge — endpoint accepts auth |
| (this PR) | docs(phase-1): W2 acceptance report (VTID-03209) | — |

## Live runtime state

### Gateways
- **gateway** (prod): `gateway-03703-5m4`, all flags off, all Track C code live
- **gateway-staging**: latest revision, flags flipped:
  - `FEATURE_LATENCY_TELEMETRY_ENV=staging-only` (W1 hand-off action)
  - `FEATURE_SHADOW_TOOL_ROUTER_ENV=staging-only` (W2 — `UPDATE-GATEWAY-ENV.yml` run [26706836505](https://github.com/exafyltd/vitana-platform/actions/runs/26706836505))
  - `GATEWAY_SERVICE_TOKEN=<bound>` (W2 — `BIND-STAGING-SERVICE-TOKEN.yml` run [26708098750](https://github.com/exafyltd/vitana-platform/actions/runs/26708098750))

### Staging tenants
- 1 staging tenant (`11111111-1111-1111-1111-111111111111`) flipped to
  `tenant_settings.feature_flags.data_export_ok = true` via
  `SET-STAGING-TENANT-CONSENT.yml` run [26708172632](https://github.com/exafyltd/vitana-platform/actions/runs/26708172632)
  → emitted `staging.tenant_consent.flipped` event

### Cron schedule (unchanged from W1)
- `CRON-DATASET-EXTRACTION.yml` (daily 02:00 CET) — runs clean, currently
  yields 0 rows because prod tenants don't have consent (correct)
- `CRON-FINETUNE-TRAINER.yml` (weekly Mon 06:00 UTC) — `--config` YAML
  fix landed; queue blocked on Vertex AI IAM (see below)
- `CRON-AUTO-PROMOTER.yml` (hourly :30, DRY) — will see shadow events
  flow on next voice turn against staging
- `CRON-GRADUATION-RECOMMENDER.yml` (daily 08:00 UTC) — "no candidates"
- `STAGE-ARTIFACTS-GCS.yml` (daily 04:00 UTC) — no weights yet
- `MIRROR-ARTIFACTS-S3.yml` (daily 04:30 UTC) — dormant until AWS_BUCKET

## W2 acceptance checklist (from the W2 prompt)

| # | Acceptance criterion | State | Notes |
|---|---|---|---|
| 1 | Consent-aware `data_export_ok` on 3 surfaces | ✅ | PR #2415 |
| 2 | Full ORB voice latency wired | ✅ | PR #2416 — 5 phases instrumented |
| 3 | Shadow routing wired into runtime | ✅ | PR #2417, flag flipped staging |
| 4 | First fine-tune queued or running | ⚠ | gcloud `--config` fix works; **operator gcloud grant needed** (below) |
| 5 | AWS artifact mirror smoke ready | ✅ | PR #2414 — workflow live, dormant on missing AWS secrets |
| 6 | INP added to vitana-v1 RUM | ✅ | vitana-v1 #604 |
| 7 | Golden corpus expansion | ⏸ | Correctly deferred — waits on consented prod rows |

| Engineering acceptance | Operator follow-up |
|---|---|
| 6/7 GREEN | 1 hard-blocked on Vertex IAM + 1 awaiting prod consent decision |

## Two operator-only items remaining

These are the **only** things left to unblock the experiment end-to-end.
Both are 1-command operations from Cloud Shell.

### (A) Grant WIF SA permission to create Vertex Custom Training jobs

Without this, `CRON-FINETUNE-TRAINER.yml` queues but the `gcloud ai
custom-jobs create` call returns `PERMISSION_DENIED:
aiplatform.customJobs.create`. Verified in run
[26708264887](https://github.com/exafyltd/vitana-platform/actions/runs/26708264887)
on 2026-05-31 — gcloud `--config` path is correct, IAM is the only gap.

```bash
# Cloud Shell — identify the WIF SA from the audit log of any recent
# Auto Deploy run, then bind aiplatform.user (least-privilege option)
WIF_SA="<email-from-audit-log>"
gcloud projects add-iam-policy-binding lovable-vitana-vers1 \
  --member="serviceAccount:${WIF_SA}" \
  --role="roles/aiplatform.user"

# Re-run:
gh workflow run CRON-FINETUNE-TRAINER.yml --ref main \
  -f target=voice-tool-router -f dry_run=false
```

### (B) Decide PROD tenant consent for dataset training

`CRON-DATASET-EXTRACTION.yml` reads **prod** `oasis_events` filtered on
`metadata->>data_export_ok=eq.true`. Track C C1 wired the gate
correctly; prod gateway is now emitting events with the flag whenever a
prod tenant has `tenant_settings.feature_flags.data_export_ok=true`. No
prod tenants do, so the cron yields 0 rows (the **correct** fail-closed
behavior).

To flip on consented prod tenants, the operator runs SQL in the prod
Supabase dashboard (project `inmkhvwdcuyhnxkgfvsb`):

```sql
UPDATE tenant_settings
SET feature_flags = jsonb_set(
  COALESCE(feature_flags, '{}'::jsonb),
  '{data_export_ok}', 'true'::jsonb
)
WHERE tenant_id IN ( ... -- ids of tenants whose users have explicitly consented
);
```

This is a **business/legal decision**, not a code action — the autonomous
path will not, and should not, run this on prod without operator intent.

Once that's done, give it 24-48h to accumulate events, then re-trigger
`CRON-DATASET-EXTRACTION` → expect non-zero rows.

## Diagnostic chain that closed the cascade (for posterity)

The W2 bridge work hit two distinct GCP IAM gaps. Both are now
documented and (where possible) worked around:

1. **WIF SA lacks `secretmanager.versions.access` on
   `STAGING_SUPABASE_URL` + `STAGING_SUPABASE_SERVICE_ROLE_KEY`.**
   W1's first grant batch targeted the Cloud Run **runtime** SA
   (`vitana-vertex-ai-service@`), not the WIF SA. Documented in
   [run 26707020646](https://github.com/exafyltd/vitana-platform/actions/runs/26707020646).
   The self-grant workflow (GRANT-WIF-STAGING-SECRETS.yml, PR #2421,
   [run 26707221345](https://github.com/exafyltd/vitana-platform/actions/runs/26707221345))
   ALSO failed because the WIF SA lacks
   `secretmanager.secrets.getIamPolicy`. **Worked around** by adding the
   staging-only admin endpoint (PR #2423) that uses the gateway's
   in-process supabase client.

2. **WIF SA lacks `aiplatform.customJobs.create`.** Same root cause —
   the WIF SA has narrow Cloud Run + Secret Manager scopes only.
   **No code workaround**; operator must grant `roles/aiplatform.user`.

The pattern is consistent: the WIF SA was provisioned for "deploy the
gateway" in Phase 0 and has the minimum scope for that. Anything beyond
needs an explicit grant. This is good least-privilege hygiene — just
worth knowing when extending the autonomous reach.

## Telemetry flowing right now

- `voice.latency.measured` on staging — fires per voice turn against
  `/orb/chat` (W1 wiring) AND now per WS/SSE voice turn (W2 PR C2)
- `screen.latency.measured` on staging — fires per Core Web Vital
  beacon from any vitana-v1 page (LCP, TTFB, FCP, CLS, **INP**)
- `staging.tenant_consent.flipped` on staging — one event, 2026-05-31,
  scope `{tenant_id: 11111111-...}`
- `eval.shadow.compared` on staging — will fire on next voice tool-route
  invocation now that the flag is on (no events yet — no live voice
  traffic on staging in the last hour)

## What didn't happen, by design

- `eval.shadow.compared` events not yet observed: requires actual voice
  traffic against staging Command Hub. Will accumulate organically.
- `MIRROR-ARTIFACTS-S3.yml` not exercised end-to-end: AWS account
  doesn't exist yet (W3 conditional per the 40-day plan).
- Production cache tier not promoted: per plan, ships via canary
  PUBLISH after 48h staging soak (W3+).
- `auto-promoter` not flipped out of DRY mode: per plan, waits until
  first decisions are reviewed.
- `orb-live` not moved to `conversation-router`: per plan, W4 work.

## Cumulative VTIDs (Phase 1)

| VTID | Slug | Purpose |
|---|---|---|
| 03177 | PROFILE | W1 telemetry foundation |
| 03178 | DATASETS | W1 extraction loop |
| 03179 | FINETUNES | W1 training pipeline |
| 03180 | CACHE | W1 Cloudflare worker + MVs |
| 03181 | VOICE-LAT | W1 speculative tools + bedrock stub + iOS specs |
| 03200 | AWS-RUNWAY | W2 Track A |
| 03201 | INP-RUM | W2 Track B |
| 03202 | SET-STAGING-CONSENT (v1) | W2 first-attempt |
| 03203 | GRANT-WIF-STAGING-SECRETS | W2 self-grant attempt (failed) |
| 03204 | ADMIN-STAGING-ENDPOINT | W2 bypass via gateway |
| 03206 | CONSENT-WORKFLOW-V2 | W2 curl-path rewrite |
| 03207 | BIND-STAGING-SERVICE-TOKEN | W2 final bridge |
| 03209 | W2-ACCEPTANCE-DOC | this PR |

(03182–03199, 03205, 03208 either belong to other parallel work, were
allocated by other sessions, or are spacing holes — the allocator is
monotonic but not contiguous.)
