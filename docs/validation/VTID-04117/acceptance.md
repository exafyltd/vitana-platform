# VTID-04117 — Acceptance

Operator Deployments: currently-live ECS strip + community-app commit-pinned
redeploy. See CLAUDE.md CHANGE LOG (2026-09-19, VTID-04117) for the full
narrative and rationale.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `router.get('/deployments/live-status', requireAdminAuth, ...)`
and `router.post('/deployments/redeploy', requireAdminAuth, ...)` added to
the existing Operator router (`services/gateway/src/routes/operator.ts`),
mounted at `/api/v1/operator` (unchanged mount point — see the file's own
existing routes on the same router).

FINAL_URL: `https://gateway.vitanaland.com/api/v1/operator/deployments/live-status`
(GET) and `https://gateway.vitanaland.com/api/v1/operator/deployments/redeploy`
(POST) once promoted to production; `https://preview-aws-gateway.vitanaland.com/api/v1/operator/deployments/live-status`
on staging first, per the staging-first model (CLAUDE.md §16).

CURL_PROOF: not yet deployed — this ships on `claude/sharp-cerf-gq0za2` and
reaches staging only on merge to `main` (CLAUDE.md §16), so no live curl
proof exists yet. Both routes are admin-only (`requireAdminAuth`), so the
correct unauthenticated response is `401`, not a 404 — the same shape every
other route on this router uses, and the only thing a pre-deploy curl proof
could show is exactly that shape, not new information. Structural
verification instead: `tsc --noEmit` clean on `services/gateway`, and the
pure logic behind both routes (`deployment-live-status.ts`) is exercised by
18 new unit tests (`test/services/deployment-live-status.test.ts`) — see
`commands.log`/`outputs/`. Post-deploy curl verification is a named next
step (CLAUDE.md CHANGE LOG entry says so explicitly): once on staging,
`curl -s -H "Authorization: Bearer <admin token>" https://preview-aws-gateway.vitanaland.com/api/v1/operator/deployments/live-status`
is expected to return `{"ok":true,"targets":[...]}`.

OASIS_PROOF: two new OASIS event types were added to `CicdEventType`
(`services/gateway/src/types/cicd.ts`) — `production.redeploy.requested`
and `production.redeploy.failed` — emitted from
`POST /deployments/redeploy` via the existing `emitOasisEvent()` helper
(`services/gateway/src/routes/operator.ts`, same call shape as the
pre-existing `production.publish.requested`/`.failed` events a few lines
above in the same file). No new topic taxonomy, no schema change — these
are ordinary `production.*` lifecycle events, following the exact pattern
`/operator/publish` and `/operator/revert` already use.

AC-1 — `GET /deployments/live-status` reports drift only for gateway targets, never frontend
The pure drift computation must be `true` only when both a resolved
(live/build-info) commit and a logged (`software_versions`) commit exist,
disagree on their first 12 chars, and the target is a gateway row — never
a community-app (frontend) row, since no build-info endpoint exists there
to resolve a live commit against.
TEST: `test/services/deployment-live-status.test.ts` — `computeCommitDrift`
describe block (4 tests) and `buildLiveStatusTargetResult`'s drift-related
tests.

AC-2 — `POST /deployments/redeploy` accepts only `vitana-community-app-awsdr`, never gateway or staging
Gateway has no arbitrary-commit rebuild `deploy_mode`; staging community-app
has no `commit_sha` workflow_dispatch input. Both must be refused with
`error:"invalid_service"`.
TEST: `test/services/deployment-live-status.test.ts` — `validateRedeployRequest`
describe block, "refuses gateway" and "refuses staging community-app too".

AC-3 — the redeploy validator rejects a malformed commit or missing reason before any workflow dispatch is attempted
A commit that is not a 7-40 char hex string (too short, non-hex, a pasted
URL) or an empty/whitespace-only reason must be refused with a named error
code, never silently accepted.
TEST: `test/services/deployment-live-status.test.ts` — "refuses a malformed
commit" and "refuses an empty or whitespace-only reason".

AC-4 — the live-status endpoint degrades a single target's failure without failing the whole response
A build-info resolution failure (e.g. ECS/HTTP unreachable) for one target
must populate `resolve_error` on that target only, leave `drift:false`, and
must not throw — the endpoint still returns `ok:true` with the other
targets populated.
TEST: `test/services/deployment-live-status.test.ts` — "reports build-info
resolution failures without crashing".

AC-5 — the pre-existing `GET /deployments` route is unaffected
Adding the two new routes and the two new OASIS event types must not change
the existing deployment-log route's behavior.
TEST: `test/operator-deployments.test.ts` (8 pre-existing tests, re-run
unmodified, all passing — see `commands.log`).
