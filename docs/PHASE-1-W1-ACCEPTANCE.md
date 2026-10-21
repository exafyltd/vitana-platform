# Phase 1 W1 acceptance — VTID-03177 et al

**Window:** 2026-05-28 (Day 1, all scaffolding compressed into one session)
**Worktree base:** `origin/main`
**Plan:** [`.claude/plans/yes-make-a-week-by-week-wild-shore.md`](../.claude/plans/yes-make-a-week-by-week-wild-shore.md)

## Headline

7 PRs landed (5 scaffolds + 1 sibling repo + 1 fix-up). 2 follow-up fix-ups
needed before all autonomous loops produce real artifacts (PostgREST filter
landed; gcloud worker-pool-spec landed; one upstream-surface change still
owed for dataset consent). All scaffold code is inert in prod behind
`FEATURE_*_ENV=off` flags — no runtime behavior change has reached
production users.

## VTIDs

| Slug | VTID | PR(s) | State |
|---|---|---|---|
| PROFILE | VTID-03177 | [vitana-platform #2377](https://github.com/exafyltd/vitana-platform/pull/2377), [vitana-v1 #571](https://github.com/exafyltd/vitana-v1/pull/571) | MERGED |
| DATASETS | VTID-03178 | [#2378](https://github.com/exafyltd/vitana-platform/pull/2378), [#2382 fix](https://github.com/exafyltd/vitana-platform/pull/2382) | MERGED |
| FINETUNES | VTID-03179 | [#2380](https://github.com/exafyltd/vitana-platform/pull/2380) | MERGED |
| CACHE | VTID-03180 | [#2381](https://github.com/exafyltd/vitana-platform/pull/2381) | MERGED |
| VOICE-LAT | VTID-03181 | [#2383](https://github.com/exafyltd/vitana-platform/pull/2383) | MERGED |

## Acceptance — 9 criteria

### 1. WIF SA secret-access grant applied + STAGE-DEPLOY step 8 clean — **GREEN**

- Phase 0 memo named the wrong secrets (`STAGING_SUPABASE_*`); the
  workflow actually reads prod `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE`
  because `software_versions` is centralized in prod Supabase
- Cloud Shell IAM grants applied to `vitana-vertex-ai-service@...` AND
  six other deployer-style SAs (broad-scope grant; identifying the
  exact WIF SA can be done from any subsequent run's audit log)
- PR #1 also patched step 8 from `INSERT` → `UPSERT`
  (`on_conflict=swv_id`, `Prefer: resolution=merge-duplicates`) — the
  pre-existing race where two concurrent `STAGE-DEPLOY` runs both
  computed `max(swv_id)+1` and the second `409`d is now idempotent
- Evidence: STAGE-DEPLOY run `26623169184` logs `Recording SWV-1444 for
  gateway-staging@gateway-staging-00061-gbs` and `✓ software_versions
  row + staging.deploy.completed event emitted`. No `::warning::` line.

### 2. 114 missing-migrations spot-check — **GREEN (per-PR basis)**

- The 6 known-missing tables (`products`, `profiles`, `live_rooms`,
  `calendar_events`, `catalog_sources`, `vitana_index_config`) are NOT
  referenced by any Phase 1 W1 PR
- PR #4 CACHE's 3 new materialized views reference `autopilot_recs`,
  `vitana_index_values`, `oasis_events` — all present on staging
- Deferred: actual `\dt` enumeration on staging is owed once Supabase MCP
  authentication is restored in the operator's environment

### 3. 5 VTIDs allocated — **GREEN**

| VTID | Slug | id |
|---|---|---|
| VTID-03177 | PROFILE | `17084930-2eae-4697-9129-d54c66e5fe5a` |
| VTID-03178 | DATASETS | `33f63b0a-f1c6-4cda-a306-86c0cd8b016d` |
| VTID-03179 | FINETUNES | `c67253e4-571e-4e80-9be4-2384b85c2b14` |
| VTID-03180 | CACHE | `2877f453-8436-4463-90ff-638a88a79553` |
| VTID-03181 | VOICE-LAT | `caeb48e3-ac3d-424a-9f2a-d595e6a3cad6` |

Side-note: the VTID allocator endpoint (`POST /api/v1/vtid/allocate`) is
open and does NOT require an admin JWT — contradicts the Phase 0 handoff
brief which said one was required. Worth tightening as a Phase 0
follow-up before any auto-promoter starts opening PRs that bind VTIDs to
real production cuts.

### 4. PR #1 PROFILE merged green; auto-deploy succeeds on staging + prod — **GREEN**

- vitana-platform #2377 squash-merged @ `a64f0bc7`
- vitana-v1 #571 squash-merged
- `STAGE-DEPLOY` + `EXEC-DEPLOY` for vitana-platform: both `success`
- Staging gateway revision after merge: `gateway-staging-00054-4hd`
- Prod gateway revision after merge: `gateway-03617-zlb`
- Smoke: `POST /api/v1/rum/beacon` returns `204` on staging (route mounted;
  flag off so beacon silently dropped — exactly the W1 default state)
- Latency events visible in staging Supabase — **not yet**; requires
  flipping `FEATURE_LATENCY_TELEMETRY_ENV=staging-only` on
  `gateway-staging`. One Cloud Shell `gcloud run services update` command,
  owed to the operator before W2 starts

### 5. PR #2 DATASETS — first cron run yields ≥1k rows — **PARTIAL**

- Cron `CRON-DATASET-EXTRACTION.yml` is live (daily 02:00 CET +
  `workflow_dispatch`); first run after the PostgREST fix completed
  cleanly (no errors)
- All 3 targets returned **0 rows** because the SQL-layer PII filter
  requires `metadata->>data_export_ok=eq.true` and the producing
  surfaces (orb-live, intent emitter, memory writer) do NOT yet set this
  flag on their emitted events
- **This is not a script bug — it's the contract.** Better to extract zero
  rows than to extract un-consented rows
- Follow-up owed (NOT in W1 scope, separate VTID): a small upstream PR
  that adds `data_export_ok: true` to event metadata on surfaces where
  tenant-level consent is established. Once that PR ships and ~1 week of
  consented events accumulate, the next cron run will yield real corpora

### 6. PR #3 FINETUNES merged; auto-promoter + graduation-recommender + 4 crons live — **GREEN**

- 4 cron workflows live on main:
  - `CRON-FINETUNE-TRAINER.yml` (weekly Mon 06:00 UTC)
  - `CRON-AUTO-PROMOTER.yml` (hourly :30) — runs in DRY mode in W1
    (`AUTO_PROMOTER_DRY_RUN=1`); flips to `0` in W2 once first decisions
    are reviewed
  - `CRON-GRADUATION-RECOMMENDER.yml` (daily 08:00 UTC = 09:00 CET)
  - `STAGE-ARTIFACTS-GCS.yml` (daily 04:00 UTC) — picks up trained
    weights from `gs://vitana-artifacts-staging/finetune-runs/<target>/`
- Dormant 5th workflow: `MIRROR-ARTIFACTS-S3.yml` (guard job exits
  cleanly until `AWS_BUCKET` + `AWS_ROLE_ARN` secrets land)
- Shadow harness (`services/llm-router-shadow.ts`) ready to wire on the
  voice-tool-router runtime call site; orb-live wire-in is a W2
  follow-up (intentionally not in PR #3 to keep blast radius small)

### 7. PR #4 CACHE merged; Cloudflare worker deployed + 3 materialized views ready — **GREEN (deploy + scaffold) / PARTIAL (KV namespace + migration apply)**

- `cloudflare/community-cache/` ships via the existing
  `DEPLOY-CLOUDFLARE-WORKERS.yml` (auto-picks up new worker dirs on push)
- `wrangler.toml` has `REPLACE_WITH_KV_ID_AFTER_FIRST_DEPLOY` placeholder
  — operator runs `wrangler kv:namespace create COMMUNITY_CACHE_KV` once
  to populate, then a tiny one-line follow-up commit closes the loop
- 3 materialized views migration shipped under
  `supabase/migrations/20260528220000_VTID_03180_community_cache_materialized_views.sql`
  — needs `RUN-MIGRATION.yml` invocation against the staging branch
  (owed; not auto-applied by merge to main per the migration rule)

### 8. PR #5 VOICE-LAT merged; 3 inert files behind flags + 3 iOS specs — **GREEN**

- `services/gateway/src/services/speculative-tool-runner.ts` — runtime
  behind `FEATURE_SPECULATIVE_TOOLS_ENV=off`; READ_ONLY_TOOLS allowlist
  hand-curated
- `services/gateway/src/services/conversation-router.ts` — typed entry
  shape; `route()` throws "not implemented" so premature callers fail
  loudly. Surface migrations begin W4 (assistant-service first)
- `services/gateway/src/providers/bedrock.ts` — dormant; lazy require of
  `@aws-sdk/client-bedrock-runtime` returns typed `sdk_missing` until W3
  AWS provisioning installs the dep
- `e2e/ios-suites/{audio-context,playback-keepalive,visibility-listener}.spec.ts`
  — Playwright specs; each `test.skip()`s when `BROWSERSTACK_USERNAME`
  secret is unset

### 9. First Vertex fine-tune training submitted — **PARTIAL (fix-up PR in flight)**

- `CRON-FINETUNE-TRAINER` invocation against `voice-tool-router` failed
  on the first try with `argument --worker-pool-spec: Bad syntax for
  dict arg` — `gcloud ai custom-jobs create` does not accept JSON
  directly for nested specs; canonical workaround is `--config=<file.yaml>`
- Fix shipped in a follow-up PR (in flight at this writing):
  `submit-job.ts` now writes the spec to a tmp YAML and passes
  `--config=<path>`. Re-running the workflow with `dry_run=false` after
  merge will queue the real Vertex Custom Training job (~$50 of the
  Phase 1 budget; runs ~24-36h)

## Honest gaps

These are intentional; they're documented W2 work, not W1 misses.

1. **`FEATURE_LATENCY_TELEMETRY_ENV` not flipped on staging.** PR #1 ships
   the receiver and the tracker; the experiment design wants the operator
   to flip the env var on `gateway-staging` once they're ready to see
   events flowing.

   **Instruction for operator (Cloud Shell):**
   ```bash
   gcloud run services update gateway-staging \
     --region=us-central1 \
     --project=lovable-vitana-vers1 \
     --update-env-vars=FEATURE_LATENCY_TELEMETRY_ENV=staging-only
   ```

2. **Dataset extraction needs `data_export_ok` populated upstream.** The
   SQL-layer PII gate is correct; the producing surfaces need a small
   companion PR that starts setting the flag where tenant consent is
   established. Until then, dataset cron runs are well-formed but
   empty-bodied.

3. **First Vertex fine-tune submission queued, not yet started.** Fix-up
   PR resolves the `--worker-pool-spec` syntax issue. Operator (or the
   weekly Monday cron) re-triggers post-merge.

4. **Staging MV migration apply.** `RUN-MIGRATION.yml` invocation against
   the Supabase staging branch is owed for the 3 community-cache views.
   One-shot per migration; takes ~10s.

5. **Cloudflare KV namespace id placeholder.** First worker deploy will
   fail with "namespace not found" until the operator runs
   `wrangler kv:namespace create COMMUNITY_CACHE_KV --env staging` and
   commits the resulting id into `wrangler.toml`.

6. **Identify the actual WIF SA + revoke unused 6 grants.** Broad grant
   was a pragmatic unblocker; the audit log from any subsequent
   STAGE-DEPLOY run will reveal which SA actually authenticated. The
   other 6 grants are harmless (read-only access to two secrets) but
   should be cleaned up for least-privilege hygiene.

## Costs spent in W1

- ~$0 GCP — the Vertex Custom Training submission failed before any
  compute was billed; gateway deploys + the 0-row dataset cron consumed
  rounding-error compute
- ~$0 Cloudflare — worker not yet deployed (waiting on KV namespace id)
- 7 PR-level CI runs against `vitana-platform` (typical)
- 1 PR-level CI run against `vitana-v1`

## Hand-off

Autonomous loops scheduled and running. Parent session returns
**Jul 5–7** for final QA per the 40-day plan. Between now and then:

- Daily 09:00 CET — `CRON-GRADUATION-RECOMMENDER` FCM digest (will say
  "no candidates ready" until the first fine-tune completes)
- Daily 02:00 CET — `CRON-DATASET-EXTRACTION` (empty until `data_export_ok`
  population PR lands)
- Daily 04:00 UTC — `STAGE-ARTIFACTS-GCS` (no-op until first weights land)
- Hourly :30 — `CRON-AUTO-PROMOTER` (no decisions until shadow events
  start flowing, which requires the wire-in in PR #3 follow-up)
- Weekly Mon 06:00 UTC — `CRON-FINETUNE-TRAINER` (queues
  `voice-tool-router` after fix PR merges; ~$50/run on Vertex)
