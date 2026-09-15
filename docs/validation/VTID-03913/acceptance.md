# VTID-03913 — Fix concurrent-generation race in POST /specs/:vtid/generate

Found live while watching the newly-shipped operator-planner (VTID-03902)
run its first sweeps on AWS staging against a real backlog of stranded
operator-chat tasks.

## Root cause

Staging runs multiple ECS task replicas for `vitana-gateway`, each
independently running its own in-process `operator-planner.ts` interval
loop (no cross-instance coordination — by design, that loop is a plain
`setInterval`, not a singleton). Three `operator.planner.sweep_completed`
events fired within ~90 seconds of each other, which is only possible if
more than one process was running the sweep concurrently.

Both replicas' loops query the same "operator-chat tasks stuck at
`spec_status=missing`" backlog before either one's write commits, then both
call `POST /api/v1/specs/:vtid/generate` for the same vtid at nearly the
same time. That route's own "claim" step (VTID-01188, pre-existing, not
part of VTID-03902) was an **unconditional** `PATCH spec_status='generating'`
— it never checked the row's current state before writing, so both
concurrent callers "won" the claim and both proceeded. Both then called
`get_next_spec_version` (also non-atomic) and could compute the same next
version number, and whichever lost the `oasis_specs` insert got
`spec_insert_failed` — which the route's own failure path resets to
`spec_status='missing'` + `spec_last_error` set.

Because `operator-planner.ts` deliberately never auto-retries a row with
`spec_last_error` set (by design — a failed row needs human/Operator
attention, not an infinite retry loop), three real tasks landed
permanently stuck: VTID-03350, VTID-03869, VTID-03870.

## Fix

`services/gateway/src/routes/specs.ts`'s claim step is now a
compare-and-swap: `PATCH vtid_ledger?vtid=eq.X&spec_status=not.eq.generating`
with `Prefer: return=representation`. A caller that loses the race gets an
empty array back and returns `409 already_generating` immediately —
without touching the LLM, `get_next_spec_version`, the `oasis_specs`
insert, or the ledger's `spec_last_error` (leaving the row exactly as the
winning caller left it). `not.eq.generating` (not a "must be missing"
filter) deliberately allows every other legitimate starting state
(`missing`, `draft`, `approved`, …) so a human re-requesting a regenerate
via the Command Hub / `dev_generate_spec` chat tool is unaffected — only a
second call while a generation is *already in flight* for the same vtid is
rejected.

---

AC-1 — the claim step is a conditional UPDATE, not an unconditional PATCH

TEST: `test/specs-generate-claim.test.ts` — "claims via a conditional
UPDATE, not an unconditional PATCH" (asserts the first `vtid_ledger` PATCH
URL carries `spec_status=not.eq.generating`)
Output: outputs/targeted-tests.txt
Mutation-verified: reverting the filter (stripping
`&spec_status=not.eq.generating` from the claim URL) fails this test.

AC-2 — a losing concurrent caller gets 409 `already_generating` and never
reaches the LLM, the version RPC, or the spec insert

TEST: `test/specs-generate-claim.test.ts` — "a losing concurrent caller
gets 409 and never reaches the LLM/version/insert steps"
Output: outputs/targeted-tests.txt

AC-3 — a losing caller does not touch `spec_last_error` or otherwise write
to the ledger beyond its own failed claim attempt

TEST: `test/specs-generate-claim.test.ts` — "a losing caller does not
touch spec_last_error or reset the ledger"
Output: outputs/targeted-tests.txt

AC-4 — no regression to the existing gateway test suite, type-checking, or
build

TEST: `npx jest` (full suite)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt

AC-5 — the three real tasks stuck by this race (VTID-03350, VTID-03869,
VTID-03870) are manually retried and get real drafted specs once this
fix is live on staging

CURL: `POST https://preview-aws-gateway.vitanaland.com/api/v1/specs/VTID-0335
0/generate` (and the same for VTID-03869, VTID-03870) after this PR's
staging deploy completes.
Output: commands.log
