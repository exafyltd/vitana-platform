---
change_class: standard
---
# Plan — native-lane-paths-owner-20261108
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-platform` (spec files only: two lane files under `.kiro/specs/`
and `docs/validation/**`; no code, no workflow, no script, no migration, no vitana-v1 change). Spec: `requirements.md`,
`design.md`, `tasks.md`, `lanes/lane-paths.md` in this folder. Program: `docs/programs/native-app/program.md`.

<!-- plan:begin -->
## Goal
Let two open native lane PRs pass Lane scope [required] with the test edits the owner decided on 2026-11-08, without
loosening Lane scope. Owner decision (final, 2026-11-08):
- Decision 2, vitana-v1 #1608, lane `native-wave2-events-calendar-r3/events-meetups` (VTID-05531): "You may change only the /admin/activity expectation in apps/mobile/tests/orb/nav-directive.test.ts. Record that route as a parity exception in the ledger. Make no other test edits in this lane."
- Decision 4, vitana-v1 #1646, lane `native-wave2-fix-forward-r2/public-entry` (VTID-05650): "You may update the 2 landing-page tests, limited to their landing-page assertions. The PR description must list each old and new assertion."

## Today (vitana-platform origin/main `6dc6e1ba0c`, vitana-v1 PR heads `f24487667` and `c071cc764`)
- `events-meetups` `paths` hold `apps/mobile/tests/events/**` but not `apps/mobile/tests/orb/nav-directive.test.ts`
  (`.kiro/specs/native-wave2-events-calendar-r3/lanes/events-meetups.md:10-28`). `public-entry` `paths` hold
  `apps/mobile/tests/index.test.tsx` and `apps/mobile/tests/public-entry/**` but not `apps/mobile/tests/resolve-link.test.ts`
  or `apps/mobile/tests/public/i18n-routes.test.tsx` (`.kiro/specs/native-wave2-fix-forward-r2/lanes/public-entry.md:12-18`).
- Preflight on both PR heads: Lane scope [required] fails and names only those files; PR-GATE scope names the same.
- `scripts/collab/queue.mjs` scopeCheck takes a lane's `paths` from the trusted revision (`trustedFm`, `:983`, `:1014-1021`),
  so a lane PR cannot widen its own paths. The reviewed exception is `laneAdminCovers` + `targetOfAdmin`
  (`:1014-1017`): a trusted `lane_admin` lane (executor kiro, reviewer_seat the reviewer agent) whose `paths` cover a target
  lane file may change that target's permission fields. Precedent: `agentic-delivery/nav-paths` (VTID-05563, #4722) and
  `say-hello-lane-reassign/reassign` (VTID-05410).

## Decisions
1. **One `lane_admin` lane, `lane-paths`**, `paths` = exactly the two target lane files. It adds `apps/mobile/tests/orb/nav-directive.test.ts`
   to `events-meetups` and `apps/mobile/tests/resolve-link.test.ts` + `apps/mobile/tests/public/i18n-routes.test.tsx` to
   `public-entry`, three added lines in total, exact file names (no glob, so no other test becomes writable).
2. **No other mechanism.** Lane scope is not loosened, `--admin` is not used, the lane PRs are not rewritten to hide the
   files, and no `Collab-Review` carve-out is used. The two vitana-v1 PRs stay red on Lane scope only until this lane
   merges and they are brought up to date with `main`.
3. **What each lane may change in the added files stays limited by the owner quote** (the lane PR body lists it); the
   admin lane gives path permission only. The reviewer of each lane PR checks the diff of those files against the quote.
5. **Mechanism is the one the session instruction names; the §7a wording is not changed here.** The task given to this session
   (2026-11-08) names a `lane_admin` lane that adds exactly these three paths as the legal mechanism. This plan does not claim
   an owner acknowledgement of the §7a wording ("narrow its `paths`"): the use is accepted by the code (`queue.mjs:1014-1021`,
   no narrowing-only constraint), `kiro-lane-admin` requirements R1 ("add/narrow"), and the precedents VTID-05563 and
   VTID-05410, as in the reviewer entry of `agentic-delivery/lanes/nav-paths.md`. A one-word change of `collaboration.md`
   §7a to "add/narrow" is a separate governance change (a governance path: executor kiro, reviewer agent accept), outside this
   plan's single lane; it stays recorded as the follow-up named in `handoff.md` and is not a condition of this plan.
6. **The plan PR is not merged by the author.** The lane is built after the plan is merged under §7b; the builder is a
   session that is not the plan driver and the reviewer is `vitana-lane-reviewer`.

## Lanes
| lane | executor | repo | paths (= the target files) |
|---|---|---|---|
| `lane-paths` (`lane_admin`) | kiro, seat exafyltd | exafyltd/vitana-platform | `.kiro/specs/native-wave2-events-calendar-r3/lanes/events-meetups.md`, `.kiro/specs/native-wave2-fix-forward-r2/lanes/public-entry.md` |

## Tests and proof
- Byte check: the two target files differ from `origin/main` by exactly the three added `paths` lines.
- Negative proof (on today's main, scratch branch, never pushed): the vitana-v1 commits that change the three test files fail
  Lane scope for their lane. Positive proof: with this change on main they pass; a fourth unrelated test file is still refused.
- `node scripts/collab/queue.mjs validate`, `scope-check` for this lane, preflight, and the PR-GATE checks of the lane PR.
- **Staging proof:** not verified on staging: deploys nothing; proven by Collab handoff and Lane scope plus the two proofs.

## Risks
- `collaboration.md` §7a (line 250, "Lane administration") says an admin lane may "narrow" a target's paths; this lane adds three. `kiro-lane-admin`
  requirements R1 says "add/narrow", `queue.mjs` accepts any covered permission change, and VTID-05563 and VTID-05410 added
  paths the same way; the reviewer of VTID-05563 recorded this and asked for a §7a alignment follow-up (not done here).
- Both target lanes are `ready` with a claim held by the author session; the admin lane's builder takes the targets as
  they are on main, so a lane-state change there before the merge means a plain `git merge origin/main`.
- The `nav-directive.test.ts` edit also needs the ledger row for `/admin/activity` (already inside `events-meetups` paths).

## Unchanged
`scripts/collab/**`, `.github/**`, `.claude/**`, `.kiro/steering/**`, every vitana-v1 file, the other lanes of both target
plans, `paths` of every lane other than the two targets.
<!-- plan:end -->
