# VTID-03773 — Acceptance (Phase 0: Aurora connectivity diagnostic)

**Nobody has ever confirmed the gateway can reach Aurora at all.** Every prior
session working `docs/AURORA-PHASE0-FINDINGS-2026-08-08.md` /
`docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md` had no AWS CLI or console access —
this one doesn't either (`aws` isn't even installed in this sandbox). The
platform owner asked for a Vitanaland memory rebuild that lives on Aurora
only, never Supabase. Before writing a single line of memory logic against
Aurora, Phase 0 has to answer one narrow, load-bearing question: can the
gateway's running ECS task actually open a connection to
`vitana-aurora-prod` via `vitana-rds-proxy-prod`, or is that path closed by a
security group nobody has checked? That answer has to come from inside the
running task itself — a real `SELECT 1`, not a description of a security
group from outside, which this session has no way to produce anyway.

This VTID does **not** touch memory data, memory tables, or memory logic. It
adds one diagnostic route and wires one secret into staging.

---

AC-1 — A new admin-only diagnostic endpoint exists, gated behind the
platform's real auth stack, and never touches Aurora before authenticating
the caller. Verified two ways: unit tests with the auth stack mocked, and a
real local boot of the whole gateway process with the actual `jose` JWT
verification code running (not a supertest fixture) — see honesty note in
outputs/curl-local-boot.txt about what the local sandbox can and can't
reach.
TEST: `test/routes/admin-aurora-memory-health.test.ts` →
"returns 401 with no Authorization header, and never touches Aurora",
"returns 403 for a non-admin caller, and never touches Aurora"
CURL: `outputs/curl-local-boot.txt` — real gateway process on
`localhost:8099`, `GET /api/v1/admin/aurora-memory/health` with no
`Authorization` header → `401 UNAUTHENTICATED`; with a garbage bearer token
→ `401 UNAUTHENTICATED` ("Invalid or expired token"), both through real
Express routing and real JWT verification.

AC-2 — Once authenticated, the endpoint distinguishes four outcomes a human
needs to tell apart to actually answer the Phase-0 question: not configured
(no `AURORA_DATABASE_URL` at all), reachable (a real `SELECT 1` round trip
succeeded, with latency), a network failure (timeout/refused/unreachable —
points at a security-group problem), and an auth/TLS failure (credentials or
certificate rejected — points at a Secrets Manager or CA-bundle problem).
Conflating the last two would send whoever reads this chasing the wrong
fix.
TEST: `test/routes/admin-aurora-memory-health.test.ts` →
"reports not configured when AURORA_DATABASE_URL is unset",
"reports reachable=true with latency and db_time on a real round trip",
"classifies a connection timeout as a network failure, not auth/TLS",
"classifies a TLS/certificate rejection as auth_or_tls, not network"

AC-3 — No new Aurora connection module. The route reuses
`services/db-i18n/aurora-client.ts`'s existing `resolveAuroraConfig` /
`withAuroraClient`, which already implements the fail-loud TLS behaviour and
connection-string parsing this needs — duplicating that would be the exact
"rebuild a system that already exists" CLAUDE.md rules out.
TEST: `test/routes/admin-aurora-memory-health.test.ts` mocks
`../../src/services/db-i18n/aurora-client` at that exact module path (not a
new one) — the suite is inert unless the route genuinely imports from there,
which it does (`services/gateway/src/routes/admin-aurora-memory-health.ts`).

AC-4b — **Added after Codex review on this PR flagged a real gap (P1):** `AURORA_DATABASE_URL` alone is not sufficient for the connectivity check to reach its `reachable:true` outcome. `aurora-client.ts`'s `resolveSsl()` defaults to `rejectUnauthorized: true` verified against the SYSTEM trust store when `AURORA_CA_BUNDLE_PATH` is unset, and that verification fails against RDS's certificate by design (the module's own header comment says so). Without it, even an open security group and valid credentials would return `503 auth_or_tls`, not the actual Phase-0 answer. Fixed two ways: the gateway `Dockerfile` now downloads the RDS combined CA bundle at build time (the identical URL `scripts/db-i18n/seed-aurora.sh` already uses for the manual bastion flow) to `/app/certs/rds-combined-ca-bundle.pem`, and the staging deploy workflow sets `AURORA_CA_BUNDLE_PATH` to that path.
TEST: `outputs/rds-ca-bundle-fetch-check.txt` — the exact URL the Dockerfile downloads was independently confirmed live (165KB real PEM bundle, not an error page) from this session. Honest limit: this sandbox has no Docker daemon, so the full `docker build` with this step has not been exercised locally — the real build happens in CI on the next push, which is the first end-to-end confirmation.

AC-4 — Staging's gateway task definition gains `AURORA_DATABASE_URL`
(pointed at the same `vitana/aurora/prod/database-url` Secrets Manager entry
`oasis-projector` already uses in production), and nothing else on the task
definition changes — no existing env var or secret is dropped, and
production's deploy workflow (`AWS-PROD-DEPLOY-GATEWAY.yml`) is untouched.
TEST: `outputs/jq-dry-run.txt` — the same upsert-by-`select(...| not)`-then-
append pattern the real workflow uses, dry-run against a synthetic task
definition with a pre-existing secret plus one unrelated secret: the
unrelated secret survives untouched, `SUPABASE_JWT_SECRET` is replaced (not
duplicated), and `AURORA_DATABASE_URL` is added — the exact three properties
the real filter needs. The full filter (all vars, not the trimmed version
here) was separately dry-run against a task definition shaped like the real
one during development of this PR; not re-included here since the trimmed
version isolates just the AURORA_DATABASE_URL-specific behavior this AC is
about.

---

## Route markers (VALIDATOR-CHECK exit 70/71/72)

This diff genuinely adds a route (`router.get(...)`, `router.use(...)` in a
new file, plus its `mountRouterSync` registration in `index.ts`), so these
are answered for real, not marked not-applicable:

ROUTE_MOUNT: **Added.** New file `services/gateway/src/routes/admin-aurora-memory-health.ts`
defines `router.use('/admin/aurora-memory', requireAuth)`,
`router.use('/admin/aurora-memory', requireExafyAdmin)`, and
`router.get('/admin/aurora-memory/health', ...)`. Registered in
`services/gateway/src/index.ts` via
`mountRouterSync(app, '/api/v1', adminAuroraMemoryHealthRouter, { owner: 'admin-aurora-memory-health' })`,
following the exact pattern the adjacent `admin-memory-broker`/
`admin-memory-orchestrator` routers already use one screen above it.

FINAL_URL: `GET /api/v1/admin/aurora-memory/health` (exafy_admin only). On
staging once this PR merges and the auto-deploy runs:
`https://preview-aws-gateway.vitanaland.com/api/v1/admin/aurora-memory/health`.
Not added to any production deploy workflow in this PR.

CURL_PROOF: **Real, from a local boot of the actual gateway process — not
fabricated, and not a full production-shaped proof either; the honest
limits are recorded rather than hidden.** See `outputs/curl-local-boot.txt`:
`/alive` → `200`; the new route with no `Authorization` header → `401`; with
an invalid bearer token → `401`. This sandbox has no AWS CLI/credentials and
no real Aurora reachability, so the local run used a dummy, unreachable
`SUPABASE_URL` and no `AURORA_DATABASE_URL` at all — it proves the route is
genuinely mounted and the auth gate is real, not that Aurora is reachable
from staging. That second, actual Phase-0 question — is the network path
open — is answered by curling this same URL against
`preview-aws-gateway.vitanaland.com` after this PR merges and the staging
task definition picks up `AURORA_DATABASE_URL`, which is the deliverable
this whole VTID exists to produce and cannot be answered before deploy.

## OASIS traceability (VALIDATOR-CHECK exit 80/81)

OASIS_IMPACT: no. This diagnostic route emits no `oasis_events` row and adds
no new OASIS topic or stage — it is a synchronous HTTP request/response with
no async side effect to trace. No `OASIS_PROOF:` needed.

VTID-03773 is `status=in_progress`, `spec_status=approved` (user-instructed
in conversation, per §4.1); allocated and updated directly via the
`allocate_global_vtid` Supabase RPC in this session (the gateway's own
`/api/v1/vtid/allocate` endpoint wasn't reachable from here either).

---

## What this does NOT do

- **It does not prove Aurora is reachable from staging.** That is the actual
  Phase-0 answer, and it can only come from a live curl against
  `preview-aws-gateway.vitanaland.com` after this merges — recorded as the
  explicit next step, not assumed.
- **It does not create any memory table, write path, or read path.** No
  schema is created on Aurora by this PR; the endpoint only runs `SELECT 1`.
- **It does not touch production.** `AWS-PROD-DEPLOY-GATEWAY.yml` is
  unmodified; only the staging deploy workflow gains the new secret entry.
- **It does not decide the memory system's tenant-isolation approach**
  (Postgres RLS vs. application-enforced) — that is explicitly Phase 1,
  already scoped down to "application-layer, self-contained" per the
  platform owner's decision recorded in this VTID's `vtid_ledger` row, and
  not reachable from this Phase-0 slice.
