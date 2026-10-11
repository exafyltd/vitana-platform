# VTID-05063 — evidence outputs

Step A (ledger read-auth, log mode) ships no runtime artifact from the implementing
session: the session had no shell or gateway access, so no curl proof or local test
log was captured here. The authoritative evidence is:

- **CI test runs** on this PR (`exafyltd/vitana-platform#4033`): the `vtid-05063-*`
  jest suites, `vtid-04727-ledger-write-auth`, and `staging-deploy-workflow-bash-syntax`
  (20,000-char step cap), plus `scripts/ci/vtid-auto-close.test.cjs`. See the PR's
  check runs for the pass logs.
- **Acceptance criteria + their test paths**: `../acceptance.md` (AC-1..AC-6, each with a `TEST:` line).
- **Command log**: `../commands.log` (the section 2f caller grep and planning-time measurements).
- **Staging probes** (health-class only in step A, per F20): `../staging-tests.json`.

Anonymous Tier 1 → 401 probes are deliberately NOT run until step B pins enforce
(F20: they would fail STAGING-VERIFY, which replays every intervening VTID's suite).
Any step-B / step-D runtime proof (boot line `mode=enforce service_token_configured=true`,
owner-run token-bearing read) will be recorded here when those steps run.
