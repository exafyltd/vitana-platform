# Aurora cutover option B — platform parts (VTID-05023)

Approved plan: `docs/validation/VTID-05023/plan-sparring.md` (Gate 1, plan hash 26932fc1…).
Nothing here changes production on merge: the prod proxy service and edge are created only by dispatch-only workflows, and `SUPABASE_PUBLIC_URL` defaults to `SUPABASE_URL`.

AC-1: The PostgREST-Aurora proxy's internal (default) server serves `/rest/v1` from PostgREST and passes `/auth`, `/storage`, `/functions`, `/realtime` (WebSocket upgrade) through to Supabase with the right Host; uploads are unbuffered (30 MB passes); functions are capped at 50 MB; unknown paths answer 501.
TEST: services/postgrest-aurora-proxy/test/routing.sh (npm run test:proxy-routing) — outputs/proxy-routing.txt

AC-2: The public server block (`PUBLIC_HOST`, data.vitanaland.com) serves only `/rest/v1` and `/alive`; auth, storage, functions and realtime answer 404 and no request reaches Supabase.
TEST: services/postgrest-aurora-proxy/test/routing.sh ("public:" checks, "public host never reached Supabase")

AC-3: The privilege-parity gate fails on any grant, RLS, default-privilege, role-setting, attribute or membership Aurora has beyond Supabase (incl. PUBLIC/anon EXECUTE on increment_wallet_balance), and emits fix SQL without executing writes.
TEST: scripts/aws/test/test_aurora_privilege_parity.py (npm run test:aurora-parity) — outputs/aurora-parity.txt

AC-4: With the gateway's `SUPABASE_URL` on the internal proxy origin and `SUPABASE_PUBLIC_URL` on supabase.co, storage public URLs, signed URLs, the video thumbnail URL, `GET /auth/config` and the Command Hub CSP use the public origin and never contain the internal host; unchanged today.
TEST: services/gateway/test/lib/supabase-public-url.test.ts, services/gateway/test/vtid-05023-supabase-public-url-cutover.test.ts — outputs/gateway-public-url.txt

AC-5: A new `getPublicUrl`/`createSignedUrl(s)`/`createSignedUploadUrl` call site or a hand-built `SUPABASE_URL…/storage/v1/` URL outside the helper fails CI.
TEST: services/gateway/test/vtid-05023-public-url-guard.test.ts

AC-6: The prod proxy deploy and edge setup are dispatch-only workflows (required reason, pinned commit, account guard); the edge workflow refuses without a PASS parity report under 24 h old and never overwrites a DNS record, rule or attachment pointing elsewhere.
TEST: .github/workflows/AWS-PROD-DEPLOY-POSTGREST-AURORA-PROXY.yml and AWS-PROD-SETUP-POSTGREST-AURORA-PROXY-EDGE.yml parse as YAML, workflow_dispatch is the only trigger, run blocks pass `bash -n` (commands.log)

AC-7: The change suite for staging verification is present and valid.
TEST: docs/validation/VTID-05023/staging-tests.json — outputs/check-pr.txt

AC-8: Every Supabase-side side effect has an Aurora/AWS replacement: the 21 plain-SQL cron jobs on Aurora pg_cron with identical names, schedules and commands; the 2 HTTP cron jobs as disabled EventBridge schedules; the 2 pg_net triggers queue into an Aurora outbox with secret references only; the Supabase unschedule is snapshotted and its rollback restores all 25 jobs byte-identical.
TEST: scripts/ci/test-vtid-05023-aurora-cron-outbox.sh (npm run test:aurora-cron-outbox) — outputs/aurora-cron-outbox.txt

AC-9: The gateway's outbox sender (off by default) claims, sends, retries with backoff, gives up after 5 attempts, is idempotent per row, resolves header references from an allowlist, sends only to allowed destinations and never logs a secret.
TEST: services/gateway/test/vtid-05023-outbound-http-worker.test.ts — outputs/gateway-auth-bridge-outbox.txt

AC-10: On Aurora, ensure_provisioned() creates exactly the rows Supabase's six auth.users triggers create, idempotently; the PostgREST db-pre-request hook is a no-op for read-only and null-uid requests, provisions an unprovisioned member before their first write, skips service accounts and never fails a request; deletion applies the auth.users FK actions from the exported map; erase_user_data() runs on Aurora (no auth.users) and leaves auth-cascade tables to the deletion handler; members cannot call any of these.
TEST: scripts/aws/test/auth-bridge.sh (npm run test:auth-bridge) — outputs/auth-bridge.txt

AC-11: The gateway side of the auth bridge: the service-token-gated user-event endpoint (records auth_bridge.user.provisioned / .deleted in OASIS when Aurora changed; a failed emit never fails the webhook), the reconciler (off by default, never on staging), and ensureProvisioned() awaited by the eight post-sign-up write paths.
TEST: services/gateway/test/auth-bridge.test.ts, services/gateway/test/vtid-05023-auth-bridge-{reconciler,write-paths}.test.ts — outputs/gateway-auth-bridge-outbox.txt

AC-12: Self-hosted Supabase Realtime on Aurora (part 7a) delivers RLS-filtered postgres_changes, broadcast and presence to @supabase/realtime-js on Host realtime.vitanaland.com, refuses member tokens on its management API, and the setup SQL runs as a non-superuser role; the prod deploy is a dispatch-only workflow.
TEST: services/realtime-aurora/test/local-delivery.sh (npm run test:realtime-local) — outputs/realtime-local.txt

AC-13: After the flip, Supabase Storage's chat-attachment and voucher-PDF policies keep current data through a CDC-only Aurora->Supabase task for their 5 tables (and the T+2h rollback task for every other public table); replicated rows fire no Supabase trigger (all public user triggers snapshotted and disabled, exact rollback); tasks are created but never started by the script and no password reaches a command line.
TEST: scripts/aws/test/reverse-cdc.sh (npm run test:reverse-cdc) — outputs/reverse-cdc.txt

AC-14: With `MIGRATION_TARGET=aurora` (or dispatch input `target=aurora`) `RUN-MIGRATION.yml` applies a migration file to Aurora over the RDS Data API in one transaction (file BEGIN/COMMIT dropped; a failure anywhere, including at COMMIT, rolls back and fails the run naming the statement), refuses psql meta-commands, a top-level ROLLBACK and unflagged non-transactional statements, then sends `NOTIFY pgrst, 'reload schema'`; `MIGRATION-DRIFT-CHECK.yml` answers the same question against Aurora read-only; unset target keeps the Supabase path unchanged; `MIGRATION_FREEZE=true` fails both; `aurora-pgrst-ddl-watch.sql` makes DDL send `NOTIFY pgrst`.
TEST: scripts/aws/test/aurora-apply-migration.sh + scripts/aws/test/test_aurora_sql_split.py (npm run test:aurora-migrations) — outputs/aurora-migrations.txt
