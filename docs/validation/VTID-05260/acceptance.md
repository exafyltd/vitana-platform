# VTID-05260 — collab-kiro-governance / owner-governance: owner-named Kiro governance lanes

Plan: `.kiro/specs/collab-kiro-governance/plan.md` Change A (CONVERGED, policy-approved `converged-auto-v1`); tasks
T1–T3 in `tasks.md`, incl. sparring note R3-N1. CI tooling and rule files only: no gateway code, no route, no
migration, no deploy path, no OASIS event.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: Lane field `governance: owner` (plan A.1, R3-N1). One constant `GOVERNANCE_OWNER = 'owner'`, strict comparison in `validateLane` and in `scopeCheck` (`isOwnerGovernanceLane`). Any other value (`owners`, `bob`, `Owner`, empty string, an empty `governance:` line), the field on an `executor: claude` lane, or on a lane without `executor: kiro`, is an error.
  TEST: scripts/collab/queue.test.mjs — "VTID-05260 validateLane: governance: owner lets a kiro lane declare governance paths; strict value, kiro only (R3-N1)"
AC-2: `validateLane` (plan A.2). An `executor: kiro` lane with `governance: owner` may declare governance paths. Without the field, or with any other value, today's error stays.
  TEST: scripts/collab/queue.test.mjs — same test as AC-1
AC-3: `scopeCheck` (plan A.3). A governance file inside the lane's `paths` is in scope for `executor: kiro` + `governance: owner`. A governance file outside the `paths` is still refused, and so is a lane without the field, with `governance: owners`, or with another executor.
  TEST: scripts/collab/queue.test.mjs — "VTID-05260 scope-check: a governance: owner lane may change governance files inside its paths; without it, still refused"
AC-4: No self-grant, first guard (plan A.3a). `governance` joins `PERM`, so `scopeCheck` takes it from the base revision. A lane PR that adds the field (none → owner) or changes it (owners → owner, owner → owners) is refused and is judged by the base value.
  TEST: scripts/collab/queue.test.mjs — "VTID-05260 no self-grant: a lane PR adding or changing governance fails scope-check (PERM) and validate"
AC-5: No self-grant, second guard (plan A.3a, sparring R2-N2). `validateRange` reports an error when `governance` differs between the merge base and head, unless every commit in range that touches the lane file is a `_plan` commit and the lane is `ready` at head. A lane PR that creates its own lane file with the field is refused the same way.
  TEST: scripts/collab/queue.test.mjs — same test as AC-4
AC-6: The plan author can grant the field (plan A.3a/A.5). A `_plan` commit may add `governance` to a `ready` lane, changing only `governance` and `updated`. It may not do so on an `executing` lane, or together with any other field such as widened `paths`. The lane's later PR then passes Lane scope and `validate` on a governance file.
  TEST: scripts/collab/queue.test.mjs — "VTID-05260: a _plan commit may add governance to a ready lane; not to a working lane, and not together with other fields"
AC-7: Each new rule is load-bearing. 9 mutations of `queue.mjs` were run (loose comparison, no executor check, `governance` out of `PERM`, no `validateRange` check, no `ready` condition, no `_plan` exemption, a `_plan` grant that may change other fields, no Lane-scope unlock). Each one makes `queue.test.mjs` fail.
  TEST: outputs/mutation.txt (each mutation KILLED); the harness ran on copies outside the repo
AC-8: Existing behaviour is unchanged. All 40 earlier `queue.test.mjs` and `plan-spar.test.mjs` tests pass, 44/44 with the 4 new ones.
  TEST: node --test scripts/collab/queue.test.mjs scripts/collab/plan-spar.test.mjs (outputs/collab-tests.txt)
AC-9: Rules (T2). `.claude/rules/collaboration.md` §7b gains the owner-named governance lane rule: the plan states the owner's instruction; the lane is sparred, gets a VTID from CI and is reviewed by `reviewer_seat`; only a `_plan` commit grants the field; it merges only on the owner's explicit instruction, never in an unattended run, never to production. §2, §3a and §7 point at it. `CLAUDE.md` and `.kiro/steering/vitana-kiro-notes.md` point at it. Each pair is identical in vitana-platform and vitana-v1: collaboration.md byte-for-byte, the Kiro notes byte-for-byte, and CLAUDE.md's collaboration section.
  TEST: cmp / diff in outputs/pair-identity.txt; node scripts/ci/kiro-steering/guard.cjs (both repos OK)

## Known red check on this PR (bootstrap, plan A.5)
**Lane scope** is red on this PR only. The lane file on `main` has no `governance: owner`: the field becomes valid only
with this change, and the lane cannot grant it to itself (AC-4). So scope-check refuses all 5 governance files the lane
changes (outputs/scope-check.txt): `scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`,
`.claude/rules/collaboration.md`, `CLAUDE.md` and `.kiro/steering/vitana-kiro-notes.md`. Each one is inside the lane's
`paths`. Plan A.5 names this as the one-time known false positive that §7b allows to be overridden. Every real test is
green. The report-only **Collab handoff** step (outputs/collab-validate.txt) shows the same bootstrap finding as
7 lines. They cover the governance `paths` of both lane files: 5 for `owner-governance` and 2 for
`retry-partner-invalid`, whose `governance: owner` the plan author adds by a `_plan` commit after this merges.
