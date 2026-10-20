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
   inside the lane's `paths`). The base-revision rule (`:446`–`:457`) applies unchanged, so a lane PR cannot add
   `governance: owner` to itself: it must already be on `main`, written by the plan that created the lane.
4. `collaboration.md` §7b gains: the owner may name a lane for Kiro to build on governance paths; its plan carries
   `governance: owner` and states the owner's instruction; it is still sparred, gets a VTID, is reviewed by
   `reviewer_seat`, and merges only on the owner's explicit merge instruction in the conversation. Never in an
   unattended run. Production stays forbidden. `CLAUDE.md` and `.kiro/steering/vitana-kiro-notes.md` point at it.
5. **Bootstrap, once.** This lane's own PR changes the rule that guards it, so Lane scope cannot pass on it. §7b
   already allows an `--admin` override of a governance-artifact check that is a known false positive for the change.
   That applies here, once, to Lane scope only. Every real test must be green. Every later governance lane passes
   normally.

## Change B — lane `retry-partner-invalid` (retry a review that never happened)
1. `plan-spar.mjs:35`: add `partner_output_invalid` to `RETRYABLE_REASONS`.
2. `plan-sparring-service.ts:46`: add `partner_output_invalid` to the gateway's `RETRYABLE_REASONS`. Both lists move
   together, or the gateway dedups the retry (`:252`).
3. Loop guard: at most 2 automatic retries per plan hash for `partner_output_invalid`. The gateway counts escalated
   sessions with that reason for the hash (`fetchSessionByPlanHash` / one count query); after 2 the session is
   not retryable and the plan waits as today. The CI side needs no count, because it follows the gateway's answer.
4. Tests: `plan-spar.test.mjs:193` becomes "is retried on the next push"; gateway Jest: a stored
   `partner_output_invalid` session is re-run rather than deduplicated, and the third attempt for the same hash is
   deduplicated.
5. Lane `governance: owner` (touches `scripts/collab/**`). Depends on `owner-governance`, so it passes Lane scope
   normally with no override.

## Out of scope
Changing `ROUND_CAPS`, `MAX_SESSIONS`, the evidence floor, or which reasons count as infra; any other governance
path; production deploy rules.

## Tests
`node --test scripts/collab/queue.test.mjs scripts/collab/plan-spar.test.mjs`; gateway Jest
`test/vtid-04868-plan-sparring-service.test.ts`; `tsc --noEmit`. New `queue.test.mjs` cases: a `governance: owner`
lane passes `validateLane` and `scopeCheck` on a governance file; without it, both still fail; the field on a
`claude` lane or without `executor: kiro` is an error; a lane PR adding the field to itself fails (base revision).
Change suites: `existing` entries running those suites (no staging surface change).

## Lanes
- `owner-governance` — executor kiro, `governance: owner`, seat `exafy` (platform), reviewer `jtadic`.
- `retry-partner-invalid` — executor kiro, `governance: owner`, seat `exafy`, reviewer `jtadic`; depends on
  `owner-governance`.

## Risks
- Kiro changing its own guard rails: bounded. Each such lane needs the owner's instruction in its plan, sparring, a VTID,
  a reviewer from another seat and the owner's explicit merge. The field cannot be self-granted (base-revision rule).
- Retry loop: capped at 2 per plan hash.
<!-- plan:end -->
