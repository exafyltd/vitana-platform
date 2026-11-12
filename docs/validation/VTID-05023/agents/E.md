# VTID-05023 agent E: parity review of scripts/aws/rehearsal-parity-counts.sh

Status: OPERATIONAL FAILURE. The review could not be performed. Nothing was approved.

## What was required
Fetch `cutover/vtid-05023-rehearsal-parity` from GitLab (project id 2), review `scripts/aws/rehearsal-parity-counts.sh`, run it with shellcheck and a local Postgres or stub, open an MR to `main`, and post review findings as an MR note.

## Evidence
- Branch lookup: `GET /projects/2/repository/branches/cutover%2Fvtid-05023-rehearsal-parity` returned `404 Branch Not Found`.
- MR lookup: `GET /projects/2/merge_requests?source_branch=cutover/vtid-05023-rehearsal-parity` returned an empty list.
- Branch search: `GET /projects/2/repository/branches?search=vtid-05023` and `?search=parity` list no rehearsal-parity branch. Matches are `cutover/vtid-05023-aurora-pin-test`, `-aurora-strip-all`, `-gitlab-aurora-strip`, `-handover`, `-lane`, `-staging-hygiene`, `plan/vtid-05023-staging-aurora`, plus unrelated `*parity*` branches for other work.
- Script lookup: `GET /projects/2/repository/files/scripts%2Faws%2Frehearsal-parity-counts.sh/raw?ref=main` returned HTTP 404. Refs `cutover/vtid-05023-aurora-strip-all`, `cutover/vtid-05023-lane` and `cutover/vtid-05023-handover` also returned 404 for that path.
- Local clones under `/projects/sandbox/agents/*` contain no `rehearsal-parity` branch and no copy of the script. A `git log --all -S rehearsal-parity-counts` in the local clones found nothing.
- Git: `git fetch origin cutover/vtid-05023-rehearsal-parity` failed with `fatal: couldn't find remote ref`.
- Tooling: shellcheck, psql and pg_ctl are not installed on this machine, so no local run was possible even with the script.

## Not done
- No shellcheck run, no script execution, no Postgres or stub run. No output was recorded because there was no script to run.
- No MR was opened. Its source branch does not exist, and a MR from a missing branch cannot be created.
- No MR note was posted. The review did not happen.
- The script was not written or edited by this agent. Writing it here would replace the review with an unreviewed script.

## Blockers
1. The source branch `cutover/vtid-05023-rehearsal-parity` is not on GitLab. The agent that owns the parity script (the lane lists it under agent F in one brief and agent E in another) must push it. Command for the owner: `git push -u origin cutover/vtid-05023-rehearsal-parity` from the workstation that holds `scripts/aws/rehearsal-parity-counts.sh`. If that workstation is unknown, the script must be located first; it is not in any clone available to this run.
2. Once the branch exists, this review must be rerun: fetch the branch, run `shellcheck scripts/aws/rehearsal-parity-counts.sh`, run the script against a local Postgres or stub, then open the MR with `POST /projects/2/merge_requests` (source `cutover/vtid-05023-rehearsal-parity`, target `main`) and post findings with `POST /projects/2/merge_requests/<iid>/notes`.

## Verdict
CHANGES_REQUESTED is not applicable: no code was reviewed. The review is incomplete and is reported as an operational failure, not as approval.
