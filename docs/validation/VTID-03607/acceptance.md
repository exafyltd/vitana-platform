# VTID-03607 — Acceptance

**Title:** ORB new-day briefing was unreachable whenever context assembly finished before the greeting
**This PR:** the VTID-reference correction only. The behaviour change itself shipped in #3088.

## What this PR changes

Comment text. The new-day-briefing work merged in #3088 cites **VTID-03593** in five files;
that number belongs to a different session's task. VTID-03592 was properly allocated for the
sibling Nova `turnComplete` fix in the same PR, and 03593 was then assumed to be the next free
number rather than allocated from the ledger. The ledger is shared across concurrent sessions,
so consecutive numbers are not reservable — the allocator handed 03593 to another task while
this work was in progress.

No executable line changes. No route added, removed, or re-mounted. No exported signature,
control flow, or emitted payload differs.

## Acceptance criteria

AC-1 — Every `VTID-03593` reference under `services/gateway/{src,test}` is replaced by
`VTID-03607`, and none remain.
TEST: `grep -rn "VTID-03593" services/gateway/src services/gateway/test` returns no matches
— see `outputs/grep-no-stale-vtid.txt`.

AC-2 — The rename is comment-only: the greeting brain's behaviour is byte-identical, proven by
the existing golden snapshots continuing to pass unchanged.
TEST: `npx jest test/services/conversation/compute-greeting-decision.golden.test.ts` — 47 tests
and 34 snapshots pass with no snapshot writes. See `outputs/jest-affected-suites.txt`.

AC-3 — The two characterization suites that pin the transport's delegation invariant still pass,
including the VTID-03607-commented assertions.
TEST: `npx jest test/orb/live/characterization` — 183 tests pass. See
`outputs/jest-affected-suites.txt` (230 tests total across both commands).

## Route mount

ROUTE_MOUNT: none. `services/gateway/src/routes/orb-live.ts` appears in the diff, but only its
comment text changed — no `router.get/post/use` line is added, removed, or altered, so no route
is mounted or unmounted by this PR. The Route Mount Evidence Gate fires on the file path, not on
the nature of the change; these three markers record that the answer is "nothing mounted".

FINAL_URL: https://gateway.vitanaland.com/api/v1/orb/live/transport — an existing, unchanged
route in the touched file, used here to show the router still serves normally.

CURL_PROOF: `curl -s -w "%{http_code} %{content_type}" https://gateway.vitanaland.com/api/v1/orb/live/transport`
→ `200 application/json; charset=utf-8` / `{"ok":true,"transport":"sse"}`.
JSON, not an HTML 404, so the route exists and is mounted. See
`outputs/curl-orb-live-transport.txt`.

## Notes

Two pre-existing failures are unrelated to this diff and reproduce on a clean tree with these
commits stashed: the `offer-integrity contract` suite. Locally, three suites also fail to load
`@aws-sdk/client-polly`; that is an incomplete local `node_modules`, not a repo state — CI's
`npm ci` installs it.
