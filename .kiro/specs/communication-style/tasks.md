# Tasks — communication-style
Authoritative plan: `plan.md` (between the plan markers). Lane files: `lanes/platform-style.md`, `lanes/v1-style.md`.
VTIDs: allocated by CI PLAN-SPAR after policy approval; never by hand. Branch `kiro/communication-style/<lane>`, PR
title `VTID-xxxxx (communication-style/<lane>): …`, trailers `Collab-Session` + `Collab-Lane` on every commit,
identity `kiro-agent[bot]`, no `Co-Authored-By: Claude` trailer, evidence in `docs/validation/<VTID>/`.

<!-- lane: platform-style -->
## Lane `platform-style` — vitana-platform
- [ ] T1 Append the plan §4 test to `scripts/ci/kiro-steering/guard.test.cjs`; red on `origin/main` recorded in
      `docs/validation/<VTID>/red-on-base.txt`.
- [ ] T2 Add `.kiro/steering/vitana-communication-style.md` (plan §3, `inclusion: always`, no `#[[file:]]`).
- [ ] T3 Local checks: guard tests, `guard.cjs .`, `kiro-web-steering.mjs` then `--check`, preflight; all in
      `commands.log`.

**Acceptance**
- Change types: Tooling/docs
- Outcome: every Kiro session on vitana-platform loads the owner's communication-style rule as always-included steering.
- States: n/a: static steering text.
- Surfaces: Kiro Web (generated workspace steering) and Kiro IDE (repo steering).
- Locales: n/a: agent guidance, not user-visible product text.
- Accessibility: n/a: no UI.
- Contract: n/a: no boundary crossed.
- Staging proof: not verified on staging: deploys nothing; proven by the guard test and one generator run.
- Only the lane's `paths` change; no other steering file, `CLAUDE.md`, `.claude/**` or protected gate file changes.
- The new test fails on `origin/main` and passes on the head; no existing test is changed or weakened.
- The file keeps every safeguard (plan §3 closing section) and is byte-identical to the `v1-style` file.

<!-- lane: v1-style -->
## Lane `v1-style` — vitana-v1
- [ ] T1 Append the same test to vitana-v1 `scripts/ci/kiro-steering/guard.test.cjs`; red on vitana-v1 `origin/main`
      recorded in `docs/validation/<VTID>/red-on-base.txt`.
- [ ] T2 Add `.kiro/steering/vitana-communication-style.md`, byte-identical to the `platform-style` file.
- [ ] T3 Local checks: guard tests, `guard.cjs .`, preflight; all in `commands.log`.

**Acceptance**
- Change types: Tooling/docs
- Outcome: every Kiro session on vitana-v1 loads the same communication-style rule.
- States: n/a: static steering text.
- Surfaces: Kiro Web and Kiro IDE sessions with vitana-v1.
- Locales: n/a: agent guidance, not user-visible product text.
- Accessibility: n/a: no UI.
- Contract: n/a: no boundary crossed.
- Staging proof: not verified on staging: deploys nothing; proven by the guard test.
- Only the lane's `paths` change (vitana-v1 repo).
- The new test fails on vitana-v1 `origin/main` and passes on the head; no existing test is changed or weakened.
- The steering file is byte-identical to the vitana-platform copy.
