# Tasks — agentic-delivery (the hard cutover)
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR, never by hand. Branches `kiro/agentic-delivery/<lane>`; PR
titles `VTID-xxxxx (agentic-delivery/<lane>): …`; trailers `Collab-Session` and `Collab-Lane: agentic-delivery/<lane>`;
identity `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/` (`land-guard.mjs evidence` before the first code
commit). Node tests are dependency-free and run with `node --test` (`UNIT.yml` runs `scripts/**/*.test.mjs` with no
install). Gateway tests: `cd services/gateway && npm run typecheck && npx jest test/delivery`. Cross-plan starts (plan
§9): `prerequisites` at once, and it lands before `gateway-delivery`, the `.record` job of `verify-on-gitlab` and
eng-gitlab-m2 `scm-webhook`; `pipelines` after eng-gitlab-m2 `settings`; `deploy-path` after eng-gitlab-m2 `fleet`; `merge-queue` after
eng-gitlab-m2 `merge-bot`; `github-bridge` after eng-gitlab-m2 `gitlab-client`; `gateway-delivery` after eng-gitlab-m2
`scm-webhook`; `verify-on-gitlab` at once, its template merging after eng-gitlab-m2 `settings`; `cutover` after the other
six and eng-gitlab-m2 `settings`. Every new test is recorded red on `origin/main` in `commands.log` before the code.

<!-- lane: prerequisites -->
## Lane `prerequisites` (vitana-platform)
- [ ] R1 Write and record red on base: `services/gateway/test/atlas-gitlab-route-claims.test.ts` (`domainsForRoute` of
      `internal-gitlab-webhook` and of `delivery` returns the atlas domain `deploy`; red on base, where neither is
      claimed) and `scripts/ci/staging-verify/record-oasis-workflow.test.mjs` (runs `record-oasis.sh` with a fake `curl`
      first on `PATH` that saves the body it is sent: without `WORKFLOW` the body is byte-identical to today's for the
      same `results.json` fixture, with `metadata.workflow: "STAGING-VERIFY.yml"`; with
      `WORKFLOW=gitlab:vitana/vitana-v1/staging-verify` the body differs only in `metadata.workflow`; the crashed-runner
      body behaves the same way; red on base for the `WORKFLOW` cases).
- [ ] R2 `services/gateway/src/orb/developer/domain-atlas.ts`: add `/^internal-gitlab-webhook$/` and `/^delivery$/` to
      the `routes` of domain `deploy`, nothing else. `scripts/ci/staging-verify/record-oasis.sh`: read `WORKFLOW` with the
      default `STAGING-VERIFY.yml` in both jq programs, nothing else.
- [ ] R3 `docs/validation/<VTID>/staging-tests.json`: the gateway smoke suite plus the atlas test as an `existing` test;
      evidence: tests red then green, `npm run test:roles` green, `node --test scripts/ci/staging-verify/` green.

**Acceptance**
- Change types: Backend, Tooling/docs.
- Outcome: the two route files the GitLab lanes add (`routes/internal-gitlab-webhook.ts` of eng-gitlab-m2 and
  `routes/delivery.ts` of this plan) pass the atlas drift guard when they land, and every STAGING-VERIFY row in OASIS
  says which host verified it, while GitHub's rows stay exactly as they are.
- States: `WORKFLOW` unset (today's value); set (that value); the crashed-runner path (same rule).
- Surfaces: callers of `domainsForRoute` (the developer assistant's deep dive and atlas tools); the drift test; the
  STAGING-VERIFY workflow (unchanged inputs); readers of `oasis_events` `staging.verify.*` (the PUBLISH gate reads topic,
  service and commit only, `publish-gate.ts:135`).
- Locales: n/a. Accessibility: n/a.
- Contract: the atlas entry shape of `domain-atlas.ts`; the `record-oasis.sh` environment of its header (lines 4-5) plus
  `WORKFLOW`; `npm run test:roles` stays green (CLAUDE.md NEVER 42h).
- Staging proof: the gateway smoke suite on the deployed staging build plus the atlas test as an `existing` test in
  `staging-tests.json`. The atlas has no read endpoint, so the claims are not otherwise observable on staging: not
  verified on staging beyond that; the drift test covers it. `record-oasis.sh` deploys nothing; its next real run is the
  next STAGING-VERIFY on GitHub, which must record the same body as before.

<!-- lane: pipelines -->
## Lane `pipelines` (vitana-platform)
- [ ] P1 Write and record red on base: `scripts/eng/pipeline-gen.test.mjs` (renders both project files from the service
      list; `--check` exits 3 on drift; each T1 check job has `rules: changes:` from its service paths; a shared path
      selects every check; `gate` needs every check with `optional: true`; governance jobs carry no path rule; no T1 job
      declares `id_tokens`, a secret or `include: local`; governance jobs come first; every test job is sharded so its
      fixture duration is under 4 minutes; dependencies use the lockfile-keyed cache; T1 jobs are tagged `vitana-eng` and
      interruptible; `main`
      pipelines are not interruptible; main-class and deploy-class tags as plan §3.2; `DELIVERY_MODE` defaults to
      `shadow`, and in shadow mode `.record`, `.vtid-close`, `.notify-platform` and every assist job are absent and no
      `env_overrides` are passed), `scripts/eng/affected-parity.test.mjs` (for each of the last 60 merged PRs of each
      repository in the fixtures, the selected checks cover every GitHub workflow that ran for it),
      `scripts/eng/services-parity.test.mjs` (platform service paths equal `config/service-path-map.json`; every path
      filter of the pull-request workflows of plan §2.2 maps to a service).
- [ ] P2 `config/delivery/services.json` (schema `vitana.delivery-services/v1`) and `config/delivery/README.md`: the
      vitana-v1 services (`community-app`, `mobile`, `edge-functions`, `sql`, `i18n`, `calendar`) and the vitana-platform
      services of `config/service-path-map.json`, with their checks taken from today's pull-request workflows, images,
      staging targets, STAGING-VERIFY service ids, the v1 preview kind, the assist rules `i18n-propagate` and
      `i18n-nightly`, and the gateway's `env_overrides` of plan §3.6 step 2.
- [ ] P3 `scripts/eng/pipeline-gen.mjs` (render and `--check`); `infra/gitlab-engineering/ci/tpl-checks.yml`
      (governance jobs `lane-scope`, `change-suite`, `pr-gate-report`, `collab-handoff`; the service checks; `gate`),
      `tpl-main.yml` (plan §3.6), `tpl-nightly.yml` (02:17 UTC, every check, full STAGING-VERIFY, the CI-HEALTH report
      rules), `tpl-assist.yml` (plan §3.9); the generated `v1-delivery.gitlab-ci.yml` and `platform-delivery.gitlab-ci.yml`,
      which include `tpl-deploy.yml` and `tpl-verify.yml` by the job names of plan §9.
- [ ] P4 Fixtures `scripts/eng/fixtures/{v1,platform}-pr-files.json` (file lists and the workflows that ran, read once
      through read-only `gh api` calls; the commands are in `commands.log`).
- [ ] P5 Evidence: tests red then green; `pipeline-gen.mjs --check` output; the two generated files.

**Acceptance**
- Change types: Infrastructure/CI, Tooling/docs.
- Outcome: one service list drives both repositories' pipelines. A merge request runs only the checks of what it
  changed, never fewer than GitHub ran for the same files. `main` runs every check once per landing; the nightly run
  adds the full STAGING-VERIFY.
- States: unknown path (every check); shared path (every check); documentation-only change (governance jobs and `gate`
  only); a failing check (`gate` does not run, so the merge request cannot land); generator drift (`--check` exits 3);
  `DELIVERY_MODE` unset (shadow).
- Surfaces: GitLab projects `vitana/vitana-v1` and `vitana/vitana-platform` through `vitana/ci-config`; callers: the M2
  settings sync (copies `infra/gitlab-engineering/ci/*.yml`) and the merge bot (required jobs `lane-scope`,
  `change-suite`, `gate`).
- Locales: n/a. Accessibility: n/a.
- Contract: the schema of plan §3.3 with `env_overrides`; the template and job names of plan §9; the runner tags of plan
  §3.2.
- Staging proof: not verified on staging: deploys nothing when merged. Proven by its tests and by lane `cutover`'s shadow
  pipelines (plan §8.1 step 3).
- Sibling sweep: every workflow that plan §2.2 disables at the cut has its jobs in a generated file (a test maps workflow
  names to job names).

<!-- lane: deploy-path -->
## Lane `deploy-path` (vitana-platform)
- [ ] D1 Write and record red on base: `scripts/eng/deploy/deploy-ecs.test.mjs` (from a fixture of a live task definition
      only the image digest, the commit variables and, in live mode, the service's `env_overrides` change; a service
      outside the allowlist of plan §3.10 is refused; a deploy that finds a newer descendant served ends `superseded` and
      writes nothing; a stabilise or stamp failure re-points to the captured revision; shadow mode makes no ECS write; it
      writes the deploy-runs file of the contract below), `scripts/eng/deploy/push-image.test.mjs` (outputs the digest;
      refuses a target outside the service's ECR repository), `scripts/eng/deploy/preview.test.mjs` (only the prefixes
      `mr-<iid>/` and `gl-main/`; teardown removes only its own prefix), `scripts/eng/gitlab-oidc-structure.test.mjs`
      (each trust policy: `StringEquals` on `aud`; `sub` pinned to the project paths and refs of plan §7; no `*`
      principal; each policy names only the resources of plan §7; no production role), and
      `scripts/eng/fleet-classes-structure.test.mjs` (two new groups with min 0 and single-use machines; the main class
      registered as a protected runner; IMDSv2 hop limit 1; no instance policy; egress 80, 443 and DNS only; the manager
      renders three runner blocks tagged `vitana-eng`, `vitana-eng-main`, `vitana-eng-deploy`, the untrusted block with
      `idle_count = 4` and the maxima of plan §5; seccomp and AppArmor
      unconfined only for the main class's build jobs; `privileged = false` everywhere).
- [ ] D2 `scripts/eng/deploy/build-image.sh` (rootless BuildKit, `--oci-worker-no-process-sandbox`, OCI archive),
      `push-image.mjs`, `deploy-ecs.mjs`, `preview.mjs` (AWS CLI and registry CLI behind an injectable runner, so tests
      need no network).
- [ ] D3 `infra/gitlab-engineering/ci/tpl-deploy.yml`: `.build-image`, `.push-image`, `.deploy-staging`,
      `.rollback-staging`, `.preview-upload`, `.preview-stop` (GitLab environment `review/mr-<iid>` with `on_stop`).
- [ ] D4 `infra/gitlab-engineering/terraform/fleet-classes.tf`; `host/fleet-manager-install.sh` renders one runner block
      per class.
- [ ] D5 `scripts/aws/iam/gitlab-oidc-*.json` (provider and the six roles of plan §7) and `scripts/aws/setup-gitlab-oidc.sh`
      (dry run by default; `--apply` for the owner; stops unless the account is `472838866351` and the region
      `eu-central-1`, CLAUDE.md IF–THEN 11; lists which secrets exist and which need a value);
      `scripts/eng/deploy/staging-tg-setup.sh` (dry run by default) sets the staging target groups' deregistration delay to
      30 seconds when the owner applies it (A1).
- [ ] D6 `infra/gitlab-engineering/RUNBOOK-delivery-aws.md`: owner steps A1 and A2 of plan §10, the secret list, how to
      read a failed deploy, how to drain a class.
- [ ] D7 Evidence: tests red then green; `terraform fmt -check` and `terraform validate` with the M1 and M2 files; the
      setup script's dry-run transcript; rootless builds of the vitana-v1 `Dockerfile` and `services/gateway` on the M2
      job image, or the recorded switch to rootless Buildah, with the cold and cached build times.

**Acceptance**
- Change types: Infrastructure/CI.
- Outcome: GitLab builds the images of both repositories without a privileged daemon, pushes them by digest, deploys
  them to staging, rolls back a deploy that does not serve, and publishes vitana-v1 merge-request previews, with
  short-lived AWS sign-in and no stored key.
- States: quota too low (the Terraform check prints the request); role missing (the job fails and names the role);
  superseded (nothing written); not stable or wrong stamp (rollback, job red); shadow mode (only `shadow-<sha12>` images
  and the `gl-main/` preview are written); a closed merge request (preview removed).
- Surfaces: GitLab deploy-class and main-class jobs; the staging ECR repositories and ECS services of plan §3.10;
  `s3://vitana-pr-previews`; the preview CloudFront distribution.
- Locales: n/a. Accessibility: n/a.
- Contract: roles, audiences, subjects and permissions of plan §7; job names of plan §9; the deploy-runs file
  `[{"service","sha","started_at","finished_at","outcome"}]` that lane `verify-on-gitlab` reads.
- Staging proof: not verified on staging at merge: nothing deploys on merge. Proven in lane `cutover`'s shadow run (the
  `gl-main/` preview, `shadow-<sha12>` images, rendered task definitions) and by the rehearsal's real staging deploys.
- No secret or key in git, Terraform outputs or logs; every trust policy pinned by `aud` and `sub`.

<!-- lane: verify-on-gitlab -->
## Lane `verify-on-gitlab` (vitana-platform)
- [ ] V1 Write and record red on base: `scripts/ci/staging-verify/deploy-runs.test.mjs` (with `--deploy-runs-file`,
      `run.mjs` makes no `gh` call and computes the same attribution cutoff as from the GitHub fixture; without it the
      GitHub path is unchanged and the existing staging-verify tests stay green), `scripts/eng/verify/vtid-close-env.test.mjs`
      (a squash commit with the plan §3.5 trailers maps to `PR_TITLE`, `PR_BODY`, `PR_HEAD_REF`, `PR_LABELS`, `PR_REF`; a
      `dev-autopilot/*` source branch and the `VTID_AUTO_CLOSE: no` line keep their meaning),
      `scripts/eng/verify/record-env.test.mjs` (GitLab variables map to the inputs of `record-oasis.sh`, which then builds
      the same body as on GitHub for the same `results.json`, except `metadata.workflow`, which names the GitLab job), `scripts/eng/verify/tpl-verify-structure.test.mjs`
      (`.staging-verify` on the main class with a `resource_group` per service, oldest first, not interruptible; `.record`
      and `.vtid-close` on the deploy class with the audiences of `gl-verify` and `gl-record`; the nightly run passes
      `full=true`), `scripts/eng/verify/shadow-wait.test.mjs` (in shadow mode the wrapper waits up to 60 minutes for
      staging to serve the commit, then runs `run.mjs`; if staging never serves it, the result is `not_comparable` and
      nothing is recorded).
- [ ] V2 `scripts/ci/staging-verify/run.mjs`: the `--deploy-runs-file` input (plan §3.6 step 3); nothing else changes.
- [ ] V3 `infra/gitlab-engineering/ci/tpl-verify.yml` (`.staging-verify`, `.record`, `.vtid-close`, `.notify-platform`)
      and the wrappers in `scripts/eng/verify/` (environment mapping, the shadow wait); `record-oasis.sh` and
      `vtid-auto-close.cjs` are not edited.
- [ ] V4 Evidence: tests red then green; `node --test scripts/ci/staging-verify/` green; a dry run of `run.mjs verify` for
      the gateway and the community app with deploy-runs fixtures and no network.

**Acceptance**
- Change types: Infrastructure/CI, Tooling/docs.
- Outcome: STAGING-VERIFY runs on GitLab for the gateway and the community app with the same suites, guard and outcome as
  on GitHub, writes the same OASIS rows the PUBLISH gate reads, and closes VTIDs with the same script.
- States: deploy-runs file missing on GitLab (the run fails closed and says why; it never falls back to GitHub); staging
  moved mid-run (superseded, as today); no production stamp (failed, as today); `record` without its secret (job red; the
  result stays in the artifact).
- Surfaces: GitHub STAGING-VERIFY (path unchanged until the cut); GitLab `main` and nightly pipelines; `oasis_events`;
  the reader `services/gateway/src/services/testing/publish-gate.ts:148`.
- Locales: n/a. Accessibility: n/a.
- Contract: the `record-oasis.sh` body (`scripts/ci/staging-verify/record-oasis.sh:28-59`; only `metadata.workflow` differs,
  lane `prerequisites`) and the `vtid-auto-close.cjs` inputs (`scripts/ci/vtid-auto-close.cjs:134-143`) unchanged; the deploy-runs file of lane `deploy-path`.
- Staging proof: not verified on staging at merge: deploys nothing. The unchanged GitHub path keeps passing on the next
  merges; the GitLab path is proven by lane `cutover`'s shadow run.

<!-- lane: merge-queue -->
## Lane `merge-queue` (vitana-platform)
- [ ] Q1 Write and record red on base: `scripts/eng/review-source.test.mjs` (temporary git repositories for the platform
      project and a vitana-v1 merge request: finds the accept for `<slug>/<lane>` on `main`, then on `kiro/<slug>/*`;
      refuses an entry `reviewCurrent` rejects for the merge request's commits, a reviewer session that appears on a
      merge-request commit, a model outside the chain, a `changes` verdict), `scripts/eng/gitlab-gates.test.mjs` (the
      `lane-scope` and `collab-handoff` wrappers call `scopeCheck` and `validateRange` with fetchers over a local platform
      clone and give the same verdicts as `queue.mjs` on the same inputs; an unreachable project fails closed),
      `scripts/eng/assist-trigger.test.mjs` (one `assist/<iid>-<rule>` per head and rule; never after an accept; never for
      a protected-file merge request), `scripts/eng/gitlab-land-queue.test.mjs` (revert and fix-main first while `main` is
      red, then the oldest accept; red `main` pauses the rest; a hot-file merge request waits for the previous hot-file
      STAGING-VERIFY result; the train builds up to 8 positions in queue order from `main` plus the first k merge
      requests, lands merge request k only when its position is green, every earlier position has landed and the
      `ci.skip` update's tree equals the tested tree, drops a failed or conflicting position and rebuilds the ones behind
      it; a `plan(` merge request lands only with `approved`, a `sparring_record` and a successful
      `gitlab/plan-spar` or GitHub PLAN-SPAR status on its head; the squash message starts with the VTID and has the six
      trailers; each queue label is set once per state).
- [ ] Q2 `scripts/eng/review-source.mjs`, `scripts/eng/gitlab-gates.mjs`, `scripts/eng/assist-trigger.mjs`; extend
      `scripts/eng/gitlab-land.mjs` (M2) with the review source, order, pause, the train of plan §3.5, plan merge
      requests, trailers, labels and assist trigger. `land-guard.mjs` and `queue.mjs` are not edited.
- [ ] Q3 Evidence: tests red then green; `git diff` showing `land-guard.mjs` and `queue.mjs` untouched; a dry run over the
      fake GitLab with 12 merge requests, three of them cross-repo vitana-v1 lanes and one a plan.

**Acceptance**
- Change types: Tooling/docs, Integration.
- Outcome: reviewed, green merge requests of both repositories land one at a time per repository in the right order; a
  red `main` stops normal landings until a fix or revert lands; each landing carries its review facts into the commit on
  `main`; a converged plan lands without a person.
- States: platform project unreachable (nothing lands); two accepts (the newest current one counts); accept on an old
  head (refused); `main` red (paused); hot file (waits); protected file (refused, one comment); assist pending (waits).
- Surfaces: merge requests of landing projects; GitLab labels and notes; the required jobs of the generated pipelines.
- Locales: n/a. Accessibility: n/a.
- Contract: `land-guard.mjs` functions unchanged (`reviewCurrent` :59, `checksVerdict` :85, `mergeDecision` :108);
  `queue.mjs` `scopeCheck` :912 and `validateRange` :779 unchanged; trailers, labels and assist refs of plan §3.5, §3.9.
- Staging proof: not verified on staging: it runs on the GitLab host in the engineering account. Proven by its tests and
  the dry run; live from the cut.

<!-- lane: github-bridge -->
## Lane `github-bridge` (vitana-platform)
- [ ] B1 Write and record red on base: `scripts/eng/github-bridge.test.mjs` on temporary git repositories and recording
      fakes of the GitHub and GitLab APIs: copies `kiro/*` and `claude/*` branches GitHub to GitLab and never `main`,
      `assist/*` or `pm-agent/*`; refuses a branch that already lives on GitLab with other history and reports it once;
      opens one merge request per open PR from a bridged branch with the same title, body and head, updates it on
      change, closes it when the PR closes; posts one `gitlab/<job>` commit status per job result on the GitHub commit
      and never duplicates it; closes the GitHub PR with a link after the merge request lands; pushes an assist commit to
      the GitHub branch with the bridge token only for a bridged branch; `--dry-run` writes nothing; any API error
      changes nothing for that branch and is retried at the next tick; no token in any log line.
- [ ] B2 `scripts/eng/github-bridge.mjs` (uses `scripts/eng/gitlab-api.mjs` of M2), the systemd units
      `vitana-github-bridge.{service,timer}` (every minute, `flock`), `RUNBOOK-github-bridge.md` (token scopes, how to
      read a refused branch, how to stop it).
- [ ] B3 Evidence: tests red then green; a dry run against both repositories' open PRs, read-only, with the planned
      actions printed.

**Acceptance**
- Change types: Integration, Infrastructure/CI.
- Outcome: an agent that can only push to GitHub keeps working after the cut: within about a minute its branch and PR
  appear on GitLab, its checks run there, it sees the results on GitHub, and the PR is closed with a link when the work
  lands.
- States: GitHub or GitLab API down (no change, retried); a branch with two writers (refused, reported); a PR from a fork
  (ignored); a PR closed without landing (merge request closed); a force-push to an agent branch (copied, the review rule
  decides whether the review still counts).
- Surfaces: the trusted GitLab host; GitHub PRs and commit statuses of both repositories; GitLab merge requests.
- Locales: n/a. Accessibility: n/a.
- Contract: branch rules and status names of plan §3.13; the token scopes of plan §7.
- Staging proof: not verified on staging: it runs in the engineering account and touches no product path. Proven by its
  tests and the dry run of plan §8.1 step 4.

<!-- lane: gateway-delivery -->
## Lane `gateway-delivery` (vitana-platform)
- [ ] G1 Write and record red on base (gateway Jest): `test/delivery/gitlab-delivery-mapping.test.ts` (a `main` pipeline
      event with the trailers gives one `delivery.landed`; the deploy job's status gives `staging.deploy.completed` or
      `.failed` with the commit, the rollback job `staging.deploy.rolled_back`; a queue label change gives
      `scm.gitlab.merge_request.updated`; pipeline running and canceled give `.started` and `.canceled`; the tags
      `delivery/cutover-<repo>` give `scm.migration.cutover`; shadow runs are marked `metadata.mode: shadow`; every event
      has a VTID or `BOOTSTRAP-DELIVERY`, `metadata.dedupe_key`, `plane: delivery` and `host: gitlab`; a duplicate key
      gives one row; a push gives `scm.gitlab.push` with the VTID of its branch's merge request; a pushed commit with
      `Collab-Verdict` gives one `delivery.review.recorded` and a commit that changes a lane file one
      `delivery.lane.updated`; no rule of `autopilot-event-mapper.ts` lists `scm.gitlab.*` or `delivery.*`),
      `test/delivery/delivery-host-guard.test.ts` (with `DELIVERY_HOST_<REPO>=gitlab`, `mergePullRequest` and
      `updatePullRequestBranch` for that repository make no GitHub call, return `merge_moved_to_gitlab` and emit one OASIS
      event; with the flag unset they behave exactly as before; `safeMerge` and the Project Manager's merge report the
      refusal as blocked, not as an error loop), `test/delivery/delivery-route.test.ts` (no token: 401 JSON; exafy_admin:
      the summary is built only from `vtid_ledger` and `oasis_events` fakes; queue order from labels; a metric without a
      source is `null`), `test/delivery/command-hub-delivery.test.ts` (the Delivery module is in `NAVIGATION_CONFIG`; its
      script has no inline script or style).
- [ ] G2 Mapping in `services/gateway/src/services/gitlab-events/**`; `services/delivery-host.ts` and the two guard calls
      in `services/github-service.ts`; the plan §3.11 topics and `delivery.merge.refused` added to `CicdEventType`;
      `routes/delivery.ts` (`/api/v1/delivery/summary`, `/api/v1/delivery/metrics`) mounted in `index.ts`; Command Hub
      `delivery.js`, its `NAVIGATION_CONFIG` entry, the regenerated `navigation-config.js` and
      `specs/dev-screen-inventory-v1.json`, and the `?v=` bump in `index.html` (CLAUDE.md IF–THEN 25).
- [ ] G3 `docs/validation/<VTID>/staging-tests.json`: on the staging gateway, `GET /api/v1/delivery/summary` without a
      token answers 401 `application/json`; `/command-hub/` loads `delivery.js`; an unsigned
      `POST /api/v1/internal/gitlab/webhook` answers JSON 401 or 500 `not_configured`, never 404 or HTML.
- [ ] G4 Evidence: typecheck; the new suites, `npm run test:operator` and `npm run test:support` green; screenshots of the
      Delivery module at 1400×900 and 390×844 with fixture data, viewed.

**Acceptance**
- Change types: Backend, Integration, UI.
- Outcome: every GitLab delivery step appears once in OASIS with its VTID; after the cut the gateway never merges on
  GitHub and says why; the owner opens Command Hub → Delivery and sees both repositories' merge queues, pipelines and the
  latest staging verification, read only from the ledger and OASIS.
- States: no events yet (empty state); route error (inline error with retry); slow response (loading state); unknown
  GitLab event (202, ignored); duplicate (one row); shadow events (marked and filterable); flag unset (no change in
  behaviour).
- Surfaces: Command Hub at desktop and phone widths; route caller: the Command Hub; webhook callers: the two project
  webhooks to the staging gateway; guard callers: `safeMerge`, the Project Manager, Dev Autopilot's watcher.
- Locales: the Command Hub is an English admin surface like its other modules; no member-visible text.
- Accessibility: named tabs and tables, keyboard order, visible focus, AA contrast (ALWAYS 40).
- Contract: route auth (exafy_admin or service token) and JSON shapes; the topics in `CicdEventType`
  (`services/gateway/src/types/cicd.ts:139`); the M2 signature check unchanged; the guard's return value; `file:line` of
  route, mount, guard and mapper in the PR body.
- Staging proof: the `staging-tests.json` probes above on the deployed staging gateway, and the Delivery module rendering
  on the staging Command Hub. The guard switches on with the cut's first GitLab deploy (plan §8.2 step 7).

<!-- lane: cutover -->
## Lane `cutover` (vitana-platform)
- [ ] C1 Write and record red on base: `scripts/eng/gitlab-settings-cutover.test.mjs` (a project with a cutover block
      keeps the `mirror` profile until the instance marker exists, then converges to `native` with landing, the required
      jobs `lane-scope`, `change-suite` and `gate`, webhook events including pushes and tag pushes, the push mirror of protected
      branches to GitHub with divergent refs kept, protected `assist/*`, "skipped pipelines are considered successful" and
      `DELIVERY_MODE=live`; removing the marker
      converges back; a second run writes nothing), `scripts/eng/github-workflows.test.mjs` (the list covers all 159
      workflow files of both repositories with one action each, `disable` or `keep`; every `keep` file has no
      `pull_request` trigger except PLAN-SPAR and MIGRATION-DRIFT-CHECK and never pushes to `main`; the only `keep` file
      that a push to `main` starts and that deploys production is DEPLOY-CLOUDFLARE-WORKERS, with its `cloudflare/**`
      path filter; it matches plan §2.2),
      `scripts/eng/delivery-cutover.test.mjs` (with fake GitHub and GitLab: `status` prints every checklist item of plan
      §8.1, including the §5 targets for first result and required checks measured on the shadow pipelines, and
      `apply` runs the steps of plan §8.2 in order and stops at the first failure with nothing half-done for that
      step; `--dry-run` writes nothing; `delivery-rollback.sh` reverses them), `scripts/eng/parity-report.test.mjs` (pairs
      GitHub results and GitLab jobs by SHA through the workflow-to-job map, lists every unexplained difference, counts a
      commit staging never served as not comparable), `scripts/eng/delivery-metrics.test.mjs` (the fields of
      `vitana.delivery-metrics/v1` from fixture rows; `null` when a source is missing).
- [ ] C2 `infra/gitlab-engineering/settings/gitlab-settings.json`: both projects point at their generated pipeline files
      (shadow), webhooks on, the cutover block; `scripts/eng/gitlab-settings.mjs` (M2): conditional profiles.
- [ ] C3 `scripts/eng/delivery-cutover.sh` (`status`, `rehearse`, `apply`; dry run by default; checks account and region;
      tokens typed hidden, never written), `scripts/eng/delivery-rollback.sh`, `scripts/eng/parity-report.mjs`,
      `scripts/eng/delivery-metrics.mjs`, `scripts/eng/github-workflows.json`.
- [ ] C4 `infra/gitlab-engineering/RUNBOOK-cutover.md` (owner steps A3 to A5 and B1, the timeline of plan §8, the
      rollback); `.kiro/pipeline/driver.md` and `.kiro/pipeline/lane-land.md`: after the cut tag of a repository, the
      merge bot lands; the driver waits for `delivery.landed` instead of merging.
- [ ] C5 After merge: the shadow evidence (first `gl-main/` preview deploy, first shadow STAGING-VERIFY of each service,
      parity over at least 10 commits per repository) in the lane log; then the rehearsal and the cut with the owner, and
      the first `delivery-metrics.json`.

**Acceptance**
- Change types: Infrastructure/CI, Tooling/docs.
- Outcome: the owner moves both repositories' delivery to GitLab with one command once the checklist is green, and can
  move it back with one command; open PRs keep working through the bridge.
- States: checklist not green (`apply` refuses and names the item); marker set (native); marker removed (back); wrong
  account (the script stops); an API error mid-step (that step stops, nothing half-done); re-run (no change).
- Surfaces: the settings sync on the GitLab host; GitHub settings of both repositories through the owner's script; the
  owner's CloudShell; Command Hub Delivery (events); the pipeline runbooks agents read.
- Locales: n/a. Accessibility: n/a.
- Contract: the cutover block of the settings file; the workflow list JSON; the tags `delivery/cutover-<repo>`; schema
  `vitana.delivery-metrics/v1`.
- Staging proof: the shadow pipelines this lane switches on deploy a non-production path to staging (the `gl-main/`
  preview, `shadow-<sha12>` images, rendered task definitions) and run STAGING-VERIFY read-only on the commit GitHub
  verified. The lane is `done` when the first such run passed for each service and its link is in the lane log.

<!-- lane: reseat -->
## Lane `reseat` (vitana-platform; late lane, `lane_admin`)
- [ ] S1 Claim `agentic-delivery/reseat` with a seat `exafy` session that is not the plan driver; branch
      `kiro/agentic-delivery/reseat` from `origin/main`. List the open PRs that touch the eight target lane files
      (REST `gh api`), and record them.
- [ ] S2 In each of the eight target lane files (`prerequisites`, `pipelines`, `deploy-path`, `verify-on-gitlab`,
      `merge-queue`, `github-bridge`, `gateway-delivery`, `cutover`) change only `seat: exafyltd` to `seat: exafy`.
      Nothing else in a target changes: `state`, `next_actor`, `depends_on`, `executor`, `reviewer_seat`, `paths`,
      `vtid`, `updated`, `claimed_by` and every log line stay byte-identical.
- [ ] S3 Evidence `docs/validation/<VTID>/`: `scope.json`, `plan-sparring.md` (the converged record of this plan),
      `acceptance.md` (AC- entries each followed by a TEST: line within 12 lines), `commands.log`, `outputs/`, no
      `staging-tests.json` if `run.mjs check-pr` says nothing deploys. Save under `outputs/`: `queue.mjs validate` and
      `scope-check` for this lane against `origin/main`; `node --test scripts/collab/queue.test.mjs`; a negative proof
      on a scratch branch (never pushed): the same seat edit from a lane without `lane_admin` is refused by Lane scope;
      a positive proof: after a trial merge of this branch into the head of #4690, Lane scope passes for its builder's
      lane-file commits; preflight.

**Acceptance**
- Change types: Tooling/docs.
- Outcome: the eight lanes of plan agentic-delivery belong to seat `exafy` again, as plan §9 says, so the plan
  driver's builders of seat `exafy` can bring their lane PRs up to date with `main` and keep Lane scope green; the
  open lane PRs #4689 and #4690 keep their work.
- States: a target lane `ready` (only the seat changes); a target `in-review` on its own branch with a claim held
  (`main`'s copy changes only the seat line, so merging `main` into that branch conflicts at most on the lines the
  PM changed before); the same edit from a lane without `lane_admin` (refused).
- Surfaces: PR-GATE Collab handoff and Lane scope (`queue.mjs validate`, `scope-check`) for this PR and for the later
  lane PRs of this plan; the Project Manager's reassign rule (`decide.ts:227-283`), which reads the seat.
- Locales: n/a (developer-facing). Accessibility: n/a.
- Contract: the diff of each target lane file is exactly one line (`seat:`); no governance path, protected gate file,
  code or migration in the PR; `lane_admin` is not edited and this lane's own file is not in its `paths`.
- Staging proof: not verified on staging: deploys nothing. Proven by `queue.mjs validate`/`scope-check` on the PR and the
  trial merge into #4690's head.

<!-- lane: nav-paths -->
## Lane `nav-paths` (vitana-platform; late lane, `lane_admin`)
- [ ] N1 Claim `agentic-delivery/nav-paths` with a seat `exafy` session that is not the plan driver; branch
      `kiro/agentic-delivery/nav-paths` from `origin/main`.
- [ ] N2 In `.kiro/specs/agentic-delivery/lanes/gateway-delivery.md` add exactly four entries to `paths`:
      `services/gateway/src/navigation/data/command-hub-screens.json`,
      `services/gateway/src/navigation/data/nav-embeddings.bin`,
      `services/gateway/src/navigation/data/nav-embeddings.json`, `scripts/ci/command-hub-ownership-guard.js`. Nothing else
      in the target changes (`state`, `seat`, `executor`, `reviewer_seat`, `vtid`, `updated`, `claimed_by`, every log line).
      Mechanism and precedent: `laneAdminCovers` (`scripts/collab/queue.mjs`) lets a trusted `lane_admin` lane change a
      target's permission fields; lane `say-hello-lane-reassign/reassign` (VTID-05410, `ee1d363dd2`) added four `paths` to
      `new-member-welcome/say-hello-composer` the same way.
- [ ] N3 Evidence `docs/validation/<VTID>/`: `scope.json`, `plan-sparring.md`, `acceptance.md` (AC- entries each followed by a
      TEST: line within 12 lines), `commands.log`, `outputs/`: `queue.mjs validate` and `scope-check` for this lane; a byte
      check that the target differs only by the four lines; a positive proof on a scratch branch (never pushed): with this
      change on main, a commit of lane gateway-delivery that changes the four files passes Lane scope; a negative proof: the
      same commit fails Lane scope on today's main.

**Acceptance**
- Change types: Tooling/docs.
- Outcome: lane `gateway-delivery` can land its Delivery screen together with the voice-navigation entries, the stored
  vectors and the ownership-guard line it needs, in one green PR.
- States: the target lane `ready` on main with a claim held on its branch (only the `paths` block changes on main);
  the four files changed by another lane (refused, as before).
- Surfaces: PR-GATE Collab handoff and Lane scope for this PR and for lane gateway-delivery's PR.
- Locales: n/a. Accessibility: n/a.
- Contract: the target diff is exactly four added `paths` lines; no governance path, protected gate file or code in the PR;
  `lane_admin` and this lane's own `paths` are unchanged.
- Staging proof: not verified on staging: deploys nothing. Proven by Collab handoff and Lane scope and the two proofs.

<!-- lane: sv-cwd -->
## Lane `sv-cwd` (vitana-platform; late lane, fix forward of STAGING-VERIFY)
- [ ] V1 Claim `agentic-delivery/sv-cwd` with a seat `exafy` session that is not the plan driver; branch
      `kiro/agentic-delivery/sv-cwd` from `origin/main`.
- [ ] V2 Record red: the `existing` refs of `docs/validation/VTID-05515/staging-tests.json`, `VTID-05516` and `VTID-05518`,
      run the way `scripts/ci/staging-verify/run.mjs` runs them without `cwd` (from the repository root), fail; cite the
      STAGING-VERIFY runs 42078889519 and 42098033490 where they are the only failures.
- [ ] V3 Add `"cwd": "services/gateway"` to the `existing` test of each of the three manifests, nothing else; record green:
      the same refs run from `services/gateway` pass, `lib.validateManifest` accepts each manifest, and
      `node --test scripts/ci/staging-verify/` (every test file) stays green.
- [ ] V4 Evidence `docs/validation/<VTID>/` (`scope.json`, `plan-sparring.md`, `acceptance.md`, `commands.log`, `outputs/`).

**Acceptance**
- Change types: Tooling/docs.
- Outcome: the next gateway STAGING-VERIFY runs the suites of VTID-05515, VTID-05516 and VTID-05518 in the gateway folder,
  where they pass, so a gateway merge of this plan can reach a passed STAGING-VERIFY.
- States: a manifest whose ref names `test/…` paths and has no `cwd` (fails from the root); with `cwd` (passes).
- Surfaces: STAGING-VERIFY for the gateway (`run.mjs` `runExisting`, `run.mjs:298-306`); the three manifests.
- Locales: n/a. Accessibility: n/a.
- Contract: the manifest schema of `scripts/ci/staging-verify/lib.cjs` (`validateManifest`, the `existing` kind with an
  optional repo-relative `cwd`); each manifest diff is one added `"cwd"` line.
- Staging proof: the next gateway STAGING-VERIFY on a commit that contains this change (the merge of a later gateway lane),
  linked in the lane log; until then the local runs above.

<!-- lane: cut-settings -->
## Lane `cut-settings` (vitana-platform; late lane, after `cutover`)
- [ ] C1 Claim `agentic-delivery/cut-settings` with a seat `exafy` session that is not the plan driver. Read the settings file and sync script as lanes eng-gitlab-m2 `settings` and `cutover` leave
      them (prepare on a scratch base of their trees if they are not on main yet; push only after `cutover` is on main).
- [ ] C2 Tests first, red on that base (`scripts/eng/gitlab-settings-delivery.test.mjs`, the fake GitLab of
      `scripts/eng/testing/fake-fetch.mjs`): the sync creates or keeps the `bot-assist` service account (Developer on
      vitana-v1 only) and writes its token as the protected, masked CI variable `ASSIST_PUSH_TOKEN` of vitana-v1, rotated
      with the other tokens (plan §3.9); creates the pipeline schedules the generated pipelines need (the nightly and T3
      jobs of lane pipelines, read from its files); sets `process_mode: oldest_first` on the resource groups that
      `tpl-verify.yml` `.resource-groups` lists; allows the vitana-v1 job token to read vitana-platform and the reverse where
      the templates need it; sets the maximum artifact size the image archives need (lane deploy-path: at least 2 GB);
      lets `bot-land` push `assist/*` (plan §3.9) and keeps `train/*` unprotected (plan §3.5). creates the GitHub bridge's
      GitLab account (Developer on both projects; scopes api, write_repository) and writes its token to
      /etc/vitana/gitlab-bridge-token on the host, as for bot-land (RUNBOOK-github-bridge.md); A second run writes nothing;
      `--check` exits 3 on drift; nothing is printed that holds a token.
- [ ] C3 Implement in `scripts/eng/gitlab-settings.mjs` and `infra/gitlab-engineering/settings/gitlab-settings.json` only;
      any item that lanes `settings` or `cutover` already apply is recorded and not built twice.
- [ ] C4 Evidence `docs/validation/<VTID>/`; a dry run over the fake GitLab with both projects.

**Acceptance**
- Change types: Integration, Infrastructure/CI.
- Outcome: after the cut the assist jobs can push, the nightly and T3 pipelines run on schedule, STAGING-VERIFY runs
  oldest first, the platform scripts are readable from vitana-v1 jobs, image archives fit, and the merge bot can move its
  `assist/*` and `train/*` refs.
- States: GitLab API down (nothing changes, retried); a token near expiry (rotated); a setting already right (no write);
  drift (`--check` exit 3).
- Surfaces: the trusted GitLab host (the settings sync timer); both GitLab projects.
- Locales: n/a. Accessibility: n/a.
- Contract: the settings file schema of lane eng-gitlab-m2 `settings`; the job names, schedules and resource groups of lanes
  pipelines and verify-on-gitlab; the GitLab REST endpoints used, with file:line on both sides.
- Staging proof: not verified on staging: runs on the GitLab host in the engineering account. Proven by its tests and the
  dry run; live from the cut.

<!-- lane: build-class-retag -->
## Lane `build-class-retag` (vitana-platform; late lane)
- [ ] B1 Claim `agentic-delivery/build-class-retag`; branch `kiro/agentic-delivery/build-class-retag` from `origin/main` (after the VTID is on main).
- [ ] B2 Red first: a test in `pipeline-gen.test.mjs` shows the five `build-image:*` jobs tag `vitana-eng-main`; record it in `docs/validation/VTID-05546/outputs/`.
- [ ] B3 Set the build-job tag to `vitana-eng-build` in `pipeline-gen.mjs` (the line that sets `tags` for `build-image:${svc}`).
- [ ] B4 Regenerate `platform-delivery.gitlab-ci.yml` and `v1-delivery.gitlab-ci.yml` with `node scripts/eng/pipeline-gen.mjs`; `--check` exits 0.
- [ ] B5 Green: deploy-path's `fleet-classes-structure.test.mjs` test 14 passes against the regenerated files.
- [ ] B6 Validate and scope-check exit 0; PR; reviewer agent; merge under §7b after the merge gate above.

<!-- lane: build-class-retag-2 -->
## Lane `build-class-retag-2` (vitana-platform; late lane, replaces build-class-retag)
- [ ] R1 Claim `agentic-delivery/build-class-retag-2` after its VTID is on main; branch `kiro/agentic-delivery/build-class-retag-2` from `origin/main`.
- [ ] R2 Red first: test 14 of `fleet-classes-structure.test.mjs` and a generator test show the five `build-image:*` jobs on `vitana-eng-main`; save under `docs/validation/VTID-<new>/` and `docs/validation/VTID-05546/`.
- [ ] R3 Set the build-job tag to `vitana-eng-build` in `pipeline-gen.mjs`; update the main-class classification in its test.
- [ ] R4 Regenerate both CI files with `node scripts/eng/pipeline-gen.mjs`; `--check` exits 0; the diff is the five tags.
- [ ] R5 Green: the generator tests pass; deploy-path test 14 passes against the regenerated files (naming check is deploy-path's, step 5).
- [ ] R6 Validate and scope-check exit 0; PR; reviewer agent; merge under §7b after the merge gate.
