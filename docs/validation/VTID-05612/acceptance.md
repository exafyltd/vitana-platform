# VTID-05612 acceptance (eng-gitlab-m2/runner-pin-jq)
Change types: Infrastructure/CI, Tooling/docs.

Outcome: a fresh fleet manager or M1 runner installs the pinned runner without "held broken packages"; the platform pipeline's
gateway-jest shards have jq, as GitHub's ubuntu-latest does.
States: helper version present (19.5.2-1 is in the repository) installs; a missing version fails the installer (exit 1) instead of
taking another one (one `apt install ... || exit 1` for both packages).
Surfaces: host/fleet-manager-install.sh, host/runner-install.sh, ci/platform.gitlab-ci.yml (.gateway before_script), RUNBOOK-m2-fleet.md.
Locales: n/a. Accessibility: n/a.
Contract: the central CI jobs stay word for word milestone 1 except the one jq line first in .gateway's before_script (pinned by the
free-tier-guard test). Two existing assertions changed on purpose and only tighten: fleet-structure test 24 and test 36 now require
the helper package in the same pinned install and both packages held.
Staging proof: not verified on staging: deploys nothing. The live proof is the next GitLab platform main pipeline after the settings
sync writes the central file (gitlab-verify, VTID-05555).

AC-1 — both installers pin and hold gitlab-runner-helper-images with gitlab-runner at $RUNNER_VERSION
  TEST: scripts/eng/fleet-structure.test.mjs ("both runner installers pin and hold gitlab-runner-helper-images ...", tests 24 and 36)

AC-2 — the platform .gateway jobs install jq first; everything else is the milestone 1 job
  TEST: scripts/eng/free-tier-guard.test.mjs ("the platform .gateway jobs install jq before their script", test 10)

AC-3 — the fleet runbook records the helper recovery and the fleet size of 5 with terraform.tfvars
  TEST: infra/gitlab-engineering/RUNBOOK-m2-fleet.md (sections 3 and 2)
