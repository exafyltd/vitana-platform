Change types: Infrastructure/CI, Tooling/docs.

# VTID-05552 acceptance (agentic-delivery/verify-on-gitlab)
Lane `verify-on-gitlab` of plan `agentic-delivery` (vitana-platform), tasks V1-V4 of `.kiro/specs/agentic-delivery/tasks.md`;
plan §3.6 steps 3 to 6 and 8, §3.2 (runner classes), §3.11 (the record), §7 (roles `gl-verify`, `gl-record`), §9.
Builder session `kiro-exafy-202611051219-be7f` (seat exafy; driver `kiro-exafy-202611041929-802c`), base `origin/main`
`3767d3d09d`.

Outcome: STAGING-VERIFY can run on GitLab for the gateway and the community app with the same suites, guard and outcome
as on GitHub. `run.mjs verify` takes one new input, `--deploy-runs-file`, in place of its GitHub Actions API call; the
`.record` job runs the unchanged `record-oasis.sh`, which writes the same `staging.verify.*` row the PUBLISH gate reads
(only `metadata.workflow` names the GitLab job, through lane prerequisites' `WORKFLOW`); the `.vtid-close` job runs the
unchanged `vtid-auto-close.cjs` with its environment from the squash commit. In shadow mode (before the cutover) the
GitLab job waits for staging to serve the commit GitHub deployed, keeps its result in the artifact and writes nothing.
Nothing runs on merge: the template is used by lane `pipelines` and switched on by lane `cutover`.

AC-1 For the same deploys, the deploy-runs file (`[{"service","sha","started_at","finished_at","outcome"}]`, lane
deploy-path) gives the same attribution cutoff T_cut as the GitHub listing: a deploy started mid-run, one finished inside
the 5-minute margin, a skipped deploy, a failed deploy, one older than the 6-hour lookback, none of this service.
TEST: scripts/ci/staging-verify/deploy-runs.test.mjs "deploy-runs file and GitHub listing give the same T_cut: <case>" (6 tests).

AC-2 Each entry of the service under test becomes the run shape `deployCutoff` reads (started_at → created_at,
finished_at → updated_at, none = in progress, outcome → conclusion); entries of the other service are ignored; a file that
is not a list of entries, or has an entry without a service, or an entry of this service without a valid started_at, is
refused as a whole.
TEST: scripts/ci/staging-verify/deploy-runs.test.mjs "deploy-runs entries become the run shape deployCutoff reads, only for the service under test"; "a malformed deploy-runs file is refused as a whole (fail closed), never partly read".

AC-3 With `--deploy-runs-file`, run.mjs makes no `gh` call, even with `GITHUB_TOKEN` and `VITANA_V1_READ_TOKEN` set.
Without it the GitHub path is unchanged: the same `gh api -X GET repos/<repo>/actions/workflows/<AWS-STAGE-DEPLOY-*.yml>/runs`
call per service, the same runs.
TEST: scripts/ci/staging-verify/deploy-runs.test.mjs "with --deploy-runs-file there is no gh call, even with a GitHub token present, and T_cut matches GitHub"; "without --deploy-runs-file the GitHub path is unchanged: the same gh call per service, the same runs".

AC-4 Deploy-runs file missing on GitLab: the run fails closed and says why, and never falls back to GitHub. A missing,
empty, unreadable or non-JSON file (or the flag with no value) gives T_cut = run start, so no request result is
attributed and a superseded run ends `superseded` (never a pass); the log line names the file and "no GitHub fallback".
TEST: scripts/ci/staging-verify/deploy-runs.test.mjs "a missing, empty or unreadable deploy-runs file fails closed: null (T_cut = run start), no GitHub fallback"; "dry run, gateway: deploy-runs file missing on GitLab — fails closed (nothing attributed), says why, no GitHub fallback".

AC-5 Task V4 dry run: `run.mjs verify` end to end for the gateway and the community app with deploy-runs fixtures and no
network. fetch is replaced before run.mjs loads (every staging and production stamp and smoke request is answered by
the stub, any other URL is refused), `gh` and `npx` are fakes that record each call. Staging moves to a descendant
mid-run: the run is `superseded` by it, T_cut equals the GitHub listing's for the same deploy, all results are
attributed, `gh` is never called; without the flag the same run lists the GitHub deploy runs once with the same T_cut.
TEST: scripts/ci/staging-verify/deploy-runs.test.mjs "dry run, gateway: run.mjs verify with a deploy-runs file — no network, no gh call, T_cut from the file"; "dry run, community-app: …" ; "dry run, <service>: without the flag the GitHub listing is used, with the same T_cut" (transcripts: outputs/dry-run-*.txt).

AC-6 Nothing else in run.mjs changes: the diff is the usage line, `deployRunsFromEntries`, `readDeployRuns`,
`deployRunsFor` (after `listStageDeployRuns`) and the one call site (`run.mjs:479`); every existing staging-verify test
stays green.
TEST: `node --test` of every test file in scripts/ci/staging-verify/ (outputs/staging-verify-dir.txt, 104/104: 88 existing + 16 new); confirm-live.test.mjs, lib.test.cjs, record-oasis.test.cjs, workflow.test.cjs unchanged.

AC-7 A squash commit with the plan §3.5 trailers maps to `PR_TITLE` (the title), `PR_BODY` (the description, without the
trailer block), `PR_HEAD_REF` (`Source-Branch:`), `PR_LABELS` (`[]`) and `PR_REF` (`<project>!<iid>` from
`Merge-Request:`); trailers are found with or without a blank line before them; CRLF is accepted. vtid-auto-close.cjs's
own `autoCloseDecision` gives the same decision for the mapped environment as for the GitHub pull request.
TEST: scripts/eng/verify/vtid-close-env.test.mjs "a squash commit with the §3.5 trailers maps to PR_TITLE, PR_BODY, PR_HEAD_REF, PR_LABELS and PR_REF"; "the trailers are parsed from the last block, also without a blank line before them; CRLF is accepted"; "the mapped environment gives vtid-auto-close.cjs the same decision as the GitHub pull request did".

AC-8 A `dev-autopilot/*` source branch and the `VTID_AUTO_CLOSE: no` line keep their meaning (no close, the same reasons
as on GitHub); the opt-out line stays in PR_BODY.
TEST: scripts/eng/verify/vtid-close-env.test.mjs "a dev-autopilot/* source branch keeps its meaning: …"; "the `VTID_AUTO_CLOSE: no` line in the description keeps its meaning and stays in PR_BODY".

AC-9 `vtid-close-env.mjs run` in live mode runs the unchanged vtid-auto-close.cjs with that environment and the service
token (read, then close through `/api/v1/oasis/tasks/<VTID>/complete` with reason `PR merged to main (<project>!<iid>)`;
the token is never printed). It closes nothing in shadow mode or with `DELIVERY_MODE` unset, and nothing for a commit
without a `Merge-Request:` trailer (not a merge-bot landing).
TEST: scripts/eng/verify/vtid-close-env.test.mjs "`vtid-close-env.mjs run` in live mode runs vtid-auto-close.cjs …"; "… closes nothing in shadow mode, or when DELIVERY_MODE is unset …"; "a commit on main without a Merge-Request trailer …"; "… on a commit without the merge-bot trailers makes no gateway call and says why".

AC-10 GitLab variables, the `vitana/ci/oasis-recorder` secret and the verify artifact map to every input of
record-oasis.sh: SUPABASE_URL (`DATA_REST_URL` overrides, as on GitHub), SUPABASE_SVC, RESULTS, RUN_URL
(`CI_PIPELINE_URL`), SERVICE and SHA (from the verify job's `target.json`, else the job variables), WORKFLOW
`gitlab:<CI_PROJECT_PATH>/staging-verify`.
TEST: scripts/eng/verify/record-env.test.mjs "GitLab variables and the oasis-recorder secret map to every input of record-oasis.sh"; "WORKFLOW names the GitLab project of the job; DATA_REST_URL overrides the secret URL as on GitHub"; "the commit and service the verify job wrote in target.json win over the pipeline commit (the nightly run)".

AC-11 record-oasis.sh then builds the same body as on GitHub for the same results.json, except `metadata.workflow`,
which names the GitLab job: a passed run, a superseded full run with attribution, the crashed runner. The fields the
PUBLISH gate filters on (topic, `metadata.service`, `metadata.commit`) are the same. Known red until lane prerequisites
(#4690) landed, because record-oasis.sh ignored WORKFLOW; #4690 is on main as `51c2bead07`, and with main merged into
this branch (`6ce814552f`) all 11 tests pass in the repo (outputs/green.txt).
TEST: scripts/eng/verify/record-env.test.mjs "integration, <case>: the same body as on GitHub except metadata.workflow, which names the GitLab job" (3 tests); "the fields the PUBLISH gate filters on (topic, metadata.service, metadata.commit) are the same on both hosts".

AC-12 `record` without its secret: the job is red (record-oasis.sh's own refusal), nothing is sent, results.json stays in
the artifact. In shadow mode or with DELIVERY_MODE unset nothing is recorded. When the verify job never started (no
target.json, no results.json) nothing is recorded and the log says why.
TEST: scripts/eng/verify/record-env.test.mjs "record without its secret: the job is red, nothing is sent, the result stays in the artifact"; "shadow mode, or DELIVERY_MODE unset: nothing is recorded …"; "the verify job never started …"; "without the secret the Supabase inputs are empty, …".

AC-13 Shadow mode: the wrapper waits up to 60 minutes (polls every 30 s) for staging to serve the commit, then runs
run.mjs verify once with `--deploy-runs-file` and keeps the outcome in `shadow.json` (`recorded: false`); if staging never
serves it, or already serves a descendant, the result is `not_comparable`, run.mjs does not run and no results.json is
written. Live mode runs run.mjs at once. Only `DELIVERY_MODE=live` is live.
TEST: scripts/eng/verify/shadow-wait.test.mjs "shadow mode: waits until staging serves the commit, then runs run.mjs verify once"; "shadow mode: staging never serves the commit within 60 minutes → not_comparable, …"; "shadow mode: staging already serves a descendant → not_comparable at once …"; "shadow mode: a failed verification keeps its exit code …"; "live mode: no wait; …"; "DELIVERY_MODE: only the exact value `live` is live; …"; "run.mjs is always given --deploy-runs-file …"; "target.json records what the job verifies …"; "bad input is refused before any wait …".

AC-14 The nightly run passes full=true on the commit staging serves now (resolved with `run.mjs stamp`, checked out
first), in its own resource group.
TEST: scripts/eng/verify/shadow-wait.test.mjs "nightly (--sha-from-staging): the commit is the one staging serves now, checked out before the full run"; scripts/eng/verify/tpl-verify-structure.test.mjs "the nightly run passes full=true on the commit staging serves, in its own resource group".

AC-15 `tpl-verify.yml`: `.staging-verify` on the main class with a resource_group per service, oldest first, not
interruptible, audience `aws:verify` only; `.record` and `.vtid-close` on the deploy class with audience `aws:record`
only, checking out nothing, live mode only; `.notify-platform` on the deploy class, no ID token, live mode only, the
paths and payload of SCREENS-CATALOG-TRIGGER.yml; nothing on the untrusted class; deploy-class jobs run only platform
main's scripts; each writing job also refuses in its own script in shadow mode.
TEST: scripts/eng/verify/tpl-verify-structure.test.mjs (10 tests, one per rule above); outputs/yaml-cross-check.txt (the test reader and Ruby Psych, GitLab's YAML library, parse the file to identical data).

AC-16 A job reads its one secret with its ID token: STS AssumeRoleWithWebIdentity (unsigned, 900 s) for the plan §7 role,
then Secrets Manager GetSecretValue signed with SigV4 (the signer reproduces the AWS documentation example); a role
outside account 472838866351 or a region other than eu-central-1 is refused before any call (CLAUDE.md IF–THEN 11);
errors name the role or secret and the AWS error, never the token; the CLI writes the secret with mode 0600 and prints
no secret.
TEST: scripts/eng/verify/aws-secret.test.mjs (6 tests).

States: deploy-runs file missing on GitLab (T_cut = run start, nothing attributed, the log says why, no GitHub
fallback: AC-4); staging moved mid-run (superseded, as today: AC-5); no production stamp (failed, as today: the
unchanged `describeBaseline` path of run.mjs, `lib.test.cjs`); `record` without its secret (job red; the result stays in
the artifact: AC-12); shadow mode, served (result in the artifact, not recorded), not served in 60 minutes or moved past
(`not_comparable`, run.mjs not run: AC-13); DELIVERY_MODE unset (shadow: nothing written); a commit without the merge-bot
trailers (nothing closed: AC-9); the verify job never started (nothing recorded: AC-12).

Surfaces: GitHub STAGING-VERIFY (path unchanged until the cut: AC-3, AC-6); GitLab `main` and nightly pipelines (the
hidden jobs of `infra/gitlab-engineering/ci/tpl-verify.yml`, extended by lane `pipelines`); `oasis_events` (through the
unchanged record-oasis.sh); the reader `services/gateway/src/services/testing/publish-gate.ts:148`
(`evaluatePublishGate`) and its row query `:133-140` (topic `staging.verify.%`, `metadata->>service`,
`metadata->>commit`), which never reads `metadata.workflow`; the VTID ledger through the governed completion endpoint
(unchanged vtid-auto-close.cjs).

Locales: n/a. Accessibility: n/a.

Contract: the `record-oasis.sh` body (`scripts/ci/staging-verify/record-oasis.sh:26-59`, its environment `:5`; not edited
here) on one side and `recordEnv` (`scripts/eng/verify/record-env.mjs:24-34`) on the other: only `metadata.workflow`
differs, through lane prerequisites' `WORKFLOW`. The `vtid-auto-close.cjs` inputs (`scripts/ci/vtid-auto-close.cjs:134-143`;
not edited here) on one side and `vtidCloseEnv` (`scripts/eng/verify/vtid-close-env.mjs:35-46`) on the other: the same
five variables GitHub sets (`.github/workflows/VTID-AUTO-CLOSE.yml:46-54`). The deploy-runs file of lane deploy-path
(`.kiro/specs/agentic-delivery/tasks.md:137-138`, `[{"service","sha","started_at","finished_at","outcome"}]`) on one side
and `deployRunsFromEntries` / `readDeployRuns` (`scripts/ci/staging-verify/run.mjs:208-248`) on the other; `service` is
the STAGING-VERIFY service id (`gateway`, `community-app`), and `.staging-verify` reads it from `$DEPLOY_RUNS_FILE`,
default `$CI_PROJECT_DIR/deploy-runs.json` (`tpl-verify.yml:56`). The T_cut rule itself is `lib.cjs:475-488`
(`deployCutoff`), unchanged. The job names `.staging-verify`, `.record`, `.vtid-close`, `.notify-platform` (plan §9)
and the roles and audiences of plan §7 (`gl-verify`/`aws:verify`, `gl-record`/`aws:record`).
SCREENS-CATALOG-TRIGGER (vitana-v1 `.github/workflows/SCREENS-CATALOG-TRIGGER.yml:9-11` paths, `:27-29` payload) on one
side and `.notify-platform` (`tpl-verify.yml:122-139`) on the other.

OASIS_PROOF: this PR adds no new writer and writes nothing on merge. After the cutover (DELIVERY_MODE=live) the
`.record` job writes one `oasis_events` row per STAGING-VERIFY run through the unchanged record-oasis.sh
(`POST $SUPABASE_URL/rest/v1/oasis_events`): topic `staging.verify.passed|failed|superseded`, `vtid` (the run's VTID or
`BOOTSTRAP-STAGING-VERIFY`), service `staging-verify-<service>`, role `CICD`, model `staging-verify`, and the same
metadata as on GitHub with `metadata.workflow` = `gitlab:<project>/staging-verify`; the crashed-runner row
`staging.verify.failed` likewise. record-env.test.mjs compares the bodies record-oasis.sh sends from the GitHub and the
mapped GitLab environment, captured by a fake curl (`https://example.invalid`); no row was written to verify this lane.
The PUBLISH gate's query (`publish-gate.ts:133-140`) filters on topic, `metadata->>service` and `metadata->>commit`,
which are identical on both hosts (AC-11). In shadow mode, and with DELIVERY_MODE unset, nothing is recorded (AC-12):
GitHub stays the only writer of these rows until the cutover (plan §3.6 step 8). The `.vtid-close` job's only write is
the governed completion endpoint, as on GitHub (`vtid.lifecycle.completed`, emitted by the gateway).

Staging proof: not verified on staging at merge: this lane deploys nothing (`run.mjs check-pr --service gateway`:
"PR touches no gateway deploy path — nothing deploys", outputs/check-pr.txt; no `staging-tests.json`). The unchanged
GitHub path keeps passing on the next merges (AC-3, AC-6: the GitHub dry runs and the 88 existing staging-verify tests);
the GitLab path is proven by lane `cutover`'s shadow run. Covering tests: AC-1 to AC-16 above, all offline.

Red on base (`origin/main` `3767d3d09d`, the final tests): outputs/red-on-base.txt — run 1 in a detached base worktree,
62 tests, 60 failed, 2 passed; run 2 against no-behaviour stubs outside the repo, 62 tests, 60 failed (assertion
failures), 2 passed. The 2 that pass on base are by design: they prove that without `--deploy-runs-file` the GitHub
listing is used with the same T_cut (task V1, "without it the GitHub path is unchanged").
Green (final code): outputs/green.txt — on `6ce814552f`, the merge of origin/main `51c2bead07` (lane prerequisites
#4690, merged 2026-11-05T17:40:30Z) into this branch: 62 tests, 62 pass. Before #4690 landed: 59 pass, 3 fail (the
known-red record-env integration cases); the same record-env.test.mjs with #4690's record-oasis.sh (`18a10349d8`,
outside the repo) 11/11.
outputs/staging-verify-dir.txt 104/104. outputs/unit-all.txt (UNIT.yml's command): base 613 tests, 612 pass, 1 skipped;
head before #4690 675 tests, 671 pass, 3 fail (the same three), 1 skipped; `6ce814552f` 724 tests, 723 pass, 0 fail,
1 skipped. outputs/dry-run-*.txt: the V4 dry runs.
outputs/yaml-cross-check.txt: the template parses identically with Ruby Psych.

Decisions taken (for Gate 2):
- Deploy-runs mapping: started_at → created_at, finished_at → updated_at (null = still running), outcome → conclusion as
  written, so only `skipped` is ignored, as GitHub's `skipped`. Any other outcome (a GitLab deploy that ended
  `superseded` included) counts as a deploy that may have rolled tasks: it can only lower T_cut, the fail-safe
  direction of `lib.cjs`.
- A deploy-runs entry's `service` is the STAGING-VERIFY service id (`gateway`, `community-app`). An entry without a
  service, or an entry of this service without a valid started_at, invalidates the whole file (T_cut = run start).
- A missing file gives T_cut = run start (as a failed GitHub lookup does), not a failed outcome: `superseded` is never a
  pass, while a `failed` deploy row would mark every VTID failed through `per_vtid` for a wiring fault. The flag given
  with no value counts as given, so GitLab can never fall back to GitHub. run.mjs reads the file when the cutoff is
  needed, where the API call was.
- Shadow wait: run.mjs `confirmLive` (1 round of 5 samples) every 30 s. When staging already serves a descendant the
  wrapper stops at once with `not_comparable` (staging deploys forward, so it will not serve the commit): a commit
  GitHub skipped then does not hold the per-service resource group for 60 minutes. `not_comparable` exits 0 (it is not
  a verification failure); a verification that ran keeps run.mjs's exit code in both modes.
- DELIVERY_MODE: only `live` is live; unset or any other value is shadow, which writes nothing. The record, close and
  notify scripts also refuse (exit 3) outside live mode, so a pipeline that replaces the template's `rules` still writes
  nothing, and shows it.
- `.vtid-close`: `PR_LABELS` is `[]` because the squash commit carries no labels (plan §3.5 defines no label trailer),
  so the `vtid-keep-open` label has no GitLab equivalent and the `VTID_AUTO_CLOSE: no` line is the opt-out. A commit on
  `main` without `Merge-Request: !<iid>` closes nothing (GitHub closes only merged pull requests). `PR_BODY` is the
  description without the trailing run of `Key: value` lines (the opt-out line has an underscore, so it is never part
  of it). `PR_REF` is `<project>!<iid>`. `.vtid-close` and `.notify-platform` are `allow_failure: true`: on GitHub they
  are separate workflows and VTID-AUTO-CLOSE never fails by design. `.record` can go red (the plan's States).
- Secrets: each secret is JSON keyed by the GitHub secret names it replaces (`vitana/ci/test-user`: TEST_USER_EMAIL,
  TEST_USER_PASSWORD; `vitana/ci/oasis-recorder`: SUPABASE_URL, SUPABASE_SERVICE_ROLE;
  `vitana/ci/gateway-service-token`: GATEWAY_SERVICE_TOKEN). They are read by `scripts/eng/verify/aws-secret.mjs`, a
  dependency-free STS + SigV4 reader, because the Node 20 job image has no AWS CLI and GitLab Free has no `secrets:`
  for AWS. Role ARNs default to `arn:aws:iam::472838866351:role/gl-verify` and `.../gl-record` (plan §7 names) and can be
  overridden by a CI variable. Secret files are removed once read; the ID tokens are not passed to run.mjs,
  record-oasis.sh or vtid-auto-close.cjs.
- Central scripts: a sparse, shallow clone of platform `main` with the job token (GitHub's STAGING-VERIFY checks out its
  runner from `main` the same way); deploy-class jobs use `GIT_STRATEGY: none`, so the commit under test is not even
  checked out there. `.record` installs `jq` when missing (record-oasis.sh needs it; the Node 20 image has none).
- `.notify-platform` calls the pipeline trigger API with `CI_JOB_TOKEN` from a deploy-class job (plan §3.2 lists "notify
  platform" there) instead of a `trigger:` bridge job; its variables `DISPATCH_EVENT_TYPE=regen-screens-catalog`,
  `DISPATCH_SOURCE_REPO`, `DISPATCH_SOURCE_SHA` mirror the repository dispatch payload, and its `changes` rule has the
  two paths of SCREENS-CATALOG-TRIGGER.yml.
- Resource groups: `staging-verify-${VERIFY_SERVICE}`, and `…-full` for the nightly run (as GitHub's `-full` concurrency
  group). GitLab sets oldest-first only through the API, so the template declares it in `.resource-groups` for the
  settings sync. Timeout 2h 15m: GitHub's 75 minutes plus the 60-minute shadow wait.
- RUN_URL is `CI_PIPELINE_URL` (GitHub: the workflow run URL). `results.json`'s own `run_url` stays null on GitLab,
  because run.mjs gets only the one new input.
- The verify wrapper writes `target.json` first; `.record` takes SERVICE/SHA from it (the nightly commit) and treats
  its absence, with no results.json, as "the verify job did not start" (GitHub skips the record step then too).
- `aws-secret.mjs` and its test are one more file pair than tasks V1/V3 name, inside the lane's `scripts/eng/verify/**`.
- `scope.json` lists the lane's paths, the lane file `.kiro/specs/agentic-delivery/lanes/verify-on-gitlab.md` (its
  state entries) and `docs/validation/VTID-05552/**`, narrower than the lane's `docs/validation/**`.
- The lane file is not changed in the first push. On main it says `seat: exafyltd` (the Project Manager's reassignment
  of 02:53Z/02:59Z), this builder is seat exafy (plan §9), Lane scope refuses a lane-file edit by a session of another
  seat, and the session's push guard refuses a push whose preflight fails. Lane `reseat` (VTID-05554, #4703) restores
  seat exafy; once it is on main and main is merged into this branch, the lane file's `ready → executing` entry (with
  `claimed_by`, `branch`, `pr:`) follows. A scratch simulation of exactly that passes every preflight check and merges
  the lane file without a conflict (outputs/preflight.txt).
- After #4690 landed, UNIT.yml's full command was run once more on the merged head (outputs/unit-all.txt), besides the
  lane's own tests, so the lane's `executing → in-review` entry ("every test green") rests on the command the `unit`
  check runs, the one check that was red before.
