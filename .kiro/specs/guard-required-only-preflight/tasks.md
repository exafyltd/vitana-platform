# Tasks — guard-required-only-preflight
Authoritative plan: `plan.md`. VTID: allocated by PLAN-SPAR.

<!-- lane: guard-required-only -->
## guard-required-only
- [ ] G1. Tests first (red on base): the five cases in `plan.md` (incl. the mixed required + report-only failure) in `preflight.test.mjs` and `kiro-web-session.test.mjs`.
- [ ] G2. `preflight.mjs`: `isRequired`, `requiredOk`, `--required-only` (usage header updated).
- [ ] G3. `kiro-web-session.mjs` `checkPush`: pass `--required-only`; allow and print report-only failures; no cache then.
- [ ] G4. `docs/validation/<VTID>/commands.log` with the test runs and the red-on-base run.

**Acceptance (reviewer agent):**
- Change types: Tooling/docs
- **Outcome** — a Kiro session pushing a lane branch is blocked only by failures CI requires; report-only failures are printed in the guard message and do not stop the push. A v1 lane PR with bot-added i18n commits can be pushed again.
- **States** — preflight exit 0 with report-only FAIL lines, exit 1 from a required failure, exit 0 clean (cached), no PR title, pushed commit != HEAD, PLAN-SPAR false positive (exempt as before).
- **Surfaces** — callers of `preflight.mjs`: the guard (new flag) and runbooks (unchanged default exit status).
- **Locales** — n/a: developer tooling, English by design.
- **Accessibility** — n/a: no UI.
- **Contract** — `preflight --required-only` exit 0/1 and `requiredOk` in `--json` (`preflight.mjs`), consumed at `kiro-web-session.mjs` `checkPush`; default exit status unchanged.
- **Staging proof** — n/a: deploys nothing; covered by the Collab tests in CI (`node --test scripts/collab/*.test.mjs`). Not verified on staging: no deploy.
<!-- lane: guard-required-only -->
