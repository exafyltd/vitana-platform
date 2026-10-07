# VTID-04923 — Plan sparring record

- Plan Sparring Gate: VTID-04868. Partner: `plan-sparring-partner` (independent, read-only).
- Change class: standard (.github/workflows + deploy). Rounds: 2.
- Final plan hash: `1f2685130752f15b21b1957f3451b5e5aa39eb5abf1d4c3a5c063cad62be9a95`
- Verdict: **converged**.
- Owner approval: in session 2026-10-06 ("Yes, here's the ARN …"), after the owner stored
  `vitana/gateway/staging/daily-api-key` and `vitana/gateway/prod/daily-api-key`.

## Final plan

<!-- plan:begin -->
## Context
Gateway STAGING-VERIFY @cdf104dd is 22/23; the only failure is VTID-04904 "live health reports the Daily.co key on
the staging task definition" (`/api/v1/live/health` → `daily_configured:false`). No AWS workflow wires
`DAILY_API_KEY` (only the dead GCP-era `scripts/deploy/deploy-service.sh`). Owner decision 2026-10-06: option (b) —
no gateway promotion until the exact candidate has a fully green (23/23) STAGING-VERIFY. The owner has now stored the
Daily.co API key in Secrets Manager (472838866351 / eu-central-1) as two plaintext secrets with the same value:
`vitana/gateway/staging/daily-api-key` and `vitana/gateway/prod/daily-api-key`.

Change class: **standard** (`.github/workflows` + deploy).

## Prerequisite (before the PR is written)
The owner supplies the full ARN (incl. the 6-character suffix) of `vitana/gateway/prod/daily-api-key` from the
AWS Console; the prod deploy role cannot resolve it. Without it the PR is not written.

## Scope
1. `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` — a new small step "Resolve Live Rooms Daily key" placed right
   after "Resolve Jev decision config", following the Jev pattern: `describe-secret
   vitana/gateway/staging/daily-api-key` (full ARN incl. suffix); found → append `{name:"DAILY_API_KEY",
   valueFrom:$ARN}` to `.sec` of `$RUNNER_TEMP/connected-apps.json`; not found / access denied → logged (warning
   for access denied), not wired, deploy never fails. The Connected Apps loop and its comment stay untouched.
   `connected-apps.json` is already merged into the task definition by name (strip-then-add, lines 1170–1171), so a
   redeploy never duplicates the entry. The task-definition step itself does not change (20,000-char run limit /
   VTID-03788 size guard untouched).
2. `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` — new small step "Build task-definition (Daily key)" modelled on
   "Build task-definition (internal token)": `env: DAILY_SECRET_ARN: <full ARN of vitana/gateway/prod/daily-api-key,
   supplied by the owner>` (the prod deploy role has no `secretsmanager:Describe*`, so a name cannot be resolved; the
   comment there says the execution role already reads `vitana/*`), jq strip `DAILY_API_KEY` then add
   `{name:"DAILY_API_KEY", valueFrom:$ARN}`. Takes effect only on an owner-approved production deploy; this PR deploys
   nothing to production.
3. `docs/validation/<VTID>/` — plan-sparring.md, acceptance.md, commands.log, outputs/, staging-tests.json
   (http GET `/api/v1/live/health` expect `daily_configured: true` on staging — read-only).
4. No application code, no migration, no secret value anywhere in the repo or logs (only names/ARNs).

## Verification
- Local: `actionlint`/YAML parse of both workflows; the repo's workflow size guard; jq snippet run on a sample task
  definition JSON to show strip-then-add yields exactly one `DAILY_API_KEY`.
- The existing read-only "Report DAILY_API_KEY presence" steps (stage :1250, prod :1445) need no change and serve as
  the post-deploy check on the live task definition.
- After merge (push to main → staging deploy): deploy log shows "resolved vitana/gateway/staging/daily-api-key →
  DAILY_API_KEY"; staging `/api/v1/live/health` `daily_configured:true`; STAGING-VERIFY on the new main commit reports
  23/23 (+ this VTID's own probe). Then the owner gets the gateway approval report (exact SHA, run id, full range,
  task-def/config implications, rollback f52f2ae5 / :152, 0/0 partner terms) and the session STOPS.

## Risks
- Execution role cannot read the new secret → staging tasks fail to start (ResourceInitializationError). Mitigation:
  the prod workflow comment states the execution role reads `vitana/*`, the same naming already works for
  fish-api-key/typesafe; the staging deploy has a circuit breaker/rollback; nothing reaches production.
- Wrong prod ARN → a future prod deploy would fail to start tasks; mitigated by the prod workflow's automatic rollback
  (VTID-04647) and by verifying the ARN string against the owner's console value before merge.
- Staging and prod now share one Daily account (owner accepted).
<!-- plan:end -->

## Round 1 — partner findings (summary)
- Verified: no AWS workflow wires DAILY_API_KEY (only the GCP-era deploy-service.sh); the staging optional loop and
  strip-then-add merge (stage :1170–1171); prod deploy role has no secretsmanager:Describe* (prod :505, :866, :935);
  `/api/v1/live/health` daily_configured = !!process.env.DAILY_API_KEY (live.ts:1750, :1759).
- F1 [minor] DAILY_API_KEY is not a Connected Apps item — use a separate step like Jev.
- F2 [minor] the full prod ARN (suffix) must be obtained before the PR.
- F3 [minor] dependency chain (secret exists, describe allowed, execution role reads it) — already in Risks.
- F4 [minor] mention the existing "Report DAILY_API_KEY presence" steps as post-deploy check.
- F5 [minor/positive] no secret value in repo or logs — confirmed.
- Verdict: CONVERGED (no blockers/majors).

## Planner responses — round 1
- F1 ACCEPTED — separate step after the Jev step; Connected Apps loop untouched.
- F2 ACCEPTED — prerequisite; owner supplied `…:secret:vitana/gateway/prod/daily-api-key-9wlfyX`.
- F3 ACKNOWLEDGED. F4 ACCEPTED. F5 ACKNOWLEDGED.

## Round 2 — partner
F1 closed, F2 closed, F3 acknowledged, F4 closed, F5 acknowledged. Placement after the Jev step verified valid
(connected-apps.json complete before the roll step consumes it). No new findings. Verdict: **CONVERGED**.
