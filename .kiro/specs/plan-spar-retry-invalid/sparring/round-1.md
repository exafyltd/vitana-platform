# Sparring round 1 — in_progress

Session: `6da8bdd3-19c4-4c25-aacd-30cd0e3d2164` · plan hash `7c0a07f9619b199216f9b101235663b1e2dcf921db1194a0ebdb573d8cc73ddb`

## Summary

All file and line premises I could verify check out. The plan's description of today's code is accurate: `partner_output_invalid` is in `INFRA_REASONS` (line 34) but not `RETRYABLE_REASONS` (line 35) in plan-spar.mjs; the gateway's `RETRYABLE_REASONS` at line 46 of plan-sparring-service.ts is likewise missing it; the handoff sets `next_actor: 'claude'` (line 278); and test:193 pins the current "not auto-retried" behaviour. Two substantive issues were found: one blocker (the cap bypass when plan hash changes) and one major (lost-response path silently drops `retry_exhausted`).

## Findings

### R1-F1 [blocker]

The gateway-side retry cap can be bypassed by a trivial plan-text edit, creating an unbounded loop despite the plan's stated guarantee that 'editing plan.md does not reset it'.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-service.ts:259` — const existing = await repo.fetchSessionByPlanHash(deps.sb, input.producer, plan.hash); … if (existing.data) { … const retryable = … if (!retryable) return { session: e, deduplicated: true }; } } const ins = await repo.insertSession(…)
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-repository.ts:74` — export async function fetchSessionByPlanHash(sb, producer, planHash) — .eq('producer', producer).eq('plan_hash', planHash).order('created_at', { ascending: false }).limit(1).maybeSingle()
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:188` — const retryInfra = cur && cur.verdict === 'escalated' && cur.infra && cur.retryable; … if (!cur || retryInfra || replan) { … if (retryInfra) state.sessions.pop(); session = await client.create({ … producer: `ci-plan-spar.${slug}`

Suggestion: The count query must be executed regardless of whether `fetchSessionByPlanHash` found a match for the current hash. Place it either (a) before the `fetchSessionByPlanHash` call at the top of `createSparringSession`, or (b) just before `insertSession` at line 289, outside the `if (existing.data)` block. Scoping it to the `else` branch (line 282) means any plan-text change between pushes causes `existing.data` to be null, skips the count, and inserts without limit. The test spec line 'also when the plan hash changed in between' cannot be satisfied by the described placement.

### R1-F2 [major]

The `gatewayClient.create` lost-response recovery path (lines 119–121) calls `waitFor`, which polls via GET; the GET endpoint returns only `{ ok, session }` with no `retry_exhausted` field. A careless implementation will drop `retry_exhausted` on this path, the CI will see `undefined` (falsy), set `entry.retryable = true`, and loop on the next push.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:103` — const waitFor = async (id, rounds) => { … const g = await call('GET', `/api/v1/plans/spar/${id}`); const s = g.json?.session; if (s && …) return s; } … const again = await call('POST', …); … return waitFor(again.json.session.id, 1);
- `exafyltd/vitana-platform:services/gateway/src/routes/plans-spar.ts:46` — router.post('/', …) { const { session, deduplicated } = await createSparringSession(…); return res.status(deduplicated ? 200 : 201).json({ ok: true, deduplicated, session }); } … router.get('/:id', …) { return res.status(200).json({ ok: true, session }); }
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:227` — entry.retryable = (session.escalation_reasons ?? []).some((x) => RETRYABLE_REASONS.includes(x));

Suggestion: The lost-response path must capture `retry_exhausted` from `again.json` before entering `waitFor`, then return it alongside the session. For example: `const { retry_exhausted, deduplicated } = again.json; const session = await waitFor(again.json.session.id, 1); return { session, deduplicated, retry_exhausted };`. The plan states this path will be handled but gives no mechanism; it must be made explicit in the implementation spec to prevent a silent regression.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
