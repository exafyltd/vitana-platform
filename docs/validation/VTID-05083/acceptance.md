# VTID-05083 — STAGING-VERIFY sends no request body on a GET/HEAD rejected probe

Owner approval 2026-10-12 ("Approved" at Gate 1 on the sparred plan). Sparring: `plan-sparring.md` (standard class, 2 rounds, CONVERGED).

Problem: STAGING-VERIFY for gateway @ 3032e0ce (run 38250886414), a0f8047a (run 38251713535) and 97d1911a (run 38253029205) each failed on one test only: VTID-05043 › "tenant-scoped read route still refuses an invalid caller" — `Request with GET/HEAD method cannot have body.` The runner (`run.mjs` runHttp) attached `content-type: application/json` and `body: '{}'` to every rejected probe; fetch refuses a GET with a body, so the probe never reached staging. Production cannot move past 475e7e43 without a passing gateway STAGING-VERIFY.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: not applicable (CI script change; no route, no service deploy; scripts/ci is outside the gateway deploy paths).

FINAL_URL: not applicable (no deployed surface). Evidence on staging is the next STAGING-VERIFY run, which reads this runner from main.

OASIS_PROOF: not applicable; the verification record keeps its shape.

CURL_PROOF: not applicable (no endpoint).

## Acceptance criteria

AC-1: A GET, HEAD or method-less rejected probe carries the invalid bearer and no body and no content-type.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-2: A write-method rejected probe is byte-identical to before (invalid bearer, `content-type: application/json`, body `{}`).
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-3: A plain GET carries no authorization header.
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-4: An accepted read probe fails and names its method ("REJECTED PROBE WAS ACCEPTED — GET"); an accepted write probe keeps "WRITE PROBE WAS ACCEPTED".
  TEST: scripts/ci/staging-verify/lib.test.cjs
AC-5: After merge, STAGING-VERIFY for the commit staging serves shows VTID-05043's GET probe PASS (401 application/json).
  TEST: STAGING-VERIFY run for the staging commit (dispatched after merge; link recorded in the PR)

## Evidence
- Unit: 38/38 (`outputs/lib.test.txt`); baseline on main 34/34.
- Reproduction: `commands.log` (old init raises the exact error; new init builds the request).

## Decisions taken
- Validation rules unchanged: GET was already an allowed probe; write methods still only as 401/403 rejected probes.
