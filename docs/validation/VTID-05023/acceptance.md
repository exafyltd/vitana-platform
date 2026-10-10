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
