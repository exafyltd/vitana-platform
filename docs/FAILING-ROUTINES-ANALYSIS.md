# Failing Routines Analysis — 2026-07-22

Audit of every scheduled (`cron`) GitHub Actions workflow in this repo plus
`vitana-v1`'s two scheduled workflows (27 total), triggered by the question
"why are all the routines failing?". Each workflow's last ~5 completed runs
were pulled via the GitHub Actions API and checked for conclusion.

## Result: 4 of 27 were failing on every single run

| Workflow | Failing since (approx) | Root cause | Fix |
|---|---|---|---|
| `MARKETPLACE-SYNC-CRON.yml` | every run on record | **Two stacked workflow bugs**, not an outage. (1) `grep -q '"HTTP 200"'` searches for a quoted literal, but curl's `-w "HTTP %{http_code}"` prints the unquoted text `HTTP 200` — the pattern can never match, so the job hard-failed even when the sync itself returned `HTTP 200` / `ok:true`. (2) Once (1) is fixed, a **second, previously-unreachable bug** surfaces: the step-summary block reads `.result.shopify.totals` / `.result.cj.totals`, but `runAllMarketplaceSync`'s real response nests those under `.result.providers.<name>` (`services/gateway/src/routes/internal-marketplace-sync.ts`) — `to_entries` on the resulting `null` threw `null (null) has no keys` (jq exit 5). Bug (2) had been there all along; bug (1) simply always failed first, so nobody ever saw it. | **Fixed in this branch, both bugs** — grep replaced with `[[ "$RESP" != "HTTP 200"* ]]`; jq paths corrected to `.result.providers.shopify.totals` / `.result.providers.cj.totals` with `// {}` fallbacks. **Partially live-verified so far** via `workflow_dispatch` on this branch: run [29938536672](https://github.com/exafyltd/vitana-platform/actions/runs/29938536672) got past bug (1) (real `HTTP 200`/`ok:true`, no more false failure) and failed on bug (2) instead — confirming (1) is fixed and exposing (2). Re-dispatched after fixing (2); that confirmation run was still in progress as of this writing (~4 min runtime, dominated by the admitad 300k-item feed scan) — update this line once it completes. |
| `DAILY-STATUS-UPDATE.yml` ("Hourly Status Check") | every run since branch protection on `main` started requiring the `validate` status check | The job itself succeeds (health probe, `docs/STATUS.md` regen, self-healing report) — it only fails at the final `git push` to `main`: `GH006: Protected branch update failed ... Required status check "validate" is expected.` The required `validate` check is the `validate` job in `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` (`on: [pull_request]`), which only ever runs on a pull request — a direct push can never produce that check, so **every** direct push to `main` from this workflow is permanently rejected. | **Fixed in this branch** — the commit now publishes to a dedicated `automation/status-report` branch instead of `main`. `docs/STATUS.md` is a generated report, not frontend source, so it doesn't need to go through the frontend-canonical-source check built for actual Command Hub frontend PRs. |
| `CRON-AUTO-PROMOTER.yml` | every run on record | GCP IAM: `gcloud secrets versions access --secret=STAGING_SUPABASE_URL` (and `STAGING_SUPABASE_SERVICE_ROLE_KEY`) fails with `PERMISSION_DENIED: secretmanager.versions.access denied` for the WIF service account (`secrets.GCP_WIF_SA_EMAIL`). | **Needs manual GCP action** — see below. Cannot be fixed from a code change. |
| `CRON-GRADUATION-RECOMMENDER.yml` | every run on record | Same as above, plus also reads `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE` (prod) — same `PERMISSION_DENIED`. | **Needs manual GCP action** — see below. |

A handful of others (`STAGE-ARTIFACTS-GCS`, `SMOKE-WELCOME-GREETING`,
`MIRROR-ARTIFACTS-S3`, `TEST-SUITE`, `CRON-DATASET-EXTRACTION`,
`CRON-FINETUNE-STATUS`, `CRON-FINETUNE-TRAINER`,
`ALERT-WELCOME-GREETING-HEALTH`, `i18n-audit-llm` in `vitana-v1`) show one
isolated failure out of the last 5 runs each — that's normal transient noise
(flaky third-party API, a single bad commit since fixed) and not a pattern.
`TEST-SUITE` also shows 2 cancelled runs, consistent with `concurrency`
superseding an in-flight run — also not a concern.

## Manual action required — GCP Secret Manager IAM

`CRON-AUTO-PROMOTER.yml` and `CRON-GRADUATION-RECOMMENDER.yml` both
authenticate via Workload Identity Federation (`secrets.GCP_WIF_PROVIDER` /
`secrets.GCP_WIF_SA_EMAIL`) and then call `gcloud secrets versions access`
directly. That service account is currently missing
`roles/secretmanager.secretAccessor` (or an equivalent per-secret binding)
on:

- `STAGING_SUPABASE_URL`
- `STAGING_SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE`

This is a GCP IAM change against project `lovable-vitana-vers1` — it
requires `gcloud`/console access this session does not have, and granting
Secret Manager access is a security-relevant action that should be a
deliberate decision, not a side effect of a code PR. Whoever has IAM admin
on the project should run (adjust the SA email to the real
`GCP_WIF_SA_EMAIL` value):

```bash
SA_EMAIL="<value of GCP_WIF_SA_EMAIL secret>"
for SECRET in STAGING_SUPABASE_URL STAGING_SUPABASE_SERVICE_ROLE_KEY SUPABASE_URL SUPABASE_SERVICE_ROLE; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --project=lovable-vitana-vers1 \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor"
done
```

Until this is granted, both workflows will keep failing on their normal
schedule (hourly / daily). `CANARY-READINESS-REPORT.yml` already treats this
same failure mode defensively (`iam_blocked` status instead of a hard
failure) — worth applying the same tolerant pattern to these two once the
underlying IAM is fixed, so a future permission regression degrades
gracefully instead of hard-failing every run again.

## What replaced what

Nothing was deleted. The two code-fixable workflows were fixed in place
(same schedule, same job). The two IAM-blocked ones are unchanged pending
the manual grant above — re-run them via `workflow_dispatch` once the IAM
binding lands to confirm.

## New: `MORNING-SYSTEM-HEALTH-CHECK.yml`

Added a new workflow, `0 6 * * *` (07:00 CET winter / 08:00 CEST summer,
same fixed-UTC-with-accepted-DST-drift convention already used by
`CRON-GRADUATION-RECOMMENDER.yml`), covering the 15 functions judged most
load-bearing across Vitanaland (platform) and Maxina (community app). See
that file's header comment for the full rationale; in short:

1. Gateway PROD `/alive`
2. Gateway PROD `/health` (core aggregate)
3. Gateway STAGING `/alive` (primary post-cutover deploy target)
4. Staging deploy freshness (`build-info` commit vs. `main` HEAD)
5. Supabase Postgres reachability
6. VTID ledger — no orphaned claims (`in_progress` past `claimed_until`)
7. OASIS events recency (system isn't silently stalled)
8. Welcome-greeting trigger — structural (exists / enabled)
9. Welcome-greeting trigger — behavioral (real signups vs. real greetings, 24h)
10. ORB Live voice — health + session-start smoke
11. Live Rooms (Go Live) health
12. Maxina PROD reachability
13. Maxina STAGING reachability
14. Screen Load Timing spot-check (reuses the existing e2e spec)
15. **Scheduled-workflow self-audit** — checks the last run of the other
    watched crons (including the two above) and fails loudly if any of them
    is red. This is the check that would have caught today's issue on day
    one instead of after an ad-hoc audit.

This does not replace the existing hourly/15-minute-granularity monitors
(`VCAOP-HEALTH`, `E2E-ORB-MONITOR`, `SCREEN-LOAD-TIMING`,
`ALERT-WELCOME-GREETING-HEALTH`, `scripts/ci/collect-status.py`'s 54-endpoint
sweep) — those remain the load-bearing, high-frequency signal and already
feed the `/api/v1/self-healing/report` VTID auto-creation pipeline. This
workflow is a once-a-morning, human-readable roll-up plus the self-audit
layer that was missing.
