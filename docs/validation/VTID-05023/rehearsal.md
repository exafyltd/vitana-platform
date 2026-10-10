# VTID-05023 part 10 — staging rehearsal against an Aurora clone

Plan part 10 (sparring F8, N7, answer Q6): the staging gateway and staging app run
against a **copy-on-write clone** of `vitana-aurora-prod` (never the production
cluster), with the staging gateway's schedulers and outbound senders off; part 0
runs against the clone before the staging host serves anything; a read-only
STAGING-VERIFY and a read-path load test prove it. Q6: "the inventory of those
jobs is the first task of part 10" — that inventory is sections A–F.

Evidence base: the code on `claude/jolly-wozniak-gueg67` @ `89aa9ab70`, and the live
staging task definitions read 2026-10-10 (read-only `describe-*`; secrets by name only):
`vitana-gateway:852`, `vitana-postgrest-aurora-staging:8`, `vitana-community-app:371`.

## Why this matters more on a clone than on today's staging

Today the staging gateway shares production's database, so most of its loops are
either off on staging or do the same work production does (idempotent claims).
**A clone is a byte copy of production's queues.** Every pending reminder, lifecycle
notification, Dev Autopilot execution in `cooling`/`running`, outbox row and FCM
device token is copied. A staging loop left on would process them **a second
time**, on the clone, and anything it sends outward (a push to a real device, a
GitHub PR, an ECS executor task — which itself talks to production Supabase — a
Microsoft/Apple/Google sync with a member's stored credentials, a TypeSafe/Bedrock
call) happens for real. Writes that stay on the clone are harmless (it is deleted
after); outward effects are not.

---

## A. In-process loops the staging gateway starts at boot

All started in the `app.listen` callback of `services/gateway/src/index.ts`.
"Staging today" = the value on `vitana-gateway:852`. "DB" = writes to the database
(on the clone during the rehearsal). "Outward" = anything leaving AWS/the clone.

| # | Loop (start) | What it does | DB | Outward | Switch | Staging today | Rehearsal |
|---|---|---|---|---|---|---|---|
| 1 | Autopilot event loop (`index.ts:1704`, `autopilot-event-loop.ts:1213`) | OASIS cursor → task state machine | yes | — | `AUTOPILOT_LOOP_ENABLED` exactly `true` | unset → **off** | `false` (explicit) |
| 2 | Operator planner (`index.ts:1721`, `operator-planner.ts:205`) | drafts specs for scheduled tasks every 5 min | yes | **LLM** (cost) | `OPERATOR_PLANNER_ENABLED` exactly `true` | `true` → **running** | `false` |
| 3 | Automations heartbeat (`index.ts:1750`) | `runHeartbeatCycle` every 60 s | shadow: writes recorded + skipped (`automation-shadow.ts`) | shadow blocks notify | `AUTOPILOT_HEARTBEAT_ENABLED`=`true` + `DEFAULT_TENANT_ID` | `true` → **running (shadow)** | `false`; keep `AUTOMATIONS_DELIVERY_MODE=shadow` |
| 4 | Reminder dispatch tick 30 s + sweeper 5 min (`index.ts:1777`, `reminders-dispatch.ts:211`) | fires due reminders | yes | **push (FCM)** | `REMINDERS_INPROCESS_DISPATCH_ENABLED`=`true` **and** on staging `REMINDERS_STAGING_DISPATCH_OVERRIDE`=`true` (`env.ts:30`) | both `true` → **running** | both `false` |
| 5 | Memory embedding backfill (`index.ts:1790`, `memory-embedding-backfill-loop.ts:35`) | AP-0910 backfill | yes | Bedrock Titan (cost) | `MEMORY_EMBEDDING_BACKFILL_LOOP_ENABLED`=`true`; refuses in shadow | unset → **off** | `false` (explicit) |
| 6 | Audiobook daily reminder 5 min (`index.ts:1800`, `audiobook-reminder-dispatch.ts:99`) | "today's episode" push | yes | **push (FCM)** | same two reminder switches; `AUDIOBOOK_REMINDERS_DISABLED=true` stops it alone | **running** | `AUDIOBOOK_REMINDERS_DISABLED=true` + #4's two `false` |
| 7 | Notification email fallback (`index.ts:1813`, `notification-email-fallback.ts:67`) | email digest | yes | **email (Resend)** | `EMAIL_FALLBACK_ENABLED`=`true` + Resend + **never when `VITANA_ENV=staging`** | **off** (no Resend key, staging block) | `false` (explicit) |
| 8 | Outbound HTTP outbox worker (`index.ts:1828`, `outbound-http-worker.ts:102`) | sends part-6 outbox rows | yes | **HTTP (edge fn → email)** | `OUTBOUND_HTTP_WORKER_ENABLED`=`true` + never on staging | **off** | `false` (explicit) |
| 9 | Auth-bridge reconciler 5 min (`index.ts:1840`, `auth-bridge-reconciler.ts:192`) | provisions/deletes vs GoTrue | yes | GoTrue admin reads | `AUTH_BRIDGE_RECONCILE_ENABLED`=`true` + never on staging | **off** | `false` (explicit) |
| 10 | Calendar default reminders 1 min (`index.ts:1853`, `calendar-reminders.ts:495`) | reconciles `reminders` vs calendar | yes | — | `CALENDAR_DEFAULT_REMINDERS_ENABLED`=`true` | `true` → **running** | `false` |
| 11 | VTNA reward sweep 6 h (`index.ts:1867`, `rewards/reward-sweep.ts:55`) | pays earned rewards | yes (ledger) | — | `VITANA_ENV≠staging` + ECS + `REWARD_SWEEP_ENABLED≠false` | **off** (staging block) | `REWARD_SWEEP_ENABLED=false` (belt) |
| 12 | Reward shop reservation sweep 5 min (`index.ts:1881`, `rewards/reward-shop.ts:243`) | releases unpaid holds | yes | Stripe (checkout state) | `VITANA_ENV≠staging` + ECS only (no flag) | **off** (staging block) | unchanged (`VITANA_ENV=staging`) |
| 13 | Calendar maintenance 1 h / 6 h (`index.ts:1893`, `calendar-rescheduler.ts:214`) | moves missed suggestions, reprioritises | yes | — | `CALENDAR_MAINTENANCE_ENABLED`=`true` | `true` → **running** | `false` |
| 14 | Google Calendar sync (`index.ts:1906`, `calendar-google-sync.ts:44`) | two-way sync | yes | **Google** | `CALENDAR_GOOGLE_SYNC_ENABLED`=`true` + Google OAuth client | `true`, but no `GOOGLE_OAUTH_CLIENT_*` → **not started** | `false` |
| 15 | Connected Apps sync 5 min (`index.ts:1920`, `connected-apps/hub.ts:634`) | Outlook/iCloud busy times, Google/iCloud contacts | yes | **Microsoft/Apple/Google with members' stored credentials** | `CONNECTED_APPS_SYNC_LOOP=false` stops it | unset → **running** | `false` |
| 16 | **Trial lifecycle notifications 5 min** (`index.ts:1929`, `lifecycle-notification-worker.ts:153`) | notifies fired lifecycle rows, marks `notified_at` | yes | **push + in-app** (`notifyUserAsync`) | **none** | **running** | **no switch** → clone neutralised (G step 3) |
| 17 | Recommendation scheduler (`index.ts:1939`, `recommendation-engine/scheduler.ts:452`): OASIS analysis 6 h, codebase scan, community regeneration, marketplace sync (daily) | generates recommendations | yes | marketplace catalogue APIs | `RECOMMENDATION_SCHEDULER_ENABLED=false` | unset → **running** | `false` |
| 18 | Morning brief (`index.ts:1954`, `guide/morning-brief-scheduler.ts:46`) | daily brief push | yes | push | `MORNING_BRIEF_ENABLED`=`true` | unset → **off** | `false` (explicit) |
| 19 | Product analytics rollup + purge (`index.ts:1963`, `product-analytics/rollup.ts:219`) | daily rollup, deletes expired | yes (deletes) | — | `PRODUCT_ANALYTICS_ROLLUP_ENABLED=false` | unset → **running** | `false` |
| 20 | Jev voice backstop clusters (`index.ts:1972`, `jev/gates/backstop-cluster-gate.ts:101`) | daily judgement | yes | **TypeSafe API** (cost) | `JEV_VOICE_BACKSTOP_CLUSTERS_MODE` off\|shadow\|enforce | `shadow` → **running** | `off` |
| 21 | Jev slow voice sessions (`index.ts:1981`, `slow-session-gate.ts:101`) | daily judgement | yes | TypeSafe | `JEV_VOICE_SLOW_SESSION_MODE` | `shadow` → **running** | `off` |
| 22 | Jev opener outcomes (`index.ts:1990`, `opener-outcome-gate.ts:117`) | daily judgement | yes | TypeSafe | `JEV_VOICE_OPENER_OUTCOMES_MODE` | `shadow` → **running** | `off` |
| 23 | Jev root-cause roll-up (`index.ts:1999`, `root-cause-rollup-gate.ts:85`) | daily + Monday roll-up | yes | TypeSafe | `JEV_ROOT_CAUSE_ROLLUP_MODE` | `shadow` → **running** | `off` |
| 24 | **Autonomous self-improvement engine** (`index.ts:2007`, `recommendation-engine/autonomous-engine.ts:470-490`): startup cleanup, signals + auto-activate 5 min, feedback 10 min, cleanup 6 h | recommendations, OASIS | yes | none found (auto-activate only with `AUTO_ACTIVATE_RECOMMENDATIONS=true`, unset) | **none** | **running** | **no switch** → accepted, clone-only writes |
| 25 | Self-healing reconciler 10 min (`index.ts:2018`, `self-healing-reconciler.ts:915`) | orphaned pending rows, voice probes, rollback recommendations | yes | probes the gateway (voice/LLM cost); Google Chat (webhook unset on staging) | `SELF_HEALING_RECONCILER_ENABLED=false` | unset → **running** | `false` |
| 26 | Plan Sparring reconciler 1 h (`index.ts:2030`, `plan-sparring/reconciler.ts:54`) | read-only tamper check, P1 OASIS | OASIS only | — | `PLAN_SPARRING_RECONCILER_ENABLED`=`true` | unset → **off** | `false` (explicit) |
| 27 | Idle session closer 5 min (`index.ts:2044`, `idle-session-closer.ts:218`) | `user_session_summaries` | yes | **LLM** (llm-router → Bedrock) | `IDLE_SESSION_CLOSER_ENABLED=false` | unset → **running** | `false` |
| 28 | Intent embedding worker 5 s (`index.ts:2056`, `intent-embedding-worker.ts:149`) | embeds `user_intents` | yes | Bedrock Titan (cost) | `INTENT_EMBEDDING_WORKER_ENABLED=false` | unset → **running** | `false` |
| 29 | OAuth token refresher (`index.ts:2070`, `oauth-token-refresher.ts:224`) | refreshes `social_connections` | yes | **Google token endpoint** | `OAUTH_TOKEN_REFRESHER_ENABLED=false`; needs Google client | **not started** (no client) | `false` |
| 30 | Admin awareness KPIs 5 min (`index.ts:2083`, `admin-awareness-worker.ts:36`) | `tenant_kpi_current/daily` upserts | yes | — | `ADMIN_KPI_WORKER_ENABLED=false` | unset → **running** | `false` |
| 31 | Shopify catalogue sync (`index.ts:2095`, `shopify-sync.ts:179`) | products.json → discover | yes | Shopify | `SHOPIFY_SYNC_ENABLED`=`true` | unset → **off** | `false` (explicit) |
| 32 | Awin programme sync (`index.ts:2104`, `awin-sync.ts:95`) | joined programmes | yes | Awin | `AWIN_SYNC_ENABLED`=`true` | **off** | `false` (explicit) |
| 33 | Awin conversions (`index.ts:2114`, `awin-conversions.ts:221`) | credits conversions to rewards | yes (ledger) | Awin | `AWIN_CONVERSIONS_ENABLED`=`true` | **off** | `false` (explicit) |
| 34 | **Dev Autopilot background executor** (`index.ts:2124`, `dev-autopilot-execute.ts:4356`): claim, auto-approve, plan, reaper | executions | yes | **GitHub PRs, ECS RunTask of the executor (which uses production Supabase), LLM** | `DEV_AUTOPILOT_EXECUTOR_ENABLED=false`; loop owner `DEV_AUTOPILOT_LOOP_OWNER_ENV` (unset = staging owns it) | **running** (staging is the loop owner) | `false` |
| 35 | Dev Autopilot watchers CI/deploy/verify (`index.ts:2138`, `dev-autopilot-watcher.ts:1221`) | advances executions | yes | **GitHub merges, workflow dispatches** (`DEV_AUTOPILOT_WATCHER_LIVE=true`) | `DEV_AUTOPILOT_WATCHERS_ENABLED=false` | **running** | `false` + `DEV_AUTOPILOT_WATCHER_LIVE=false` |
| 36 | Watcher observer 60 s (`index.ts:2152`, `watcher/watcher-observer.ts:97`) | `watcher_steps`, lessons | yes | — | `WATCHER_OBSERVER_ENABLED=false` | unset → **running** | `false` |
| 37 | Longevity news fetcher 12 h (`index.ts:2253`, `longevity-news-fetcher.ts:302`) | RSS → news items | yes | RSS feeds, og:image scraping | `LONGEVITY_NEWS_FETCHER_ENABLED=false` | unset → **running** | `false` |
| 38 | Nova Sonic keep-warm 4 min + model warm 90 s (`routes/orb-live.ts:2348/2354`, at import) | keeps Bedrock warm | — | Bedrock (small cost) | `NOVA_SONIC_KEEPWARM_MS=0`, `NOVA_SONIC_MODEL_WARM_MS=0` | **running** | unchanged (no DB, keeps voice latency representative) |
| 39 | Decision-contract cache refresh 15 s ×3 (`decision-contract/policy-resolver.ts:269`, `compatibility-resolver.ts:367`, `conflict-pair-resolver.ts:197`) | reads `decision_policy`… | **read-only** | — | none (read-only) | running | unchanged — reads the clone |

One-shot boot work (no switch, clone-only writes, accepted): `initializeAutopilotController`
ensures the `VTID-01178` ledger row (`index.ts:1695`); `bootstrapEmbeddedAgents` PATCHes
`agents_registry` (`index.ts:2242`); the conversation-system snapshot writes one OASIS
event 45 s after boot when the fingerprint changed (`index.ts:2212`); cache warmers
(`index.ts:2160-2196`) read; `warmNavService` GETs the staging app's `/nav-registry.json`.

## B. Timers that are not background jobs (no action)

- Import-time in-memory sweeps, no I/O: `task-intake-service.ts:138`,
  `d33-availability-readiness-engine.ts:1228`, `session-memory-buffer.ts:83`,
  `extraction-dedup-manager.ts:80`, `cross-turn-state-engine.ts:1112`.
- Per-request SSE polls and heartbeats, alive only while a client is connected, reads:
  `routes/events.ts:1083`, `routes/devhub.ts:223/254`, `routes/reminders.ts:249/250`,
  `routes/dev-autopilot.ts:1263`, `routes/operator.ts:761`, `routes/realtime-relay.ts:63`
  (+ `realtime/chat-messages-poller.ts:90`, `realtime/generic-cursor-relay.ts:128`).
- Per-voice-session timers in `orb/live/**` and `routes/orb-live.ts` (keepalives,
  preconnect, prewarm): only while someone talks to the ORB.
- `auto-logger-metrics.ts:34` `startTelemetryScheduler` has no caller.

## C. What still reaches production after the repoint

Repointing `SUPABASE_URL` moves only `/rest/v1` (PostgREST → clone). These stay on
production and must stay read-only during the rehearsal:

1. **Storage** (`/storage/v1` passthrough → Supabase Storage, whose `storage.objects`
   lives in the production Supabase database). Reads only; no upload.
2. **Auth** (`/auth/v1` passthrough → production GoTrue). Sign-in only. A sign-up or
   deletion through staging would write production `auth.users` and fire Supabase's
   provisioning triggers on **production** Supabase, not the clone.
3. **Edge functions** (`/functions/v1` passthrough and the app's direct calls) run on
   Supabase against **production data** (`DATA_API_URL` is unset in the edge secrets
   until the window). A function invoked during the rehearsal never touches the clone.
4. **Direct Postgres to production Aurora**: `AURORA_DATABASE_URL`
   (`vitana/aurora/prod/database-url`, admin) and `AURORA_RLS_DATABASE_URL`
   (`vitana/aurora/prod/postgrest-authenticator-uri`) are on the staging task def today.
   Users: `services/db-i18n/aurora-client.ts` (only with `DB_I18N_TARGET=aurora`, unset;
   writes also need `AURORA_I18N_WRITES=enabled`, unset), `services/aurora-client.ts`
   (admin health reads). Overlay: remove the admin URL, repoint the RLS URL to the clone.
5. **Executor tasks** dispatched by #34 use their own task definition, whose Supabase
   is production → #34 off.
6. Redis: `REDIS_HOST` (prod ElastiCache) is set but unused; the client reads
   `REDIS_URL`, which is unset (`services/redis-client.ts:22`). Nothing shared.
7. `DB_HOST`/`DB_READER_HOST`/`DB_PASSWORD` (RDS proxy / Aurora reader / an `rds!db-…`
   secret) are set on the staging gateway but no gateway code reads them.

Also noted (not part 10, worth a look): `GATEWAY_SERVICE_TOKEN` on the staging task def
is sourced from `vitana/supabase/prod/service-role-key`, and `ENV`/`ENVIRONMENT` are
`prod` on the staging task def (`VITANA_ENV=staging` is what the code reads).

## D. Things outside the gateway that call it

EventBridge Scheduler entries whose Input targets the **staging** gateway
(`scripts/aws/setup-eventbridge-cron-migration.sh` defaults
`AUTOMATIONS_GATEWAY_URL` and `TEST_CONTRACTS_GATEWAY_URL` to
`https://preview-aws-gateway.vitanaland.com`): the 21 `autopilot-*` AP-xxxx crons
(staging runs them in shadow), `gateway-test-contracts-scheduled-run` (*/15),
`gateway-test-contracts-missing`, `gateway-dev-memory-handoff-sweep`,
`gateway-community-autopilot-scan` (writes nothing unless
`COMMUNITY_AUTOPILOT_SCAN_ENABLED=true`, unset). The full list is in
`scripts/aws/rehearsal-staging-overlay.json` → `eventbridge_schedules_to_disable`.
The live list could not be read from this session (`scheduler:ListSchedules` is denied
to `claude-code-aws-agent`). Control: disable them for the window; belt: the overlay
removes `GATEWAY_INTERNAL_TOKEN` (internal-token routes then 403) and sets
`SCHEDULED_NOTIFICATIONS_AUTH_MODE=enforce` (today `log`, which would let a tokenless
call through). `gateway-push-dispatch`, `gateway-whats-new`, `gateway-daily-feature-tip`
target production and are unaffected.

## E. Community app, proxy, and other writers to the clone

- **Staging community app** (`vitana-community-app-staging`, `vitana-community-app:371`):
  static nginx (`vitana-v1/Dockerfile`, `nginx.conf` has no `proxy_pass`). Nothing
  server-side. Its task def injects `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE` secrets and
  `DB_HOST`/`REDIS_HOST` env that nginx never reads — unnecessary service-role exposure,
  separate cleanup. All its data traffic is from the browser: `/rest/v1` goes to the
  clone only once `VITE_DATA_API_URL_STAGING` points at a staging data host (none
  exists yet — G step 6).
- **Staging PostgREST proxy** (`vitana-postgrest-aurora-proxy`): writes only when a
  request writes. `PGRST_DB_PRE_REQUEST` is not set on staging, so no provisioning
  hook runs. Today its `PGRST_DB_URI` is production Aurora's authenticator.
- **pg_cron on the clone**: the clone gets a copy of the cluster parameter group
  (`shared_preload_libraries` includes `pg_cron`, `cron.database_name=vitana`). If
  `aurora-cutover-cron.sql` is applied to the clone, its 21 jobs run there (clone-only
  writes; Aurora has no `pg_net`, so no HTTP). Intended: it rehearses part 6.
- **DMS**: every task's target endpoint is production Aurora; nothing replicates into the
  clone. The part-8b/12(i) CDC script hardcodes the production host
  (`aurora-to-supabase-cdc.sh:30`), so it cannot be rehearsed on the clone unchanged.
- Nothing else knows the clone's endpoint.

## F. Counts and "needs a switch"

- **39 recurring loops** in section A (plus the 3 one-shot boot writes and the
  section-B timers). **36 have an off switch** (env flag or the `VITANA_ENV=staging`
  hard block); the overlay sets every one of them explicitly.
- **Running on staging today: 24** (#2, 3, 4, 6, 10, 13, 15, 16, 17, 19, 20-25, 27, 28, 30, 34-38), plus the read-only #39.
- **Without an off switch: 3.**
  - **Needs a switch (writes and sends):** `startLifecycleNotificationWorker` —
    `services/gateway/src/index.ts:1929`, `services/gateway/src/services/lifecycle-notification-worker.ts:153`
    (push + in-app notifications to real members; mitigated for the rehearsal by
    `scripts/aws/rehearsal-clone-neutralize.sql`).
  - **Needs a switch (writes):** `initializeAutonomousEngine` —
    `services/gateway/src/index.ts:2007`, `services/gateway/src/services/recommendation-engine/autonomous-engine.ts:465-490`
    (no outbound sender found; clone-only writes accepted for this rehearsal).
  - Read-only, no action: the decision-contract cache refreshers (#39).
  - Also without a flag but staging-blocked: #12 reward reservation sweep (only
    `VITANA_ENV`/ECS), acceptable.
- No switch was added in this task (as instructed).

---

## G. How to run the rehearsal

Order matters: nothing on staging points at the clone until step 5 passes.

0. **Window prep (owner/admin, before anything):** freeze merges that touch
   `services/gateway/**` and `services/postgrest-aurora-proxy/**` for the rehearsal
   (a push-deploy rebuilds the staging task def without the overlay — fail-safe, it
   reverts everything together, but it ends the rehearsal); disable the section-D
   schedules; confirm the workflow changes in section K exist.
1. **Clone** — `AWS-REHEARSAL-AURORA-CLONE.yml`, `action=create` (set
   `logical_replication=true` only if 7a / 12(i) are rehearsed too, see H). Then
   `action=status` for the endpoint.
2. **Secret** — create `vitana/aurora/rehearsal/postgrest-authenticator-uri` (overlay
   `window_prep_secrets`). Not created by any script here.
3. **Neutralise the clone** —
   `bash scripts/aws/rehearsal-clone.sh sql scripts/aws/rehearsal-clone-neutralize.sql`
   (every FCM token revoked, every waiting lifecycle row marked notified; each
   statement raises unless it runs on `vitana-aurora-rehearsal-writer`).
4. **Cutover SQL on the clone, runbook order** (all through
   `scripts/aws/rehearsal-clone.sh sql <file>`, never `aurora-run-sql.sh`, which is
   hard-wired to production). The clone already carries the 2026-10-09 load, after-load
   and the 2026-10-10 embedding backfill, so this proves the scripts are re-runnable on
   the real catalogue and adds the parts not yet on production Aurora:
   1. `aurora-cutover-schema-sync.sql` (Step 0, idempotent)
   2. `aurora-cutover-vector-postload.sql`, `aurora-cutover-recreate-foreign-keys.sql`,
      `aurora-cutover-schema-sync-views.sql` (= `aurora-cutover-after-load.sh`; run the
      three files one by one — the wrapper is hard-wired to production)
   3. `aurora-cutover-auth-bridge.sql` (part 4)
   4. `aurora-cutover-outbox.sql` (part 6 B) — and **verify** the side-effects.md
      open item: `notify_welcome_discount()` on the clone no longer needs `pg_net`
   5. `aurora-cutover-cron.sql` (part 6 A; needs `pg_cron` preloaded — the clone's
      group copy has it; first line is `CREATE EXTENSION pg_cron`) — and **verify**
      jobs 20/21 make no HTTP call (side-effects.md)
   6. `aurora-realtime-setup.sql` (part 7a) — only with `logical_replication=true`
   7. the part-8 `NOTIFY pgrst` DDL trigger (agent A's file, when it exists)
   Not on the clone: `aurora-cutover-vector-preload.sql` and the DMS final load (DMS
   targets production Aurora; a clone-targeted load needs its own target endpoint).
5. **Part 0 on the clone** —
   `python3 scripts/aws/aurora-privilege-parity.py --check --strict --cluster vitana-aurora-rehearsal --supabase-snapshot supabase-snapshot.json --role-map postgres=<aurora owner role> --report docs/validation/VTID-05023/privilege-parity-report-clone.json`
   (the script reads the clone's own `MasterUserSecret`, which `create` sets up). On
   failure `--fix`, review, apply with `rehearsal-clone.sh sql`, re-check. **Nothing
   on staging points at the clone until this exits 0.**
6. **Staging proxy → clone** — `PGRST_DB_URI` = the rehearsal secret (overlay
   `staging_proxy`), via the staging proxy workflow (section K). For the app half:
   a staging data host (e.g. `data-staging.vitanaland.com`, ALB rule priority < 10 →
   the staging proxy, `PUBLIC_HOST` set on the staging proxy) — does not exist yet.
7. **Staging gateway → staging proxy with the overlay** — one task-def revision with
   `scripts/aws/rehearsal-staging-overlay.json` → `staging_gateway` (section K).
   Check: `GET https://preview-aws-gateway.vitanaland.com/api/v1/admin/health` →
   `supabase_host == "postgrest-aurora.vitana.internal"`; the boot log shows every
   loop of section A as disabled except #38/#39 and #16/#24 (no switch).
8. **Staging app** — repository variable `VITE_DATA_API_URL_STAGING` = the staging data
   host, rebuild staging (exafyltd/vitana-v1 `AWS-STAGE-DEPLOY-FRONTEND.yml`).
9. **STAGING-VERIFY (read-only)** — gateway + community-app smoke suites, the
   VTID-05023 change suite, and the rehearsal checks in section I.
10. **Load test of read paths** — section J.
11. **Revert** — staging gateway: a normal staging deploy (drops the overlay);
    staging proxy: redeploy with the production authenticator secret; app: unset the
    variable and rebuild; re-enable the section-D schedules.
12. **Delete** — `AWS-REHEARSAL-AURORA-CLONE.yml`, `action=delete`,
    `confirm=vitana-aurora-rehearsal`; delete the rehearsal secret.

## H. Parameter group and logical replication on the clone

- `restore-db-cluster-to-point-in-time` does **not** inherit the source's cluster
  parameter group: when `--db-cluster-parameter-group-name` is omitted the clone gets
  the engine default (`default.aurora-postgresql17`), which has no `pg_cron`. The
  source today uses `vitana-aurora-pg17-prod` (user values: `cron.database_name=vitana`,
  `shared_preload_libraries=pg_cron,pg_stat_statements`, `max_connections=200`,
  `work_mem=65536`; **no** `rds.logical_replication` yet).
- The clone must not share the production group: a change made for the rehearsal
  (e.g. `rds.logical_replication=1`) would sit pending on production until its next
  reboot. `rehearsal-clone.sh create` therefore copies it to
  `vitana-aurora-rehearsal-cluster-params` and attaches the copy; the delete removes it.
- `rds.logical_replication` is static. With `--logical-replication` the copy gets
  `1` **before** the clone's writer is created, so the writer boots with it — no reboot,
  and production's group is never touched. That is what 7a (Realtime) and 12(i)
  (Aurora→Supabase CDC) need on the clone.
- Instance parameter group: the source writer uses `default.aurora-postgresql17`; the
  clone's writer gets the same.

## I. STAGING-VERIFY coverage for part 10

| Check | Existing coverage | Gap |
|---|---|---|
| Sign-in | every signed-in spec (`/auth/v1/token?grant_type=password`, allowed by the guard), e.g. `vitana-v1/tests/e2e/staging/vtid-04676-notification-settings.staging.spec.ts` | none (sign-in stays on production GoTrue by design) |
| Feed reads | `vtid-04957-feed-cards`, `vtid-04973-feed-order`, `vtid-05013-feed-image-resize` | they do not assert *where* `/rest/v1` went |
| Profile reads | `vtid-04979-social-channels` (`/me/profile`) | same |
| Storage image | `vtid-05013-feed-image-resize` (`/storage/v1/render/image/public/…`), `vtid-04921-group-chat-latest` | none (storage stays on Supabase) |
| Read-only function | `vtid-04922-room-link-preview` GETs the `og-event` **edge function** | it runs on Supabase against production data, so it does not exercise the clone |
| Realtime SUBSCRIBED | **none** | missing |
| Gateway on the clone | `smoke/gateway.json` "admin health reports staging" | no assertion on `supabase_host` |

Missing (not written here — they belong in `exafyltd/vitana-v1` / the staging-verify
runner, and some need infrastructure that does not exist yet):

1. **Data-host routing spec** (`vitana-v1`): signed in as the test user, open `/home`
   and `/me/profile`; assert every `/rest/v1/` request went to the staging data host
   with 2xx and **none** to `inmkhvwdcuyhnxkgfvsb.supabase.co/rest/v1/`.
2. **Read-only RPC on the clone**: one `GET /rest/v1/rpc/<stable function>` through the
   data host (PostgREST allows GET for STABLE/IMMUTABLE functions, so the guard's
   non-GET abort does not fire). Which function: open question.
3. **Realtime SUBSCRIBED**: needs a Realtime server against the clone (no staging twin of
   `AWS-PROD-DEPLOY-REALTIME-AURORA.yml` exists; `vitana-realtime-aurora` is not deployed)
   and `VITE_REALTIME_URL_STAGING`. Without it, realtime on staging stays on Supabase and
   SUBSCRIBED proves nothing about the clone.
4. **Gateway probe** (rehearsal-only, not in the VTID suite or normal runs would fail):
   `GET /api/v1/admin/health` → `supabase_host == "postgrest-aurora.vitana.internal"`,
   plus the existing VTID-05023 probe `GET /api/v1/auth/config` →
   `supabase_url == https://inmkhvwdcuyhnxkgfvsb.supabase.co` (R1(b) under the overlay).
5. **Guard update** (`scripts/ci/staging-verify/staging-guard.ts`, canonical copy):
   `GUARDED_HOST` must include the staging data host (and a staging realtime host), or
   a write through the data host would not be aborted; `PRODUCTION_HOST` should include
   `data.vitanaland.com` and `realtime.vitanaland.com`.

## J. Read-path load test

- **Tool: k6** (single binary, thresholds fail the run, scenarios with ramping
  arrival rate, JSON summary for the evidence pack). autocannon is fine for one URL but
  has no per-request mix or thresholds.
- **GET only.** Sign in **once** in `setup()` as the test user (one password grant to
  production GoTrue — not under load) and share the token; the run stays under the 1 h
  token lifetime. No storage, auth, functions or realtime URLs (those are production
  Supabase).
- **Targets:** (a) the staging data host `/rest/v1/*` (PostgREST → clone) and (b) the
  staging gateway's member read endpoints (gateway → internal proxy → clone; the gateway
  verifies JWTs locally, `middleware/auth-supabase-jwt.ts:319`).
- **Mix** (per iteration, weights): 30 % feed list (`/rest/v1/<feed table>?select=…&order=created_at.desc&limit=20`),
  15 % profile by id, 15 % group chat list (latest 50), 10 % calendar entries for a
  week, 10 % notifications (latest 30), 10 % wallet balance/ledger (latest 20), 10 %
  gateway member read endpoints (the ones the app calls on `/home`). Exact table and
  column lists are taken from the app's real requests in a recorded HAR of the
  STAGING-VERIFY run, so the test reads what members read.
- **Shape:** 2 min warm-up at 5 req/s, ramp to 50 req/s over 5 min, hold 10 min, spike to
  150 req/s for 2 min, ramp down. Thresholds: `http_req_failed < 1 %`,
  p95 < 800 ms, p99 < 2 s on the data host; no 5xx. Watch Aurora clone
  `DatabaseConnections`, CPU and the proxy task CPU at the same time.
- **Caveat:** the staging proxy is 1 task with PostgREST defaults; part 1(b) sizing
  (`PGRST_DB_POOL`, `PGRST_DB_MAX_ROWS=1000`, ≥ 2 tasks) is set only by the prod proxy
  workflow. Either deploy the staging proxy with the same settings for the run or treat
  the numbers as a floor. No baseline load is ever put on production Supabase.

## K. Workflow changes needed (documented, not made — other agents own these files)

1. **`AWS-STAGE-DEPLOY-GATEWAY.yml`** (agent B): a `workflow_dispatch` input
   `rehearsal_overlay` (boolean, default false). When true, after the existing env/secret
   rebuild: refuse unless `vitana-aurora-rehearsal` exists and is `available`, then apply
   `scripts/aws/rehearsal-staging-overlay.json` → `staging_gateway` in `apply_order`
   (secret refs resolved with `describe-secret`, never values), and print the resulting
   env names in the summary. Push-triggered deploys ignore it (= the revert).
2. **`AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml`**: a dispatch input
   `db_uri_secret` (default `vitana/aurora/prod/postgrest-authenticator-uri`, allowed:
   that or `vitana/aurora/rehearsal/postgrest-authenticator-uri`) used in place of the
   two hard-coded references (preflight and the jq secret rewrite), plus optional
   `public_host` for `PUBLIC_HOST`.
3. **Staging data host**: a staging twin of
   `AWS-PROD-SETUP-POSTGREST-AURORA-PROXY-EDGE.yml` (host `data-staging.vitanaland.com`,
   target the staging proxy service, its own target group and priority < 10).
4. **Staging Realtime** (only if 7a is rehearsed): a staging twin of
   `AWS-PROD-DEPLOY-REALTIME-AURORA.yml` against the clone.
5. **Clone-aware runners**: `aurora-run-sql.sh`, `aurora-cutover-after-load.sh`,
   `aurora-cutover-embedding-backfill.py`, `aurora-realtime-set-password.sh` and
   `aurora-to-supabase-cdc.sh` hard-code `vitana-aurora-prod`. For part 10 the new
   `rehearsal-clone.sh sql` replaces the first two; the others need a `CLUSTER`
   override if they are rehearsed.

## L. Files and tests (this change)

- `.github/workflows/AWS-REHEARSAL-AURORA-CLONE.yml` — dispatch-only, `reason` required,
  `action` create|delete|status, `confirm` for delete, OIDC `AWS_PROD_ROLE_ARN`,
  account/region guard, runs the guard self-test first, job summary.
- `scripts/aws/rehearsal-clone.sh` — the only code that creates/changes/deletes the clone.
- `scripts/aws/rehearsal-clone-neutralize.sql` — clone-only neutralisation (step 3).
- `scripts/aws/rehearsal-staging-overlay.json` — the overrides (sections A, C, D).
- `scripts/aws/test/rehearsal-clone.sh` — fake `aws` on PATH, no network.

Run: `bash scripts/aws/test/rehearsal-clone.sh` (suggested npm script:
`"test:rehearsal-clone": "bash scripts/aws/test/rehearsal-clone.sh"`, not added here to
avoid a `package.json` conflict). 67 checks: the guard refuses 15 production-aimed or
off-allowlist calls (equals-form, reboot, failover, prod parameter group, prod ARN for
the Data API) and allows the 2 legitimate shapes; delete refuses 7 wrong identifiers
before any AWS call, an untagged cluster and a foreign member; dry-run create/delete/sql
make no mutating call; real create/delete/sql (fake aws) touch only the clone, with
production only as `--source-*`; wrong account refused; the workflow is dispatch-only and
makes no AWS call of its own besides the identity check; every neutralise statement
carries the clone-identity guard. Mutation-checked: removing the target check, the
identifier check, the tag check, the dry-run branch, or attaching the production
parameter group each fails the suite.

## Open questions

1. Does `AWS_PROD_ROLE_ARN` allow `rds:RestoreDBClusterToPointInTime`,
   `CreateDBInstance`, `CopyDBClusterParameterGroup`, `ModifyDBClusterParameterGroup`,
   `ModifyDBCluster` (`--manage-master-user-password` also needs
   `secretsmanager:CreateSecret`/`kms` on the default key), `EnableHttpEndpoint`,
   `DeleteDBInstance/Cluster/ClusterParameterGroup`, `AddTagsToResource`? Not checkable
   from this session.
2. The live EventBridge Scheduler list (section D) — `scheduler:ListSchedules` is denied
   to the session user; confirm at window prep.
3. Cloud Map name of the staging proxy: `postgrest-aurora.vitana.internal:8080` is from
   `setup-postgrest-aurora-proxy-staging.sh`; `servicediscovery:GetService` is denied to
   the session user (service registry `srv-n7dhq5dwhkmhy7ky` is attached).
4. Which STABLE function is the "read-only function" check (section I.2)?
5. Is 7a rehearsed on the clone (needs a staging Realtime deployment) or only proven
   locally (`npm run test:realtime-local`)? Same for the 12(i) CDC (needs a clone-aware
   `aurora-to-supabase-cdc.sh` and a target that is not production Supabase).
6. FCM on staging: `notification-service.ts:30` initialises firebase-admin with
   `projectId: 'lovable-vitana-vers1'` (decommissioned) via ADC; whether any push can
   actually leave staging is unclear. The rehearsal does not rely on it failing — the
   overlay and the neutralise step are the controls.
7. `REMINDERS_STAGING_DISPATCH_OVERRIDE=true` means staging dispatches real members'
   reminders against production today (VTID-04963 "Phase 2 sets false"). Intended?
