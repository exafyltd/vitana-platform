Change types: Backend, Integration.
# Delivery loop, slice 4: GitLab REST client, failure fingerprint, loop controls

No approved lane or VTID covers this slice (VTIDs come only from CI PLAN-SPAR; none was invented). Part of the WIP merge request "delivery
loop"; it needs `plan(delivery-loop)` before it can merge. New code only (`services/gateway/src/services/delivery-loop/`), nothing is wired
into `index.ts` yet, so nothing runs.

Mission items prepared here: (1) intake and (3)(4) failure detection and repair need to read GitLab (the text of an issue, the log of a
failed job, the diff of a merge request) and write back (a comment, a label, a merge request, a retry). The gateway had no GitLab client.
(7) the loop needs controls that fail closed.

AC-1 GitLab client. `createGitlabClient` reads and writes GitLab through its REST API: issues (get, list, comment, labels), merge requests
(get, list, create, comment, diffs), pipelines (get, jobs, job log tail, retry). Configuration only from `GITLAB_API_URL` and `GITLAB_API_TOKEN`
(`gitlabClientFromEnv` is null when either is missing); no URL or project is hardcoded.
TEST: test/delivery-loop/gitlab-client.test.ts (34 tests).

AC-2 Least privilege. A project that is not in the allowlist (`DELIVERY_LOOP_PROJECTS`) is refused inside the client before any request, on
every method; a project string that is not a plain `group/name` path and an iid that is not a positive integer are refused too. The token is
sent only in `PRIVATE-TOKEN` (extra headers cannot replace it) and never appears in a URL, a body, an error or a result; a server that echoes
the token into its error message does not get it into ours.
TEST: gitlab-client.test.ts "the project allowlist", "what is sent", "failures never throw and never carry the token".

AC-3 Never throws, bounded, untrusted input. Every method answers `{ ok, data }` or `{ ok: false, error }` for an HTTP error, a network error,
a hung request (timeout), a body that is not JSON, or a list whose later page fails (no partial list is returned). Responses are parsed field
by field; a field of the wrong type becomes its empty value. Pages are capped (5 x 100), diffs at 300 files, a job log is read as a rolling
tail (16 KiB default, 256 KiB at most, and refused beyond 64 MiB).
TEST: gitlab-client.test.ts "what comes back is untrusted", "pagination", "job logs".

AC-4 Failure fingerprint. `fingerprintFailure` gives one 16 hex character key for "the same failure": project, the failed jobs (name and
GitLab's failure_reason) and the normalized error lines of their logs. Two runs of one failure give one fingerprint although their logs differ
in timestamps, uuids, hashes, durations, line numbers, temp paths, colour codes, runner step ids and the day; a different error, job, reason
or project gives a different one. `classifyFailure`: `code` when a job script failed, `infra` when every job failed for GitLab or the runner
(retry, do not repair), `unknown` otherwise (not repaired). `healKey` adds the ref, so another branch has its own attempt budget.
TEST: test/delivery-loop/fingerprint.test.ts (41 tests), including the log format of a real runner and two pinned vectors computed outside the code.

AC-5 Controls fail closed. The loop is on only for `DELIVERY_LOOP_ENABLED=true`; the autonomy level is L1 when unset and L0 for any value that
is not exactly L0 to L3, so a typo cannot raise it; `act` needs L3 and the execution plane armed (an unreadable switch is not armed);
`DELIVERY_LOOP_MAX_ACTIONS` (default 5, at most 50) and `DELIVERY_LOOP_HEAL_MAX_ATTEMPTS` (default 3, 1 to 5) fall back to the default when
out of range. Turning the loop on or raising the level is the owner's step.
TEST: test/delivery-loop/controls.test.ts (17 tests).

LIVE (read only): outputs/live-gitlab-readonly.txt runs the real client against the live GitLab 19.5.3-ee with GET methods only: it lists 73
merge requests and 3 issues of vitana/vitana-platform, reads a merge request with its head pipeline, the pipeline, its 8 jobs, the diff of
the merge request (10 files) and the tail of a job log, and is refused on a project outside the allowlist. It also fingerprints a REAL failed
job (pipeline 497 of vitana/rehearsal, the red SRT2 pipeline: class code, job unit:script_failure, 5 error lines). Running it found two defects
that the tests written from the documentation had not: the list endpoint carries no `head_pipeline`, and the runner prefixes every log line with a
timestamp and a step id that differs between runs (`01O` / `00O`); both are fixed and covered by tests.

RED ON BASE: outputs/red-on-base.txt: without the module the three suites fail to load (0 of 92 tests can run).
CHECKS: `tsc --noEmit` on the source and a one-off compile of the three test files, both exit 0 (outputs/tsc.txt).

What this does NOT prove:
- Writes. The live run is read only (the allowlist, the PUT/POST bodies and the headers are proven against the fake; no comment, label,
  merge request or retry was sent to GitLab from this slice). The write paths are exercised against the rehearsal project in slice 9.
- The production credential. The client has no token in this environment; `GITLAB_API_URL`/`GITLAB_API_TOKEN` are not set on any gateway task
  and no ECS task definition or secret was created (owner step, live write).
