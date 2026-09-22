# VTID-04268 — Dev Autopilot config screen becomes writable (safe numeric knobs)

## Report

Sixth of six Command Hub Autopilot supervisor-visibility items Operator
self-allocated (VTID-04264 through VTID-04269) and then failed to complete
end to end — every one exhausted its 120-turn agent-executor cap purely
navigating the 2.6MB Command Hub `app.js` without making a single edit.
Per the standing instruction ("Every time Operator fails, you Claude Code
take over, finish it and show Operator how you fixed it"), this session
implemented all six directly, reusing the VTIDs Operator already
allocated, each as its own PR.

Before this VTID, `GET /api/v1/dev-autopilot/config` was read-only from the
Command Hub — the `dev_autopilot_config` row (daily budget, cooldown,
concurrency cap, auto-archive window, reject-suppression window, eager
plan top-K, select-all cap, max auto-fix depth, post-deploy verification
window) could only be edited via a direct Supabase write, outside any
governance path.

`allow_scope`/`deny_scope` (the JSONB arrays governing which files the
autonomous executor may touch) and `kill_switch` (already its own route,
VTID-04264) are deliberately excluded from this surface — too
security-sensitive for a quick numeric text-field edit.

## Acceptance Criteria

AC-1 — A pure, exported validator (`validateConfigUpdate`) accepts only
the nine listed numeric fields, each bounded to a sane range, and rejects
everything else (unknown fields, non-integers, out-of-range values, a
non-object body) with a named error — no Supabase call on a rejected body.
TEST: services/gateway/test/vtid-04268-dev-autopilot-config-writable.test.ts

AC-2 — `allow_scope`, `deny_scope`, and `kill_switch` are never accepted
by the validator, even when submitted alongside a valid field.
TEST: services/gateway/test/vtid-04268-dev-autopilot-config-writable.test.ts

AC-3 — `POST /api/v1/dev-autopilot/config/update` is gated by the same
`requireDevRole` (exafy_admin) governance gate as every other dev-autopilot
endpoint; PATCHes only the validated fields plus `updated_at`; and emits a
`dev_autopilot.config.updated` OASIS event naming the changed fields.
TEST: services/gateway/test/routes/dev-autopilot.test.ts

AC-4 — A rejected (400) or failed (500) update never emits an OASIS event
and never issues the Supabase PATCH for a rejected body.
TEST: services/gateway/test/routes/dev-autopilot.test.ts

AC-5 — The Command Hub's Dev Autopilot view renders an "Advanced config"
panel with one number input per safe field, a Save button that POSTs the
diff to `/config/update`, disables its inputs while a save is in flight,
and re-fetches state (rather than trusting the local draft) after a
successful save.
TEST: services/gateway/test/vtid-04268-command-hub-config-panel-wiring.test.ts

AC-6 — No new inline `.style`/`.style.cssText` usage was introduced on the
new panel (CSP §36, NEVER rule 24/30) — styling is via CSS classes added to
`styles.css`, verified independently by the CI CSP gate
(`validator-path-guard.cjs --csp-added-lines`).
TEST: services/gateway/test/vtid-04268-command-hub-config-panel-wiring.test.ts

## Route evidence

`POST /api/v1/dev-autopilot/config/update` is a new route on the existing
`/api/v1/dev-autopilot` router (`services/gateway/src/routes/dev-autopilot.ts`,
mounted at `services/gateway/src/index.ts` alongside every other
`dev-autopilot` route — mount point unchanged by this PR).

ROUTE_MOUNT: `router.post('/config/update', requireDevRole, ...)` in
`services/gateway/src/routes/dev-autopilot.ts`, on the pre-existing
`/api/v1/dev-autopilot` router.
FINAL_URL: `POST /api/v1/dev-autopilot/config/update`
CURL_PROOF: not run against a live deployment from this session (no
staging bearer token / exafy_admin session available here); the route's
shape (auth gate, 400 on an unknown/out-of-range field, 200 + OASIS event
on a valid PATCH, 500 with no event on a Supabase failure) is exercised in
full by the jest suite listed under AC-3/AC-4, which drives the real
Express router with a mocked `fetch` — the same pattern this file's
sibling `GET /config` / `POST /config/kill-switch` routes are tested with.

## OASIS evidence

OASIS_PROOF: this change adds one new `CicdEventType` member,
`dev_autopilot.config.updated`, and alters none of the existing
`dev_autopilot.*` events. It is emitted exactly once, from
`POST /config/update`, only on a validated-and-applied patch (never on a
400/500 — see AC-4), carrying the changed field names in `payload`. Verify
post-merge:
`SELECT type, message, payload FROM oasis_events WHERE type = 'dev_autopilot.config.updated' ORDER BY created_at DESC LIMIT 5;`
(empty until the first real save from the Command Hub panel).

## Not yet independently confirmed against live traffic

The next real signal is a staging Command Hub session opening the
Dev Autopilot tab's "Advanced config" panel, editing a field, and
confirming both the toast and the subsequent `GET /config` poll reflect
the new value, plus a `dev_autopilot.config.updated` row in `oasis_events`.
