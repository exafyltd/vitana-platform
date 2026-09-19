# VTID-04095 — Acceptance

Found while live-verifying the already-merged operator-agent W0–W5c work
(VTID-04094) against staging, at the user's explicit request to confirm it
actually works — not by re-reading code, but by sending a real turn through
`POST /api/v1/operator/chat` on `preview-aws-gateway.vitanaland.com`.

## Root cause

`recordOperatorTurn()` (`operator-threads.ts`, VTID-04022/W4b) bulk-inserts
`[user, ...tools, assistant]` into `operator_messages` in one PostgREST
request. The tool-role objects carry `tool_name`; the user/assistant
objects did not. PostgREST rejects a bulk-insert array whose objects don't
all share the exact same key set — `PGRST102: "All object keys must
match"` — confirmed against the real endpoint:

```
$ curl -X POST https://inmkhvwdcuyhnxkgfvsb.supabase.co/rest/v1/operator_messages \
    -d '[{"role":"user",...},{"role":"tool","tool_name":"x",...},{"role":"assistant",...}]'
{"code":"PGRST102","details":null,"hint":null,"message":"All object keys must match"}
HTTP 400
```

The insert's own `.catch()`/`if (!ins.ok) console.warn(...)` swallows this
silently — the thread row still gets created/updated (a separate, single-
object write, unaffected), so nothing about the chat reply or the console
UI ever signaled a problem. Confirmed live: `operator_threads` has 40 real
rows; `operator_messages` has had **zero**, ever — since VTID-04022 shipped.
Almost every real operator turn calls at least one tool, so this fired on
effectively every turn threads were meant to record.

## Fix

`recordOperatorTurn()` now sets `tool_name: null` on the user/assistant
message objects, so every object in the bulk-insert array carries the same
key set. Behavior for the `tool` role objects is unchanged.

## Acceptance criteria

AC-1: operator_messages bulk insert succeeds when the turn included at
least one tool call (previously failed with PGRST102, silently, every time).
TEST: services/gateway/test/vtid-04022-operator-threads.test.ts — "creates
the thread on the first turn, appends user + tool + assistant messages,
increments turns on the next" — now asserts `recorded:true` against a fake
that itself enforces PostgREST's real same-keys bulk-insert constraint.

AC-2: the regression is real, not incidental — reverting the fix
reproduces the exact failure shape against the hardened fake.
TEST: mutation-verified manually and recorded in commands.log — stashing
operator-threads.ts and re-running the suite fails the same assertion the
live bug broke (`recorded:false` instead of `true`).

AC-3: no other call site in this module regresses from the fake being
made stricter.
TEST: services/gateway/test/vtid-04022-operator-threads.test.ts (15 tests)
and services/gateway/test/vtid-03960-operator-thread-menu.test.ts (25
tests) both pass in full, 40/40.

## Live verification

Diagnostic probe row inserted directly via SQL to confirm the table/RLS/
grants were never the blocker (they weren't — `service_role` has a
permissive `USING true / CHECK true` policy and full grants, identical to
`operator_threads`), then deleted. No other production data touched.

## Not done here

- Not re-tested against a live staging turn after deploy — the next real
  operator-chat turn with a tool call, once this merges and staging
  redeploys, is the confirming signal (`operator_messages` row count > 0).
- Did not audit other PostgREST bulk-insert call sites in the gateway for
  the same PGRST102 shape — this VTID is scoped to the one defect found
  live.
