# Plan — lock /api/v1/scheduled-notifications/* behind the internal token (VTID-04677, allocated 2026-09-26 before the sparring gate existed)

Repo: exafyltd/vitana-platform @ 0d55b1804 (main)

<!-- plan:begin -->
## Problem
Every POST under `/api/v1/scheduled-notifications/*` (17 routes in
`services/gateway/src/routes/scheduled-notifications.ts`, mounted at
`index.ts:1135`) accepts anonymous requests from the public internet. Several
fan out to every member of a tenant (push-dispatch, daily-feature-tip,
whats-new, morning-briefing, weekly-digest, night-push, daily-pace…). Anyone
who knows the path can trigger member-wide pushes.

## Facts established (live, 2026-10-05)
- Callers today:
  1. EventBridge → Lambda `vitana-push-dispatch` → prod `/push-dispatch` every minute (200s in CloudWatch).
  2. EventBridge → Lambda `vitana-daily-feature-tip` → prod `/daily-feature-tip` daily.
  3. EventBridge → Lambda `vitana-whats-new` → prod `/whats-new` daily (script `setup-eventbridge-whats-new.sh`).
  4. Shared Lambda `vitana-cron-dispatch` (`setup-eventbridge-cron-migration.sh`) defines jobs for
     `/reminders-tick`, `/reminders-sweeper`, `/daily-pace-notifications`, `/daily-feature-tip`, `/night-push`
     without `auth`. CloudWatch shows none of these firing in the last hour (reminders run in-process,
     `reminders-dispatch.ts:210/227`), so these schedules are probably not deployed; to be confirmed.
  5. In-process self-calls from `services/automation-handlers/engagement-events.ts` (lines ~437/463/557/583/704)
     to `/morning-briefing`, `/weekly-digest`, `/diary-reminder`, `/weekly-reflection`, `/upcoming-events`
     via `GATEWAY_INTERNAL_URL || localhost`, no auth header.
  6. Command Hub only GETs `/health` (stays open).
- Secrets: `vitana/gateway/prod/internal-token` (created 2026-10-05) and `vitana/gateway/staging/internal-token`
  (created 2026-09-26, value rotated 2026-10-05). Prod/staging ECS execution role `vitana-ecs-task-execution-role`
  may read `vitana/*` (inline policy `vitana-ecs-execution-secrets`).
- Staging deploy (`AWS-STAGE-DEPLOY-GATEWAY.yml` ~L956) logs "internal-token secret absent" although the secret
  exists; the `describe-secret` error is swallowed (`2>/dev/null || true`). Prod deploy workflow does not wire
  `GATEWAY_INTERNAL_TOKEN` at all.
- Existing pattern to reuse: `middleware/ledger-write-auth.ts` (VTID-04727) — mode switch `log` (default) /
  `enforce` / `off`, same check in all modes, log lines list the callers still to fix.

## Change (one PR, staging first; enforcement OFF by default)
1. **Gateway middleware** `middleware/scheduled-notifications-auth.ts`: accept ONLY
   `X-Gateway-Internal == GATEWAY_INTERNAL_TOKEN` (non-empty env, `crypto.timingSafeEqual` on equal-length
   buffers — an improvement over the plain `===` every other X-Gateway-Internal site uses, not a reuse of it;
   retrofitting those sites is a separate follow-up). No `exafy_admin` JWT path: these routes fan out real pushes
   to every member, and no human caller exists (Admin › Notifications "Send" uses its own admin route).
   Mode `SCHEDULED_NOTIFICATIONS_AUTH_MODE` = `log` (default, unset) | `enforce` | `off`, same mode semantics as
   `ledger-write-auth.ts`. **/health exclusion:** the middleware itself passes `GET /health` through (explicit
   method+path check, unit-tested), and is registered with `router.use` at the top of the router so every POST
   defined below it is covered. In log mode a would-be rejection logs method, path, caller IP and user-agent
   (never the header value) and passes. `GET /health` additionally reports `auth_mode` (the resolved mode) and
   `internal_token_configured` (boolean only) so staging can prove the deployed state.
   Replace ALL six `// public-route` markers (L552, L769, L885-886, L1086, L1097, L1492 — four of which still
   claim "protected by GCP IAM") with `// auth: scheduled-notifications-auth (VTID-04677)`.
2. **In-process self-calls**: the five `engagement-events.ts` fetches send `X-Gateway-Internal` from
   `process.env.GATEWAY_INTERNAL_TOKEN` via one small helper; when unset they send nothing (log mode keeps working).
3. **Lambdas** (scripts only; owner re-runs them in CloudShell after the PR is on prod):
   - `setup-eventbridge-push-dispatch.sh`, `-daily-feature-tip.sh`, `-whats-new.sh`: Lambda reads the secret
     named in env `GATEWAY_INTERNAL_TOKEN_SECRET_ID` (default `vitana/gateway/prod/internal-token`) once per
     container and sends `X-Gateway-Internal`; exec role gets `secretsmanager:GetSecretValue` on exactly that
     secret. If the secret read fails the Lambda logs an error and still sends the request without the header
     (fails loud in enforce mode, keeps notifications flowing in log mode).
   - `setup-eventbridge-cron-migration.sh`: per-job secret choice — jobs targeting the prod gateway use
     `vitana/gateway/prod/internal-token`, jobs targeting staging keep the staging secret; the remaining
     scheduled-notifications jobs get `auth: gateway_internal`; exec role may read both secrets.
     **Remove its `gateway-daily-feature-tip` entry**: the same schedule name is owned by the dedicated
     `setup-eventbridge-daily-feature-tip.sh` (which the owner re-ran on 2026-10-05, so the dedicated Lambda is
     what is live); keeping both means whichever script ran last silently wins.
4. **Deploy workflows**:
   - Prod `AWS-PROD-DEPLOY-GATEWAY.yml`: add `GATEWAY_INTERNAL_TOKEN` as an ECS secret referenced by name
     `vitana/gateway/prod/internal-token` (strip-then-add; prod deploy role has no secretsmanager:Describe*).
     Do NOT set the auth mode on prod (stays `log`).
   - Staging `AWS-STAGE-DEPLOY-GATEWAY.yml`: print the `describe-secret` error instead of swallowing it, so the
     "absent" mystery is diagnosable; set `SCHEDULED_NOTIFICATIONS_AUTH_MODE=log` explicitly. If the cause is
     the staging deploy credentials lacking `secretsmanager:DescribeSecret` on this secret, that IAM grant is an
     owner CloudShell step (exact command delivered with the evidence).
5. **Tests**: unit tests for the middleware (all three modes, token match/mismatch/empty env, exafy_admin JWT,
   /health open, header value never logged); a source test that every non-health route is behind it; tests for
   the engagement-events header; script syntax (`bash -n`) + pin tests for the workflow edits (existing
   pin-test pattern, VTID-03788 run-block size guard); update the VTID-04226 pin test
   (`test/vtid-04226-eventbridge-test-contract-schedules.test.ts:59,110`) from 31 to 30 jobs for the removed
   `gateway-daily-feature-tip` entry.
6. **Staging suite** `docs/validation/VTID-04677/staging-tests.json` (read-only): anonymous `GET
   /api/v1/scheduled-notifications/health` → 200 JSON with `auth_mode === "log"` and
   `internal_token_configured` present (boolean). No POST is ever sent from the suite: on staging in log mode an
   anonymous POST would run a real dispatch against the shared production database. The reject/pass behaviour
   of the middleware is proven in CI unit tests.

## Rollout
a. Merge → staging (log mode). b. PUBLISH to prod (log mode, token wired). c. Owner re-runs the four
Lambda scripts. d. The 24 h observation window starts only after (c): any would-be rejection after that is a
caller still to fix. Note: `recommendation-cleanup`, `signal-cleanup`, `recommendation-expiry`, `weekly-summary`
and `meetup-reminders` have no known caller, so silence on them proves nothing; enforce still protects them,
and retiring dead routes is a separate follow-up. e. Separate small change sets
`SCHEDULED_NOTIFICATIONS_AUTH_MODE=enforce` on staging, verify, then prod on the owner's yes.

## Out of scope
Rotating tokens; the GCP `setup-cloud-scheduler.sh` historical list; changing what any route sends.

## Change class
standard (route auth, middleware, deploy workflows, AWS scripts).

## Scope (files)
- services/gateway/src/middleware/scheduled-notifications-auth.ts (new)
- services/gateway/src/routes/scheduled-notifications.ts
- services/gateway/src/services/automation-handlers/engagement-events.ts
- scripts/aws/setup-eventbridge-{push-dispatch,daily-feature-tip,whats-new,cron-migration}.sh
- .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml, .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml
- services/gateway/test/… (new tests), docs/validation/VTID-04677/*
<!-- plan:end -->

## Plan hash
`sha256(text between the plan markers) = 7156537b496b281d676ec49151b5c200a7baf58fc6373e4675209db01409d82b`

## Partner findings (verbatim summary)
Round 1 — verified premises: 17 POST routes + GET /health (`scheduled-notifications.ts`), mount `index.ts:1135`,
`ledger-write-auth.ts:26-44` mode pattern, the five self-calls in `engagement-events.ts`, prod workflow has no
`GATEWAY_INTERNAL_TOKEN`, staging `describe-secret` swallows its error (`AWS-STAGE-DEPLOY-GATEWAY.yml:959`).
- F1 [major] staging test relied on `/health` reporting `auth_mode`, which did not exist and was out of scope.
- F2 [major] six `// public-route` markers, not two; four still claim "protected by GCP IAM".
- F3 [major] how `router.use` excludes `GET /health` was unspecified.
- F4 [minor] the "reused" pattern compares with `===`, not timing-safe.
- F5 [minor] `gateway-daily-feature-tip` defined in two scripts with the same schedule name.
- F6 [minor] five routes have no known caller; silence on them proves nothing.
- F7 [minor] an `exafy_admin` JWT path would let an admin fire tenant-wide pushes.
Round 2 — F1–F7 closed. New: F8 [minor] the VTID-04226 pin test counts 31 jobs; removing one makes it 30.
Verdict: CONVERGED.

## Owner approval
"yes, approved" — in session, 2026-10-05.

## Planner responses (round 1)
- F1 [major] ACCEPTED — /health now reports `auth_mode` + `internal_token_configured`; staging test asserts `auth_mode === "log"` (Change §1, §6).
- F2 [major] ACCEPTED — all six `// public-route` markers replaced (Change §1).
- F3 [major] ACCEPTED — middleware passes `GET /health` explicitly and is registered at the top of the router; unit-tested (Change §1).
- F4 [minor] ACCEPTED — timing-safe compare stated as an improvement, not reuse; retrofit of the other sites is a follow-up.
- F5 [minor] ACCEPTED — `gateway-daily-feature-tip` removed from cron-migration; the dedicated script owns it (Change §3).
- F6 [minor] ACCEPTED — rollout notes the five routes with no known caller (Rollout d).
- F7 [minor] ACCEPTED — exafy_admin JWT path dropped; token only (Change §1).
- Q3 — the observation window starts only after the owner re-runs the scripts (Rollout d), so pending cron jobs are expected noise before that and a caller to fix after it.

## Planner responses (round 2)
- F8 [minor] ACCEPTED — VTID-04226 pin test job count 31 → 30 added to Change §5.

## Verdict
CONVERGED after 2 rounds (partner: plan-sparring-partner). Round 1: 3 major + 4 minor, all accepted.
Round 2: F1–F7 closed, 1 new minor (F8) accepted. No open or disputed blocker/major.
