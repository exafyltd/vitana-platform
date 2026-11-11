# Tasks — privacy-ledger-auth

<!-- lane: areas-emails -->
Repo `exafyltd/vitana-platform`. Code starts only after the VTID is allocated. No address is ever written to a commit
message, a PR body, a log or an evidence file.
- [ ] T1 Write `scripts/collab/areas-no-email.test.mjs` (plan § Change). Record it red on `origin/main` in
      `docs/validation/<VTID>/commands.log`: the line names the test and its result, never the matched text.
- [ ] T2 Remove the `account:` key from the four seats in `docs/programs/areas.yaml`. Nothing else in the file changes.
- [ ] T3 `node --test scripts/collab/*.test.mjs` green; `node scripts/collab/queue.mjs validate` green.
- [ ] T4 PR `VTID-xxxxx (privacy-ledger-auth/areas-emails): the seat file keeps seat names only`.

Acceptance:
- Change types: Tooling/docs.
- **Outcome** — `docs/programs/areas.yaml` contains no address. Seats, `surface`, `automation`, areas and
  `exceptions_seat` are unchanged.
- **States / Surfaces / Locales / Accessibility** — n/a: no UI or runtime change.
- **Contract** — every reader of `areas.yaml` still parses it: the Collab tests and `queue.mjs validate` pass.
- **Staging proof** — not verified on staging: the change deploys nothing.
- No address in the diff, the PR body, a commit message or `docs/validation/<VTID>/**`.
- Diff only inside the lane `paths`; no test skipped or loosened.

<!-- lane: ledger-auth-enforce -->
Repo `exafyltd/vitana-platform`. Executor claude (protected gate file). Code starts only after the VTID is allocated.
- [ ] T1 Write the new and changed tests of plan § Change in `services/gateway/test/vtid-04727-ledger-write-auth.test.ts`;
      record them red on `origin/main`.
- [ ] T2 `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml`: the `LEDGER_WRITE_AUTH_MODE` entry with
      `LWA="${PROD_LEDGER_WRITE_AUTH_MODE:-log}"` from `vars.PROD_LEDGER_WRITE_AUTH_MODE`, so the value is never empty. No
      new workflow input; nothing else in the file changes.
- [ ] T3 Regenerate `conversation-flag-pins.generated.ts`; `node scripts/conversation/generate-flag-pins.mjs --check`.
- [ ] T4 `docs/validation/<VTID>/staging-tests.json` with the `rejected_probe` of plan § Change (completion route,
      `VTID-PROBE`, expect 401). Never a probe of the allocate route, never a well-formed VTID.
- [ ] T5 Gateway Jest: `vtid-04727-ledger-write-auth`, `vtid-04677-scheduled-notifications-auth` and the flag-pins
      test green; preflight green.
- [ ] T6 PR `VTID-xxxxx (privacy-ledger-auth/ledger-auth-enforce): production ledger writes can be switched to enforce
      by the owner`. The body states that merging changes nothing in production and gives the owner's three steps
      (log read, variable, PUBLISH) and the rollback.

Acceptance:
- Change types: Backend, Infrastructure/CI.
- **Outcome** — with the variable unset, production receives `LEDGER_WRITE_AUTH_MODE=log`, the mode it runs today; with
  the variable `enforce`, an anonymous `POST /api/v1/vtid/allocate` gets 401 JSON and no allocation (test).
- **States / Surfaces / Locales / Accessibility** — n/a: no UI change.
- **Contract** — no route or middleware code changes; staging unchanged; no workflow input added.
- **Staging proof** — the `rejected_probe` passes on staging.
- No production deploy dispatched and no repository variable set by the lane.
- Protected gate file: the owner's instruction of 2026-11-11 (item 5) plus a reviewer-agent accept on the current head.
- Diff only inside the lane `paths`; no test skipped or loosened.
