# Tasks — owner-autonomy
Authoritative plan: `plan.md` (between the plan markers). VTIDs: one per lane, allocated by CI PLAN-SPAR after policy
approval; never by hand. Branches `kiro/owner-autonomy/<lane-id>`; PR titles `VTID-xxxxx (owner-autonomy/<lane-id>): …`;
`Collab-Session` + `Collab-Lane` trailers on every commit; identity `kiro-agent[bot]`; no `Co-Authored-By: Claude`.
Evidence in `docs/validation/<VTID>/` (`commands.log` with pass/fail counts, `red-on-base.txt`, `acceptance.md`,
`scope.json`, `plan-sparring.md`). Common to both lanes: nothing outside `paths`; no protected gate file; every stop
condition of plan §3 A kept; deploys nothing.

<!-- lane: platform-rules -->
## Lane `platform-rules` (vitana-platform)
- [ ] P1 `guard.test.cjs` cases 1–5 of plan §4 written first, red on `origin/main`.
- [ ] P2 `guard.cjs`: `checkOwnerAutonomy(root)` per plan §3 D, exported, called from `check()` when
      `.kiro/steering/vitana-pipeline.md` exists.
- [ ] P3 `.kiro/steering/vitana-owner-autonomy.md` per plan §3 A; `.kiro/steering/vitana-pipeline.md` per §3 B.
- [ ] P4 `docs/kiro/kiro-web-bootstrap.md` and `docs/kiro/cloud-config/vitana-kiro-web-bootstrap.md` per §3 E.
- [ ] P5 `node --test scripts/ci/kiro-steering/guard.test.cjs`, `node scripts/ci/kiro-steering/guard.cjs .`,
      `node --test scripts/collab/*.test.mjs`, preflight; record sha256 of the two steering files.

**Acceptance**
- Each table row of the rule file cites an existing rule (file + section) that says what the row says. No row
  loosens its rule, and no existing stop is missing (plan §3 A list).
- The rule file covers non-commit work (investigation, questions, reviews, ops checks, cleanup) and names
  STAGING-VERIFY as the default end point for commit work, with "deploys nothing → merged green" and Gate 2 as the
  report.
- The guard fails on each missing anchor, on a non-always inclusion, and when the pointer is missing; fixtures
  without `vitana-pipeline.md` stay green.
- `vitana-pipeline.md` names migration approval (§7d) and protected gate files (§3a) and points to the rule file.

<!-- lane: v1-rules -->
## Lane `v1-rules` (vitana-v1)
- [ ] V1 `guard.test.cjs` cases 1–5 of plan §4 written first, red on v1 `origin/main`.
- [ ] V2 `guard.cjs`: the same `checkOwnerAutonomy(root)` as the platform lane, called the same way.
- [ ] V3 `.kiro/steering/vitana-owner-autonomy.md` and `.kiro/steering/vitana-pipeline.md` byte-identical to the
      platform lane's files (sha256 recorded in both lanes' evidence).
- [ ] V4 `.claude/rules/collaboration.md` byte-identical to platform `origin/main` (plan §3 C).
- [ ] V5 `node --test scripts/ci/kiro-steering/guard.test.cjs`, `node scripts/ci/kiro-steering/guard.cjs .`,
      preflight with the v1 checkout as `--repo`.

**Acceptance**
- The three files are byte-identical to their platform counterparts. The `collaboration.md` diff against v1 base is
  exactly the platform §3 / §7 / §7b model-chain text, and no stop rule changes.
- The guard behaves as in the platform lane, and v1 fixtures stay green.
