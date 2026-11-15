# VTID-05801: GitLab operations layer, acceptance record

Lane: `gitlab-client-hardening/gitlab-client-hardening`. Branch: `claude/gitlab-client-hardening/gitlab-client-hardening`.
Repository: GitLab `vitana/vitana-platform` (project id 2). Nothing was pushed to GitHub. No GitLab setting, token, mirror or
production system was changed. The VTID-05537 criteria in `acceptance.md` are unchanged and still apply to `gitlab-api.mjs`.

## Status

| # | Criterion | Status | Evidence |
|---|---|---|---|
| AC-1 | Operations implemented: MR create and update, MR lookup and mergeability, safe merge, pipeline trigger, job and pipeline retry, webhook verification; pagination, rate limits, retries, timeouts and API errors handled by the one client | Met | `scripts/eng/gitlab-ops.mjs`; "Implementation" below |
| AC-2 | Mocked tests pass for success and failure paths | Met: 37 of 37 in the ops suite; 125 of 125 with the client suite | `outputs/test-run-ops-and-client.txt` |
| AC-3 | Failure modes tested: permission, not found, transient, precondition, conflict | Met | tests "classifyError", "safe merge", "create merge request" |
| AC-4 | No credential in logs, errors, fixtures or committed files | Met for code, tests and committed files; leak test passes | "Security checks" |
| AC-5 | Tokens from the environment or a secure file | Met: `clientFromEnv`; token file must be mode 0600 | tests "clientFromEnv" |
| AC-6 | Webhook verification uses GitLab's own mechanism and rejects invalid requests | Met: `X-Gitlab-Token`, constant time, fails closed | tests "webhook" (9 cases) |
| AC-7 | Writes cannot target the wrong project, branch or merge request | Met: project resolved and verified; `target_project_id` checked; source and target checked; merge pinned to the head SHA | tests "project", "merge request by iid", "safe merge: every precondition" |
| AC-8 | Retries cannot duplicate an unsafe write | Met: actions sent with `retries: 0`; create idempotent; a failed merge re-read before it is called a failure | `outputs/mutants.txt`; tests "create merge request", "safe merge" |
| AC-9 | Permission failures distinguishable from missing and transient ones | Met | `classifyError` and its test |
| AC-10 | Real GitLab read-only verification | NOT MET: blocked, see "Live verification" | `outputs/live-readonly.txt` |
| AC-11 | Interface contract published for the other sessions | Met | `interface-contract.md` |
| AC-12 | Full relevant suites run; baseline failures separated from regressions | Met: 1074 tests, 5 failures, all five present before the change | `outputs/test-run-eng-collab-*.txt` |
| AC-13 | Evidence committed and the GitLab MR opened | Met when the commit and MR below are created | Report |

## Live verification (AC-10): blocked

- A GitLab read-only credential was requested through the secure form for host `gitlab.vitanaland.com` and saved on this
  session's environment.
- The client sends the token in the `PRIVATE-TOKEN` header. With the saved credential every read returned 401, and so did a
  placeholder token. A request with no token header returned 200, so the host answers anonymously, but the client always
  authenticates and was not weakened to make this check pass.
- `outputs/live-readonly.mjs` makes GET requests only and prints counts and error kinds, never a token or a body.
- Needed from the owner: confirm the saved credential is valid with `read_api` on `vitana/vitana-platform`, or supply another.
  Then run `GITLAB_URL=https://gitlab.vitanaland.com GITLAB_TOKEN_FILE=<0600 file> node docs/validation/VTID-05801/outputs/live-readonly.mjs`.
- Completion is not claimed on AC-10. The brief asks for live reads "where credentials permit"; here they do not.

## Implementation

`scripts/eng/gitlab-ops.mjs`. Everything goes through the one client in `gitlab-api.mjs`; no second client.

- Identification: `resolveProject` (numeric id, or a path verified against `path_with_namespace`, cached per client);
  `getMergeRequest` (iid checked against `target_project_id`).
- Reads: `mergeStatus` (pure; mergeable only when open, not a draft, `mergeable`, head pipeline `success`); the existing
  `findMergeRequestBySource`, `listPipelineJobs`, `failedJobs`, `getJobLog`, `getPipeline`.
- Merge requests: `createMergeRequest` (idempotent: returns the open one; a 409 is recovered by lookup); `updateMergeRequest`
  (requires `expect.sourceBranch`); `safeMerge` (head pinned to `expectedHeadSha`; one request; re-read after a failure).
- Pipelines and jobs: `triggerPipeline` (once; credential-looking names or values refused); `retryJob`, `retryPipeline`
  (only from `failed` or `canceled`).
- Webhooks: `verifyWebhook` (`X-Gitlab-Token`, SHA-256 digests compared with `timingSafeEqual`, fixed reasons, event name
  matched to `object_kind`); `isDuplicateDelivery` (by `X-Gitlab-Event-UUID`).
- Errors: `classifyError` → `permission | not_found | conflict | precondition | transient | bad_request | unknown`.
- Configuration: `clientFromEnv` (`GITLAB_URL`; `GITLAB_TOKEN` or `GITLAB_TOKEN_FILE` with mode 0600).

`scripts/eng/gitlab-ops.test.mjs`: the 9 original tests and 28 new ones (37 in total).
`scripts/eng/gitlab-api.mjs` is unchanged.

## Commands executed

See `commands.log` (appended for this batch). Summary:

1. `node --test scripts/eng/gitlab-ops.test.mjs` → 37 pass, 0 fail.
2. `node --test scripts/eng/gitlab-ops.test.mjs scripts/eng/gitlab-api.test.mjs` → 125 pass, 0 fail.
3. `node --test scripts/eng/*.test.mjs scripts/eng/testing/*.test.mjs scripts/collab/*.test.mjs` → before the change 1046 tests, 5 fail;
   after the change 1074 tests, 5 fail. The same five fail in both runs.
4. `outputs/mutate-ops.sh <repo root>` → four planted defects, each caught; the unmodified and restored code pass (`outputs/mutants.txt`).
5. `outputs/live-readonly.mjs` against `https://gitlab.vitanaland.com` → 401 (`outputs/live-readonly.txt`).

## Test results

| Run | Result | File |
|---|---|---|
| Ops + client suites | 125 pass, 0 fail | `outputs/test-run-ops-and-client.txt` |
| Full eng + collab, after the change | 1068 pass, 5 fail, 1 skipped (1074) | `outputs/test-run-eng-collab-full.txt` |
| Full eng + collab, before the change | 1040 pass, 5 fail, 1 skipped (1046) | `outputs/test-run-eng-collab-BASELINE-before-change.txt` |

Baseline failures (present before this change; not regressions):

- `collab/kiro-web-steering` "case 6" and `collab/land-guard` "CLI: evidence passes…": both run `git rev-parse` and need a real
  `.git`. The copy used here came from a REST archive, which has none. Environment failures; expected to pass in a real clone.
- `collab/program-registry` (three tests on the specs of plan item 5 and their programme): the registry on this branch does not
  list `native-wave2-ai-pages` under `native-app`. Not touched by this change; belongs to the programme owner.

## Security checks

- Credential placement: the token goes only in `PRIVATE-TOKEN` (client; `gitlab-api.test.mjs` token tests).
- Leaks: the leak test makes a 401 whose body echoes the token and asserts the token is absent from the error's JSON, its message
  and its classification. Configuration errors name the variable, never its value ("clientFromEnv" test).
- Committed files: no real credential. The only credential-shaped strings are the documented fixture `glpat-ABCDEFGHIJKLMNOPQRSTUV`
  (already in `main`'s test file) and the test webhook secret `whsec_0123456789abcdef`.
- Webhooks: timing-safe comparison; a missing or wrong token is rejected; a secret shorter than 8 characters is a configuration
  error, so nothing is accepted by accident; the event name must match `object_kind`.
- Write targeting: project verified by path; merge requests verified against the project; source and target checked; merge
  pinned to a full head SHA. A mutant that drops the head check is caught.
- Duplicate writes: creates are idempotent; actions are sent once; a re-read decides after a failed merge. A mutant that retries a
  merge is caught.
- Logging: the operations module does not log.

## Known limitations

1. Live read-only verification is not done (credential returns 401). See "Live verification".
2. Session 2 (DeliveryProvider) and Session 3 (CI and runner) could not be reached from this session (no peer agent running).
   The contract is on the lane branch and named in the MR; their lanes must consume `gitlab-ops.mjs` and must not create a second client.
3. `github-bridge.mjs` has its own `fetchInto` for GitLab refs, a second transport. Moving it onto the client belongs to its lane;
   this change does not edit it.
4. GitLab does not HMAC-sign webhook deliveries; the protection is the secret token, compared in constant time, over TLS. A handler
   must still be idempotent, because a delivery without a uuid cannot be recognised as a repeat.
5. No pipeline cancel, no branch or file writes, no project settings: not needed by the listed consumers. Add when a lane asks.
6. Job logs above 2 MB (`maxBytes`) are refused, not truncated.
7. After a lost answer from `triggerPipeline`, list the pipelines for the ref before triggering again; the operation cannot know
   whether it ran.
8. `safeMerge` requires a successful head pipeline; a project that merges without a pipeline cannot use it.
9. Git over HTTPS is not available from this session (the proxy supplies no git credential). The branch was updated through the
   REST commits API.
10. The baseline failures above remain.
