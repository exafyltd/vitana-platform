# Tasks — lane paths for two owner-approved native test edits

One lane. `design.md` and `requirements.md` in this folder are authoritative. The VTID is assigned by CI after PLAN-SPAR
converges; do not start the lane before `vtid:` is set in its lane file.

<!-- lane: lane-paths -->
## Lane `lane-paths` (vitana-platform; `lane_admin`)
- [ ] L1 Claim `native-lane-paths-owner-20261108/lane-paths` with a session that is not the plan driver; branch
      `kiro/native-lane-paths-owner-20261108/lane-paths` from `origin/main`.
- [ ] L2 In `.kiro/specs/native-wave2-events-calendar-r3/lanes/events-meetups.md` add exactly one entry to `paths`:
      `apps/mobile/tests/orb/nav-directive.test.ts`. In `.kiro/specs/native-wave2-fix-forward-r2/lanes/public-entry.md` add
      exactly two: `apps/mobile/tests/resolve-link.test.ts` and `apps/mobile/tests/public/i18n-routes.test.tsx`. Nothing else
      in either target changes (`state`, `seat`, `executor`, `reviewer_seat`, `vtid`, `updated`, `claimed_by`, every log line).
      Mechanism and precedent: `laneAdminCovers` (`scripts/collab/queue.mjs`); `agentic-delivery/nav-paths` (VTID-05563).
- [ ] L3 Evidence `docs/validation/<VTID>/`: `scope.json`, `plan-sparring.md`, `acceptance.md` (AC- entries each followed by a
      TEST: line within 12 lines), `commands.log`, `outputs/`: `queue.mjs validate` and `scope-check` for this lane; a byte
      check that each target differs only by the added lines; a negative proof on a scratch branch (never pushed): the
      vitana-v1 test-file commits fail Lane scope on today's main; a positive proof: they pass with this change on main, and an
      unrelated test file is still refused.

**Acceptance**
- Change types: Tooling/docs.
- Outcome: the owner-approved test edits of vitana-v1 #1608 and #1646 pass Lane scope, so the two lane PRs can go to the
  reviewer agent.
- States: both target lanes `ready` on main with their claims held (only the `paths` block changes); a fourth test file
  changed by either lane (refused, as before).
- Surfaces: PR-GATE Collab handoff and Lane scope for this PR and for the two vitana-v1 PRs.
- Locales: n/a. Accessibility: n/a.
- Contract: the diff is exactly three added `paths` lines; no governance path, protected gate file or code in the PR;
  `lane_admin` and this lane's own `paths` are unchanged.
- Staging proof: not verified on staging: deploys nothing. Proven by Collab handoff and Lane scope and the two proofs.
