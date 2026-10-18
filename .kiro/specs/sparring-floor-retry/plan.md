# Plan — sparring-floor-retry

Treat a round-1 `evidence_floor_not_met` escalation as a retryable partner failure, so the 10 multi-tenant plans
it stranded can re-spar without using up their last sparring session.

<!-- plan:begin -->
## Problem

Ten `plan(` PRs (mt-identity, mt-track-s, mt-data-cleanup, mt-network, mt-community-isolation, mt-tenant-admin,
mt-packs, mt-jobs, mt-launch, mt-discover) have one sparring session that escalated in round 1 with
`evidence_floor_not_met: round 1 needs at least 3 premise checks citing read_file results (have 0)`. That
happened while the partner's GitHub code-read token was broken (since fixed: `PLAN_SPARRING_GITHUB_TOKEN`
now reads both repos). With 0 `read_file` results the partner could not cite code, so no review took place.
This was a partner-side failure, not a problem with the plans.

It is classified as a plan problem anyway:
- `services/gateway/src/services/plan-sparring/partner.ts` (~line 244) raises `evidence_floor_not_met` only
  when the failed submission matched `/round 1 needs at least/`, which means round 1 and no accepted review.
- `scripts/collab/plan-spar.mjs` `INFRA_REASONS` / `RETRYABLE_REASONS` (lines 32–33) do not list it, so
  `state.json` stores `infra: false, retryable: false`.
- `step()` (line ~186) therefore sees no `retryInfra`. `replan` fires only on a changed plan text, and it
  spends session 2 of `MAX_SESSIONS = 2`; a second escalation parks the plan.
- The gateway's `createSparringSession` dedups by plan hash and re-runs only sessions whose reasons are in
  its own `RETRYABLE_REASONS` (`plan-sparring-service.ts` line 46: "Sessions that never got a real review
  may be re-run instead of deduplicated"). Even a client-side retry would get the old escalated session back.

Observed result: the "spar on fixed gateway" pushes at 2026-10-18T18:42–18:45Z ran PLAN-SPAR green
(runs 39155415959…39155608288) and committed nothing ("nothing to commit"). The plans are stuck until a
human edits each plan text and spends its last session.

## Goal

Re-run a round-1 `evidence_floor_not_met` session automatically on the next push, with the same rules as
the existing partner-outage retry. The retry replaces the failed session and does not use up one of the
plan's two sessions.

## Changes

1. `services/gateway/src/services/plan-sparring/plan-sparring-service.ts`: add `evidence_floor_not_met`
   to `RETRYABLE_REASONS`. It is emitted only for round 1 with no accepted review, so it matches that
   constant's documented meaning. `human_approved_by` still blocks a re-run, as today.
2. `scripts/collab/plan-spar.mjs`:
   - add `evidence_floor_not_met` to `INFRA_REASONS` and `RETRYABLE_REASONS` (so the handoff log says
     "partner could not review", not "parked").
   - **existing state migration:** `state.json` entries written before this change carry
     `infra: false, retryable: false`. When the current session is `escalated` and not `infra`, `step()`
     reads the live session (`client.get(cur.id)`, already used for the `in_progress` path) and recomputes
     `infra` / `retryable` from its `escalation_reasons`. If it is now retryable, it takes the `retryInfra`
     path (pop + create). A failed `get` or a session with a different `producer` keeps today's behaviour.
3. Tests:
   - `scripts/collab/plan-spar.test.mjs`: (a) a fresh `evidence_floor_not_met` escalation is stored as
     `infra: true, retryable: true` and the handoff gets the "partner unavailable" entry, not `parked`;
     (b) a legacy state entry (`infra: false`) whose live session has `evidence_floor_not_met` is retried,
     the session count stays 1, and no `s2-` files appear; (c) a legacy entry whose live reasons are a
     real non-convergence (e.g. `round_cap_reached`) is NOT retried, so today's replan/park path is unchanged.
   - `services/gateway/test/vtid-04868-plan-sparring-service.test.ts`: a create with the same plan hash
     as an `evidence_floor_not_met` session starts a new session (no dedup); `round_cap_reached` still dedups.

## Lanes

One lane, `floor-retry-code`, **executor: claude**. `scripts/collab/**` is a governance path (collaboration
§3a), so a Kiro lane would fail Lane scope. Reviewer seat `exafy` (the planner seat, not the executor).

## Out of scope

- Changing the evidence floor itself (3 premise checks in round 1 stays).
- Editing the 10 stranded plans. After merge and staging deploy, each authoring seat (hotmail) pushes once and
  the retry happens. No plan text changes, no session spent.
- Any change to round ≥2 escalations or to `partner_output_invalid` handling.

## Risks

- A partner that keeps failing the floor for a real reason (not a code-access outage) is retried once per
  push instead of parking. Each retry needs a planner push and still produces the escalation record, so it
  cannot loop on its own. `deadline_exceeded` and `model_unavailable` already work the same way.

## Verification

- `node --test scripts/collab/plan-spar.test.mjs`, gateway Jest `vtid-04868-plan-sparring-service`,
  `npx tsc --noEmit` in `services/gateway`, `scripts/ci/test-vtid-04868-plan-sparring.sh`.
- Staging (read-only, CI only): after the staging gateway deploys the merge commit, one push to a stranded
  plan (e.g. mt-identity) produces a new `sparring/state.json` session id and a `round-1.md` with findings
  that cite `read_file` evidence. No production calls.
<!-- plan:end -->
