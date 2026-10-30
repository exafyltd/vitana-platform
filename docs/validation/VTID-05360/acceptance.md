# VTID-05360 — acceptance (lane kiro-web-reliability/preflight-validator; criteria from `.kiro/specs/kiro-web-reliability/tasks.md`, plan §3.1)

AC-1: Only `scripts/collab/preflight.mjs`, `scripts/collab/preflight.test.mjs`, `docs/validation/VTID-05360/**` and the
lane file change.
TEST: PR-GATE "Lane scope" on the PR head (queue.mjs scope-check) and `git diff --stat origin/main...HEAD` (commands.log).

AC-2: New option `--body-file`; new check `VALIDATOR-CHECK` (label `required`) that applies only when a changed file
(merge-base…head) matches the workflow's own `on.pull_request.paths` (read from the file), otherwise `skip`
"not in VALIDATOR-CHECK's paths".
TEST: scripts/collab/preflight.test.mjs "VALIDATOR-CHECK: no changed file in the workflow paths (read from the file) → skip".

AC-3: The check runs the workflow's own step scripts (nothing re-implemented) from the HEAD revision of
`.github/workflows/VALIDATOR-CHECK.yml` (plan §3.1.2; base and head are identical for this plan), every `run:` step of
job `validate-pr` in order except `Build Gate`; the first failing step ends the check and its `REJECTED:` output is the
failure.
TEST: scripts/collab/preflight.test.mjs "VALIDATOR-CHECK: the workflow is read from the head revision",
"VALIDATOR-CHECK: PR body missing a declaration → fails with the --pr-body-check message naming it",
"VALIDATOR-CHECK: evidence dir without outputs/ → fails "missing …/outputs/"", "VALIDATOR-CHECK: declarations and
evidence complete → passes; Build Gate is reported as not run".

AC-4: Each step runs in the shell GitHub runs it in (see "Decisions taken"): a step without `shell:` in `bash -e`
(the runner logs of this workflow show `shell: /usr/bin/bash -e {0}`), `shell: bash` in
`bash --noprofile --norc -eo pipefail`; cwd = `--repo`.
TEST: scripts/collab/preflight.test.mjs "VALIDATOR-CHECK: `shell: bash` → a failing stage inside a pipeline fails the
step (bash -eo pipefail)", "VALIDATOR-CHECK: a step without `shell:` runs in `bash -e` as on GitHub …".

AC-5: `${{ github.base_ref }}` → the `--base` branch name, `${{ github.event.pull_request.title|body }}` → `--title` /
the body, `${{ steps.<id>.outputs.<K> }}` → the earlier step's `$GITHUB_OUTPUT` (`K=V` and `K<<EOF`); every `/tmp/`
path is rewritten to the preflight temp dir, so parallel preflights share no file.
TEST: scripts/collab/preflight.test.mjs "VALIDATOR-CHECK: ${{ github.base_ref }} and ${{ steps.<id>.outputs.<K> }} are
substituted", "VALIDATOR-CHECK: /tmp/ paths are rewritten to the preflight temp dir (two parallel runs do not collide)".

AC-6: Any other `${{ }}` expression, an unsupported step key / shell, or a workflow the minimal YAML reader cannot parse
fails the check loudly (never a silent pass).
TEST: scripts/collab/preflight.test.mjs "VALIDATOR-CHECK: an unsupported ${{ }} expression or an unparsable workflow
fails loudly".

AC-7: Body source: `--body-file`, else the open PR's body via `gh api`; neither while the check applies → fail
"no --body-file: VALIDATOR-CHECK reads the declarations from the PR body; on a first push pass PR_BODY_FILE=<file> …".
TEST: scripts/collab/preflight.test.mjs "VALIDATOR-CHECK: without --body-file the open PR body is read through gh; no
body at all → fails naming PR_BODY_FILE".

AC-8: A platform-side "Not run by preflight" entry names the VALIDATOR-CHECK Build Gate (`npm run build`, and the
`command_hub_frontend` src+dist check) whenever the check applies.
TEST: scripts/collab/preflight.test.mjs "VALIDATOR-CHECK: declarations and evidence complete → passes; Build Gate is
reported as not run" (and the skip test asserts no such entry when the check does not apply).

AC-9: Every plan §3.1.4 case is a test, red on base, green on head; no existing preflight test is weakened.
TEST: `red-on-base.txt` (13 existing pass, 11 new fail on origin/main's preflight.mjs); `outputs/preflight-test.txt`
(24/24 on head); `outputs/collab-tests.txt` (`node --test scripts/collab/*.test.mjs`, 0 fail). The 13 existing tests
are unchanged (the fixture only gains the opt-in `vc` / `noOutputs` options).

AC-10: Owner item (2): preflight on a branch with a body missing a declaration and an evidence dir without `outputs/`
catches both before push; fixed → pass.
TEST: `outputs/demo-1-missing-declaration.txt`, `outputs/demo-2-missing-outputs.txt`, `outputs/demo-3-fixed.txt`
(throwaway local branch, never pushed).

## Decisions taken
- Shell: the plan (§3.1.2) names `bash --noprofile --norc -eo pipefail` as "the GitHub Actions default shell". The
  runner logs of VALIDATOR-CHECK (run 40690281167) show every step runs in `/usr/bin/bash -e {0}`: GitHub uses the
  pipefail form only for an explicit `shell: bash`. Running the steps with pipefail would fail the real
  `CSP Governance Gate` on every PR (`REVERTED_SHA="$(git log … | grep … )"` exits 1 when no revert exists). Preflight
  therefore mirrors GitHub exactly: `bash -e` without `shell:`, the pipefail form for `shell: bash`; the plan's
  pipefail test case is kept as the `shell: bash` test.
- Workflow revision: the head revision (plan §3.1.2); tasks.md Acceptance says "base revision". Neither lane changes
  the file, so both are the same for this plan.
- The README sentence about the Build Gate (plan §3.1.2) belongs to `docs/kiro-web-parity/README.md`, a path of lane
  session-reliability, not this lane; the same text is in the "Not run by preflight" entry.
- Remote slug for the open-PR lookup comes from `git config remote.origin.url` (the configured URL), because
  `git remote get-url` applies `url.*.insteadOf` rewrites (this sandbox's git proxy).
