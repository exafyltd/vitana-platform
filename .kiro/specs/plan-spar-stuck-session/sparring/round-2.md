# Sparring round 2 — converged

Session: `bbd53a84-4c5e-4b1d-ae52-7c65d44aa5ae` · plan hash `bbf1bb459ac848e0769496a584733630f73dae24c3fb891a1829eb7d360c0927`

## Summary

The revised plan addresses both accepted R1 findings correctly (§3.1 bounds both awaited calls, §3.5 adds the protected-gate merge routing step). The deferred R1-F2 rationale is sound. Three new minor findings: (1) §3.3 does not specify which of the two `waitFor` call sites in `create` gets the re-post recovery, and the test scenario ("exactly 2 posts") covers only one path; (2) the invariant `WAIT_MS > STALE_AFTER_MS` required by §3.3 is cross-file and undocumented; (3) `writeRound` + `mustFetch` execute after `runPartnerPass` returns and are not bounded by the 15-min pass deadline, leaving only a 5-minute buffer before the new 20-min STALE_AFTER_MS fires — the plan acknowledges the `round_conflict` safety net but does not justify that 5 minutes is sufficient. None of the three rise to blocker or major.

## Findings

### R2-F1 [minor]

§3.3's 're-post when waitFor times out' recovery applies to an ambiguous call site. The current `create` function has two `waitFor` invocations: line 166 (when the initial POST returns an in_progress, 0-round, deduped session) and line 171 (after the lost-response re-post at line 169). The incident scenario specifically enters via the line 171 path: initial POST hangs → AbortSignal fires at 25 min → `lost()` → re-post at line 169 → deduped session returned → `waitFor` at line 171 times out. The plan says 'when `waitFor(id, 1)` times out, re-post the same body once' without specifying which site, and the proposed test ('exactly 2 posts') exercises only the line 166 path. If the implementer wraps only line 166, the line 171 path has no §3.3 recovery — it is covered by §3.1+§3.2 independently (re-post at ~25 min with STALE_AFTER_MS=20 min → escalate → new session → pass bounded to 15 min → done), but the plan's own test does not exercise the incident path through §3.3.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:164` — async create(body) {
  const r = await call('POST', '/api/v1/plans/spar', body);
  if (r.json?.session) return r.json.session.rounds.length >= 1 || r.json.session.verdict !== 'in_progress' ? r.json.session : waitFor(r.json.session.id, 1);
  if (!lost(r)) throw new Error(`create: HTTP ${r.status} ${JSON.stringify(r.json)}`);
  const again = await call('POST', '/api/v1/plans/spar', body);
  if (!again.json?.session) throw new Error(`create retry: HTTP ${again.status}`);
  return waitFor(again.json.session.id, 1);
},

Suggestion: Explicitly state in §3.3 whether the `waitFor`-timeout recovery wraps both call sites (line 166 and line 171) or only one. Add a second test scenario in `plan-spar.test.mjs` that exercises the lost-response path (initial POST status 0 → re-post → stuck dedup → waitFor times out → second re-post → fresh session), confirming 3 total POST calls in that path. This removes the ambiguity from the patch and ensures the incident scenario is directly regression-tested under §3.3 rather than relying solely on §3.1+§3.2.

### R2-F2 [minor]

The §3.3 re-post-on-timeout recovery depends on the invariant WAIT_MS (25 min, in plan-spar.mjs) > STALE_AFTER_MS (20 min, in plan-sparring-service.ts). If this invariant is violated — e.g. STALE_AFTER_MS is raised above 25 min in a future change — the re-post would arrive before the session is considered dead, the gateway would return the same session, the `stuck` error would fire, and CI jobs would fail indefinitely for all plans until the constants are rebalanced. Neither file currently references the other for this relationship; the only cross-file coupling comment in plan-spar.mjs documents PLAN_SPARRING_REPOS (line 37–40) but not the timing invariant.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:45` — const POLL_MS = 20_000;
const WAIT_MS = 25 * 60_000;
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:47` — /**
 * VTID-05254: age after which an in_progress session with no round is treated as dead. A dead pass and a
 * slow live one look the same on the row, so this is flat and well past the longest pass deadline (15 min).
 */
export const STALE_AFTER_MS = 60 * 60_000;

Suggestion: Add a cross-reference comment to `WAIT_MS` in `plan-spar.mjs` stating that it must remain greater than `STALE_AFTER_MS` in `plan-sparring-service.ts` for the stuck-session re-post recovery in `create` to trigger escalation. Optionally add a test assertion in `plan-spar.test.mjs` that imports the exported `STALE_AFTER_MS` equivalent (or documents the required relationship) to make the invariant machine-checkable.

### R2-F3 [minor]

`writeRound` and `mustFetch` in `createSparringSession` (lines 323–338) execute AFTER `runPartnerPass` returns and are not bounded by the 15-min pass deadline. The new STALE_AFTER_MS of 20 min leaves only a 5-minute buffer above the 15-min pass deadline for these two DB calls to complete before a concurrent re-post can trigger `isDeadRoundOne`. The old 60-min window gave a 45-minute buffer for the same DB calls. Under DB stress (slow Supabase response, failover, or connection saturation) these writes could exceed 5 minutes, causing `isDeadRoundOne` to fire on a session mid-write; the late `writeRound` would then be refused with `round_conflict` and the completed review discarded. The plan's §5 risk acknowledges '+ one `writeRound`' and the `round_conflict` safety net, but does not quantify why 5 minutes is a sufficient bound.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:314` — const pass = await runPartnerPass({
  round: 1,
  ...  deadlineMs: PASS_DEADLINE_MS[input.change_class],
  now: deps.now,
});

if (!pass.ok) {
  await writeRound(deps, session, { ... }, { verdict: 'escalated', ... });
} else {
  await writeRound(deps, session, { ... }, { verdict: 'in_progress', ... });
}
return { session: await mustFetch(deps, session.id), deduplicated: false };
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:47` — /**
 * VTID-05254: age after which an in_progress session with no round is treated as dead. A dead pass and a
 * slow live one look the same on the row, so this is flat and well past the longest pass deadline (15 min).
 */
export const STALE_AFTER_MS = 60 * 60_000;

Suggestion: Add a brief comment at the STALE_AFTER_MS definition site stating the budget breakdown: 15 min (pass deadline) + N min (writeRound + mustFetch expected worst-case) must remain below 20 min. If the DB write + fetch SLA is known (e.g. p99 < 30 s), document it there. Alternatively, add a gateway-level DB write timeout for `writeRound` to give an explicit upper bound on that portion, shrinking the uncertainty in the buffer calculation.

## Acknowledgements of earlier responses

- R1-F2: acknowledged — Rationale is sound. Threading AbortSignal through llm-router and every LLM caller (bedrock.ts, llm-router.ts) is genuinely out of scope for this fix. The orphaned request costs a connection but not correctness: the session is already escalated and a late write is refused with round_conflict. Documenting the deferral in §3.3 ('Not cancelled') is an adequate treatment.
