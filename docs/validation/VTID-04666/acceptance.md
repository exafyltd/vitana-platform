# VTID-04666 — Autopilot recommendations P1: remove known noise

Plan: `docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md` §1, §2, §4 P1.

## Root cause / why

The developer-side recommendation list was dominated by cards no one could
act on, each produced by a deterministic rule that was simply too loose
(live numbers in the plan, §2):

1. **roadmap** — the stalled-VTID query excluded only `completed`/`archived`,
   so voided, deleted, rejected, cancelled, unapproved `allocated` shells and
   `is_terminal` rows were recommended, oldest first, with no age bound
   ("Unblock VTID-01057 … stalled in voided — no activity for 9765 days").
2. **oasis** — every topic with ≥10 `status=error` events became a "recurring
   error". `voice.latency.measured` is latency telemetry written with
   `status:'error'`; autopilot/CI/ledger bookkeeping topics were counted too
   (the watcher already had `isVerificationNoiseTopic` for exactly this, the
   analyzer did not use it). A provider outage produced one card per calling
   service (`llm.call.failed` per service) because clusters were keyed on
   `topic + service`.
3. **health** — `ANTHROPIC_API_KEY` is deliberately unset (Bedrock-only
   standing rule, VTID-03563) and `GITHUB_TOKEN` is not what the gateway uses
   (`GITHUB_SAFE_MERGE_TOKEN`), so both fired forever.
4. **operator_onramp** — every operator request writes a row with
   `status='new'`; those are executed requests, not recommendations, yet the
   developer lineup and the no-role RPC listed them (103 rows).
5. **Dedupe** only blocked a fingerprint while the old row was
   `new`/`snoozed`: a rejected signal came back on the next run, for every
   source. `dev_autopilot` / `dev_autopilot_impact` rows never expired.
6. **Pending approvals** sorted `risk_class.desc` in PostgREST, i.e. as text:
   medium > low > high — high-risk rows came last.

## Fix

- `services/oasis-noise-topics.ts` (new): `isVerificationNoiseTopic` moved here
  verbatim; the watcher imports and re-exports it (identical behaviour, pinned
  by the existing VTID-04377/04625 suites). `isRecommendationNoiseTopic` adds
  `voice.latency.*` and `telemetry.*`.
- `analyzers/roadmap-analyzer.ts`: query excludes
  `completed, archived, voided, deleted, rejected, cancelled, allocated`,
  `is_terminal=not.is.true`, requires `spec_status=eq.approved`, bounds age to
  `(stale_days, 365]`, orders `updated_at.desc`; the same rules are re-checked
  in JS (`isStalledVtidCandidate`); results are newest-stalled first.
- `analyzers/oasis-analyzer.ts`: `clusterErrorEvents` (pure) drops noise
  topics; error events carrying `metadata.provider` on an `llm.*` or
  fail/error topic cluster by `provider:<provider>:<error class>` across
  services (error class = `metadata.error_code`, else an HTTP status field or
  status in the message, else a known AWS/network token, else `unknown`). The
  signal `source` — and so the fingerprint — is that root cause.
  `voice.latency.*` is also excluded server-side so it cannot fill the
  1000-row page. The ≥10 threshold is unchanged.
- `analyzers/health-analyzer.ts`: `REQUIRED_ENV_VARS` with aliases (GitHub is
  satisfied by `GITHUB_SAFE_MERGE_TOKEN` or `GITHUB_TOKEN`, reported as
  `GITHUB_SAFE_MERGE_TOKEN`) and a documented `INTENTIONALLY_ABSENT_ENV_VARS`
  list (`ANTHROPIC_API_KEY`, with its reason). The never-read "recommended"
  list was removed.
- `routes/autopilot-recommendations.ts` `queryRecommendationsByRole`: the
  developer/admin/infra lineup adds `source_type=neq.operator_onramp`.
  `GET /dev-autopilot/pending-approvals` already filtered
  `source_type=in.(dev_autopilot,dev_autopilot_impact)` — verified, pinned.
- `services/dev-recommendation-policy.ts` (new): 30-day rejected block,
  30-day expiry, `sortPendingApprovals`.
- `dev-autopilot-synthesis.ts` `ingestScan` and `POST /impact-ingest`: one
  lookup per run for fingerprints of that source rejected in the last 30 days;
  a matching signal with no live row is skipped (`suppressed_rejected`
  reported on the run result / scan event payload / response). New rows get
  `expires_at = now + 30d`; a re-sighting of a live row pushes `expires_at`
  forward, so a finding still being detected never expires. A failed lookup is
  logged and blocks nothing (the previous behaviour).
- `GET /pending-approvals`: reads the open set (up to 1000), sorts in JS by
  risk rank (critical > high > medium > low > unset), then `impact_score`
  desc, then `created_at` desc, then pages; expired findings are excluded.
- Migration `supabase/migrations/20260926140000_vtid_04666_recommendation_noise.sql`
  (CREATE OR REPLACE, signatures unchanged):
  - `insert_autopilot_recommendation`: a system-wide (`p_user_id IS NULL`)
    fingerprint rejected within 30 days is returned as a duplicate. Community
    rows are deliberately untouched — they keep their own 14-day
    `REJECTED_COOLDOWN_DAYS` pre-check (VTID-03201).
  - `get_autopilot_recommendations` / `_count` (the exafy-admin no-role path):
    exclude `operator_onramp`.
  - `cleanup_expired_autopilot_recommendations`: never DELETEs
    `dev_autopilot` / `dev_autopilot_impact` rows. They now have an
    `expires_at`, and a DELETE would cascade to their plan versions and
    executions (the history the P4 success-rate breaker needs). Before this
    VTID their `expires_at` was NULL, so the exclusion keeps today's behaviour.
- Data fix `supabase/migrations/data-fixups/20260926140100_vtid_04666_reject_noise.sql`:
  rejects the open (`new`/`snoozed`), system-wide (`user_id IS NULL`) roadmap /
  health / oasis cards the new rules would never create. There is no
  rejection-reason column (the only JSONB column, `provenance`, belongs to the
  ranker's decision trail), so the reason is recorded in the file header and
  here. Idempotent; run after the code and migration are live.

No new OASIS event type (only a `suppressed_rejected` field added to the
existing `dev_autopilot.scan.completed` payload). No new env flag. No schema
change (functions only), so `DATABASE_SCHEMA.md` is unchanged.

## Acceptance criteria

AC-1 Roadmap never recommends terminal, voided, deleted, rejected, cancelled, allocated or unapproved VTIDs, nor VTIDs untouched for more than 365 days; results are newest-stalled first.
TEST: services/gateway/test/vtid-04666-roadmap-stalled-vtids.test.ts

AC-2 OASIS noise topics (the watcher's verification list plus `voice.latency.*`, `telemetry.*`) never become recurring-error cards, and the watcher's `isVerificationNoiseTopic` is the same function with the same behaviour.
TEST: services/gateway/test/vtid-04666-oasis-noise-and-root-cause.test.ts

AC-3 A provider outage across several services is one card, fingerprinted on provider + error class; different error classes stay separate; ordinary errors still cluster per topic + service with the ≥10 threshold.
TEST: services/gateway/test/vtid-04666-oasis-noise-and-root-cause.test.ts

AC-4 Health never recommends `ANTHROPIC_API_KEY`; `GITHUB_SAFE_MERGE_TOKEN` satisfies the GitHub requirement; genuinely missing required vars are still reported.
TEST: services/gateway/test/vtid-04666-health-env-policy.test.ts

AC-5 The developer/admin/infra lineup excludes `operator_onramp`; the community lineup is unchanged; the no-role RPCs exclude it (SQL contract); pending approvals only list dev sources.
TEST: services/gateway/test/vtid-04666-onramp-excluded-and-sql-contract.test.ts

AC-6 A dev_autopilot or dev_autopilot_impact fingerprint rejected in the last 30 days is not re-created; a failed lookup blocks nothing; the SQL insert function blocks system-wide rejected fingerprints for 30 days.
TEST: services/gateway/test/vtid-04666-dev-findings-rejected-expiry-sort.test.ts

AC-7 New dev findings carry `expires_at` 30 days out and a re-sighting refreshes it; cleanup never deletes dev findings.
TEST: services/gateway/test/vtid-04666-dev-findings-rejected-expiry-sort.test.ts

AC-8 Pending approvals sort high > medium > low, then impact desc, then created_at desc, and page after sorting; expired findings are excluded.
TEST: services/gateway/test/vtid-04666-dev-findings-rejected-expiry-sort.test.ts

AC-9 The data fix only touches open, system-wide roadmap / health / oasis rows matching the new rules, and contains no DELETE/INSERT/DROP.
TEST: services/gateway/test/vtid-04666-onramp-excluded-and-sql-contract.test.ts

AC-10 Deploy failures still become recommendations: the error clustering treats deploy topics as noise, so the failed-deploy pass now also reads the AWS topics `staging.deploy.failed` / `prod.deploy.failed` (live, 30 days: 31 and 5 events) — before, it only read three GCP-era topics that are no longer emitted.
TEST: services/gateway/test/vtid-04666-oasis-noise-and-root-cause.test.ts

## Existing tests changed

`services/gateway/test/dev-autopilot-synthesis.test.ts` ("the dedup GET query
includes activated alongside new/snoozed") asserted exactly one GET to
`autopilot_recommendations`. That count was incidental, not a rule: the new
per-run rejected-fingerprint lookup is a second GET. The test now asserts one
rejected lookup and one dedup lookup, and still checks the VTID-04274
`status=in.(new,snoozed,activated)` filter on the dedup lookup.

## Not verified live

- Nothing was written to any database. The migration and the data fix ship as
  files; they take effect only when `RUN-MIGRATION.yml` is dispatched for each
  (migration first, data fix after the gateway code is on the target stack).
- The oasis root-cause classification is built from the event shape the code
  emits (`llm-telemetry-service.ts` `buildLLMCallFailed`: `metadata.provider`,
  `error_code`, `error_message`); the live distribution of error classes was
  not re-queried in this session.
- Staging checks (`staging-tests.json`) are read-only by rule; the behaviour
  is proven by the suites above.
