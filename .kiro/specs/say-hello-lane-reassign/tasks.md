# Tasks — say-hello-lane-reassign

Plan: `.kiro/specs/say-hello-lane-reassign/plan.md` (plan block authoritative).

<!-- lane: reassign -->
## Lane `reassign`
- [ ] A1 Claim the lane (`queue.mjs claim say-hello-lane-reassign/reassign --session <id>`), branch
      `kiro/say-hello-lane-reassign/reassign` from `origin/main`; confirm with `gh pr list` that no open PR touches the
      three target lane files.
- [ ] A2 Edit `.kiro/specs/new-member-welcome/lanes/say-hello-composer.md`: `seat: jtadic`, `executor: kiro`,
      `reviewer_seat: agent:vitana-lane-reviewer`, `paths:` the list of plan §3 (platform and vitana-v1 globs). Change
      nothing else (no `state`, `depends_on`, `vtid`, `claimed_by`, log line).
- [ ] A3 Edit `new-member-card-optin.md` and `grouped-welcome-notifications.md`: `seat: jtadic` only.
- [ ] A4 Every commit carries `Collab-Session: kiro-jtadic-…` and `Collab-Lane: say-hello-lane-reassign/reassign`.
      Add `docs/validation/<VTID>/`: `scope.json` (kind, paths, sparring_record), `plan-sparring.md` (copy of the
      converged record: CONVERGED, Owner approval, plan hash), `acceptance.md` (AC- entries each followed by
      TEST:/CURL:/UI: within 12 lines), `commands.log`, `outputs/`, `staging-tests.json` (refs only of the forms `npm run <script>`,
      `npx jest <paths>`, `npx vitest run <paths>`; nothing deploys, so the list is empty and `acceptance.md` says why).
- [ ] A5 Run, save under `outputs/`: `node --test scripts/collab/queue.test.mjs`; `queue.mjs validate` and
      `scope-check` for this lane against `origin/main`; the two negative proofs of plan §6 on a scratch branch (never
      pushed); `preflight.mjs`. PR body declarations: VALIDATION_PROFILE, SCOPE_ALLOWLIST, ACCEPTANCE,
      MERGE_PAYLOAD_PREVIEW, OASIS_IMPACT.
- [ ] A6 Reviewer agent `vitana-lane-reviewer` reviews the PR head independently (never the builder); merge under §7b
      after every check is green and the PR is up to date. Then run plan §4 (closing PRs: claim lane, set claimed_by to own session in first commit; merged by the plan driver under §7b) and hand to the feature PRs.

**Acceptance:**
- Change types: Tooling/docs.
- Outcome — `say-hello-composer` is `seat: jtadic`, `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer`
  with `paths` that list exactly the files the two feature branches change (no more, none missing); the two finished
  dependency lanes are `seat: jtadic` and otherwise unchanged. The lane PR passes Collab handoff and Lane scope through
  the `lane_admin` path, and the same edit from a non-`lane_admin` lane is refused.
- States — n/a (lane-file front matter only; no UI).
- Surfaces — `queue.mjs scope-check` / `validate` (PR-GATE Collab handoff + Lane scope) for the later feature PRs in
  both repos; the PM merge decision (`decide.ts`).
- Locales — n/a (developer-facing, English by design).
- Accessibility — n/a (no UI).
- Contract — the diff of the three lane files is exactly these front-matter lines: 5 on `say-hello-composer.md`
  (seat, executor, reviewer_seat, paths block) and 1 each on the other two; `depends_on`, `state`, `vtid`,
  `claimed_by` and every log line are byte-identical; no governance path, protected gate file, code or migration in the
  PR; `lane_admin` is not edited and the admin lane file is not listed in its own `paths`.
- Staging proof — not verified on staging: lane files only, nothing deploys. Proven by `queue.test.mjs` green,
  `validate`/`scope-check` green on the PR, the negative proofs refused, and `scope-check` of both feature branches
  against the new `main` showing 0 errors.
- Reviewer — the trusted-source read (the admin lane file is on `main`, not only in the PR head); the diff is PERM
  lines only; `paths` equal the real `git diff --name-only` of both feature branches and reach no governance path;
  the builder session is not the reviewer; the dependency lanes are only re-seated, not closed, in this PR; plan §4
  does not close a lane without an independent review entry and a real merge sha.
