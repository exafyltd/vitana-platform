# VTID-04437 — the Operator Console lists server-side threads

The Command Hub half of VTID-04409 (`GET /api/v1/operator/threads`, merged in #3606).
Until now the console's sidebar was browser `localStorage` only, so a thread
started on another device, or by voice, never appeared.

## Acceptance

AC-1: server threads missing from the local index are added to the sidebar (newest activity as their time); existing local threads keep their title and archive state, and only an untitled one takes the server title.
TEST: services/gateway/test/command-hub/vtid-04437-operator-server-threads.test.ts

AC-2: a thread deleted in the console is remembered locally and never re-added from the server list.
TEST: services/gateway/test/command-hub/vtid-04437-operator-server-threads.test.ts

AC-3: the list is fetched once per page load with the auth headers; no session means no request; a failed request changes nothing; a `?operator_thread=` deep link to a thread only the server knows opens it once the list arrives.
TEST: services/gateway/test/command-hub/vtid-04437-operator-server-threads.test.ts

AC-4: opening a thread with no local history loads its whole server transcript (typed and voice turns; tool rows skipped), unless the user switched away or typed meanwhile.
TEST: services/gateway/test/command-hub/vtid-04437-operator-server-threads.test.ts

AC-5: CSP-safe (no inline script/style), cache-bust bumped on both `styles.css` and `app.js`, VTID-04437 in the Command Hub ownership allowlist.
TEST: services/gateway/test/command-hub (72 suites, all green)

## Visual verification

Local harness only (statics from the working tree, stubbed APIs, nothing live):
`outputs/harness-server.js`, `outputs/harness-shoot.js`. One local thread in
`localStorage`, two server-only threads from the stub. Screenshots at 1400×900
and 390×844: the sidebar lists all three, and opening the phone thread loads
its four turns (two typed, two voice). The narrow chat pane at 390 px is the
existing VTID-03949 layout, unchanged here.

## Not verified live

Needs the staging gateway on #3606 (the list endpoint) with `OPERATOR_THREADS_ENABLED=true`, and an exafy_admin session.
