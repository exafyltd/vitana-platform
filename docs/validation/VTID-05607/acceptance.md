# VTID-05607 acceptance: settings sync writes secrets from a private file

Lane `settings-fix` of plan eng-gitlab-m2. Cause: `makeSecrets.put` passed each value as `--secret-string file:///dev/stdin`;
the AWS CLI cannot read stdin under systemd (ParamValidation, errno 6), so every secret write failed on the GitLab machine
(owner run 2026-11-07 10:33Z, 8 failures).

AC-1 A secret value is never a command-line argument: it is written to a file and the argument is `file://<path>`.
TEST: scripts/eng/gitlab-settings.test.mjs "tokens: created once with 90 days and the configured scopes; secret values are written from a private file, never as an argument" (the mock asserts `file://…/value` and reads the stored value from that file).

AC-2 The value file exists only for the call: it is removed after success and after a failure.
TEST: scripts/eng/gitlab-settings.mjs `makeSecrets.put` removes the directory in `finally`; covered by the same test run (every write path goes through put).

AC-3 A secret that does not exist yet is created with the same file argument.
TEST: scripts/eng/gitlab-settings.test.mjs "apply: a first apply on the M1 GitLab creates everything of plan 3.3, and the second apply makes zero writes" (create-secret calls for the agent secrets).

AC-4 Red before, green after, on the same test file: outputs/red-on-base.txt (18 pass, 38 fail) and outputs/green.txt (56 pass, 0 fail).
TEST: node --test scripts/eng/gitlab-settings.test.mjs

Staging proof: not applicable (deploys nothing). The owner's `bash ~/vitana-eng/m2.sh settings` (exit 0) is the live proof.
