# VTID-04273 — Fix secret-exposure-scanner-v1 false positives

## Report

Part of processing the Dev Autopilot findings backlog toward zero. The
`autopilot_recommendations` row `3d729613-5196-4219-8d49-d4bf317ee51c`
("Hardcoded secret in AURORA-I18N-INTEGRATION.yml", `risk_class: high`, so
by this repo's own conservative-triage design it is never auto-executed —
`secret_exposure` always requires human review) is a `[rollup]` from
`secret-exposure-scanner-v1` flagging 8 files with the same "URL with
embedded credentials appears hardcoded" message.

Read every one of the 8 files directly rather than trusting the scanner's
own verdict (this class of finding is exactly why it requires a human).
All 8 are false positives, of two shapes:

1. `${...}` / a bare `$VAR` between the `:` and the `@` — the URL is
   CONSTRUCTED from a variable at runtime (a TS template literal or a bash
   expansion), so there is no literal secret in the source to leak.
   `services/gateway/src/services/autopilot-agent/agent-workspace.ts:55`
   builds `https://x-access-token:${token}@github.com/...` from a function
   parameter; `scripts/aws/setup-operator-sql-readonly-secret.sh:88` builds
   `postgresql://${USER_NAME}:${ENC_PASS}@${READER}:5432/...` from values
   fetched live from AWS Secrets Manager two lines above.
2. `@127.0.0.1` / `@localhost` — a loopback host. Whatever credential
   precedes it is reachable only from the machine that already has it (a
   GitHub Actions ephemeral Postgres service container), never a real
   exposure. `.github/workflows/AURORA-I18N-INTEGRATION.yml:60` and
   `.github/workflows/CICDL-GATEWAY-CI.yml:69` both hardcode the
   well-known `postgres:postgres` service-container default at
   `127.0.0.1`/`localhost`; two docs (`docs/DEV-CICDL-0034-IMPLEMENTATION.md:45`,
   `docs/reports/devcicdl0034-telemetry-ci-fix.md:83`) just quote the same
   snippet.

The 8th file, `docs/validation/VTID-03798/outputs/before-fix-live-staging-
evidence.txt:24`, is different again: it already redacts the password as
`postgresql://vitana_admin:***@vitana-rds-proxy-prod...` — a masked
preview from a past diagnostic, not a live credential.

## Fix

`scripts/ci/scanners/secret-exposure.mjs`'s "URL with embedded credentials"
pattern gets an `ignore` regex (`\$\{|\$[A-Za-z_][A-Za-z0-9_]*|
@(?:127\.0\.0\.1|localhost)\b`) covering both false-positive shapes, and
`***` joins `GLOBAL_PLACEHOLDER_HINTS` for the redacted-preview shape —
following the exact `ignore`-field convention the OpenAI-key pattern in
the same file already uses. This is a scanner-source fix, not 8 file
annotations (the scanner's own suggested per-line `secret-allow` escape
hatch), so the same false-positive class cannot keep recurring on future
scans of these or similar files — the actual "does the backlog ever
converge to zero" question behind the continuous Dev Autopilot loop.

## Acceptance Criteria

AC-1 — The scanner no longer flags the CI service-container default
credential at a loopback host (`127.0.0.1` or `localhost`), in any of the
file types the rollup hit (`.yml`, `.md`).
TEST: services/gateway/test/scripts/secret-exposure-scanner.test.ts

AC-2 — The scanner no longer flags a URL constructed from runtime
variables (`${...}` in a TS template literal or a bash expansion), in
either language.
TEST: services/gateway/test/scripts/secret-exposure-scanner.test.ts

AC-3 — The scanner no longer flags an already-redacted (`***`) credential
preview.
TEST: services/gateway/test/scripts/secret-exposure-scanner.test.ts

AC-4 — The scanner STILL flags a genuine, literal, non-loopback,
non-redacted embedded credential — including one whose host is a bare,
non-loopback IP address (ruling out an over-broad "any IP-looking host is
safe" regression).
TEST: services/gateway/test/scripts/secret-exposure-scanner.test.ts

AC-5 — Every other pattern in the scanner (e.g. an Anthropic API key) is
unaffected by this change.
TEST: services/gateway/test/scripts/secret-exposure-scanner.test.ts

## Route evidence

No route is added, removed, or mounted by this change — it is a fix to a
CI scanner script plus one new regression test. The Route Mount Evidence
Gate does not apply.

## Not yet independently confirmed live

The next scheduled `DEV-AUTOPILOT.yml` scan (cron `0 7,19 * * *`) after
this merges is the real exercise: none of these 8 files, or any future
file matching the same two shapes, should reappear in a new
`secret_exposure` finding. The `autopilot_recommendations` row itself
(`3d729613...`) is marked `completed` directly from this session (see
`commands.log`) rather than left for an automated sweep, since no
mechanism in this codebase automatically resolves a scanner-sourced
finding once its underlying signal stops firing — the row would otherwise
sit as `new`/`snoozed` indefinitely even after the root cause is fixed.
