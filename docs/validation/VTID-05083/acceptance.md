# Acceptance — VTID-05083

## Problem
STAGING-VERIFY gateway @ 3032e0ce (run 38250886414), a0f8047a (run 38251713535) and 97d1911a (run 38253029205) each failed on one test only: VTID-05043 › "tenant-scoped read route still refuses an invalid caller" — `Request with GET/HEAD method cannot have body.` The runner (`run.mjs` runHttp) attached `content-type: application/json` and `body: '{}'` to every rejected probe; fetch refuses a GET with a body, so the probe never reached staging. Production cannot move past 475e7e43 without a passing gateway STAGING-VERIFY.

## Change
- `lib.cjs`: `httpRequestInit(t)` builds the request; a rejected probe gets the invalid bearer, and the JSON body only for write methods. An accepted read probe is reported as "REJECTED PROBE WAS ACCEPTED — <METHOD>"; write probes keep "WRITE PROBE WAS ACCEPTED".
- `run.mjs`: runHttp uses `lib.httpRequestInit(t)`; write probes are byte-identical to before.
- Validation rules unchanged (GET was already an allowed probe; write methods still only as 401/403 rejected probes).

## Evidence
- Unit: 38/38 (`outputs/lib.test.txt`), 4 new tests: GET/HEAD/default probe without body, write probe with body, plain GET without authorization, accepted read probe flagged with its method.
- Reproduction: `commands.log`.
- Staging: after merge, STAGING-VERIFY is dispatched for the commit staging serves; acceptance = VTID-05043's GET probe PASS (401 application/json).
