# Directive to Kiro (seat hotmail): M0 multi-tenant work, parallel agents

Owner decisions taken 2026-11-10 (answers to the three questions below). This directive is the owner instruction for
every plan it names. Coordinator: the hotmail seat. Program: `docs/MULTI-TENANT-PLAN.md` §7 (M0). Rules: collaboration
§3a, §5, §7b, §8a.

## Owner decisions
1. **Seat move (approved).** Lanes `maxina-golden-suite` (VTID-05448), `gateway-scope-lint-contract` (VTID-05444) and
   `tenant-db-and-slug-cleanup` (VTID-05468) move from seat jtadic to seat hotmail through a plan amendment. Each keeps
   its own VTID and `paths:`. The amendment is a plan change: Kiro writes it as a `plan(` PR, sparred by PLAN-SPAR, and
   it merges under §7b. Parallel build agents start only after that plan is approved.
2. **Track S residual (approved, keep).** `approvals-auth` (VTID-05452) and `work-surface-permission` (VTID-05453) move
   from seat exafy to seat hotmail, with the same amendment. They ship before Track S Gate 2. Gate 2 waits for them.
3. **Superseded-lane rule (approved).** Kiro changes `scripts/collab/queue.mjs` (around line 390) so a plan may reach
   done when each parked lane records `superseded by` a lane that is done. This is a protected gate file. This directive
   is the owner instruction naming the plan `mt-queue-superseded-close` for that change. The change still needs a
   reviewer-agent accept on the current head before it merges. Affected plans: mt-track-s-r2, mt-guardrails-r2,
   mt-track-s-authz.

## Coordinator role
Keep one table of streams, lanes, agents, state and blocker. Each agent gets one lane, one VTID and a `paths:` list.
An agent never edits outside its `paths:`.

## Streams that run now
- **S1 Owner packets (docs only).** Packets for queue rows 12–13 (VTID-05465), rows 17–18 (VTID-05464) and 043000
  (VTID-05569). Each packet: file, target DB, bare policies or hook behaviour changed, PGlite dry-run, pre-check,
  post-check, rollback id, apply window. Output: `docs/validation/<VTID>/owner-packet.md`. Nothing is applied.
  No `RUN-MIGRATION.yml` dispatch.
- **S2 Merged-change audit.** For VTIDs 05576, 05575, 05579, 05569, 05506, 05573, 05504, 05491, 05493: re-run the lane's
  suites on current main, check the flag gate (`MT_RESOLUTION_V2`, `tenant_settings.feature_flags.mt.*`), and check the
  code runs before its migration is applied. One line per VTID in the lane log. Re-run the suites for the #4869 head too,
  because its reviewer had no shell.
- **S3 STAGING-VERIFY collector (read-only).** Collect the result for each recent merge commit. Record "no result yet"
  where there is none. No Gate 2 yet.
- **S4 Status table.** Maintain the M0 table in the report below.

## Streams that run after the seat move (plan approved)
- **S5 Maxina golden suite** (VTID-05448). Paths: `services/gateway/test/mt-maxina-golden.test.ts`,
  `services/gateway/test/golden/**`, `scripts/mt/golden/**`.
- **S6 Gateway-scope lint contract** (VTID-05444).
- **S7 TenantContext and tenantDb** (VTID-05468, plus the WS1 `resolvePrimaryTenant` and `tenantDb` pieces).
- **S8 Track S residual** (VTID-05452, VTID-05453).
- `ci-wiring` (VTID-05443) starts after S5 and S6 are merged.

## Rules for every agent (collaboration §8a)
- One lane, one VTID, one agent, one branch. Claim the lane before touching it.
- Declare `depends_on` and `paths` in the lane file. No two agents edit the same file. Sequence hot files
  (`src/App.tsx`, `screens.json`, `DATABASE_SCHEMA.md`, migrations, `CLAUDE.md`).
- Migrations are numbered by timestamp in `docs/multitenancy/MIGRATION-QUEUE.md`, added in the PR that adds the file.
  Never applied by an agent.
- Before merge: rebase on latest main, re-run required checks on that head, one merge per repo at a time, re-review
  open lanes after every merge to main. Dark by default behind a flag. Record STAGING-VERIFY per merge commit.
- Build fan-out capped at 6 per plan; PLAN-SPAR at most 2 in flight repo-wide. New lanes go through sparring first.
- A task of one lane and three files or fewer runs as one agent.

## Report (one message to the owner, then every 4 hours while streams run)
- Stream table: stream, lane/VTID, agent, state, blocker, next step.
- M0 table: done, blocked (by whom), not started.
- For each finished item: what ran, what passed, what did not run. No "verified" without command output in the log.

## Do not
- Apply a migration or dispatch a workflow that applies one. Send any request to production.
- Edit a protected gate file except the one change in decision 3, and only through its plan with a reviewer accept.
- Edit another seat's lane file (after decision 1 and 2 the moved lanes are hotmail's).
- Use `--admin` or override a red check. Close a plan by changing lane states to get past a gate.
