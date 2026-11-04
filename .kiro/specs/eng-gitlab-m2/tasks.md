# Tasks — eng-gitlab-m2
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Branches `kiro/eng-gitlab-m2/<lane>`; PR titles
`VTID-xxxxx (eng-gitlab-m2/<lane>): …`; trailers `Collab-Session` and `Collab-Lane: eng-gitlab-m2/<lane>`; identity
`kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`. Node tests: `node --test scripts/eng/*.test.mjs
scripts/eng/testing/*.test.mjs` (dependency-free; `UNIT.yml` runs them on every PR). Lanes that add Terraform
(`fleet`, `settings`, `monitoring`) start when M1 lane `gitlab-infra` is `done`.

<!-- lane: gitlab-client -->
## Lane `gitlab-client` (vitana-platform)
- [ ] G1 Write `scripts/eng/gitlab-api.test.mjs` and `scripts/eng/testing/fake-fetch.test.mjs`; record them red on base.
- [ ] G2 `scripts/eng/gitlab-api.mjs`: `createClient`, `request`, `paginate`, retry with back-off, a safe error type.
- [ ] G3 `scripts/eng/testing/fake-fetch.mjs`: a recording fake `fetch` with route matching and call assertions.
- [ ] G4 Evidence: tests red then green; the `node --test` output.

**Acceptance**
- Change types: Tooling/docs.
- Outcome: the other lanes talk to GitLab and test every call without a network and without a token.
- States: 429 and 5xx retried with back-off and a cap; other 4xx not retried; an empty or non-JSON body handled; a
  timeout becomes an error, not a hang.
- Surfaces: callers are the settings sync, the merge bot, the metrics job and the rehearsal.
- Locales: n/a. Accessibility: n/a.
- Contract: `createClient` and `fakeFetch` as in plan §3.7; dependency-free Node 20; no token in any error, log line or
  thrown message (a test greps for it).
- Staging proof: not verified on staging: deploys nothing. Proven by its tests, then by the first real calls in the
  rehearsal.

<!-- lane: fleet -->
## Lane `fleet` (vitana-platform)
- [ ] F1 Write `scripts/eng/fleet-structure.test.mjs`; record it red on base.
- [ ] F2 `terraform/fleet.tf`: ASG, launch template, the two security groups, manager instance and role, cache bucket,
      runner-token secret, quota preconditions, variables and outputs.
- [ ] F3 `terraform/fleet-ami.tf` and `host/fleet-image/`: Image Builder component, recipe, infrastructure configuration.
- [ ] F4 `host/fleet-manager-install.sh`: pinned runner install, `gitlab-runner fleeting install`, wait for the token,
      render `config.toml`, start, log to `/var/log/vitana-bootstrap.log`.
- [ ] F5 `RUNBOOK-m2-fleet.md`: the quota commands, the apply, what to read when a job waits, how to drain the fleet.
- [ ] F6 Evidence: test red then green; `terraform fmt -check` and `terraform validate` on the tree with M1's `main.tf`;
      the monthly cost estimate from the AWS price list.

**Acceptance**
- Change types: Infrastructure/CI.
- Outcome: CI jobs run on throw-away machines that start with the queue and are deleted after one job; a job cannot
  reach AWS or the GitLab host's private address.
- States: spot interruption (the job is retried by the central CI); quota too low (the plan stops and prints the exact
  command); the image build fails (the apply stops, no half-built fleet); the runner token not there yet (the manager
  waits); the group at its maximum (jobs wait in the queue).
- Surfaces: `infra/gitlab-engineering/` and `scripts/eng/fleet-structure.test.mjs`; M1 files are not edited.
- Locales: n/a. Accessibility: n/a.
- Contract: plan §3.2 values exactly (names, sizes, limits, ports, tags, secret names).
- Staging proof: not verified on staging: separate AWS account, no product path. Proof: the structure test, the validate
  output, the owner's apply and rehearsal A1, A2.
- No secret or key in Git or in Terraform outputs; no stored SSH key; the job instance profile has no policy.

<!-- lane: settings -->
## Lane `settings` (vitana-platform)
- [ ] S1 Write `scripts/eng/gitlab-settings.test.mjs` and `scripts/eng/free-tier-guard.test.mjs`; record them red on base.
- [ ] S2 `settings/gitlab-settings.json` (schema version 1) with its README; `scripts/eng/gitlab-settings.mjs` (apply and
      `--check`).
- [ ] S3 `ci/` central CI files for `vitana-platform`, `vitana-v1` and `rehearsal`, with merge-request pipelines, retry and
      `interruptible`; synced into `vitana/ci-config` by the apply.
- [ ] S4 `host/ops-install.sh`, `host/units/vitana-settings.*` and `vitana-platform-sync.*`, `terraform/settings.tf` (the
      host role may write the agent, fleet-token and webhook secrets), `m2.sh` (`install`, `status`, `settings`,
      `rehearse`).
- [ ] S5 Documentation: amend `docs/ENGINEERING-PLATFORM-PLAN.md` (D2 becomes Free; the replacement table; every line that
      assumes Premium) and add `docs/ENGINEERING-PLATFORM-LICENCES.md` (each component, its licence, the file it was read from).
- [ ] S6 Evidence: tests red then green; a full apply against the fake GitLab (transcript); the diff of the document.

**Acceptance**
- Change types: Infrastructure/CI, Tooling/docs.
- Outcome: one file says who may do what in GitLab; GitLab is corrected to match it every 10 minutes; each agent seat has
  its own login; nothing needs a licence.
- States: GitLab unreachable (the run writes nothing and the next run retries); a token under 30 days left (rotated); a
  setting changed by hand (reported by `--check`, corrected at the next run); a licence key appears (the run stops with a
  loud message); the 100-account cap near (reported).
- Surfaces: the GitLab API, the three timers' host files, `m2.sh` for the owner, the document.
- Locales: n/a (English, like the plan). Accessibility: n/a.
- Contract: schema version 1 of plan §3.3; the secret names and host file paths of plan §3; `GET /license` handling.
- Staging proof: not verified on staging: separate account, no product path. Proof: tests against the fake GitLab, then the
  first real run (`m2.sh status`) and rehearsal A3, A7, A8.
- The document edit keeps every other decision, says what changed and why, and its links resolve; the licence list names
  the licence found in each component's own repository.

<!-- lane: merge-bot -->
## Lane `merge-bot` (vitana-platform)
- [ ] B1 Write `scripts/eng/gitlab-land.test.mjs` on temporary git repositories and the fake `fetch`; record it red on base.
- [ ] B2 `scripts/eng/gitlab-land.mjs`: `run`, `merge`, `status`, `--dry-run`; imports the `land-guard.mjs` and `queue.mjs`
      functions unchanged; exports `jobToCheckRun(job)` implementing the status table of plan §3.4 (every documented GitLab
      job status, `allow_failure`, unknown status fails closed) and the rule that a `required_jobs` name must map to `success`.
- [ ] B3 `host/units/vitana-land.service` and `.timer` with `flock`, `Nice`, `CPUQuota`, `MemoryMax`.
- [ ] B4 Evidence: tests red then green; a dry-run transcript; the table showing the same verdicts as `mergeDecision`;
      `git diff` showing `land-guard.mjs` and `queue.mjs` untouched.

**Acceptance**
- Change types: Tooling/docs, Integration.
- Outcome: a reviewed, green, up-to-date merge request lands by itself, one at a time, as exactly one commit with its VTID
  in the subject; an unreviewed, red, forged or protected-file one does not, and says why once.
- States: GitLab error half-way (nothing lands); the merge call refused (retried next tick); two ready (oldest first, one
  per tick); pipeline pending (waits up to 60 minutes); branch behind (updated, not landed in the same tick); a force-push
  after the review (the review no longer counts); a comment already written (not repeated).
- Surfaces: merge requests of the projects with `landing:true`; no human screen.
- Locales: n/a. Accessibility: n/a.
- Contract: plan §3.4, including its job-status table; the GitLab requests it makes (merge requests, pipelines and jobs,
  commits, project events, notes, merge) are listed in the test with their paths; the merge request is pinned by `sha`.
- Staging proof: not verified on staging: separate account, no product path. Proof: the tests and rehearsal A4.
- No token in a log line; any error lands nothing.

<!-- lane: scm-webhook -->
## Lane `scm-webhook` (vitana-platform)
- [ ] W1 Write `services/gateway/test/routes/internal-gitlab-webhook.test.ts` and the mapper tests; record them red on base.
- [ ] W2 Route `internal-gitlab-webhook.ts` (maps `webhook-id|timestamp|signature` to `verifySvix`'s `id|timestamp|signature`
      with `headerValue`; `webhook-signature.ts` is not edited), mapper under `services/gitlab-events/`, the five
      `CicdEventType` additions of plan §3.5 (`scm.gitlab.merge_request.opened|merged|closed`,
      `scm.gitlab.pipeline.succeeded|failed`), the mount in `index.ts` with `express.raw` before `express.json()`.
- [ ] W3 `AWS-STAGE-DEPLOY-GATEWAY.yml`: tolerant resolution of `vitana/gateway/staging/gitlab-webhook-signing-token` into
      `GITLAB_WEBHOOK_SIGNING_TOKEN` (absent: not wired, the deploy never fails; no `secrets.` in an `if:`).
- [ ] W4 `scripts/aws/setup-gitlab-webhook-secret.sh` (dry run by default; `--apply` copies the value from the engineering
      account).
- [ ] W5 `docs/validation/<VTID>/staging-tests.json` with the read-only probe; typecheck and the gateway tests.
- [ ] W6 Test that no rule of `autopilot-event-mapper.ts` lists a topic starting `scm.gitlab.` (so no GitLab event moves a
      VTID's state in this milestone) and that the route emits none of the existing `cicd.*` topics; the file itself is not
      edited. Record the result in the evidence.

**Acceptance**
- Change types: Backend, Integration, Infrastructure/CI.
- Outcome: when GitLab sends a signed event, the gateway records the matching OASIS event once; an unsigned, stale or
  replayed one is refused. Nothing changes for members.
- States: key missing (500 JSON `not_configured`); bad signature (401); stale timestamp (401); duplicate id (200, no second
  event); unknown event (202); malformed JSON (400); body too large (413).
- Surfaces: callers: GitLab project webhooks (from cutover). Consumers: the OASIS event feed only; the VTID lifecycle
  mapper and the Command Hub's reading of `cicd.*` topics are not changed, so no GitLab event moves a VTID.
- Locales: n/a (machine route). Accessibility: n/a.
- Contract: request headers `webhook-id`, `webhook-timestamp`, `webhook-signature`, raw JSON body; replies always JSON; no
  JWT, the signature is the gate; the five topics and the event-to-topic table of plan §3.5; `file:line` of the route, the
  mount and the verifier on both sides in the PR body.
- Staging proof: an unsigned `POST` answers JSON 401 or 500 `not_configured`, never 404 or HTML. Not verified on staging with
  a real event: it would write OASIS rows to the shared database; the mapper is covered by Jest and goes live at cutover.
- Sibling sweep: `AWS-PROD-DEPLOY-GATEWAY.yml` is intentionally unchanged (protected gate file; no hook exists before
  cutover). Say so in the PR body.

<!-- lane: monitoring -->
## Lane `monitoring` (vitana-platform)
- [ ] M1 Write `scripts/eng/monitoring-structure.test.mjs` and `scripts/eng/ci-metrics.test.mjs`; record them red on base.
- [ ] M2 `terraform/monitoring.tf`: SNS topic (KMS) with the e-mail subscription, the alarms of plan §3.6, the monthly
      budget, `cloudwatch:PutMetricData` for the host role.
- [ ] M3 `scripts/eng/ci-metrics.mjs`, `host/units/vitana-ci-metrics.*`, `host/ops.d/20-cwagent.sh` (disk metric).
- [ ] M4 Evidence: tests red then green; `terraform validate` output.

**Acceptance**
- Change types: Infrastructure/CI.
- Outcome: the owner gets an e-mail when CI is down, stuck, not backed up or over budget; a healthy system sends nothing.
- States: the metric job cannot read GitLab (it publishes a failure metric, never a zero); missing data counts as breaching
  for the heartbeat alarms and as not breaching for the queue alarms; an unconfirmed e-mail subscription is shown by
  `m2.sh status`.
- Surfaces: CloudWatch, SNS, the owner's inbox.
- Locales: n/a. Accessibility: n/a.
- Contract: names, thresholds and the namespace `Vitana/Engineering` of plan §3.6.
- Staging proof: not verified on staging: separate account. Proof: the structure tests and acceptance A6.

<!-- lane: rehearsal -->
## Lane `rehearsal` (vitana-platform)
- [ ] R1 Write `scripts/eng/rehearse.test.mjs`; record it red on base.
- [ ] R2 The seed under `infra/gitlab-engineering/rehearsal/seed/`: a tiny package with a passing test, the negative-control
      job scripts, a copy step for the collab tooling, a spec with 12 lanes. Required jobs are the jobs that exist in it.
- [ ] R3 `scripts/eng/rehearse.mjs` (plan §3.8): create content, open 12 merge requests from the four seat accounts, play
      the reviewer as `agent-reviewer`, wait for the bot, print the report; the safety refusals.
- [ ] R4 Evidence: tests red then green. After the owner's run the report is attached to the PR as the proof of A1–A4.

**Acceptance**
- Change types: Tooling/docs, Integration.
- Outcome: one command shows whether the whole path (agents, fleet, bot, `main`) works on a scratch project before any
  real repository depends on it.
- States: the project is not marked `rehearsal` or is mirrored or has a webhook (refuses to start); a job stuck (the report
  names it); the fleet does not scale (the report shows the ASG activity); the bot does not land (the report lists the
  reasons the bot gave).
- Surfaces: the project `vitana/rehearsal` and the ASG (read only); nothing else.
- Locales: n/a. Accessibility: n/a.
- Contract: plan §3.8 and the A1–A4 definitions of plan §9; the report format is documented in the script header.
- Staging proof: not verified on staging: the rehearsal is the verification. It never touches production, the gateway,
  Supabase or a real repository.
