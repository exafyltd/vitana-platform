# Plan sparring record — VTID-05083

- Sparring id: `plan_sparring_sessions` `fe876827-7cf0-4a7e-8cd0-4c44fd273e95`
- Plan hash (sha256 of the text between the plan markers): `d474238172344fe3223c03401ea7269cd19476cbdeeea2e3ea5baa04c88a15ce`
- Change class: standard · producer: claude-code · partner: plan-sparring-partner (independent, read-only) · 2 rounds · verdict **CONVERGED**
- **Owner approval:** 2026-10-12, Claude Code session https://claude.ai/code/session_019XRHThojRVzYPDzoLtuby6 — "Approved" (Gate 1)

## Rounds
- Round 1 — NOT CONVERGED
  - F1 [major] "VTID-05043 staging-tests.json has no GET rejected probe" — **rejected with evidence**: the partner read a stale local checkout; the entry is at `docs/validation/VTID-05043/staging-tests.json:13-22` on main (added by 3032e0ce, #4014). Partner confirmed in round 2.
  - F2 [minor] "WRITE PROBE WAS ACCEPTED" is misleading for a GET — **accepted**: the message names the method for a read probe.
  - F3 [minor] redirect could forward the invalid bearer — **accepted (note)**: a 401 never enters httpGet's redirect loop.
  - F4 [minor] check-pr not addressed — **accepted (note)**: scripts/ci/staging-verify/ is not a gateway deploy path.
- Round 2 — CONVERGED, no new findings.

# Plan

<!-- plan:begin -->
## Problem
STAGING-VERIFY for gateway @ 3032e0ce, a0f8047a and 97d1911a failed (runs
38250886414, 38253029205) on one test only: VTID-05043 › "tenant-scoped read
route still refuses an invalid caller" — `Request with GET/HEAD method cannot
have body.` The entry (docs/validation/VTID-05043/staging-tests.json) is a GET
with `rejected_probe: true` and no body. The runner
(scripts/ci/staging-verify/run.mjs:154-160, runHttp) adds
`content-type: application/json` and `body: '{}'` to EVERY rejected probe,
whatever the method; Node fetch throws before any request is sent. The probe
never reached staging. Production cannot move past 475e7e43 until a gateway
STAGING-VERIFY passes, so this blocks every publish (VTID-05078, -05043,
-05061, -05080).

## Change (one runner fix, no rule change)
1. scripts/ci/staging-verify/lib.cjs: new pure export `httpRequestInit(t)`
   returning `{ method, headers, body? }`: method upper-cased (default GET);
   accept header as today; for `rejected_probe` the invalid bearer as today;
   `content-type` + `body: '{}'` ONLY when the method is not GET/HEAD.
2. run.mjs runHttp uses `lib.httpRequestInit(t)` instead of building init
   inline. Behaviour for POST/PUT/PATCH/DELETE probes (e.g. the smoke
   "publish route exists" POST) is byte-identical.
3. lib.test.cjs: tests — GET rejected probe has the bearer and no body /
   no content-type; HEAD likewise; POST rejected probe keeps bearer, content
   type and `{}`; a non-probe GET has no authorization header.
4. The validation rules are untouched: GET was always allowed as a probe (the
   write-method guard at lib.cjs:143 only restricts non-GET methods). The
   2xx check stays; its message names the method for a read probe
   ("REJECTED PROBE WAS ACCEPTED — GET …") and keeps the existing
   "WRITE PROBE WAS ACCEPTED" wording for write methods (existing test at
   lib.test.cjs:125-130 unchanged). Redirects: httpGet follows redirects
   only for GET/HEAD and only on 3xx; an expected 401 never enters that
   loop, so the invalid bearer is not forwarded anywhere.
   check-pr passes: scripts/ci/staging-verify/ is not in
   SERVICES.gateway.deployPaths (lib.cjs:39-41).
5. Evidence pack docs/validation/<VTID>/ (plan-sparring.md, scope.json,
   acceptance.md, staging-tests.json running `node --test
   scripts/ci/staging-verify/lib.test.cjs`). Not a gateway change: the PR
   does not touch services/gateway, so no staging deploy is triggered by it;
   the runner is read from main on the next STAGING-VERIFY. After merge,
   re-run STAGING-VERIFY for the commit staging serves at that moment (now
   97d1911a, read from /api/v1/admin/build-info; workflow_dispatch, as done
   for c6100f80 in run 38236989335). If staging has moved, the newest
   staging commit's own automatic run covers it.

Evidence for the entry: added by 3032e0ce (VTID-05043, #4014),
docs/validation/VTID-05043/staging-tests.json lines 13-22 at origin/main
(GET /api/v1/memory/garden/entries, rejected_probe: true, expect 401).

## Out of scope
VTID-05043's own entry (correct as written); VTID-05043's production
migrations (owner's Gate 2 for that VTID); any change to which methods may
be probed.

## Test plan
node --test scripts/ci/staging-verify/lib.test.cjs (34 existing + new);
after merge, the dispatched STAGING-VERIFY for the staging commit shows the
VTID-05043 probe PASS (401 application/json).
<!-- plan:end -->
