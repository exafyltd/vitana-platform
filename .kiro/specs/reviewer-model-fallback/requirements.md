# Requirements — reviewer-model-fallback

## R1 — The chain change of 91d26a15 is recorded, not changed
The reviewer agent's verdict counts on any model of `REVIEWER_AGENT_MODELS`
(`claude-sonnet-5.5` → `claude-opus-5.5` → `claude-sonnet-4.5`, `governance.ts:35`), exact identity strings only,
current head only. This plan does not alter that behaviour unless the sparring partner finds a defect in it.

## R2 — Claude only, exact identity
No non-Claude model can enter the chain; near-miss reviewer strings never count (`governance.test.ts:216-247`).

## R3 — A CI VTID for the change
The lane's VTID comes from CI PLAN-SPAR after policy approval (`converged-auto-v1`), never by hand.

## R4 — Read-only staging suite
`docs/validation/<VTID>/staging-tests.json` for service `gateway`: `/alive`, the public PM `/mode`, the auth-gated
PM `/status` as a rejected probe, and the `existing` jest suite `npx jest test/project-manager`. No write, no
production target (rule 48).

## R5 — Commit coverage for 91d26a15
One `docs/validation/commit-coverage.json` `covers[]` entry for `91d26a1560763d0835d85276cda7d139e496aa12` naming the
VTID, why its suite covers the change, and the approval (owner instruction 2026-10-21 + the converged sparring record).

## R6 — Verified on staging
The next gateway STAGING-VERIFY whose range contains `91d26a15` lists it as covered and passes.
