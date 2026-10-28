# Plan sparring record — VTID-05023 (Aurora cutover, option B)

- Change class: standard
- Plan hash (sha256 of the text between the plan markers): `26932fc1eef4d940bbaef9749bfbba88f3d7af965c8f6cf68312e4159197b56f`
- Rounds: 3 (cap). Verdict: **ESCALATED** (R1, R2 open at the cap; realtime, rollback and reboot are owner decisions).
- Partner: general-purpose agent run with the plan-sparring-partner instructions on Opus (the Opus 4.6-on-Bedrock partner type was not loaded in the session at the time; deviation from rule 53 recorded).
- VTID note: VTID-05023 was allocated 2026-10-10 09:04Z, before this sparring (a breach of rule 51, disclosed to the owner at Gate 1). It was not used for further work until approval.

## Owner approval (Gate 1)

**APPROVED 2026-10-10 by the owner ("Yes") — plan hash 26932fc1eef4d940…**, with the planner's recommendation on each escalated decision:
1. R1 gateway data routing: **(b)** repoint the gateway's `SUPABASE_URL` to the internal proxy (gateway-only passthrough for auth/storage), `SUPABASE_PUBLIC_URL` for every member-visible URL.
2. R2: **accepted** — lazy hook skips read-only and null-uid requests; gateway calls `ensure_provisioned(uuid)`.
3. Realtime: **7a** — self-hosted Supabase Realtime against Aurora before the switch.
4. Rollback: **12(i)** — T+2h window with replica-mode Aurora→Supabase CDC.
5. Aurora reboot for `rds.logical_replication=1`: **approved** (no member impact while production runs on Supabase).

---

# Plan: Aurora cutover, option B — every public-schema writer on Aurora in one window, no split-brain

Change class: **standard** (infra, deploy, both repos)
Repos: exafyltd/vitana-platform, exafyltd/vitana-v1
Context: runbook `docs/AURORA-CUTOVER-RUNBOOK-2026-09-20.md` (platform, branch
`claude/jolly-wozniak-gueg67`, draft PR #3830). Data path proven on the real
cluster: dress rehearsal 2026-10-09 (663 tables, 0 errors), after-load (358
FKs, 19 views), embedding backfill (7,942/7,942). Owner chose option B
2026-10-10. Revision 2 after sparring round 1 (responses below the plan).

<!-- plan:begin -->
## Goal
One cutover window after which every writer of the `public` schema writes to
Aurora, members stay signed in, and nothing keeps writing `public` on
Supabase unnoticed. Supabase stays GoTrue, Storage, Realtime transport and
edge-function host (runbook Step 12 moves those later).

## Design (revision 3)
**Only database traffic moves, the same way in every client.** Every
supabase-js client (app, gateway, edge functions) keeps its `SUPABASE_URL` =
supabase.co and gets a `global.fetch` wrapper that rewrites
`${SUPABASE_URL}/rest/v1/*` to `${DATA_API_URL}/rest/v1/*` when the data URL
is set (app: `VITE_DATA_API_URL` = https://data.vitanaland.com; gateway:
`DATA_API_URL` = the Cloud Map name; edge: `DATA_API_URL` = the public host).
Auth, storage (incl. every public/signed URL the gateway builds), functions
stay on supabase.co. The proxy serves only `/rest/v1` and `/alive`; the
nginx passthrough drafted earlier is removed. Realtime moves to a
self-hosted server only if the owner picks 7a (separate client, part 7).

## Parts
0. **Privilege parity gate (before anything is public; re-run after every final
   load)**: compare Aurora's `role_table_grants`, `routine_privileges` and
   default privileges for anon/authenticated/service_role with Supabase's,
   reapply Supabase's anon lockdown (incl. `increment_wallet_balance`), revoke
   anything Supabase does not grant, fail on any difference; list tables
   without RLS and match Supabase exactly. Cross-tenant RLS read check with two
   existing accounts through the endpoint, reads only.
1. **Proxy**: (a) nginx serves `/rest/v1` and `/alive` only (passthrough
   draft reverted; `/auth` passthrough removed too, nothing uses it under this
   design). (b) Sizing: `worker_processes auto`,
   `worker_connections 4096`, `PGRST_DB_POOL` sized against Aurora
   `max_connections`, `PGRST_DB_MAX_ROWS=1000`, role `statement_timeout`
   matching Supabase (anon 3s, authenticated 8s), ECS autoscaling (min 2).
   (c) Separate **prod** service + task family + `AWS-PROD-DEPLOY-POSTGREST-
   AURORA-PROXY.yml` (dispatch-only, pinned commit) and a staging twin on its
   own host; the existing `vitana-postgrest-aurora-staging` family stays
   staging. ALB/TG/DNS wiring by a governed, dispatch-only workflow
   (`AWS-PROD-SETUP-POSTGREST-AURORA-PROXY-EDGE.yml`, required `reason`,
   idempotent) — no hand-run `aws` changes, no rule-17 exception. Test
   `test/routing.sh` updated to the `/rest`-only surface (everything else 501).
2. **Public endpoint** `data.vitanaland.com` → prod proxy, Cloudflare WAF/bot
   rule skipped for that host, JWT-secret equality check.
3. **App and gateway**: the fetch wrapper (above) in the app's
   `client.ts` and in the gateway's Supabase client factory, plus a gateway
   unit test that no URL leaving the gateway (storage public/signed URLs,
   thumbnails) contains the data host; the app part: + `VITE_DATA_API_URL` as a per-
   environment variable in `AWS-STAGE-DEPLOY-FRONTEND.yml` /
   `AWS-PROD-DEPLOY-FRONTEND.yml` (unset = today's behaviour); version bump so
   open tabs reload. The earlier storageKey/storage-host changes are dropped.
   Vitest: rewrite only `/rest/v1`, leave auth/storage/functions/realtime.
4. **Auth→Aurora bridge** (new sign-ups, confirmations, deletions), three
   layers, all idempotent: (a) lazy: PostgREST `db-pre-request` function on
   Aurora provisions `app_users`/profile/wallet/tenant rows for `auth.uid()`
   when missing, before the request runs (no FK race); (b) fast path: one
   database webhook on `auth.users` → gateway endpoint (service token);
   (c) reconciliation every 5 min, gateway job comparing Supabase
   `auth.users` with Aurora `app_users`, provisioning missing and handling
   deleted users. At the flip the eight provisioning triggers that write
   `public` are disabled; `before_auth_user_delete_cleanup_contacts` stays.
   Gap backfill by (c). CI tests: race (write before webhook), lost webhook,
   deletion.
5. **Edge functions on Aurora**: `_shared` data client: `/rest` via
   `DATA_API_URL`, auth/storage via `SUPABASE_URL`; when `CUTOVER_DONE=true`
   and `DATA_API_URL` is unset it throws (no silent fallback). Migrate every
   function that touches `public` tables; CI guard fails any function calling
   `createClient` directly; Deno test of the routing.
6. **Scheduled and HTTP side effects**: first a live inventory of every
   `cron.job`, every `supabase_functions.hooks` entry, and every trigger whose
   function calls `net.*` / `supabase_functions.http_request` (any schema),
   written to `docs/validation/<VTID>/side-effects.md` with one line per item:
   Aurora replacement (pg_cron on Aurora with `shared_preload_libraries`,
   gateway outbox, or EventBridge Scheduler → gateway endpoint) or a recorded,
   owner-visible drop. At the flip unschedule/disable every Supabase item on
   the list (no double firing); the window checklist requires every line
   resolved. CI test per replacement.
7. **Realtime** (owner decision): (a) self-host Supabase Realtime on ECS
   against Aurora (logical replication, reboot, publication for the 33
   tables, same JWT secret) at `realtime.vitanaland.com` (own ALB host rule
   via the part-1 workflow). The app gets a separate `RealtimeClient`
   (`@supabase/realtime-js`) for that host, token from `onAuthStateChange`,
   behind a `realtimeChannel()` helper; all 36 `postgres_changes` and 24
   broadcast/presence call sites move to it (one Realtime server, no split),
   and server-side broadcasters (inventory in part 6's file) move too —
   recommended; or (b) switch with `postgres_changes` silent (chat,
   notifications, wallet live updates) and do (a) after. Tests: Vitest that
   channels use the new host while auth stays on supabase.co; CI local
   Postgres + Realtime proves change delivery; staging proves SUBSCRIBED.
8. **Migrations and schema**: repoint the migration workflows
   (`RUN-MIGRATION.yml`, `MIGRATION-DRIFT-CHECK.yml`, `apply-*-migration.yml`)
   at Aurora; install a `NOTIFY pgrst` DDL event trigger on Aurora; schema
   freeze from final load to flip.
8b. **Storage authorization after the flip**: list every storage.objects
   policy and every other policy that calls a SECURITY DEFINER helper or
   reads `public`; for the tables they read (`chat_group_members`,
   `thread_participants`, `media_uploads`, …) run a one-way Aurora→Supabase
   DMS CDC task (target `AfterConnectScript=SET session_replication_role=
   replica`, so no Supabase trigger fires). Read-only staging check: an
   existing member opens an existing chat attachment.
9. **Other services**: repoint verification-engine, orb-agent, both staging
   services in the window through their workflows.
10. **Staging rehearsal against an Aurora clone** (copy-on-write clone of
    `vitana-aurora-prod`, never the prod cluster; part 0 runs against the
    clone before the staging host serves anything): staging gateway + staging
    app on the staging proxy → clone, with the staging gateway's schedulers
    and outbound senders (push, email, payments) disabled for the rehearsal.
    Read-only STAGING-VERIFY: sign-in, feed/profile reads, a storage image, a
    read-only function, realtime SUBSCRIBED; load test of read paths.
11. **Cutover window**: freeze (role REVOKE on tables; reads keep working)
    → at the flip: revoke EXECUTE from API roles only on SECURITY DEFINER
    `public` functions that no policy references (list computed from
    `pg_policies` × `pg_proc`), unschedule the part-6 inventory → final load → after-load → embedding backfill → privilege
    parity gate (part 0) → verify → flip gateway (prod workflow, Cloud Map),
    other services, edge secret, bridge webhook, app PUBLISH with
    `VITE_DATA_API_URL` → verify. Supabase `public` stays write-frozen; a
    5-minute drift monitor compares Supabase with Aurora per table, excluding
    tables written by the part-8b and part-12(i) CDC tasks, and alerts on any
    other change on Supabase.
12. **Rollback** (owner decision): (i) bounded window T+2h with an Aurora→
    Supabase DMS CDC task for all `public` tables created before the flip
    (logical replication as in 7a; target in replica mode so no Supabase
    trigger, push or email fires; proven on the clone in part 10), after
    which rollback is not offered; or (ii) no data-preserving rollback,
    declared up front.

## Order
0–3 first (nothing member-facing changes while `VITE_DATA_API_URL` is unset;
the public host stays dark until part 0 passes). Then 4–9. Then 10. Part 11
only after 10 passes; the window and date go to the owner then.

## Out of scope
Moving Auth, Storage or edge-function hosting off Supabase; the 16 enum
columns; `signup_funnel`.

## Test plan
- `services/postgrest-aurora-proxy/test/routing.sh` (`/rest` + `/alive` only).
- Gateway unit test: no outgoing URL contains the data host.
- Privilege-parity script (part 0) with a CI unit test over fixture catalogs.
- Vitest: fetch-wrapper routing (part 3).
- Deno: edge data client routing + direct-createClient guard (part 5).
- CI against local Postgres (+ pg_cron, + Realtime): bridge endpoint (4),
  cron/EventBridge replacements (6), realtime delivery (7a).
- Staging (read-only, Aurora clone): part 10 suite + read-path load test.
- Window: row and embedding counts, privilege parity, `/alive` + build-info,
  read-only smoke as the test user; no production writes as tests.
<!-- plan:end -->

## Planner responses — round 1
- F1 ACCEPTED — new part 0 (privilege parity gate, before the host goes public and after every final load). Q1: no parity check is recorded since `setup-aurora-postgrest-grants.sh`; part 0 creates it.
- F2 ACCEPTED — new part 4 (auth→Aurora bridge via one auth.users webhook → gateway; Supabase triggers neutralised; gap backfill; CI test).
- F3 ACCEPTED — freeze extended (EXECUTE revoke on SECURITY DEFINER, cron/webhooks unscheduled), drift monitor added, rollback made explicit as an owner decision (part 12).
- F4 ACCEPTED — design changed: only `/rest/v1` moves for the app (fetch wrapper); auth/storage/functions/realtime stay on supabase.co. storageKey + storage-host changes dropped (incl. the MeetupDetailsDrawer site). Q2 answered by this change.
- F5 ACCEPTED — part 1b sizing + autoscaling + read-path load test (part 10); Q7: gateway via Cloud Map.
- F6 ACCEPTED — part 1c: prod service/family + dispatch-only prod workflow, staging twin on its own host, ALB wiring governed or recorded as an exception.
- F7 ACCEPTED — new part 8.
- F8 ACCEPTED — part 10 rehearses against an Aurora clone, with staging schedulers and outbound senders disabled. Q6: the inventory of those jobs is the first task of part 10.
- F9 ACCEPTED — fail-loud helper, CI guard, Deno test; tests listed for parts 4–7.
- F10 ACCEPTED — per-environment `VITE_DATA_API_URL` in the workflows, version bump.
- F11 ACCEPTED — WAF/bot skip rule for the data host; long streams are moot (functions stay on supabase.co).
- Owner decisions carried to Gate 1: realtime (7a/7b), rollback (12 i/ii).

## Planner responses — round 2
- F6 ACCEPTED (no exception): ALB/TG/DNS wiring moves into a governed dispatch-only workflow (part 1c).
- N1 ACCEPTED: gateway uses the same `/rest`-only fetch split (`DATA_API_URL`), `SUPABASE_URL` stays supabase.co, so storage public/signed URLs keep the public host; unit test added. Proxy passthrough removed. Q1 answered.
- N2 ACCEPTED: EXECUTE revoke limited to functions no policy references, done at the flip; storage-policy tables replicated Aurora→Supabase in replica mode (part 8b); staging attachment check. Q2: the policy list is the first task of 8b.
- N3 ACCEPTED: three-layer idempotent bridge (lazy `db-pre-request`, webhook, reconciliation); delete-cleanup trigger kept; race/lost-webhook/deletion CI tests. Q3 answered by layer (a).
- N4 ACCEPTED: full side-effect inventory (cron, `supabase_functions.hooks`, any trigger calling net/http_request) with a replacement or recorded drop per line; window checklist. Q4: the inventory file is part 6's first deliverable.
- N5 ACCEPTED: replica-mode target for every Aurora→Supabase CDC task, proven on the clone; drift monitor compares against Aurora and excludes CDC-written tables.
- N6 ACCEPTED: separate `RealtimeClient` on `realtime.vitanaland.com` behind a `realtimeChannel()` helper; all postgres_changes and broadcast/presence sites and server-side broadcasters move; Vitest. Q5 answered.
- N7 ACCEPTED: part 0 runs against the clone first.

## Round 3 — partner result (verbatim summary)
Closed: F6, N1 (intent), N2, N3 (webhook/reconciliation/deletion), N4, N5, N6, N7.
R1 [major] Gateway has no single client factory: 113 direct createClient sites and 885 raw `${SUPABASE_URL}/rest/v1` URLs bypass a factory wrapper; reads would silently hit frozen Supabase. Options: (a) process-wide fetch override + CI guards, or (b) repoint gateway SUPABASE_URL to the internal proxy (with gateway-only passthrough) + SUPABASE_PUBLIC_URL for member-visible URLs.
R2 [major] Lazy db-pre-request provisioning fails on GET (read-only tx, 25006) and does nothing for service_role gateway writes. Fix: skip on read-only/null uid; ensure_provisioned(uuid) RPC called by the gateway; CI tests.
R3 [minor] Part 8b needs rds.logical_replication=1 + Aurora reboot regardless of 7/12; add slot-lag alarm.
Verdict: ESCALATED (round cap) — owner decides R1, R2, realtime 7a/7b, rollback 12 i/ii, reboot.

Plan hash (sha256 of text between markers): 26932fc1eef4d940bbaef9749bfbba88f3d7af965c8f6cf68312e4159197b56f
Partner: general-purpose agent with the plan-sparring-partner instructions, model "opus" (the Opus 4.6-on-Bedrock partner type was not loaded in this session) — recorded deviation from rule 53.

## Round 1 — partner findings (one line each; verdict NOT CONVERGED)
- F1 [blocker] Publishing the proxy gives the public anon key more than on Supabase (GRANT ALL to anon in setup-aurora-postgrest-grants.sh; Supabase's anon RPC lockdown incl. increment_wallet_balance not on Aurora; ~57 tables without RLS).
- F2 [blocker] auth.users triggers keep provisioning new sign-ups on Supabase only; Aurora FKs to app_users then fail.
- F3 [blocker] "Frozen Supabase fails loudly" and the rollback do not hold (role REVOKE only; pg_cron, SECURITY DEFINER keep writing; no export tool; restore-grants snapshot stale).
- F4 [major] Proxying auth/storage/functions concentrates all members on 2 egress IPs (Supabase per-IP limits). Simpler: move only /rest/v1 via a fetch wrapper.
- F5 [major] Proxy undersized (1 nginx worker, PGRST pool 10, no max-rows, no statement_timeout).
- F6 [major] Member-facing prod service deployed by a staging workflow and a hand-run script (rule 17, rules 46–50).
- F7 [major] Migration workflows keep targeting Supabase; no pgrst schema reload on Aurora.
- F8 [major] Staging rehearsal on the prod Aurora cluster with live schedulers/senders is not isolated.
- F9 [major] Edge helper's silent fallback to SUPABASE_URL; no tests for parts 5–8.
- F10 [minor] VITE_SUPABASE_URL lives in committed .env; open tabs keep old URL.
- F11 [minor] Cloudflare 100 MB/100 s limits and WAF challenges on the data host.

## Round 2 — partner findings (verdict NOT CONVERGED; F1–F5, F7–F11 closed, F6 acknowledged)
- N1 [major] Gateway on an internal data URL would hand members unreachable storage public/signed URLs.
- N2 [major] Revoking EXECUTE on all SECURITY DEFINER functions breaks RLS reads; storage policies read stale Supabase tables after the flip.
- N3 [major] Webhook bridge is async/lossy; FK race on first writes; delete-cleanup trigger must stay.
- N4 [major] Webhook/cron/http-trigger inventory incomplete (supabase_functions.hooks, net.* triggers in any schema).
- N5 [major] Reverse CDC would fire Supabase triggers (repeat pushes) and flood the drift monitor.
- N6 [major] Realtime 7a not implementable by config: supabase-js builds the realtime URL from the base URL.
- N7 [minor] Part 0 must also gate the clone/staging public host.
