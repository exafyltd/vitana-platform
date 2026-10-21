# VTID-04974 — remove three stale staging verification entries (test maintenance only)

Owner instruction 2026-10-08 ("Option 1 - fix forward"). Sparring: `plan-sparring.md` (converged, 2 rounds, light class). Not part of the ChatGPT plugin feature scope; no production code is changed.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none (no code, no route; verification manifests only).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/alive (staging, read-only liveness GET).

CURL_PROOF: after merge a full STAGING-VERIFY on the gateway commit intended for production must pass every remaining entry (797 minus the three removed); recorded in the Gate evidence.

## Acceptance criteria

AC-1: `docs/validation/VTID-04836/staging-tests.json` no longer runs `npx jest test/navigation-catalog.test.ts`, a command that matches zero files (the test never existed in this repository, so it never provided coverage). Its HTTP probe "Command Hub loads the app.js that drops the retired earthlinks tenant" is kept.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-2: `docs/validation/VTID-04665/staging-tests.json` and `docs/validation/VTID-04698/staging-tests.json` no longer contain the HTTP probes that expect `/api/v1/mitigation/health` to read "down" because `risk_mitigations` is missing. The table now exists in the shared database (migration 20260928200400_vtid_04717_risk_mitigations.sql), so the premise of those probes ended. Every other entry of both manifests is unchanged, including "a route whose table exists stays healthy" and the dependency-probe jest entry.
  TEST: services/gateway/test/vtid-04665-dependency-probe.test.ts
AC-3: The behaviour "a missing table reads down with table_missing" stays proven by the in-process, mock-based `test/vtid-04665-dependency-probe.test.ts` (it does not depend on live database state), which remains in both manifests.
  TEST: services/gateway/test/vtid-04665-dependency-probe.test.ts
AC-4: No production code, no other manifest and no acceptance file changes; the manifests stay valid JSON and the staging-verify runner loads them.
  TEST: scripts/ci/staging-verify/lib.test.cjs

## Notes (history, not changed)
- `docs/validation/VTID-04698/acceptance.md` AC-4 ("mitigation health reads down with table_missing") stays as the record of what was true when VTID-04698 shipped; its "reads down" half is superseded because the premise ended.
- Nothing covers "AUTH.EARTHLINKS_PORTAL is gone from the voice navigation catalog" today; the removed jest entry never did either (zero files matched). Adding such a test is out of scope here; possible follow-up for the owner.

## Evidence
Full STAGING-VERIFY run 37758096460 (gateway @ 814df036): 794/797, the failures being exactly these three entries; the same three failed the full runs on 43bbd367 and 463e22a.
