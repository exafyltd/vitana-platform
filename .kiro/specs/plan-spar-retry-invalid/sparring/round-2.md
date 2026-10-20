# Sparring round 2 — in_progress

Session: `6da8bdd3-19c4-4c25-aacd-30cd0e3d2164` · plan hash `b26b45423f5b4425f7dde1d54a4a32dc0367b4cb0917f4bcb0dcb9e29ac16898`

## Summary

Both R1-F1 and R1-F2 were accepted and the revised plan does address their core concerns. R1-F1: the cap query is now correctly placed outside the `if (existing.data)` block, before `insertSession`. R1-F2: the plan now spells out all three `gatewayClient.create` paths capturing flags from `r.json`/`again.json` before polling. However, the R1-F2 fix introduces a new interface-breaking change to `gatewayClient.create`'s return shape whose downstream effects on `step()`'s call site and the entire `fakeClient`-based test suite are unspecified (R2-F1). Separately, Change 4's `next_actor` flip from `'claude'` to `'kiro'` for retryable infra breaks an existing test that the plan does not mention updating (R2-F2).

## Findings

### R2-F1 [major]

The plan changes `gatewayClient.create`'s return shape from a bare session to `{ session, deduplicated, retry_exhausted }` but does not update (a) the call site in `step()` at line 194/203 that assigns the result to `session` and immediately reads `session.id`, (b) the seven-plus existing `fakeClient`-based tests that supply raw session objects via `take()`, or (c) the `round` path at line 215 where `deduplicated`/`retry_exhausted` would be undefined at the shared block that uses them at line 228.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:113` — async create(body) { const r = await call('POST', '/api/v1/plans/spar', body); if (r.json?.session) return r.json.session.rounds.length >= 1 || r.json.session.verdict !== 'in_progress' ? r.json.session : waitFor(r.json.session.id, 1); … const again = await call('POST', …); … return waitFor(again.json.session.id, 1); }
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:190` — session = await client.create({ plan_text: planText, producer: `ci-plan-spar.${slug}`, … }); state.sessions.push({ id: session.id, submitted: [], plan_text_sha: sha(planText) });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:215` — session = await client.round(cur.id, n + 1, { … }); … entry.retryable = (session.escalation_reasons ?? []).some((x) => RETRYABLE_REASONS.includes(x));
- `exafyltd/vitana-platform:scripts/collab/plan-spar.test.mjs:33` — function fakeClient(script) { … create: async (b) => { calls.push(['create', b]); return take(); }, round: async (id, n, b) => { calls.push(['round', id, n, b]); return take(); }, … }

Suggestion: The plan must explicitly specify: (1) the call site at line 194 changes from `session = await client.create({…})` to `const { session, deduplicated, retry_exhausted } = await client.create({…})`, with `let deduplicated = false, retry_exhausted = false` declared before the if/else so they are always in scope at line 228 on the `round` path; (2) `fakeClient.create` at test line 39 changes its return from `take()` to `{ session: take(), deduplicated: false, retry_exhausted: false }` (with overrides for the new cap-exhaustion tests), and all existing tests that assert on `session` properties pass the unwrapped object; (3) `state.sessions.push({ id: session.id, … })` at line 203 uses the already-destructured `session` variable. These three items must appear in the implementation spec, not be left for the implementer to infer.

### R2-F2 [major]

Change 4 flips the handoff `next_actor` from `'claude'` to `'kiro'` for every infra escalation that will be retried. `code_access_unavailable` is already in `RETRYABLE_REASONS` (line 35) and already causes `retryInfra` to be true. The test at lines 140–153 therefore asserts `next_actor: 'claude'` for exactly that case after the change, and will fail. The plan only mentions updating the test at line 193, not the test at line 140.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:34` — const INFRA_REASONS = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded', 'partner_output_invalid']; const RETRYABLE_REASONS = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded'];
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:277` — write(handoffPath, appendLog(setFrontMatter(ht, infra ? { next_actor: 'claude', updated: t } : { state: 'parked', …, next_actor: 'claude', updated: t }), …))
- `exafyltd/vitana-platform:scripts/collab/plan-spar.test.mjs:140` — test('a partner outage hands the plan to Claude, is never parked, and the retry does not use up a session', … const down = sess('S1', [[]], 'escalated', { escalation_reasons: ['code_access_unavailable'] }); … assert.equal(h.next_actor, 'claude');

Suggestion: Add the test at lines 140–153 to the list of tests the plan updates. Its name, log-line assertion, and `next_actor` assertion must all change: after the fix, a retryable infra escalation (`code_access_unavailable`, `model_unavailable`, `deadline_exceeded`) sets `next_actor: 'kiro'`, not `'claude'`. The plan should state this explicitly alongside the :193 update.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — The revised plan places the cap count query before `insertSession` and outside the `if (existing.data)` block, which is the correct placement. The count is scoped to the producer window regardless of plan hash, satisfying the original concern. No further issue with this fix.
- R1-F2: acknowledged — The revised plan correctly names all three `gatewayClient.create` paths and pins the flag capture to `r.json`/`again.json` before any `waitFor` poll. The core concern (flags dropped on the lost-response path) is addressed. The downstream call-site and test impacts are raised separately as R2-F1.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
