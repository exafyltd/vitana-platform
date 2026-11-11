Change types: Tooling/docs.

# Acceptance — VTID-05699 (privacy-ledger-auth / lane `areas-emails`)

Outcome: `docs/programs/areas.yaml` names the four seats (`jtadic`, `exafyltd`, `hotmail`, `exafy`) and no longer holds
the account address behind each one. The `account:` key is removed from lines 15-18; `surface`, `automation`, the
comment on the `hotmail` line, the areas and `exceptions_seat` are unchanged. A new test keeps addresses out of the file.

- AC-1 Red on base: `scripts/collab/areas-no-email.test.mjs` fails on `origin/main` 6dc6e1ba0c, naming lines 15, 16,
  17 and 18 (`commands.log`). The failure message gives line numbers only, never the matched text.
- AC-2 Green after the change: the same test passes (2 of 2).
- AC-3 Contract: no reader uses the key (plan premise 2: `scripts/collab/queue.mjs`, `scripts/eng/gitlab-gates.mjs`,
  the Project Manager's `governance.ts`, `observe-live.ts`, `types.ts`). `node --test scripts/collab/*.test.mjs` (259
  tests, 0 failed, 1 skipped as on base) and `node --test scripts/eng/gitlab-gates.test.mjs` (8 of 8) pass.
- AC-4 No address is added anywhere: the added lines of the diff, the commit messages, the PR body and this folder hold
  none. The test's own sample address is built at run time, so the repository holds no address literal for it. The
  removed lines of the diff still show the old values; removing them from history is the separate, owner-gated step 1
  of `.kiro/specs/privacy-ledger-auth/history-rewrite-proposal.md`.
- States, surfaces, locales, accessibility: n/a, no UI or runtime change.
- Staging proof: not verified on staging. The change deploys nothing.
- The diff stays inside the lane `paths` plus this evidence folder; no test is skipped or loosened.
