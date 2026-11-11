# VTID-05023 cutover lane

Lane key: `vtid-05023/cutover` (queue slug `vtid-05023`, lane `cutover`). Not the `agentic-delivery/cutover` lane of VTID-05545.

## Claim

- Session id: `kiro-202611111450-a7d2` (generated for this session; the queue requires this form. Lane claim commit `78db61ff54aecb0f28aa5088807bcea3d8ea9235`.)
- Claimed through `node scripts/collab/queue.mjs claim vtid-05023/cutover --session kiro-202611111450-a7d2`.

## Blockers (exact)

| ID | Task | Error or state | Next |
|---|---|---|---|
| B-MR | Open draft MRs for `console-probes-a`, `console-probes-b`, `pm-mode-probes` | Branches exist on GitLab. The sandbox cannot create MRs: `GET /api/v4/projects/vitana%2Fvitana-platform/merge_requests` returns `400 {"message":"Missing header field, please provide AuthToken"}`. A push with `-o merge_request.create` returned `Everything up-to-date`. | Owner or a session with GitLab API access opens the MRs. Links below. |
| B-MERGE | Merge the three MRs after green CI | Depends on B-MR | Same |
| B-AWS-V1 | `aws sts get-caller-identity` | `NoCredentials` (sandbox has no AWS credentials) | Owner attaches permissions to `kiro-1-dstevanovic` and registers the role; the sandbox does not yet pick up the role. |
| B-AWS-C/D | Phases C1 to D4 | Depend on B-AWS-V1 | Start at C1 once V1 passes. |

## MR links (open these to create the drafts)

- console-probes-a: https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/new?merge_request[source_branch]=kiro/staging-verify-manifest-repair/console-probes-a&merge_request[target_branch]=main
- console-probes-b: https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/new?merge_request[source_branch]=kiro/staging-verify-manifest-repair/console-probes-b&merge_request[target_branch]=main
- pm-mode-probes: https://gitlab.vitanaland.com/vitana/vitana-platform/-/merge_requests/new?merge_request[source_branch]=kiro/staging-verify-manifest-repair/pm-mode-probes&merge_request[target_branch]=main

## Phase A status

| Task | Status | Evidence |
|---|---|---|
| A1 (12 tests) | Fixed on branches, not merged | console-probes-a `42dfc93727`, console-probes-b `fc46e215a1`, pm-mode-probes `6f73cd6b01`; `docs/validation/VTID-04887/console-probes-a-check.log`, `docs/validation/VTID-05064/console-probes-b-check.log`, `docs/validation/VTID-05277/pm-mode-probes-runner-tests.log` |
| A2 (track PR #4964) | Not started | |
| STAGING-VERIFY green on one commit | Not run (needs merged MRs) | |

## Phase B status

Not started at time of writing; see updates below.

## Updates

- Claim recorded.
- MR creation blocked (B-MR); Phase B proceeds.
