# VTID-05023 part 9 — the other services and CI's REST calls

Option B moves only PostgREST traffic (`/rest/v1`) to Aurora. The gateway was
designed for it in part 1–3 (R1(b): `SUPABASE_URL` → internal proxy,
`SUPABASE_PUBLIC_URL` → supabase.co). This part gives every other writer a
governed, reversible switch, and moves GitHub Actions' own REST calls.

Nothing here changes production on merge. Every switch defaults to "as today":
the `data_backend` input defaults to `keep`, and `DATA_REST_URL` is unset.

## 1. The switch: `data_backend` (keep | supabase | aurora)

One script does every task-definition change:
`scripts/aws/taskdef-data-backend.py --backend keep|supabase|aurora --service <svc> [--resolve] < in.json > out.json`
(tests: `scripts/aws/test/test_taskdef_data_backend.py`, run by
`npm run test:aurora-parity` and the `AURORA-PRIVILEGE-PARITY-UNIT` workflow).

| Backend | What changes |
|---|---|
| `keep` (default; what PUBLISH and every push deploy use) | Nothing. The input bytes are written back unchanged, so a task definition carries whichever backend it is on forward. |
| `aurora` | `SUPABASE_URL` valueFrom → `vitana/supabase/<env>/url-aurora-proxy` (value: the internal proxy URL). Gateways also get env `SUPABASE_PUBLIC_URL=https://inmkhvwdcuyhnxkgfvsb.supabase.co`. oasis-projector also gets `DATABASE_URL` → `vitana/aurora/prod/database-url`. |
| `supabase` (rollback) | The exact original references (full or partial ARN, as each live task definition had it on 2026-10-10) and `SUPABASE_PUBLIC_URL` removed. aurora → supabase gives back the original task definition exactly (tested on all seven). |

Every reference is changed in place (same position), nothing else is touched.
The script refuses: an unknown service or backend, a task definition of
another family (so a prod switch can never land on the staging task
definition), a task definition without exactly one `SUPABASE_URL` secret, a
`SUPABASE_URL`/`DATABASE_URL` reference that is neither the known Supabase
one nor a url-aurora-proxy ARN, and an aurora ARN of the wrong environment.

**Resolving the new secret's ARN.** The supabase references and the Aurora
database URL are pinned literals (they exist; describe-secret confirmed
2026-10-10). The url-aurora-proxy secrets are created in the window, so their
ARN suffix is unknown in advance: the script runs `describe-secret` (ARN
only, never the value). `ResourceNotFoundException` fails the deploy before
anything is registered. The prod deploy role has no `secretsmanager:Describe*`
(VTID-03880), so on `AccessDenied` the script uses the repository variable
`SUPABASE_URL_AURORA_PROXY_PROD_ARN` (staging: `..._STAGING_ARN`), validated
against `arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/supabase/<env>/url-aurora-proxy-XXXXXX`;
neither → fail. With only the variable, existence is not provable from the
role; a wrong ARN stops the new tasks and the workflow's automatic rollback
(VTID-04647/04950) restores the previous task definition.

### Workflows

| Workflow | Service key | Where the switch runs | Notes |
|---|---|---|---|
| `AWS-PROD-DEPLOY-GATEWAY.yml` | `gateway` (family `vitana-gateway-awsdr`) | own step "Build task-definition (data backend — VTID-05023)" before step 2/2, every deploy mode | Input 25 of 25 (GitHub's ceiling; `vtid-03958`/`vtid-03961` tests updated to 25 on purpose — `env_overrides` cannot carry a `valueFrom`). promote-staging takes only the image from staging; the task definition is the awsdr one, and the script refuses any other family. Use `deploy_mode=env-only` for the flip so no app code ships with it. |
| `AWS-STAGE-DEPLOY-GATEWAY.yml` | `gateway-staging` (family `vitana-gateway`) | register/roll split into its own step (the build step is at the VTID-03788 20,000-char limit) | Dispatchable; pushes have no inputs → `keep`, so a dispatched switch persists across later pushes. Staging role has describe-secret. Secret `vitana/supabase/staging/url-aurora-proxy`. |
| `AWS-PROD-DEPLOY-VERIFICATION-ENGINE.yml` | `verification-engine` | inside the register step, before `register-task-definition` | No env-only mode: it always rebuilds from `commit_sha` — pin the commit the service already runs. |
| `AWS-PROD-DEPLOY-ORB-AGENT.yml` | `orb-agent` | same | same |
| `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` | `autopilot-executor` | same | Registers only; the next `ecs:RunTask` picks the new revision. |
| `AWS-PROD-DEPLOY-OASIS-PROJECTOR.yml` | `oasis-projector` | same | Also moves `DATABASE_URL`. Service is at desired=0: a dispatch now fails its own "task HEALTHY" check and rolls back — do not dispatch in the window (see below). |
| (none) `AWS-PROD-DEPLOY-WORKER-RUNNER.yml` | `worker-runner` | — | Workflow retired by VTID-04327; service desired=0. The script supports the key so a revival can switch. |

A pinned commit that predates the script: `keep` deploys as before; any other
backend fails with "needs scripts/aws/taskdef-data-backend.py".
The job summary shows the input and the resulting references (secret names,
never values).

## 2. ECS inventory (read-only, 2026-10-10, cluster `Vitana-ECS-Cluster`)

Running (desired > 0):

| Service | Task def | SUPABASE_URL ref | Switch |
|---|---|---|---|
| `vitana-gateway-awsdr` (prod) | `vitana-gateway-awsdr:175` | `vitana/supabase/prod/url-OKnsxz` | AWS-PROD-DEPLOY-GATEWAY |
| `vitana-gateway` (staging) | `vitana-gateway:852/853` | `vitana/supabase/staging/url-I9rciI` (+ `AURORA_DATABASE_URL`) | AWS-STAGE-DEPLOY-GATEWAY |
| `vitana-vitana-verification-engine` | `:8` | `vitana/supabase/prod/url` (partial ARN) | AWS-PROD-DEPLOY-VERIFICATION-ENGINE |
| `vitana-orb-agent` | `:12` | `vitana/supabase/prod/url` (partial ARN) | AWS-PROD-DEPLOY-ORB-AGENT |
| `vitana-community-app-staging` | `vitana-community-app:372` | `vitana/supabase/prod/url` | **Not switched here** — the frontend container; the SPA's data URL is `VITE_DATA_API_URL` in `exafyltd/vitana-v1` (plan part 11, app PUBLISH). |

One-shot: `vitana-autopilot-executor:28` — `vitana/supabase/prod/url-OKnsxz` — AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.

Desired = 0, left untouched (they do not run; if one were scaled up it would
read and write the write-frozen, stale Supabase `public` schema — reviving any
of them needs its own VTID and a switch first):

| Supabase ref | Services |
|---|---|
| `vitana/supabase/prod/url` | `vitana-oasis-projector` (+ `DATABASE_URL` = `vitana/supabase/prod/database-url`; switch exists, see above), `vitana-worker-runner`, `vitana-auth-proxy`, `vitana-cognee-extractor`, `vitana-community-app`, `vitana-conductor`, `vitana-memory-indexer`, `vitana-vitana-memory-indexer`, `vitana-oasis-operator`, `vitana-openclaw-bridge`, `vitana-planner-core`, `vitana-validator-core`, `vitana-worker-core` |
| `vitana/supabase/staging/url` | `vitana-cloudshell-relay`, `vitana-crewai-kb-agent`, `vitana-crewai-prompt-synth`, `vitana-dev-console-ui`, `vitana-github-sync-service`, `vitana-lifetime-context-crew`, `vitana-mcp-gateway`, `vitana-oasis-approval`, `vitana-oasis-mcp-v2`, `vitana-qa-agent`, `vitana-test-agent`, `vitana-vitana-dev-gateway` |

## 3. GitHub workflows calling Supabase REST

After the flip Supabase `public` is write-frozen and stale, so CI must read and
write through `https://data.vitanaland.com` (the proxy's public surface,
`/rest/v1` only). Each REST base below is now
`${{ vars.DATA_REST_URL || secrets.SUPABASE_URL }}` — repository variable
`DATA_REST_URL` unset (today) = byte-for-byte the old value. Only the base
URL changes; the service-role key stays (PostgREST on Aurora verifies the same
JWT secret). The RPCs (`ci_*`) must exist on Aurora — covered by the schema
sync/parity parts, not re-checked here.

### Changed — 20 steps in 15 workflows (21 env references)

| Workflow | Step | Endpoint(s) |
|---|---|---|
| ALERT-NEWDAY-BRIEFING-LOOP.yml | Fetch recent stamp-write failures and reconnect-bucket briefing greetings | GET /rest/v1/oasis_events (2 calls) |
| ALERT-OASIS-LEDGER-INTEGRITY.yml | Assert the ledger records no false failures | POST /rest/v1/rpc/ci_ledger_integrity_check |
| ALERT-ORB-BOOTSTRAP-LATENCY.yml | Fetch recent ORB context-bootstrap latencies | GET /rest/v1/oasis_events |
| ALERT-ORB-SESSION-STATE-HEALTH.yml | Fetch ORB session-state health | POST /rest/v1/rpc/ci_orb_session_state_health |
| ALERT-PUSH-DISPATCH-HEALTH.yml | Fetch oldest unsent push-eligible notifications | GET /rest/v1/user_notifications |
| ALERT-WELCOME-GREETING-HEALTH.yml | Compare last-24h signups vs greetings | POST /rest/v1/rpc/ci_welcome_greeting_health |
| AWS-PROD-DEPLOY-GATEWAY.yml | Emit OASIS event + software_versions row | POST /rest/v1/software_versions, /rest/v1/oasis_events |
| AWS-STAGE-DEPLOY-GATEWAY.yml | Emit OASIS event + software_versions row | POST /rest/v1/software_versions, /rest/v1/oasis_events |
| CRON-AUTO-PROMOTER.yml | Run auto-promoter (`STAGING_SUPABASE_URL`) | services/gateway/scripts/auto-promoter.ts: GET+POST /rest/v1/oasis_events |
| CRON-GRADUATION-RECOMMENDER.yml | Run graduation recommender (`STAGING_SUPABASE_URL` and `SUPABASE_URL`) | graduation-recommender.ts: GET+POST /rest/v1/oasis_events |
| I18N-DB-SEED.yml | Propagate to every language | seed-db-i18n.ts via supabase-js (`DB_I18N_TARGET` unset = supabase → REST only) |
| I18N-DB-SEED.yml | Verify no language is left behind | same, read-only |
| I18N-DB-SEED.yml | Seed | same |
| JOURNEY-TRANSLATIONS-BACKFILL.yml | Run translation backfill | scripts/journey/generate-checklist-translations.mjs: /rest/v1/* |
| MORNING-SYSTEM-HEALTH-CHECK.yml | 5-12. Database + governance health (RPCs) | POST /rest/v1/rpc/ci_system_health, ci_welcome_greeting_health, ci_vital_systems_health |
| MORNING-SYSTEM-HEALTH-CHECK.yml | 16. ORB session-state health | POST /rest/v1/rpc/ci_orb_session_state_health |
| MORNING-SYSTEM-HEALTH-CHECK.yml | 17. OASIS ledger integrity | POST /rest/v1/rpc/ci_ledger_integrity_check |
| MORNING-SYSTEM-HEALTH-CHECK.yml | 21. Memory system health | POST /rest/v1/rpc/ci_memory_health |
| SMOKE-WELCOME-GREETING.yml | Verify trigger structure | POST /rest/v1/rpc/ci_welcome_greeting_health |
| STAGING-VERIFY.yml | Record result in OASIS | POST /rest/v1/oasis_events |

(MORNING-SYSTEM-HEALTH-CHECK row 5 still prints "Supabase Postgres
reachability"; after the flip it measures Aurora through PostgREST. Label
left as is.)

### Skipped

| Workflow | Step | Why |
|---|---|---|
| ALERT-APP-USERS-IDENTITY-DRIFT.yml | Query Supabase app_users count (PostgREST) | Deliberately the Supabase side of a Supabase-vs-Aurora comparison (Aurora is read via the RDS Data API). Pointing it at Aurora would compare Aurora with itself; after the flip it measures the part-12(i) reverse CDC. |
| MIGRATION-DRIFT-CHECK.yml | Snapshot live public tables (`/rest/v1/rpc/ci_schema_inventory`) | Owned by the concurrent part-8 change; not touched here. Needs the same decision there. |
| RUN-MIGRATION.yml | Apply migration / Reload PostgREST schema cache | Owned by part 8; SQL over the Supabase Management API, not PostgREST REST. |
| VTID-02409-BOOTSTRAP.yml | 3 steps | GCP-era one-off: SQL over the Management API (`SUPABASE_URL` only derives the project ref) and it dispatches the dead `EXEC-DEPLOY.yml`. |
| OASIS-PERSISTENCE.yml | Preflight - Ensure Test Env Vars | Test env for mocked tests (falls back to localhost); no real call. |
| CICDL-GATEWAY-CI.yml | Set Test Environment | Sets `http://localhost:54321`; no secret, no real call. |
| AWS-PROD-SETUP-SCHEDULED-EDGE-CALLS.yml | `EDGE_BASE` | `/functions/v1` — edge functions stay on Supabase (option B). |
| AWS-PROD-SETUP-POSTGREST-AURORA-PROXY-EDGE.yml | /rest/v1 probe | Already probes data.vitanaland.com itself. |
| SET-STAGING-TENANT-CONSENT.yml | — | Calls the staging gateway; `SUPABASE_URL` appears only in a comment. |
| AUTO-DEPLOY.yml (dead, GCP-era; CLAUDE.md §9) | — | No Supabase REST call; dead workflow, not dispatched. (EXEC-DEPLOY.yml / STAGE-DEPLOY.yml no longer exist in the tree.) |

Inventory method: every workflow file containing `SUPABASE_URL`,
`supabase.co` or `rest/v1`, parsed per step. Before this change: 29
`secrets.SUPABASE_URL` references in 20 files; 21 changed, 8 left (ALERT-APP-USERS
1, MIGRATION-DRIFT-CHECK 1, OASIS-PERSISTENCE 1, RUN-MIGRATION 2, VTID-02409 3).

## 4. Window steps (part 11) for these services

Prerequisites (before the window): prod proxy service
`vitana-postgrest-aurora-proxy-prod` running and healthy (part 1c; it was not
created yet on 2026-10-10); the edge `data.vitanaland.com` live (part 1c edge);
part 0 parity PASS.

1. **Create the two secrets** (owner; values are internal URLs):
   ```
   aws secretsmanager create-secret --region eu-central-1 \
     --name vitana/supabase/prod/url-aurora-proxy \
     --secret-string 'http://postgrest-aurora-prod.vitana.internal:8080' --query ARN --output text
   aws secretsmanager create-secret --region eu-central-1 \
     --name vitana/supabase/staging/url-aurora-proxy \
     --secret-string 'http://postgrest-aurora.vitana.internal:8080' --query ARN --output text
   ```
   Set repository variables `SUPABASE_URL_AURORA_PROXY_PROD_ARN` and
   `SUPABASE_URL_AURORA_PROXY_STAGING_ARN` to the printed ARNs. The execution
   role `vitana-ecs-task-execution-role` already reads `vitana/*`.
   Before the window, check from a staging task that
   `postgrest-aurora-prod.vitana.internal:8080/alive` answers: every service
   above runs in security group `sg-0fbcf7b59b1f0d685`, the same group as the
   proxy, but this session could not read the group's ingress rules.
2. **Freeze → final load → after-load → parity → verify** (part 11, other parts).
3. **Prod gateway first**: `AWS-PROD-DEPLOY-GATEWAY.yml` with
   `deploy_mode=env-only`, `data_backend=aurora`, reason citing VTID-05023.
   Its smoke + post-deploy checks run; a failure rolls back automatically.
4. **Staging gateway** right after: `AWS-STAGE-DEPLOY-GATEWAY.yml` with
   `data_backend=aurora` and `commit_sha` = the commit staging already runs.
   Staging shares the database and runs schedulers (reminders, calendar), so it
   must not keep writing to frozen Supabase.
5. **Set repository variable `DATA_REST_URL=https://data.vitanaland.com`.**
6. **orb-agent**, then **verification-engine**: their workflows with
   `data_backend=aurora` and `commit_sha` = the commit in the live image tag
   (they always rebuild; pinning ships no new code).
7. **autopilot-executor**: `data_backend=aurora`, `commit_sha` = the commit
   of the current `:LATEST` revision's image.
8. **oasis-projector / worker-runner: not dispatched** (desired=0; the
   projector workflow's health check needs a running task and would roll
   back). If either is ever scaled up: switch first (projector:
   `data_backend=aurora`, which also moves `DATABASE_URL`), then scale.

**Why the gateway first.** After the freeze every writer still on Supabase gets
write errors until it is switched. The gateway is the main writer and the only
member-facing one, so it goes first and its member-visible error window is the
shortest. The final load is complete before any flip, so a service writing to
Aurora early loses nothing; order only decides who sees errors and for how long.
The gateway's flip is also the one most likely to need a rollback, and doing
it first means that decision comes before anything else has moved. The
internal services (orb-agent, verification-engine, executor) tolerate a few
minutes of failed writes; CI's REST calls move with `DATA_REST_URL` right
after the gateways.

**Rollback** (within the part-12(i) window): same order — prod gateway
`deploy_mode=env-only, data_backend=supabase`; staging gateway
`data_backend=supabase`; delete repository variable `DATA_REST_URL`; then
orb-agent, verification-engine, autopilot-executor with `data_backend=supabase`
(pinned commits as above). The supabase references are pinned literals, so
rollback never depends on describe-secret.
