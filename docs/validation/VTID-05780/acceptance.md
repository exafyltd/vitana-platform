# VTID-05780 — autonomous-to-staging-r2, lane `protect-gate-workflow`

Plan: `.kiro/specs/autonomous-to-staging-r2/plan.md` §3.1, §5, merged as `a97a79d9a9` (#5024); sparring verdict
`.kiro/specs/autonomous-to-staging-r2/sparring/verdict.md` (converged, policy `converged-auto-v1`). Base `origin/main`
`1d6126bff4`. Builder session `kiro-exafy-202611110920-270b`.
Owner directive 2026-11-12: *"The plan is not complete until this missing protection is implemented and verified."*
This lane changes protected gate files and merges under the two-model rule on `main` (`land-guard.mjs merge`); no
bootstrap authority is used for this merge.

## What changed
- **T1, protected list (all four copies):** `.github/workflows/GATE-INVARIANTS.yml`,
  `scripts/ci/workflow-trigger-check.test.mjs`, `scripts/collab/gate-audit.mjs` added to
  `scripts/collab/protected-gate-files.json` `globs`, `PROTECTED_GATE_BUILTIN` (`scripts/collab/queue.mjs`),
  `PROTECTED_GATE_GLOBS` (`governance.ts`) and `REQUIRED_PROTECTED` (`scripts/collab/gate-invariants.test.mjs`).
  `checkInvariants` now also checks the checkout's own `REQUIRED_PROTECTED` text, so the fourth list cannot shrink
  either.
- **T2, exact-head rule:**
  - `land-guard.mjs`: new `protectedReviewCurrent(reviewed, head, after, laneKey, { prDiffSame, protectedSame })`
    (every commit after the reviewed head changes only the lane's own lane file; any merge commit, a PM handoff edit or
    any other path voids the accept; the protected paths' bytes at the reviewed head must equal those at the merged
    head), `builderSessions(laneText, messages, laneKey)`, `parseReviewEntry` returns `session`,
    `protectedAcceptModels(entries, { builders })` returns two models only for a pair with two distinct models and two
    distinct sessions, neither a builder. `localAfter` returns `protectedSame`. `merge` refuses a protected-file PR
    without `--repo` and judges each accept with `protectedReviewCurrent`; single-review behaviour (`reviewCurrent`) is
    unchanged.
  - `queue.mjs`: `logSection` and `logEntries` exported (read-only, used by `builderSessions`).
  - `governance.ts`: `protectedAcceptModels(reviews, pr, builders)` counts a protected-file accept only on the exact
    head (`r.head_sha === pr.head_sha`, no `review_only_since`), with distinct `ReviewEntry.session_id`s, excluding the
    lane's `executing_log` sessions; `governanceMergeAllowed` passes the builders.
- **T3, shared fixtures:** `scripts/collab/fixtures/protected-review-cases.json` (seven cases), run by
  `scripts/collab/land-guard.test.mjs` and `services/gateway/test/project-manager/governance-protected-review.test.ts`.
- **T4, post-merge audit:** `scripts/collab/gate-audit.mjs` walks first-parent commits of `origin/main` in the window
  that change a protected file, finds the merged PR (`repos/<gh>/commits/<sha>/pulls`), fetches `refs/pull/<n>/head`,
  requires the merge tree to equal the PR head's tree and applies the land-guard functions (imported) to the PR's
  review entries; `BOOTSTRAP` lists the merges allowed without that. `GATE-INVARIANTS.yml`: checkout
  `fetch-depth: 0`, audit step (`if: always()`), job `invariants` `contents: read` + `pull-requests: read`, new job
  `report` (`needs: [invariants]`, `if: failure()`, `contents: read`) — the only job naming a secret
  (`GATEWAY_SERVICE_TOKEN`) — posts OASIS `collab.gate.bypass_detected` to `/api/v1/events/ingest`.
  `workflow-trigger-check.test.mjs` rewritten to parse the jobs and assert each of these with a mutation per assertion.

## Acceptance criteria → tests

AC-1 Each of the seven shared fixture cases gives the same verdict in both layers (valid two-model accept on the exact head allowed; stale accept, accept then code commit, accept then merge of main, same model twice, same session twice, builder self-review refused).
TEST: scripts/collab/land-guard.test.mjs ("VTID-05780 shared fixtures: each protected-review case gives its expected verdict in land-guard")
TEST: services/gateway/test/project-manager/governance-protected-review.test.ts ("VTID-05780 shared protected-review fixtures (same verdict as land-guard.test.mjs)")

AC-2 A protected-file accept counts only when every later commit changes only the lane file and the protected bytes are equal; a clean merge of main voids it (the single-review rule still keeps it).
TEST: scripts/collab/land-guard.test.mjs ("VTID-05780 protectedReviewCurrent: …", "VTID-05780 local walk (k): a clean merge of main after two accepts voids them for a protected file")

AC-3 Two models need two distinct sessions; a builder session or a missing session never counts; parseReviewEntry returns the session.
TEST: scripts/collab/land-guard.test.mjs ("VTID-05780 protectedAcceptModels: …", "VTID-05780 builderSessions: …", "merge: a protected gate file needs two accepts …")
TEST: services/gateway/test/project-manager/governance-protected-review.test.ts ("VTID-05780 protectedAcceptModels: exact head, distinct sessions, builders excluded")

AC-4 `land-guard.mjs merge` refuses a protected-file PR without `--repo`.
TEST: scripts/collab/land-guard.test.mjs ("VTID-05780 CLI: merge refuses a protected-file PR without --repo (local walk required)")

AC-5 Dropping `GATE-INVARIANTS.yml` from any of the four lists fails the invariant check; weakening the exact-head rule (merge of main, one session, builder) fails it.
TEST: scripts/collab/gate-invariants.test.mjs ("mutation: dropping GATE-INVARIANTS.yml from any of the four protected lists fails", "mutation: the exact-head rule weakened (merge of main, one session, builder) fails")

AC-6 `gate-audit.mjs` reports a protected merge with one accept, a stale accept, two same-model accepts, one session, a builder accept or no PR, and passes a valid two-model merge and a bootstrap-listed SHA; it passes on `origin/main` with the bootstrap list.
TEST: scripts/collab/gate-audit.test.mjs ("gate-audit: a valid two-model, two-session merge passes; …", "gate-audit: the merge tree must equal the PR head; …", "gate-audit: the bootstrap list holds full SHAs …")
TEST: node scripts/collab/gate-audit.mjs --repo . --gh exafyltd/vitana-platform --since '14 days ago' (outputs/gate-audit-origin-main.txt: 0 violations, 11 bootstrap)

AC-7 GATE-INVARIANTS.yml: audit step, `fetch-depth: 0`, exact permissions per job, `report` only `if: failure()` with `needs: [invariants]`, the secret only in `report`; each assertion has a failing mutation.
TEST: scripts/ci/workflow-trigger-check.test.mjs ("GATE-INVARIANTS.yml runs the invariants and the audit …", "mutations: each weakened trigger, step, permission or secret placement is caught")

AC-8 The first GATE-INVARIANTS run on `main` after merge is green and its URL is in `commands.log`; the merge is through `land-guard.mjs merge` under the two-model rule, no bootstrap authority.
TEST: GATE-INVARIANTS workflow run on the merge commit (URL appended to commands.log by the closing record)

Red on base (new tests against `origin/main` code): `outputs/red-on-base.txt` (land-guard 7, gate-invariants 3, queue 1,
gate-audit 1 (module missing), workflow-trigger-check 1 fail), `outputs/red-on-base-governance.txt` (5 fail). Green: see
`commands.log`.

No migration, no production write. `governance.ts` is on the gateway deploy path, so `staging-tests.json` names the
existing `npx jest test/project-manager` suite (rule 47; merge-decision logic, no new route), as VTID-05765 did. The `report` job writes one OASIS event
only when GATE-INVARIANTS fails on `main`.

OASIS_PROOF: new event type `collab.gate.bypass_detected` (source `gate-invariants`, status `error`, surface `cicd`,
vtid VTID-05780, payload `{ run_url, sha, trigger }`), posted by GATE-INVARIANTS.yml job `report` through the existing
`POST /api/v1/events/ingest` (`services/gateway/src/routes/events.ts`, IngestEventSchema) only when job `invariants`
fails on `main`; no event is written by this PR, its tests or a green run. Asserted statically by
`scripts/ci/workflow-trigger-check.test.mjs` (event type and endpoint in job `report`, `if: failure()`,
`needs: [invariants]`, secret only there).

## Tests changed on purpose (contract change, plan §3.1)
- `land-guard.test.mjs` "merge: a protected gate file needs two accepts …": fixture accepts carry distinct sessions;
  `parseReviewEntry` now also returns `session`.
- `governance.test.ts` "two models on the current head are allowed": the second accept has its own `session_id`; the
  same assertion with one session is now refused.
- `queue.test.mjs` SECTION_43 / T16: the three new protected globs; `scripts/ci/workflow-trigger-check.test.mjs` is gate
  code outside the governance paths.
- `workflow-trigger-check.test.mjs`: the global "no secret" rule becomes "no secret outside job `report`" (plan §3.1);
  every earlier mutation is kept.

## Decisions taken
- Bootstrap list lives in `scripts/collab/gate-audit.mjs` (`BOOTSTRAP`, protected) instead of the plan's separate
  `scripts/collab/fixtures/gate-audit-bootstrap.json` (not protected): widening it then needs the two-model rule.
- `BOOTSTRAP` is exactly the 11 protected merges the audit reported on `origin/main` `1d6126bff4` for the 14-day window
  (`outputs/gate-audit-before.txt`), each with its reason; they leave the window within 14 days.
  **Flagged for the owner:** #5013 (`53c087911b`) and #5021 (`a199f9ac9a`) merged on 2026-11-12, after the two-model rule
  (#5002), by the owner account `exafyltd` without two recorded accepts; they are bootstrapped as owner-authority merges.
- `report` posts to `vars.GATE_AUDIT_GATEWAY_URL`, default the staging gateway `https://preview-aws-gateway.vitanaland.com`
  (the same oasis_events store; no production gateway call from CI by default), with `vtid: VTID-05780`,
  `surface: cicd`. It fails loudly when the token is unset. It reports any `invariants` failure (a weakened invariant is
  a bypass too), with the run URL; the audit's details are in the step summary.
- Builders: land-guard uses the lane-log build entries plus every `Collab-Lane: <lane>` commit that is not a review
  entry; the PM uses the lane's `executing_log` (every non-review, non-PM log session), a superset.
- An accept without a `Collab-Session` never counts for a protected file (distinct sessions cannot be shown).
- The audit skips the repository's root commit (it merges nothing) and audits with the current protected list.
- `staging-tests.json` added (fix-forward 1): CI `change-suite` requires it because `governance.ts` is a gateway deploy
  path (CLAUDE.md rule 47); the lane brief said none, the stricter rule wins (IF–THEN 9).
- The audit step runs `if: always()` so the audit is reported even when an earlier invariant step failed.
