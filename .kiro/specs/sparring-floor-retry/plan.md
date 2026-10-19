# Plan — sparring-floor-retry

When every code read fails in a round, classify the round as a retryable code-access failure, not
`evidence_floor_not_met`. Re-spar the 10 multi-tenant plans this stranded without using up their last session.

<!-- plan:begin -->
## Problem

Ten `plan(` PRs (mt-identity, mt-track-s, mt-data-cleanup, mt-network, mt-community-isolation, mt-tenant-admin,
mt-packs, mt-jobs, mt-launch, mt-discover) each have one sparring session, escalated in round 1 with
`evidence_floor_not_met`.

**Evidence, read from each session (`GET /api/v1/plans/spar/:id`, staging):**
- All 10 ran on 2026-10-17 between 18:39Z and 18:44Z.
- Every round-1 `tool_log` has 15–30 entries and **0 with `ok: true`**. The partner called
  `read_file` / `list_dir` / `search`, and every GitHub read failed.
- Every escalation reason is `evidence_floor_not_met`. None is `partner_output_invalid` (sparring R1-F4).
- Sessions created after the code-read token was fixed (2026-10-18) pass the floor: mt-guardrails 30/30 reads
  ok, native-g1-wiring 20/25, this plan 16/17.

So this is not an intermittent flake in the partner's behaviour. It is a code-access outage that got the wrong
label.

**Why it gets the wrong label:**
- `plan-sparring-service.ts` `hasCodeAccess` is `Boolean(planSparringGithubToken())`. It only checks that the
  token is set. A token that is set but broken passes it, and `code_access_unavailable` is never raised.
- `partner.ts` (~L242) then fails the round on the evidence floor. It returns `evidence_floor_not_met` when the last
  rejected submission matched `/round 1 needs at least/`, and `partner_output_invalid` otherwise. A partner with
  zero readable files can never meet the floor, so this is a reliable outcome, not a judgement on the plan.
- That reason is in neither `plan-spar.mjs` `INFRA_REASONS` nor `RETRYABLE_REASONS` (L32–33), so `state.json`
  stores `infra: false, retryable: false`. `step()` (L186) never retries. `replan` needs a changed plan text and
  uses session 2 of `MAX_SESSIONS = 2`.
- The gateway create dedups by plan hash, and re-runs only sessions whose reasons are in its own
  `RETRYABLE_REASONS` (L46). Even a client-side retry would get the old session back.

Observed: the re-pushes at 2026-10-18T18:42–18:45Z ran PLAN-SPAR green and committed nothing.

## Goal

1. A round where the partner attempted code reads and **none succeeded** escalates as `code_access_unavailable`
   (already infra and retryable everywhere), whatever the floor check said.
2. The 10 stored sessions with that shape get re-run on their next push. That needs no plan edit and does not use
   up a session.
3. A round-1 floor failure where reads **did** succeed stays a real, non-retryable `evidence_floor_not_met`. Real
   non-convergence (`round_cap_reached`, a round ≥2 failure) is unchanged.

## Changes

1. `services/gateway/src/services/plan-sparring/partner.ts`: one helper,
   `codeAccessFailed(toolLog) = toolLog.length > 0 && toolLog.every((e) => !e.ok)`. At the
   invalid-submission exit (~L242) and the turn-cap exit (~L253), if it is true, return
   `fail('code_access_unavailable', 'every code read failed this round (N attempts): <first error>')` instead of
   `evidence_floor_not_met` / `partner_output_invalid`.
2. `services/gateway/src/services/plan-sparring/plan-sparring-service.ts`: in the create dedup (~L251), a stored
   session is also retryable when its reasons include `evidence_floor_not_met` or `partner_output_invalid` **and**
   its round-1 `tool_log` meets the same `codeAccessFailed` test. This covers the 10 legacy sessions, which were
   stored before change 1. The test is exported from `partner.ts` and used in both places.
   `human_approved_by` still blocks a re-run.
3. `scripts/collab/plan-spar.mjs`: legacy-state migration in `step()`. Run it only when the current entry is
   `verdict: 'escalated'`, `infra === false`, `retryable === false` **and** has no `reclassified` key (R1-F2:
   each legacy session is checked at most once, and a normal no-op push makes no network call):
   - call `client.get(cur.id)`. If the live session's `producer` is `ci-plan-spar.<slug>`, its reasons include
     `evidence_floor_not_met` / `partner_output_invalid`, and its round-1 `tool_log` has entries with none `ok`,
     set `cur.infra = cur.retryable = true`. The existing `retryInfra` path then pops it and creates a new session.
   - otherwise set `cur.reclassified = false` and continue as today.
   New escalations need no list change: change 1 reports them as `code_access_unavailable`, which is already in both
   lists.
4. Tests:
   - `services/gateway/test/vtid-04868-plan-sparring-service.test.ts`:
     - a pass whose tool executor fails every read escalates `code_access_unavailable`;
     - a pass with ≥1 ok read and too few cited premises still escalates `evidence_floor_not_met`;
     - create with the same plan hash as a stored floor session whose round-1 `tool_log` is all failed starts a
       new session;
     - the same with an ok entry in `tool_log`, or with `round_cap_reached`, is deduped.
   - `scripts/collab/plan-spar.test.mjs` (R1-F1: each migration test overrides `c.get`, using the pattern at L185):
     - (a) legacy entry, live session all-failed floor → `c.calls` contains a `create`, the session count stays
       1, the new session id is stored, and no `s2-` files are written;
     - (b) legacy entry, live floor session with an ok read → no `create`, `reclassified: false` stored,
       `nothing_to_do`;
     - (c) an entry already carrying `reclassified: false` → `c.get` is never called (assert with a counting
       stub);
     - (d) `round_cap_reached` legacy entry → no `create`, and the replan/park path is unchanged.

## Lanes

One lane, `floor-retry-code`, **executor: claude**. `scripts/collab/**` is a governance path (collaboration §3a).
Reviewer seat `exafy`.

## Coordination

`plan-spar.mjs` is also edited by `plan(sparring-token-efficiency)` #4189 (lane `plan-spar-reasons`, adds
`token_budget` to the reason lists) and `plan(collab-throughput)` #4191. All three are Claude Code lanes. This one
goes first. The others rebase on it.

## Out of scope

- The evidence floor itself (3 cited premise checks in round 1 stays).
- Making `hasCodeAccess` probe GitHub. Change 1 reports the real outcome at the point of use, so no extra call is
  needed per session.
- Editing the 10 plans. After merge and the staging deploy, one push per plan (author seat hotmail) re-runs it.
- Pinning a vitana-v1 ref for cross-repo plans. That is `native-g1-wiring`'s `spar-vitana-v1-ref` lane (the
  gateway already accepts `extra_refs`).

## Risks

- A partner that cannot reach GitHub keeps escalating as `code_access_unavailable` on each push. That is the
  correct, visible signal, and every retry still needs a push, so it cannot loop on its own.
- A real plan problem can never be relabelled as infra, because relabelling needs zero successful reads.

## Verification

- `node --test scripts/collab/plan-spar.test.mjs`; gateway Jest `vtid-04868-plan-sparring-service` and
  `vtid-04868-plan-sparring-stage`; `npx tsc --noEmit` in `services/gateway`. (The DB-layer script
  `scripts/ci/test-vtid-04868-plan-sparring.sh` covers nothing here and is not listed, R1-F3.)
- Staging, read-only, through CI only: after the staging gateway runs the merge commit, push once to mt-identity.
  Its `sparring/state.json` should name a new session id (the session count stays 1), with a `round-1.md` whose
  findings cite `read_file` evidence. No production calls.
<!-- plan:end -->
