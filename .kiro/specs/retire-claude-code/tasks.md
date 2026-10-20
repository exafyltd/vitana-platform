# Tasks — retire-claude-code

<!-- lane: scope-rules -->
## Lane `scope-rules`
- [ ] S1 `validateLane`: `governance: true` rule and reviewer-seat rule (design §1).
- [ ] S2 `scopeCheck`: governance files, permission changes, `reviewer_seat: claude` legacy reviews (design §1).
- [ ] S3 `queue.test.mjs`: a case for each rule and each unchanged refusal.

**Acceptance:** `node --test scripts/collab/` green; every refusal that held on origin/main still holds except the
three changed rules; the PR body lists the cases.

<!-- lane: rules-platform -->
## Lane `rules-platform`
- [ ] P1 `collaboration.md` §7/§7a/§7c/§8; P2 `CLAUDE.md` roles + Gate 2 line; P3 steering; P4 automations;
      P5 `routine-prompt.md` retired header.

**Acceptance:** no rule text names Claude Code as an actor; §7b unchanged; `queue.mjs validate` green; sha256 of
`collaboration.md` in the PR body.

<!-- lane: rules-v1 -->
## Lane `rules-v1`
- [ ] V1 `collaboration.md` copied byte-identical from `rules-platform`; V2 `CLAUDE.md`; V3 steering.

**Acceptance:** sha256 of `collaboration.md` equals `rules-platform`'s; `queue.mjs validate` green.

<!-- lane: ci-runner-platform -->
## Lane `ci-runner-platform`
- [ ] C1 `runs-on: ubuntu-24.04` on every Playwright job in the 10 workflows.

**Acceptance:** diff is only `runs-on` lines; actionlint (if present) green; after merge STAGING-VERIFY's browser step
installs Chromium.

<!-- lane: ci-runner-v1 -->
## Lane `ci-runner-v1`
- [ ] D1 the same pin in `PR-GATE.yml`, `E2E-PREVIEW-ORB.yml`, `STAGING-TESTS-REQUIRED.yml`.

**Acceptance:** diff is only `runs-on` lines; the PR's own preview-e2e installs Chromium and runs the smoke spec.
