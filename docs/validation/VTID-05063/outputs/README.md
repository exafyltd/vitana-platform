# VTID-05063 — evidence outputs

This directory holds the local-check output captured for the VTID-05063 PR
(`exafyltd/vitana-platform#4033`). CI on the PR is the authoritative run; the
logs below are a local reproduction captured in the worktree
`.worktrees/vtid-05063-ledger-read-auth` on node v24.11.1 / npm 11.6.2.

## Captured logs (all PASS)

- **`typecheck.log`** — `npm run typecheck` (`tsc --noEmit`) in `services/gateway`.
  Exit 0, no type errors.
- **`jest-vtid-05063.log`** — the six targeted jest suites in `services/gateway`:
  `vtid-05063-ledger-read-auth`, `vtid-05063-ledger-read-routes`,
  `vtid-05063-ledger-read-self-calls`, `vtid-05063-command-hub-ledger-read-headers`,
  `vtid-04727-ledger-write-auth`, and
  `orb/live/upstream/staging-deploy-workflow-bash-syntax`.
  Exit 0 — **6/6 suites, 163/163 tests passed**.
- **`vtid-auto-close-test.log`** — `node --test scripts/ci/vtid-auto-close.test.cjs`
  from the repo root. Exit 0 — **9/9 tests passed**.

### Raw captures

`jest-raw.log` and `vtid-auto-close-raw.log` are the unedited PowerShell
captures of the jest and node-test runs. They carry the full transcript but are
rendered with narrow-console line-wrapping and some non-ASCII mojibake
(checkmark / box glyphs) — console-encoding artifacts only. The `.log` files
above are cleaned transcripts of the same runs; the exit codes and pass/fail
content match.

## Other evidence

- **Acceptance criteria + their test paths**: `../acceptance.md` (AC-1..AC-6, each with a `TEST:` line).
- **Command log**: `../commands.log` (the section 2f caller grep, planning-time
  measurements, and the appended record of the local commands run for these logs).
- **Staging probes** (health-class only in step A, per F20): `../staging-tests.json`.

Anonymous Tier 1 → 401 probes against staging are deliberately NOT run until
step B pins enforce (F20: they would fail STAGING-VERIFY, which replays every
intervening VTID's suite). The jest suite above exercises the enforce-mode
anonymous→401 behaviour in-process. Any step-B / step-D runtime proof (boot line
`mode=enforce service_token_configured=true`, owner-run token-bearing read) will
be recorded here when those steps run.
