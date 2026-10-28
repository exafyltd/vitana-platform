# VTID-03885 — Acceptance (Partner Health Test Integration, DoctorBox as Partner #001)

Scope of this PR: gateway-only backend (routes, services, connectors) +
the Supabase migration for the new data model. The companion frontend
change (real "connect DoctorBox" consent flow + admin UI) lives in
`exafyltd/vitana-v1` on the shared `claude/vitanaland-commerce-handoff-r9lbve`
branch, not in this repo.

Full audit + design rationale (why these tables and not the existing
`lab_tests`/`lab_test_orders`/`lab_test_results` "ghost tables", why the
generic connector framework and not VCAOP) is in the migration file's own
header comment and the PR description — not duplicated here.

AC-1 — Migration applies cleanly and does not touch the ghost tables or
`biomarker_results`'s schema
  TEST: applied live against the production Supabase project and verified
        via `information_schema.tables` + a real `SELECT` on
        `partner_registry` (this session has Supabase MCP access; see the
        migration commit's own message for the exact verification queries
        run)

AC-2 — Consent is checked before any `partner_health_results` write;
missing consent quarantines instead of writing
  TEST: services/gateway/test/partner-health/ingestion.test.ts
        ("quarantines when consent is missing, and never writes
        partner_health_results")

AC-3 — An invalid result payload is quarantined after recording
provenance, never projected into biomarker_results
  TEST: services/gateway/test/partner-health/ingestion.test.ts
        ("quarantines invalid payloads after recording provenance")

AC-4 — A valid result payload is projected into lab_reports +
biomarker_results, flips the order to result_ready, notifies the user, and
emits health_test.result_ready
  TEST: services/gateway/test/partner-health/ingestion.test.ts
        ("projects a valid result into lab_reports/biomarker_results,
        flips status, notifies, and emits result_ready")

AC-5 — A duplicate webhook delivery for an already-ingested order is an
idempotent no-op (never a second write/notification/event)
  TEST: services/gateway/test/partner-health/ingestion.test.ts
        ("is idempotent on a duplicate webhook delivery")

AC-6 — ORB voice tools narrate the canonical status only (never a raw
partner label) and are honest when no test/result exists yet
  TEST: services/gateway/test/orb-tools/partner-health-test-tools.test.ts

AC-7 — The DoctorBox mock connector verifies its HMAC signature, resolves
identity by external_order_ref, quarantines (never guesses) an unmatched
order, maps a known raw status to the canonical vocabulary (rejecting an
unmapped one rather than guessing), and delegates status/result events
into the ingestion pipeline
  TEST: services/gateway/test/connectors/doctorbox.test.ts

AC-8 — The admin portal's confirm-match endpoint is the only way an
ambiguous/unmatched inbox result becomes a real order, and requires
exactly one named user (never a "pick the top candidate" shortcut); a
manual PATCH cannot set the derived result_ready state
  TEST: services/gateway/test/admin-partner-health.test.ts

AC-9 — Self-service consent grant/revoke/check round-trip correctly for
the authenticated user's own identity
  TEST: services/gateway/test/partner-health-consent.test.ts

AC-10 — The proactive ORB continuation provider surfaces a real
unsurfaced result with a grounded EN/DE line, a deterministic navigate
CTA, and marks the order surfaced before returning
  TEST: services/gateway/test/services/assistant-continuation/providers/partner-health-result-ready.test.ts

AC-11 — Adding the two new ORB tool declarations is a reviewed,
intentional content change to the golden system-instruction/tool-catalog
snapshots, not silent drift
  TEST: services/gateway/test/orb/live/characterization/system-instruction.characterization.test.ts
        services/gateway/test/orb/live/characterization/tool-catalog.characterization.test.ts

ROUTE_MOUNT: `/api/v1/admin/partner-health` (admin-partner-health.ts,
requireTenantAdmin-gated) and `/api/v1/partner-health/consent`
(partner-health-consent.ts, requireAuthWithTenant-gated) both mounted in
services/gateway/src/index.ts via mountRouterSync, same pattern as the
existing `/api/v1/admin/marketplace` mount.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/partner-health/orders
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/partner-health/consent
CURL_PROOF: this session has no live gateway/AWS credentials to curl a
deployed instance, and this branch has not been merged/deployed yet — no
fabricated transcript is recorded here. After merge-to-main auto-deploys
staging (§16), `curl -s -o /dev/null -w "%{http_code} %{content_type}"
https://preview-aws-gateway.vitanaland.com/api/v1/admin/partner-health/orders`
must return `401 application/json...` (route exists, admin auth required)
— NOT `404 text/html` (route missing, per §15's HTML-vs-JSON diagnostic).
Same check against `/api/v1/partner-health/consent` (expect 401, missing
partner_key/scope would otherwise be 400 once authenticated).
OASIS_PROOF: `health_test.order_created` is emitted by
POST /inbox/:id/confirm-match (routes/admin-partner-health.ts) when a
quarantined result becomes a real order; `health_test.status_changed` and
`health_test.result_ready`/`health_test.result_quarantined` are emitted
by services/partner-health/ingestion.ts's recordStatusChange()/
ingestPartnerResult(), called from both the admin routes and the
DoctorBox connector — never duplicated at the route layer (see the
`impact-allow-no-oasis` comments on the two routes that delegate instead
of emitting directly). Verify post-deploy once a real DoctorBox webhook
or admin action fires:
`SELECT type, message FROM oasis_events WHERE type LIKE 'health_test.%' ORDER BY created_at DESC LIMIT 5;`
data_sharing_consents' own grant/revoke path is deliberately NOT an OASIS
event — its audit trail is the purpose-built data_sharing_consent_events
table (before/after snapshots), which would only be duplicated by a
generic event.

---

## Known limitation, disclosed rather than hidden

This sandbox's `services/gateway` checkout has no `node_modules` and no
npm registry access (`npm install` returns 403), so none of the tests
listed above, nor `npm run build`, could be executed in this session. What
WAS run: `tsc --noEmit --ignoreDeprecations 6.0` (bypassing an unrelated
pre-existing `moduleResolution=node10` deprecation abort) against the
whole `services/gateway` package — the ~8,000+ reported errors are
uniformly the missing-`node_modules` artifact (unresolved `@types/node`,
`@supabase/supabase-js`, `express`, `react`), affecting every file in the
repo identically; filtering those out left two real issues in this PR's
own files, both fixed in-session (a duplicate object key in a response
literal, a missing index signature on a webhook payload type). Every test
file listed above was written against the real handler/provider/route
source, tracing each Supabase query chain and call signature by hand
against the actual implementation rather than guessed — but this is
disclosed as unverified-by-a-real-test-run, not claimed as green CI, per
this repo's own established honesty convention for exactly this
situation. The real CI run on this PR (`Gateway (Jest, ~7.5k tests)`) is
the first execution of these tests against real `node_modules` — this
row of the evidence pack will read as a placeholder until that run is
observed green, which is checked in-conversation, not restated here.
