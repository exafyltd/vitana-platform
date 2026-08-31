# VTID-03591 — merge/CI-fix increment (continued under VTID-03702)

Evidence pack for the commits pushed to this PR on 2026-08-23 that merge
`origin/main` (141 commits, including the GCP decommission and other
in-flight Aurora/DB-i18n work) into this branch and fix the resulting CI
breakage. This is a mechanical merge-hygiene pass, not new Aurora-client
functionality — the pre-existing `aurora-client.ts`/RLS-shim work in the
rest of this PR is unchanged by these commits.

Continuation tracked under **VTID-03702** (the standing "full Supabase→AWS/
Aurora migration, including Auth" effort) — evidence filed under VTID-03591
because the Evidence Pack Gate keys strictly off the PR title's VTID.

---

AC-1 — Merging 141 commits from `origin/main` does not silently drop or
corrupt this branch's own Aurora work

The merge resolved two real conflicts (`services/gateway/package.json`,
`services/gateway/package-lock.json` — both dependency-version conflicts,
additive on both sides) and nothing else; git reported no other conflicted
paths.

TEST: `git log --oneline ca00ed8..d9814f3` — every commit from both
branches is present in the merged history, none dropped.
Output: `outputs/merge-commits.txt` (145 commits)

AC-2 — `services/gateway/package.json` resolves cleanly with no leftover
conflict markers and no version regression

Both branches' additions are kept: `@aws-sdk/client-s3` and
`@aws-sdk/client-transcribe-streaming` (added by `main`), `pg@^8.23.0` and
`@types/pg@^8.21.0` (this branch's versions, newer than `main`'s
`8.22.0`/`8.20.4`).

TEST: `grep -n "^<<<<<<<\|^=======\|^>>>>>>>" services/gateway/package.json`
returns nothing.

AC-3 — `services/gateway/pnpm-lock.yaml` matches the resolved `package.json`

That's the lockfile CI's `pnpm install --frozen-lockfile` actually reads
(`TEST-SUITE.yml`'s `working-directory: services/gateway`). The first fix
attempt regenerated the wrong one (`package-lock.json` via `npm`) and CI
kept failing with `ERR_PNPM_OUTDATED_LOCKFILE`. Regenerated with pnpm 9.0.0
(matching `packageManager`/CI's pin) so the format matches CI exactly.

TEST: `cd services/gateway && pnpm install --frozen-lockfile` exits 0.
Output: `outputs/pnpm-frozen-lockfile-check.txt`

AC-4 — The Dev Autopilot Impact Scan warning (undocumented
`AURORA_DATABASE_URL`/`AURORA_SSL`/`AURORA_POOL_MAX`) is closed without
changing `aurora-client.ts`'s behavior

`getAuroraPool()` still returns `null` until `AURORA_DATABASE_URL` is set —
this is a `.env.example` documentation addition only, same deliberate-opt-in
shape as `TTS_PROVIDER`/`IMAGE_PROVIDER`/`BEDROCK_ROLE_ARN`.

TEST: `grep -A12 "Aurora application-layer client" services/gateway/.env.example`
Output: `outputs/env-example-aurora-section.txt`

---

OASIS_IMPACT: no — this increment is CI/lockfile hygiene and documentation
only; `getAuroraPool()` remains unwired and unconfigured, no runtime
behavior changes, so there is no state transition for OASIS to record.

---

# Aurora migration B7 — AI Bridge route (VTID-03764 chain)

Filed under this VTID because the Evidence Pack Gate keys off the PR
title's VTID, same reason as the section above — this is a separate,
later increment on the same PR (Aurora migration B7: closing the
"23-of-74 edge functions call Gemini/Vertex directly" violation named in
`docs/AURORA-B7-EDGE-FUNCTIONS-INVENTORY.md`), not new Aurora-identity
work.

AC-5 — A new gateway route exists for the Bedrock bridge, correctly
auth-gated, and is mounted where the route-mount evidence gate expects

ROUTE_MOUNT: `services/gateway/src/routes/ai-bridge.ts` → `router.post('/generate', requireServiceOrAdmin, ...)`; mounted in `services/gateway/src/index.ts` via `mountRouterSync(app, '/api/v1/ai-bridge', aiBridgeRouter, { owner: 'ai-bridge' })`.
FINAL_URL: `POST {gateway}/api/v1/ai-bridge/generate`
CURL_PROOF: this is a service-to-service route (Supabase edge functions → gateway), never called by an end user, so there is no production traffic to point at pre-merge — same shape as VTID-03605's FHIR callback evidence above ("after merge-to-main auto-deploys staging"). Once staging picks up this commit: `curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST https://preview-aws-gateway.vitanaland.com/api/v1/ai-bridge/generate -H "Content-Type: application/json" -d '{}'` must return `401 application/json...` (`{"ok":false,"error":"missing bearer token"}` — auth required, route exists), NOT `404 text/html`. With a valid `GATEWAY_SERVICE_TOKEN` bearer and an empty `messages` array, the same endpoint must return `400 application/json` (`{"ok":false,"error":"messages must be a non-empty array"}`), confirming request validation runs past the auth gate. Local equivalent, run this session (not a substitute for the staging check above, but confirms the route exists and both gates fire before any deploy): `services/gateway/test/ai-bridge.test.ts` boots the router directly via `express()`+`supertest` and asserts exactly these two response shapes (10/10 passing — see the Test Suite Summary check on this PR's own CI run).

AC-6 — The route makes no DB write and has no state transition to record

`invokeBedrock()` (existing, unmodified — `services/gateway/src/providers/bedrock.ts`) makes a single stateless call to Bedrock and returns its response; nothing is written to Supabase/Aurora, no OASIS-worthy decision is made. Marked `// impact-allow-no-oasis` in the handler body, same category as VTID-03605's FHIR-authorize leg noted above ("only runs discovery and returns a URL, no state change").

TEST: `services/gateway/test/ai-bridge.test.ts` — 10 tests covering auth gating (401 with no token, JWT path never touched when the service token matches), request-shape validation (400s), Gemini→Bedrock request translation (system-turn splitting, tool-schema translation, option forwarding/defaulting), and Bedrock→Gemini response translation (text and functionCall shapes) plus a `not_configured` error surfaced as 502.

OASIS_IMPACT: no — see AC-6.
