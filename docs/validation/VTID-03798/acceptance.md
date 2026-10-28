# VTID-03798 — Fix Aurora TLS verification for RDS Proxy endpoints

VALIDATION_PROFILE: gateway_backend

## Why this exists

VTID-03773 shipped a diagnostic route and wired `AURORA_CA_BUNDLE_PATH` onto
staging. This session called that route for real, with a real admin token,
against the real deployed staging gateway (see
`outputs/before-fix-live-staging-evidence.txt`) — and it failed:
`configured:true, reachable:false, error_type:auth_or_tls, "unable to get
local issuer certificate"`, despite the CA bundle containing the exact root
matching the Aurora cluster's own `CACertificateIdentifier`. Independently
confirmed via the AWS API (real credentials already present in this
session's environment, account 472838866351/eu-central-1) that: the task
definition wiring is correct, the deployed image postdates both prior
fix PRs, and the bundle content itself is correct and current. That rules
out every explanation except the one this PR fixes.

Root cause: `AURORA_DATABASE_URL` in staging/production points at the RDS
**Proxy** endpoint, not the Aurora instance directly. RDS Proxy terminates
TLS with a certificate that can chain to a different, public trust root
than the RDS-instance-specific CA hierarchy the downloaded bundle covers.
Node's `tls`/`pg` `ca` option **replaces** the default trusted CA store
rather than extending it, so setting `ca` to only the RDS bundle silently
dropped every public root Node normally trusts — exactly the root the
proxy's certificate may need.

## What changed

`resolveSsl()` in `services/gateway/src/services/db-i18n/aurora-client.ts`
now builds `ca` as the union of the RDS bundle's individually-split
certificates plus Node's own `tls.rootCertificates`. `rejectUnauthorized`
stays `true` throughout — this restores trust anchors a naive custom `ca`
value silently removed; it does not relax verification.

---

AC-1 — When `AURORA_CA_BUNDLE_PATH` is set, `resolveSsl` returns a `ca`
array containing every certificate from the bundle AND every one of
Node's built-in trusted roots (`tls.rootCertificates`) — not the bundle
alone. This is the exact property whose absence caused the live failure.
TEST: `test/db-i18n/aurora-client.test.ts` →
"unions the CA bundle certs with tls.rootCertificates, not replacing them"
(asserts `ca.length === bundleCerts.length + rootCertificates.length` and
that every entry of both sets is present).

AC-2 — `rejectUnauthorized` is still `true` in the union path — this is a
trust-anchor fix, not a verification bypass.
TEST: `test/db-i18n/aurora-client.test.ts` → same test, `toMatchObject({
rejectUnauthorized: true })`.

AC-3 — A CA bundle file that exists but contains no parseable PEM
certificates (a truncated download, an HTML error page saved to the
expected path) fails loudly with a specific `AuroraConfigError`, rather
than silently producing an empty/ineffective `ca` array.
TEST: `test/db-i18n/aurora-client.test.ts` →
"throws AuroraConfigError when the bundle file contains no PEM certificates"

AC-4 — Every pre-existing `resolveSsl`/`resolveAuroraConfig` branch —
missing `AURORA_DATABASE_URL`, invalid URL scheme, missing CA bundle file,
`AURORA_SSL_INSECURE=true`, `sslmode=disable` on loopback vs. remote hosts,
password redaction in `describe()` — is now covered by a dedicated unit
test, where previously this module (in production since VTID-03517) had
ZERO direct test coverage.
TEST: `test/db-i18n/aurora-client.test.ts` — 11 tests total, all passing
(`outputs/jest-run.txt`).

AC-5 — No behavior change to any other consumer of this module.
`createDbI18nRepository`'s existing integration suite
(`test/db-i18n/aurora-integration.test.ts`) and the VTID-03773 health-route
suite (`test/routes/admin-aurora-memory-health.test.ts`, which mocks this
module) both still pass unmodified.
TEST: `outputs/jest-run.txt` (health-route suite, 6/6); full `test/db-i18n`
sweep run locally: 81 passed, 22 skipped (no local Postgres — expected,
unchanged from before this PR), 0 failed.

AC-6 — TypeScript compiles clean.
TEST: `outputs/tsc-noemit.txt` (empty diff = clean).

---

## Route Mount Evidence Gate — not applicable

No route is added or mounted by this PR — only an internal SSL-config
helper function inside an existing service module changes. Per the
VTID-03696 fix, the Route Mount Evidence Gate only triggers on an ADDED
route registration line in `src/routes/`, `src/index.ts`, or `src/app.ts`,
none of which this diff touches.

## OASIS traceability

OASIS_IMPACT: no. This changes how a TLS trust store is constructed for an
outbound connection — no `oasis_events` row, no new topic/stage, no
async side effect to trace.

## What this does NOT do

- **It does not, by itself, prove Aurora is reachable from staging** —
  that requires this fix to actually deploy and the same real curl (login
  as `e2e-test@vitana.dev`, call `GET
  /api/v1/admin/aurora-memory/health`) to be re-run against staging,
  which is the very next step once this merges and
  `AWS-STAGE-DEPLOY-GATEWAY.yml` picks it up. Recorded as the explicit
  next step, not assumed done here.
- **It does not change `AURORA_I18N_WRITES` gating, the DMS
  reconciliation state, or any Phase 1+ memory-schema work** — this is
  purely the TLS trust-anchor fix for the Phase 0 connectivity check.
- **It does not touch production** — no production deploy workflow is
  touched by this PR; staging picks it up automatically on merge to
  `main` per the repo's staging-first model.

---

SCOPE_ALLOWLIST: services/gateway/src/services/db-i18n/aurora-client.ts,
services/gateway/test/db-i18n/aurora-client.test.ts,
docs/validation/VTID-03798/**

ACCEPTANCE: see AC-1 through AC-6 above, each mapped to a TEST: line.

MERGE_PAYLOAD_PREVIEW: services/gateway/src/services/db-i18n/aurora-client.ts
(resolveSsl: CA bundle now unioned with tls.rootCertificates instead of
replacing them) + one new unit test file
(services/gateway/test/db-i18n/aurora-client.test.ts, 11 tests) + this
evidence pack. No route, schema, or config-var change.
