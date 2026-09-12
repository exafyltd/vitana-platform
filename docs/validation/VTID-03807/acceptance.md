# VTID-03807 — Acceptance Criteria

Root cause and full reasoning: `root-cause.md` in this directory.

AC-1 — `GeminiLiveSession` gains a `sseEverAttached` field, and exactly one
site in the codebase ever sets it `true` — the real `GET /live/stream`
attach point — so it cannot read `true` for a session whose SSE stream was
never opened.

TEST: `grep -n "sseEverAttached" services/gateway/src/routes/orb-live.ts services/gateway/src/orb/live/session/live-session-controller.ts` — see `outputs/brace-and-field-checks.txt`. Exactly one assignment site (`session.sseEverAttached = true`) exists in the whole diff; every other occurrence is either the interface declaration or a read.

AC-2 — `sse_ever_attached` is threaded into the three `vtid.live.session.stop`
emission sites that can plausibly fire before any SSE attach (idle/expired
reap sweep, same-user `superseded_by_new_session` teardown, explicit `POST
/live/session/stop`), and deliberately NOT into the two WS-transport-only
stop sites, where the field would always read `false`/meaningless.

TEST: `grep -n "sse_ever_attached" services/gateway/src/routes/orb-live.ts services/gateway/src/orb/live/session/live-session-controller.ts` — see `outputs/brace-and-field-checks.txt`. 3 read sites total, matching the 3 named above; neither WS-only stop site (orb-live.ts's `transport: 'websocket'` block, live-session-controller.ts's `ws.on('close')` handler) appears in the results.

OASIS_PROOF: `sse_ever_attached` is a new field on the existing `vtid.live.session.stop` OASIS event payload (topic/schema unchanged, no new event type). See AC-2's grep evidence above for the three emission sites that now carry it.

AC-3 — The one genuinely behavior-affecting-looking change in a
conversation-flow file (`live-session-controller.ts`) is in fact
behavior-free (a telemetry-payload field addition only), and is marked as
such for the impact scanner.

TEST: `grep -n "flow-test-exempt" services/gateway/src/orb/live/session/live-session-controller.ts` — see `outputs/brace-and-field-checks.txt`.

AC-4 — Both edited files remain syntactically well-formed (no unbalanced
braces introduced).

TEST: Node brace-count script — see `outputs/brace-and-field-checks.txt` ("BALANCED" for both files).

AC-5 — The production root-cause investigation this VTID is based on used
only read-only queries against `oasis_events` (per the absolute
no-writes-to-production rule) and is reproducible.

TEST: SQL queries recorded verbatim in `commands.log`, all `SELECT`-only, no mutation of any table.

## Not independently confirmed

This session could not run the project's pinned `tsc`/Jest toolchain (no
npm registry access from this sandbox — see `outputs/tsc-attempt.txt`).
CI (which does have registry access) is the actual gate for type-safety and
the full test suite on this PR; the checks above are what this session
could verify directly. The underlying client-side mechanism this VTID's
diagnostic exists to confirm (why the widget's post-`session/start`
continuation never runs for the affected sessions) is explicitly NOT
confirmed here — see `root-cause.md`'s "Not fixed here" section.
