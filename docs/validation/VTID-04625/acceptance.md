# VTID-04625 — verification no longer reverts a correct change for a couple of unrelated errors

2026-09-26 on staging: PR #3726 (VTID-04597) passed CI and the LLM review,
merged (95739c9), deployed, then failed verification with "2 unrelated error
events during verification window" and was auto-reverted (#3741, merged).
The two events were a `voice.latency.measured` "latency 760ms (voice,
errored)" record from a member voice session and an operator-console
`assistant.turn` "Tool call: dev_run_sql_readonly" record. The window failed
on ANY rise over its baseline, so a single sporadic event of a rare type
reverted correct work.

Now: the live watcher requires an error type to exceed its baseline by at
least 3 (`DEV_AUTOPILOT_VERIFY_MIN_EXCESS`, default 3), and
`voice.latency.*` / `assistant.turn` telemetry are never blast radius. The
pure function's default is unchanged (any rise), so its existing contract
tests stand.

## Acceptance criteria

AC-1: an error type must exceed its baseline by the configured excess; the default without the option is unchanged.
TEST: services/gateway/test/vtid-04625-verification-min-excess.test.ts

AC-2: voice latency measurements and console turn records are not blast radius.
TEST: services/gateway/test/vtid-04625-verification-min-excess.test.ts

AC-3: end to end, the exact 2026-09-26 event mix completes the execution, and a new error type firing 3 times still fails it (rule 42f scenario; mutation-checked: without the watcher passing the threshold the first scenario fails).
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-4: the VTID-04377 baseline and earlier exclusions are unchanged.
TEST: services/gateway/test/vtid-04377-verification-baseline.test.ts
