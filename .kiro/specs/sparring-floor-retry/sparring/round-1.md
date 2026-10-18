# Sparring round 1 — in_progress

Session: `d0be51a3-2a9e-4557-b7e7-6fd39d26836e` · plan hash `97f0eac8d383a20b49d5b4956caddc64d3ad60a4ad54d0efec552168ea8e70e8`

## Summary

All core premises in the plan hold against the pinned code. The diagnosis is accurate and the two-part fix (gateway RETRYABLE_REASONS + script INFRA/RETRYABLE_REASONS + state migration) is logically sound for the 10 stranded plans. One major gap exists: the plan-spar.mjs test scenario (b) cannot be implemented as described because the existing fakeClient.get() returns null before any create() call, making the migration test either unwritable or silently vacuous. Three minor issues follow.

## Findings

### R1-F1 [major]

Test scenario (b) — 'a legacy state entry (infra: false) whose live session has evidence_floor_not_met is retried' — cannot be implemented as described because fakeClient.get() in plan-spar.test.mjs returns null when called before any create() call, which is exactly the situation for a migration test. The migration code in step() calls client.get(cur.id) before client.create(). With the default fakeClient, last = null at that point, so get() returns null (line 41: 'last && last.id === id ? ... : null'). The migration then sees live = null, does not fire, and step() returns nothing_to_do. The test assertion 'session count stays 1' passes for the wrong reason (no-op instead of pop+create), giving a false green. The existing test at line 187 demonstrates the correct override pattern (c.get = async (id) => ...) but the plan does not mention it. Without explicitly specifying this override, the executor will either write a broken test or write one that passes vacuously.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.test.mjs:33` — get: async (id) => (last && last.id === id ? { producer: 'ci-plan-spar.cards', ...last } : null)
- `exafyltd/vitana-platform:scripts/collab/plan-spar.test.mjs:185` — c.get = async (id) => ({ id, producer: 'ci-plan-spar.other', verdict: 'in_progress', rounds: [{}] });
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:186` — const retryInfra = cur && cur.verdict === 'escalated' && cur.infra && cur.retryable;

Suggestion: The plan must explicitly specify that test (b) overrides c.get on the fakeClient before calling step(), e.g. 'c.get = async (id) => id === legacyId ? { id: legacyId, producer: "ci-plan-spar.cards", verdict: "escalated", escalation_reasons: ["evidence_floor_not_met"], rounds: [], ... } : null'. The test must also assert that c.calls contains a create entry (not just that session count is 1), otherwise the nothing_to_do path produces an identical count and the test proves nothing about the migration.

### R1-F2 [minor]

The migration code as described calls client.get() for every escalated + !infra session on every push, not just sessions that could plausibly be evidence_floor_not_met. Any plan that was legitimately parked with round_cap_reached or disputed_items before this change also has infra: false stored. On every subsequent push those plans will incur an extra live API call (client.get), conclude liveRetryable = false, and fall through to nothing_to_do. There is no guard on this wasted call and no mention of it in the plan.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:186` — const retryInfra = cur && cur.verdict === 'escalated' && cur.infra && cur.retryable;
const replan = cur && cur.verdict === 'escalated' && !cur.infra && state.sessions.length < MAX_SESSIONS && cur.plan_text_sha !== sha(planText);
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:128` — async get(id) { if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null; const g = await call('GET', `/api/v1/plans/spar/${id}`); return g.json?.session ?? null; }

Suggestion: Scope the client.get() call to cases where it is likely to be useful: add a guard such as '!cur.infra && !cur.retryable' (i.e. the entry was stored before the fix and has neither flag set), rather than calling get() for all non-infra escalated sessions. Legacy round_cap_reached plans will not have a retryable session anyway, but avoiding the call keeps nothing_to_do truly free of network I/O.

### R1-F3 [minor]

The verification section lists scripts/ci/test-vtid-04868-plan-sparring.sh as a verification step. Reading the script shows it spins up a local Postgres, applies SQL migration files (20261004110000_vtid_04868_plan_sparring_gate.sql and the hardening migration), runs SQL-level pgTAP assertions, and tests rollback/re-apply of those migrations. It exercises no JavaScript code at all. This plan makes zero database-schema changes; the script verifies only the existing DB layer. Including it implies it covers the new behaviour, which it does not.

- `exafyltd/vitana-platform:scripts/ci/test-vtid-04868-plan-sparring.sh:1` — # VTID-04868: Plan Sparring Gate DB foundation ... apply the migration and the hardening migration twice each, run the gate assertions
- `exafyltd/vitana-platform:scripts/ci/test-vtid-04868-plan-sparring.sh:38` — ${PSQL[@]} -f "$FIXTURE" ... ${PSQL[@]} -f "$MIGRATION" ... ${PSQL[@]} -f "$HARDENING"

Suggestion: Remove test-vtid-04868-plan-sparring.sh from the verification steps for this change (or note explicitly that it is a regression-only check for the DB layer and provides no coverage of the new evidence_floor_not_met retry path). The actual coverage comes from 'node --test scripts/collab/plan-spar.test.mjs' and the Jest suite.

### R1-F4 [minor]

evidence_floor_not_met is only raised when invalidSubmissions > PARTNER_MAX_INVALID_SUBMISSIONS (line 242: '>2', i.e. 3+ failed submit_review calls). A broken-token partner that exhausts PARTNER_MAX_TURNS_PER_ROUND = 40 turns before reaching 3 invalid submissions would escalate as partner_output_invalid instead. partner_output_invalid is in INFRA_REASONS (treated as 'not a plan problem', goes to Claude) but is NOT in RETRYABLE_REASONS (not auto-retried by the gateway). Such sessions would remain stuck after this fix. The plan does not acknowledge this case nor verify that none of the 10 stranded plans landed in this state.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:39` — export const PARTNER_MAX_INVALID_SUBMISSIONS = 2;
export const PARTNER_MAX_TURNS_PER_ROUND = 40 (implicit from line 128 for loop)
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:242` — if (invalidSubmissions > PARTNER_MAX_INVALID_SUBMISSIONS) { const floorProblem = /round 1 needs at least/.test(lastProblem); return fail(floorProblem ? 'evidence_floor_not_met' : 'partner_output_invalid', lastProblem); }
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:32` — const INFRA_REASONS = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded', 'partner_output_invalid'];
const RETRYABLE_REASONS = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded'];

Suggestion: Before merging, verify the escalation_reasons stored for each of the 10 stranded sessions. If any show partner_output_invalid rather than evidence_floor_not_met, that plan is not rescued by this change and needs manual intervention (e.g. a one-off bump of the plan text). Note: with 40 turns and an AI model that actively calls tools, the 3-submission threshold is almost certainly hit before the turn cap, so this is unlikely to affect the stranded plans in practice.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
