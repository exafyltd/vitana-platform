# Plan — collab-kiro-governance

Let Kiro finish its own pipeline without Claude Code: (1) an owner-named Kiro lane may change governance paths, and
(2) a sparring round that ended without a review is retried on the next push instead of waiting for Claude Code.

<!-- plan:begin -->
## Goal (owner, 2026-10-20)
"Eliminate Claude Code, I want everything done by Kiro end-to-end" and "go with option B and the real fix". Pinned:
`exafyltd/vitana-platform@6bab918f8`.

## Today (verified in code)
1. **Governance paths are Claude-only.** `scripts/collab/queue.mjs:69` lists `GOVERNANCE_PATHS` (`.github/**`,
   `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`, `CLAUDE.md`,
   `docs/programs/areas.yaml`). `validateLane` (`:180`) rejects an `executor: kiro` lane whose `paths` reach one;
   `scopeCheck` (`:471`) rejects a governance file in a lane PR unless the lane is `executor: claude`.
   `.claude/rules/collaboration.md` §3a/§7 give such lanes to Claude Code.
2. **A partner that never submits a review stalls the plan.** The partner pass fails with `partner_output_invalid`
   when it ends its turn without `submit_review` or runs out of turns
   (`services/gateway/src/services/plan-sparring/partner.ts:212`, `:279`, `:285`). `scripts/collab/plan-spar.mjs:34`
   counts it as infra but not retryable (`:35`); the gateway dedups a create on the same plan hash unless the stored
   session's reason is in its own `RETRYABLE_REASONS` (`plan-sparring-service.ts:46`, `:246`–`:252`). So the plan
   sits `escalated` with `next_actor: claude`. Seen 2026-10-20 on `gateway-test-cachebust` (#4207) round 3, after
   rounds 1–2 had reviewed it normally. `plan-spar.test.mjs:193` pins today's behaviour.

## Change A — lane `owner-governance` (rules + `queue.mjs`)
1. New lane front-matter field `governance: owner`. Only valid with `executor: kiro`.
2. `validateLane`: an `executor: kiro` lane may reach governance paths when it declares `governance: owner`; without
   it, today's error stays.
3. `scopeCheck`: a governance file is in scope for a lane with `executor: kiro` + `governance: owner` (still only
   inside the lane's `paths`).
3a. **No self-grant (sparring R1-F1).** Today `governance` would not be a base-revision permission: `PERM`
   (`:453`) is `['executor','seat','reviewer_seat','paths']` and the fold-back (`:460`) copies only those, while
   `validate` judges the head file (`:349`). So: add `governance` to `PERM` in `scopeCheck`; the fold-back then
   takes `governance` from the base revision, so a lane PR that adds or changes it is rejected and never gains it.
   In `validate`, a lane commit (`Collab-Lane: <slug>/<lane>`, not `_plan`) that changes `governance` in a lane
   file that already exists at the base is an error; only a `_plan` commit may write it, and only when it creates
   the lane. A `_plan` commit may also add it to an existing `ready` lane, the same way PLAN-SPAR writes the VTID
   into a `ready` lane today (`:386`), so the plan author can grant it but the lane's own builder cannot.
4. `collaboration.md` §7b gains: the owner may name a lane for Kiro to build on governance paths; its plan carries
   `governance: owner` and states the owner's instruction; it is still sparred, gets a VTID, is reviewed by
   `reviewer_seat`, and merges only on the owner's explicit merge instruction in the conversation. Never in an
   unattended run. Production stays forbidden. `CLAUDE.md` and `.kiro/steering/vitana-kiro-notes.md` point at it.
5. **Bootstrap, once.** The rule guards itself, so two governance-artifact checks are red until Change A is on `main`,
   and both are known false positives for exactly this change:
   - on **this plan PR**, `Collab handoff` (`queue.mjs validate`) reports both lane files' `paths` as reaching a
     governance path (`:180`). That step is report-only today (`.github/workflows/PR-GATE.yml` `continue-on-error`,
     not in the Verdict), so it does not block the plan merge;
   - on **lane `owner-governance`'s PR**, `Lane scope` (`:471`) rejects the governance files. §7b already allows an
     `--admin` override of a governance-artifact check that is a known false positive for the change; it is used once,
     here, on Lane scope only, with every real test green.
   Lane `retry-partner-invalid` is created with `governance: owner` by a `_plan` commit after Change A merges, so its
   PR passes `validate` and Lane scope with no override. Every later governance lane passes normally.

## Change B — lane `retry-partner-invalid` (retry a review that never happened)
1. `plan-spar.mjs:35`: add `partner_output_invalid` to `RETRYABLE_REASONS`.
2. `plan-sparring-service.ts:46`: add `partner_output_invalid` to the gateway's `RETRYABLE_REASONS`. Both lists move
   together, or the gateway dedups the retry (`:252`).
3. Loop guard, one count, both sides (sparring R1-F2, R1-F3): at most 2 automatic retries for
   `partner_output_invalid` per **producer** (`ci-plan-spar.<slug>`, `plan-spar.mjs:195`, stable across plan edits),
   not per plan hash, so editing `plan.md` does not reset it.
   - Gateway: `createSparringSession` counts escalated `partner_output_invalid` sessions for the producer (one count
     query in `plan-sparring-repository.ts`). Below 2 → re-run (not dedup); at 2 → dedup, and the returned session
     carries `retry_exhausted: true`.
   - CI: `plan-spar.mjs` records `entry.retryable = false` when the create answer is deduplicated or carries
     `retry_exhausted`, so `retryInfra` (`:188`) stops and the plan waits for a person as today. A push never
     re-retries an exhausted plan.
4. Tests: `plan-spar.test.mjs:193` becomes "is retried on the next push, at most twice": a third push after two
   failed retries does nothing (`retry_exhausted`). Gateway Jest: a stored `partner_output_invalid` session is re-run
   rather than deduplicated; the third attempt for the same producer is deduplicated with `retry_exhausted`, also
   when the plan text (hash) changed in between.
5. Lane `governance: owner` (touches `scripts/collab/**`). Depends on `owner-governance`, so it passes Lane scope
   normally with no override.

## Out of scope
Changing `ROUND_CAPS`, `MAX_SESSIONS`, the evidence floor, or which reasons count as infra; any other governance
path; production deploy rules.

## Tests
`node --test scripts/collab/queue.test.mjs scripts/collab/plan-spar.test.mjs`; gateway Jest
`test/vtid-04868-plan-sparring-service.test.ts`; `tsc --noEmit`. New `queue.test.mjs` cases: a `governance: owner`
lane passes `validateLane` and `scopeCheck` on a governance file; without it, both still fail; the field on a
`claude` lane or without `executor: kiro` is an error; a lane PR adding or changing the field fails in both
`scopeCheck` (base revision, `PERM`) and `validate` (lane commit); a `_plan` commit adding it to a `ready` lane passes.
Change suites: `existing` entries running those suites (no staging surface change).

## Lanes
- `owner-governance` — executor kiro, `governance: owner`, seat `exafy` (platform), reviewer `jtadic`.
- `retry-partner-invalid` — executor kiro, seat `exafy`, reviewer `jtadic`; depends on `owner-governance`. Its
  `governance: owner` is added by a `_plan` commit once Change A is on `main` (A.5).

## Risks
- Kiro changing its own guard rails: bounded. Each such lane needs the owner's instruction in its plan, sparring, a VTID,
  a reviewer from another seat and the owner's explicit merge. The field cannot be self-granted: it is a base-revision
  permission and only a `_plan` commit may write it (A.3a).
- Retry loop: capped at 2 per producer, visible to both the gateway and CI (B.3).
<!-- plan:end -->
