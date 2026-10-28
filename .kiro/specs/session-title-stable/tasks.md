# Tasks — session-title-stable
Authoritative plan: `plan.md` (between the plan markers). Lane files: `lanes/platform-title.md`, `lanes/v1-title.md`.
VTIDs: allocated by CI PLAN-SPAR after policy approval; never by hand. Branch `kiro/session-title-stable/<lane>`, PR
title `VTID-xxxxx (session-title-stable/<lane>): …`, trailers `Collab-Session` + `Collab-Lane` on every commit,
identity `kiro-agent[bot]`, no `Co-Authored-By: Claude` trailer, evidence in `docs/validation/<VTID>/`
(`commands.log` with every command and pass/fail counts, `red-on-base.txt`). Acceptance below is what the reviewer
agent `vitana-lane-reviewer` checks the PR diff against.

<!-- lane: platform-title -->
## Lane `platform-title` — vitana-platform
- [ ] T1 Append the plan §4 test to `scripts/ci/kiro-steering/guard.test.cjs`; red on `origin/main` recorded in
      `docs/validation/<VTID>/red-on-base.txt`.
- [ ] T2 Add `.kiro/steering/vitana-session-title.md` (plan §3 rules 1–5, `inclusion: always`, no `#[[file:]]`).
- [ ] T3 Local checks: `node --test scripts/ci/kiro-steering/guard.test.cjs`, `node scripts/ci/kiro-steering/guard.cjs .`,
      `node scripts/collab/kiro-web-steering.mjs` then `--check` on the session workspace, preflight on the head; all
      in `commands.log`.

**Acceptance**
- Only the lane's `paths` change; no other steering file, `CLAUDE.md`, `.claude/**` or protected gate file changes.
- The new test fails on `origin/main` and passes on the head; no existing test is changed or weakened.
- The steering file states plan §3 rules 1–5 and is byte-identical to the `v1-title` file.
- Deploys nothing.

<!-- lane: v1-title -->
## Lane `v1-title` — vitana-v1
- [ ] T1 Append the same test to vitana-v1 `scripts/ci/kiro-steering/guard.test.cjs`; red on vitana-v1 `origin/main`
      recorded in `docs/validation/<VTID>/red-on-base.txt`.
- [ ] T2 Add `.kiro/steering/vitana-session-title.md`, byte-identical to the `platform-title` file.
- [ ] T3 Local checks: `node --test scripts/ci/kiro-steering/guard.test.cjs`, `node scripts/ci/kiro-steering/guard.cjs .`,
      preflight on the head; all in `commands.log`.

**Acceptance**
- Only the lane's `paths` change (vitana-v1 repo).
- The new test fails on vitana-v1 `origin/main` and passes on the head; no existing test is changed or weakened.
- The steering file is byte-identical to the vitana-platform copy.
- Deploys nothing.
