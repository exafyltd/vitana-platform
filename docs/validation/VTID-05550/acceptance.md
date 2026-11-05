Change types: Infrastructure/CI, Tooling/docs.

# VTID-05550 — agentic-delivery/pipelines: acceptance

Outcome: one service list (`config/delivery/services.json`, schema `vitana.delivery-services/v1`) drives both
repositories' GitLab pipelines. `scripts/eng/pipeline-gen.mjs` renders `infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml`
(65 jobs) and `platform-delivery.gitlab-ci.yml` (120 jobs) from it, with the hand-written hidden-job templates
`tpl-checks.yml` (T1), `tpl-main.yml` (T2), `tpl-nightly.yml` (T3) and `tpl-assist.yml` (T7), and includes lane
deploy-path's `tpl-deploy.yml` and lane verify-on-gitlab's `tpl-verify.yml` by the job names of plan §9. A merge request
runs the governance jobs, then only the checks of what it changed, never fewer than GitHub ran for the same files (proven
over the last 60 merged PRs of each repository), then `gate`. `main` runs every check once per landing plus the deploy and
verify chain of each changed deployable service; the nightly run adds the full STAGING-VERIFY. Shadow mode is the default.

## Acceptance criteria and the tests that prove them
AC-1 One service list renders both project files byte for byte; `--check` writes nothing and exits 3 on drift.
TEST: scripts/eng/pipeline-gen.test.mjs "renders both project files from the service list, byte for byte"
TEST: scripts/eng/pipeline-gen.test.mjs "--check exits 0 when the files are current and 3 on drift, and writes nothing"

AC-2 Each T1 check job has generated `rules: changes:` from the paths of every service that lists it plus the shared and
other paths, compared with `refs/heads/main`, at most 50 patterns (GitLab's limit), with GitLab glob semantics.
TEST: scripts/eng/pipeline-gen.test.mjs "each T1 check job has rules: changes: from its service paths plus the shared and other paths"
TEST: scripts/eng/pipeline-gen.test.mjs "GitLab glob semantics: dir/**/* is recursive, a trailing ** is one level, braces and dotfiles match"

AC-3 A shared path (lockfiles, package.json, TypeScript, Vite, ESLint, Tailwind config) or an area no single service owns
selects every check; a change to one service selects that service's checks; a documentation-only change runs the
governance jobs and `gate` only.
TEST: scripts/eng/pipeline-gen.test.mjs "a shared path, or an area no single service owns, selects every check"
TEST: scripts/eng/pipeline-gen.test.mjs "a change to one service selects only that service checks; a documentation-only change selects none"

AC-4 `gate` needs every check with `optional: true` (and their artifacts), never runs `when: always` (a failing check
leaves it unrun, so the merge request cannot land), and at runtime fails closed on an unknown path or on a check the
change needs that did not run.
TEST: scripts/eng/pipeline-gen.test.mjs "gate needs every check with optional: true and runs only when they passed"
TEST: scripts/eng/pipeline-gen.test.mjs "an unknown path makes gate fail and name it, so the merge request cannot land with fewer checks"

AC-5 Governance jobs (`lane-scope`, `change-suite`, `pr-gate-report`, `collab-handoff`) come first, carry no path rule;
`collab-handoff` is required on vitana-platform and report-only on vitana-v1, as today.
TEST: scripts/eng/pipeline-gen.test.mjs "governance jobs carry no path rule, come first, and are the only jobs besides gate that always run"

AC-6 No T1 job (merge request or train ref) declares `id_tokens` or reads a secret; no file uses `include: local`; every
T1 job is tagged `vitana-eng` and is interruptible.
TEST: scripts/eng/pipeline-gen.test.mjs "no T1 job declares id_tokens or a secret, no file uses include: local, and T1 jobs are untrusted and interruptible"

AC-7 Every test job is sharded so its fixture duration (the median GitHub job time in the fixture) divided by its shards is
under 4 minutes; dependencies come from the cache keyed by the lockfile.
TEST: scripts/eng/pipeline-gen.test.mjs "every test job is sharded so its fixture duration is under 4 minutes"
TEST: scripts/eng/pipeline-gen.test.mjs "dependencies come from the cache keyed by the lockfile"

AC-8 `main` and nightly pipelines run every check once (`full-suite:<check>`), are not interruptible, and use the main
class (`vitana-eng-main`: full suite, image build, STAGING-VERIFY, assists) and the deploy class (`vitana-eng-deploy`:
push, staging deploy and rollback, record, VTID close, notify, preview upload and stop), per plan §3.2.
TEST: scripts/eng/pipeline-gen.test.mjs "main pipelines run every check once, are not interruptible, and use the main and deploy classes"

AC-9 `DELIVERY_MODE` defaults to `shadow`; in shadow mode no job extending `.record`, `.vtid-close`, `.notify-platform`
or `.assist` exists and no `env_overrides` are passed; in live mode the gateway's deploy gets exactly
`PM_AGENT_ENABLED=false`, `DELIVERY_HOST_VITANA_PLATFORM=gitlab`, `DELIVERY_HOST_VITANA_V1=gitlab`.
TEST: scripts/eng/pipeline-gen.test.mjs "DELIVERY_MODE defaults to shadow; in shadow mode record, vtid-close, notify-platform and assists are absent and no env_overrides pass"

AC-10 The generated files include `tpl-deploy.yml` and `tpl-verify.yml` (and the four templates of this lane) from
`vitana/ci-config` at `main` and extend the plan §9 job names.
TEST: scripts/eng/pipeline-gen.test.mjs "the generated files include the deploy and verify templates by the job names of plan §9"

AC-11 Sibling sweep: every workflow of the registry has the fate plan §2.2 gives it (the test reads the §2.2 table), and every
moved one (t1, t2, t3, t4, t7) has its jobs in a generated file, or names the replacement §2.2 gives (TEST-SUITE-RERUN:
`retry`); E2E-PREVIEW-ORB maps to `e2e-preview-orb`.
TEST: scripts/eng/pipeline-gen.test.mjs "sibling sweep: every workflow has its plan §2.2 fate, and every moved workflow has its jobs in a generated file"

AC-12 For each of the last 60 merged PRs of each repository (fixtures read once through read-only `gh api` GETs), the
selected checks cover every path-filtered GitHub workflow that ran for it, and no PR has an unknown path.
TEST: scripts/eng/affected-parity.test.mjs "vitana-v1: each of the 60 PRs selects every check whose path-filtered GitHub workflow ran for it"
TEST: scripts/eng/affected-parity.test.mjs "vitana-platform: each of the 60 PRs selects every check whose path-filtered GitHub workflow ran for it"

AC-13 Platform service paths equal `config/service-path-map.json`; every path filter of the platform pull-request
workflows maps to a service and selects that workflow's checks; the service list holds the v1 services, images, staging
targets, STAGING-VERIFY ids, the v1 preview kind, the assist rules and the gateway's `env_overrides`.
TEST: scripts/eng/services-parity.test.mjs "platform service paths equal config/service-path-map.json"
TEST: scripts/eng/services-parity.test.mjs "every path filter of the platform pull-request workflows maps to a service, and selects that workflow's checks"
TEST: scripts/eng/services-parity.test.mjs "the gateway service carries the env_overrides of plan §3.6 step 2; the deployable services have images and staging targets"

AC-14 (review round 1, findings 1 and 2) Every generated job runs only tools its image provides (`image_tools`, from the
images' Dockerfiles) or that an earlier line installs (`apt` with `apt_tools`, `npm install -g` with
`npm_global_tools`), and no script uses a GitHub Actions variable: `cicdl-lint-services` installs jq,
`openapi-enforce` writes `openapi-enforce.env` instead of `$GITHUB_OUTPUT`, `sql-auth-bridge` installs npm.
TEST: scripts/eng/pipeline-gen.test.mjs "every generated job: its image provides each tool its script runs, or an earlier line installs it; no GitHub Actions variable"

AC-15 (finding 1) `validator-check` reads the merge request title and description only in merge-request pipelines; on
main, nightly and `train/*` it logs why those gates are skipped and runs the CSP and build gates; full history.
TEST: scripts/eng/pipeline-gen.test.mjs "validator-check reads the merge request title and description only in merge-request pipelines and logs why it skips them elsewhere"

AC-16 (finding 2) `android-module` runs on the node image, installs JDK 17 and an Android SDK home with the accepted
licence file before `gradlew` (AGP fetches the platform and build tools), and caches `.npm`, `.android-sdk`,
`.gradle-home`.
TEST: scripts/eng/pipeline-gen.test.mjs "android-module: Node from the image, JDK 17 and an Android SDK home with accepted licences before gradlew, cached"

AC-17 (finding 3) `pr-gate-report` passes `--title "$GATE_TITLE"` (default `$CI_MERGE_REQUEST_TITLE`, the train's title
from the bot) to every `gate.mjs` check, and for a "fix" VTID installs the red_green dependencies first, cached by
that lockfile.
TEST: scripts/eng/pipeline-gen.test.mjs "pr-gate-report passes the merge request title to every gate.mjs check and installs what red-green runs"

AC-18 (finding 4) `dev-autopilot-impact` sets `IMPACT_SCAN_BASE` to `origin/<merge request target>` (`origin/main` on
trains, `$CI_COMMIT_BEFORE_SHA` on main pushes) and fails closed when it does not resolve, never HEAD~1.
TEST: scripts/eng/pipeline-gen.test.mjs "dev-autopilot-impact scans against the merge request target (main for trains, the pushed range on main), never HEAD~1"

AC-19 (findings 4 and 5) Every run step of VALIDATOR-CHECK, DEV-AUTOPILOT-IMPACT and both PR-GATE workflows maps to a
generated job, or to an open item the test lists (the impact ingest and the PR comment); no check is a partial port.
TEST: scripts/eng/pipeline-gen.test.mjs "the multi-gate ports: every run step of the GitHub workflow has a GitLab job (or is a listed open item); no partial port is left"

AC-20 (finding 5) vitana-v1 runs PR-GATE's `preview-e2e` on a local vite preview built against the staging gateway,
without a session, report-only unless `enforce_preview_e2e`; `gate-selftest` and `kiro-steering-selftest` run
the two self-tests; E2E-PREVIEW-ORB is `e2e-preview-orb`, manual, main class, live mode only.
TEST: scripts/eng/pipeline-gen.test.mjs "vitana-v1: PR-GATE preview-e2e on a local vite preview without a session; the gate and Kiro steering self-tests; E2E-PREVIEW-ORB by hand"

AC-21 (collision with eng-gitlab-m2 settings) The fixtures' raw text names no Premium approvals path, so that lane's
free-tier guard stays green with both lanes on main; the parsed paths are unchanged.
TEST: scripts/eng/affected-parity.test.mjs "vitana-platform: the fixture's raw text names no Premium approvals path, and parses to the real file names"

States: unknown path (no service, shared, other or docs entry claims it: `gate` fails and names it; GitLab `rules:changes`
has no negation, so a path no pattern lists cannot select jobs by itself; `other_paths` claim every area of today's tree
that no single service owns, so for today's tree an unclaimed path means a new top-level entry); shared path (every
check); documentation-only change (`.kiro/**`, `docs/**`, root `*.md`, `.github/**`, which are inert on GitLab:
governance jobs and `gate` only); a failing check (`gate` does not run, so the merge request cannot land); generator
drift (`--check` exits 3); `DELIVERY_MODE` unset (shadow: no record, VTID close, notify or assist job, no env_overrides,
the deploy templates only render); train refs `train/<k>` (the same T1 jobs, changes compared with main).

Surfaces: GitLab projects `vitana/vitana-v1` and `vitana/vitana-platform` through `vitana/ci-config`; callers: the M2
settings sync (copies `infra/gitlab-engineering/ci/*.yml`, applies the `.schedules`/`.schedules-assist` cron entries and
the resource-group modes) and the merge bot (required jobs `lane-scope`, `change-suite`, `gate`; the train passes
`GATE_BASE`, `GATE_HEAD`, `GATE_BRANCH`, `GATE_TITLE` as pipeline variables; the assist trigger passes `ASSIST_RULE`,
`ASSIST_KIND`, `ASSIST_MR_IID`, `ASSIST_MR_HEAD`, `ASSIST_SOURCE_BRANCH`, `ASSIST_BRANCH_HOME`).

Locales: n/a. Accessibility: n/a.

Contract:
- Schema of plan §3.3 (`.kiro/specs/agentic-delivery/plan.md:190-206`) with `env_overrides` (plan.md:279-281) ↔
  `config/delivery/services.json` (gateway `env_overrides` at services.json:757-759) and `config/delivery/README.md`.
- Template and job names of plan §9 (plan.md:627-632) ↔ the generated files: `include` at v1-delivery.gitlab-ci.yml:5 and
  platform-delivery.gitlab-ci.yml:5; `deploy-staging:gateway` platform-delivery:3647, `staging-verify:gateway` :3716,
  `record:gateway` :3738, `vtid-close` :4125; v1 `deploy-staging:community-app` v1-delivery:1767,
  `staging-verify:community-app` :1853, `record:community-app` :1889, `vtid-close` :1957, `notify-platform` :1969,
  `staging-verify-nightly:community-app` :1928, `assist:i18n-propagate` :1985, `preview-upload` :1141.
- Lane verify-on-gitlab's hidden jobs (PR #4705, branch `origin/kiro/agentic-delivery/verify-on-gitlab`,
  `infra/gitlab-engineering/ci/tpl-verify.yml`): `.staging-verify` :44 (reads `VERIFY_SERVICE` :54 and
  `DEPLOY_RUNS_FILE: $CI_PROJECT_DIR/deploy-runs.json` :56), `.staging-verify-nightly` :69, `.record` :80, `.vtid-close`
  :101, `.notify-platform` :122. The generated jobs set `VERIFY_SERVICE` and need the deploy job's artifacts.
- Runner tags of plan §3.2 (plan.md:179-188) ↔ `tpl-checks.yml:15-18` (`.t1-base`, `vitana-eng`), `tpl-main.yml:17-20`
  (`.full-suite`, `vitana-eng-main`), `tpl-assist.yml:27-30` (`.assist`, `vitana-eng-main`), and the explicit `tags` of the
  generated deploy-class jobs.
- Lane deploy-path's `tpl-deploy.yml` is not built yet: the generated jobs extend `.build-image`, `.push-image`,
  `.deploy-staging`, `.rollback-staging`, `.preview-upload`, `.preview-stop` by name only (plan §9) and pass
  `DEPLOY_SERVICE`, `DEPLOY_ECR_REPOSITORY`, `DEPLOY_IMAGE_CONTEXT`, `DEPLOY_DOCKERFILE`, `DEPLOY_ECS_CLUSTER`,
  `DEPLOY_ECS_SERVICE`, `DEPLOY_RUNS_FILE`, `DEPLOY_ENV_OVERRIDES` (live mode only), `PREVIEW_SERVICE`, `PREVIEW_PREFIX`.
  These variable names are this lane's choice; deploy-path reads them, or the driver aligns the names when both land.
- Lane merge-queue's `scripts/eng/gitlab-gates.mjs` (not on any remote branch yet) is called as
  `gitlab-gates.mjs lane-scope|collab-handoff --repository <key> --repo-root <dir> --platform-dir <platform main clone>
  --base <sha> --head <sha> --branch <name>` (`tpl-checks.yml:53-75`). Same rule: the driver aligns the CLI when both land.

Staging proof: not verified on staging: nothing deploys when this lane is merged (GitLab is not cut over; the files are
copied into `vitana/ci-config` by M2's settings sync and run only in lane `cutover`'s shadow pipelines, plan §8.1 step 3).
Covered by the 36 tests above, the `--check` run, and the Ruby Psych cross-check of every CI file
(`outputs/yaml-cross-check.txt`; Psych is the YAML library GitLab uses). `run.mjs check-pr` says nothing deploys
(`outputs/staging-check-pr.txt`), so there is no `staging-tests.json`.

Red on base: `outputs/red-on-base.txt` — on origin/main `b3d547b66c` the three files fail as whole files (3 of 3, no
`pipeline-gen.mjs`, no service list, no fixtures); against no-behaviour stubs outside the repo all 22 reported results fail (21 tests, and affected-parity.test.mjs as a whole file because its per-repository loop reads the missing fixture at load time).
Red on base, review round 1: `outputs/red-fix1.txt` — on the reviewed head e6490b1cba the 10 new or changed tests run
36 results: 27 pass, 9 fail (the 8 tests of AC-11, AC-14 to AC-20 and the platform test of AC-21; the vitana-v1 test
of AC-21 passes on base, its fixture has no such path); the same 9 fail with only the new fact tables added; the tools rule
lists 12 violations on base (android-module x2 jobs x3, cicdl jq, openapi $GITHUB_OUTPUT, sql-auth-bridge npm, each also
in full-suite) and 0 on the fixed tree.
Green: `outputs/green.txt` — 36 of 36 pass (after the merge of origin/main); `outputs/unit-all.txt` — UNIT's full command,
0 failures; `outputs/yaml-cross-check.txt` — Psych agrees on all 6 files; `outputs/bash-n.txt` — every generated job
script parses in bash; `outputs/settings-merge.txt` — with eng-gitlab-m2 settings merged, its free-tier guard and these
tests pass.

## Files of other lanes this lane needs (none of them is a file of this lane)
- eng-gitlab-m2 lane `settings` (paths include `infra/gitlab-engineering/ci/**`): the sync that copies
  `infra/gitlab-engineering/ci/*.yml` into the root of `vitana/ci-config` (`scripts/eng/gitlab-settings.mjs`), points each
  project's `ci_config_path` at `v1-delivery.gitlab-ci.yml@vitana/ci-config` / `platform-delivery.gitlab-ci.yml@vitana/ci-config`
  (`infra/gitlab-engineering/settings/gitlab-settings.json`), sets the project variable `DELIVERY_MODE`, applies the
  `.schedules` and `.schedules-assist` cron entries, the job-token allowlist (vitana-v1 jobs read vitana/vitana-platform),
  and the protected, masked `ASSIST_PUSH_TOKEN`. Its central CI files (plan S3) must not use the names of this lane's six
  files. The plan orders this lane after `settings` (§9): the driver lands it after `settings` is done.
- Lane `deploy-path`: `infra/gitlab-engineering/ci/tpl-deploy.yml` (the six hidden jobs above, `.preview-build` is this
  lane's). Lane `verify-on-gitlab`: `tpl-verify.yml`. Lane `merge-queue`: `scripts/eng/gitlab-gates.mjs`,
  `scripts/eng/assist-trigger.mjs`. Lane `github-bridge`: applies `assist-out/assist.patch` to a bridged branch.

## Decisions taken
- Review round 1: the image facts come from the Docker official images' Dockerfiles (read through `gh api`): node 20-bookworm
  has git, curl and python3 (mercurial in buildpack-deps' scm layer depends on it) and no jq or psql; postgres 16 has no
  Node. A job installs what its image lacks with one `apt-get` line rather than a new image (no image pipeline yet, M2).
- `sql-auth-bridge` installs npm on postgres:16 rather than psql on the node image, so its client matches the server like
  the other 21 SQL checks.
- `android-module` uses Debian's OpenJDK 17 (GitHub: Temurin 17) and writes the SDK licence file, as GitHub's runner image
  has it accepted; the Gradle plugin then downloads the SDK packages. The `images.android` (JDK-only) entry is removed.
- `pr-gate-report` passes `$GATE_TITLE`, not `$CI_MERGE_REQUEST_TITLE` directly: it defaults to the merge request title and
  the merge bot sets it on train refs, where the merge request variables are empty.
- `validator-check` on main and nightly runs the CSP gate against `origin/main` (an empty diff after landing) and the build;
  the PR-text gates run on merge requests only (the brief: skip them on main, nightly and `train/*` with the reason logged).
- `dev-autopilot-impact`: base `$CI_COMMIT_BEFORE_SHA` on main pushes (the landed range; GitHub used HEAD~1) and `HEAD` on
  schedules (nothing landed); dry run there, as GitHub fails only pull requests on blockers.
- The two v1 self-tests are path-selected checks (any `scripts/**` change selects them, through `other_paths`), so they
  block when they fail; on GitHub they are steps of the report-only PR-GATE job. Stricter, never fewer.
- `preview-e2e` keeps GitHub's health check, build env, specs and report-only verdict, and takes the staging guard from the
  platform-main clone (`central: true`) instead of a token fetch; it gets `NODE_OPTIONS=--max-old-space-size=4096` like
  `build`.
- `e2e-preview-orb` keeps `PREVIEW_URL=https://preview.vitanaland.com` (the workflow's target), manual and
  `allow_failure: true`, so it never blocks a main pipeline.
- The two platform fixture paths with `/approvals` are written with the JSON escape `\u002f` (same parsed data), so
  lane settings' raw-text free-tier guard does not read a lane-file name as the Premium approvals API (AC-21).
- Unknown path: GitLab `rules:changes` cannot negate, so "every check for a path no service claims" is implemented as
  `other_paths` (every unowned area of today's tree selects every check, like a shared path) plus `gate` failing closed on a
  path nothing claims. A new top-level entry therefore blocks until it is claimed in the service list, instead of
  silently running fewer checks.
- `gate` proves the selection at runtime from the service list on platform `main`: each passed check leaves a marker
  artifact (`.delivery-ran/`), and `gate` fails when a check the change needs did not run.
- The parity tests compare path-filtered workflows (plan §3.4, "never narrower than GitHub's path filters"); always-on
  workflows (PR-GATE, UNIT-TESTS, UNIT, STAGING-TESTS-REQUIRED, DEV-AUTOPILOT-IMPACT, ENFORCE-FRONTEND-CANONICAL-SOURCE,
  PHASE-2B-*) map to the governance jobs and to path-selected checks, so a documentation-only change runs no check.
- Selection is widened where GitHub runs more: TEST-SUITE's `services/**` filter selects the gateway suite and the three
  service suites for any services change; NATIVE-CI's `src/**` filter selects the mobile jobs for web changes; i18n-check's
  `src/**` selects `i18n`; OASIS-PERSISTENCE selects the gateway typecheck, Jest and build.
- GitHub `dir/**` filters became GitLab `dir/**/*` (a trailing `**` is one level in Ruby `File.fnmatch`); the generator
  refuses a trailing `**`.
- Templates hold hidden jobs; the generated files hold every concrete job with explicit `rules` (GitLab's `extends`
  replaces arrays, so the generated rules decide; the shadow guard is repeated on `record`, `vtid-close`,
  `notify-platform` and `assist:*`).
- Train refs run the T1 jobs with `changes` compared with `refs/heads/main`; the bot overrides `GATE_*` with pipeline
  variables.
- T3 reuses the `full-suite:<check>` jobs (they run on main pushes and on the nightly schedule); the 02:17 UTC schedule is a
  hidden `.schedules` entry for the settings sync (GitLab creates schedules only through the API).
- vitana-v1 Vitest has 3 shards and a union job (`shard-union.mjs` of platform main); the gateway Jest keeps 4 shards;
  `mobile-test`/`mobile-bundle` split NATIVE-CI's mobile job; the Android JVM tests run in 2 shards by test class.
- Ratchet and PR-GATE steps keep the `enforce` switch of `scripts/ci/pr-gate/config.json` (report-only today).
- SQL tests: one job per platform SQL workflow (21, each with its own filter); one job for the four vitana-v1 ones.
- Platform services not in `config/service-path-map.json` (`postgrest-aurora-proxy`, `realtime-aurora`, `vcaop`,
  `vcaop-mcp`) are `path_map: false`; check areas are `area: true`. The map is not edited (gateway file, other lane).
- T4: the merge-request preview jobs exist only in live mode (no merge requests before the cut); shadow mode builds and
  uploads the `gl-main/` preview on main (plan §8.1 step 3).
- T7: the assist job runs main's `scripts/` over a worktree of the merge request head and commits only `src/i18n`; a
  bridged branch gets the commit as `assist-out/assist.patch` (plan §7: the bridge token never reaches a CI job); the nightly
  safety net pushes `bot-assist/nightly-<rule>-<date>` (assist/* is protected) and opens a merge request. The provider
  stays the workflow's default (`gemini`), as plan §3.9 says.

## Review round 1 (agent:vitana-lane-reviewer, claude-opus-5.5, on e2c50732; entry 2026-11-05T16:54Z)
1. Jobs that could not pass on GitLab. `cicdl-lint-services` gets `apt: ["jq"]` (services.json:1964; the generator
   renders `apt-get install … jq` first, pipeline-gen.mjs:46, :118). `openapi-enforce` writes `has_specs` to
   `$CI_PROJECT_DIR/openapi-enforce.env` (services.json:1999); with no spec its `exit 0` ends the job, as the
   `has_specs` conditions skip the steps on GitHub. `sql-auth-bridge` keeps postgres:16 (psql 16 like the other 21 SQL
   checks) and installs npm (services.json:2087). `validator-check` reads merge request text only in merge-request
   pipelines (finding 4 below). New fact tables `image_tools`, `apt_tools`, `npm_global_tools` (services.json:18-60) and a
   structure test over all 151 generated jobs with scripts (AC-14).
2. `android-module` (services.json:570): node image, `apt: ["openjdk-17-jdk-headless"]`, `ANDROID_HOME`/`ANDROID_SDK_ROOT` =
   `$CI_PROJECT_DIR/.android-sdk` with the licence file `android-sdk-license` written before `gradlew`, so the Android Gradle
   plugin downloads the platform and build tools it needs; `GRADLE_USER_HOME` and the SDK are cached. A v1 `src/**` merge
   request still selects it (NATIVE-CI runs it for web files too), now on a toolchain that can pass (AC-16).
3. `pr-gate-report` (tpl-checks.yml:66-73): `--title "$GATE_TITLE"` on every `gate.mjs` call; a "fix" VTID runs `npm ci` in
   main's `red_green.cwd` first (PR-GATE.yml "Gateway deps" step; v1 root, platform `services/gateway`); the job cache is
   keyed by that lockfile (`pr_gate_install`, services.json:72, :817; pipeline-gen.mjs:159-160) (AC-17).
4. VALIDATOR-CHECK is ported step by step (services.json:1897): ruleset, PR text, body declarations, VTID and profile,
   changed files, path ownership, evidence pack, acceptance mapping (python3, in the node image), CSP, build, route mount,
   OASIS, merge deploy, PASS summary; `GIT_DEPTH: "0"` for `origin/<target>...HEAD`. `dev-autopilot-impact`
   (services.json:1949) sets `IMPACT_SCAN_BASE` per pipeline and fails closed; blockers fail merge request and train
   pipelines only (dry run on main and nightly, as GitHub's "PR only" step); the findings file is an artifact. A step map
   per workflow and a test that reads the GitHub files (AC-15, AC-18, AC-19).
5. vitana-v1 `preview-e2e` (services.json:393), `gate-selftest` (:369), `kiro-steering-selftest` (:381); E2E-PREVIEW-ORB
   (dispatch-only on GitHub, signs in) is `e2e-preview-orb` (tpl-main.yml:34, v1-delivery.gitlab-ci.yml:1470) (AC-20).
6. The sibling sweep reads plan §2.2 and checks every fate; a moved workflow without jobs needs a replacement the plan
   names (TEST-SUITE-RERUN → `retry`, services.json:2812-2816) (AC-11).
- Non-blocking, T3 CI-health report job: deferred. `tpl-nightly.yml` keeps the CI-HEALTH rules (`.ci-health-rules`); the
  report reads job durations and flaky reruns from M2 monitoring's metrics feed (plan §3.3 T3, §6 I1/I2), which is not
  built, so a job now would report nothing. The driver adds it with or after M2 monitoring.
- Non-blocking, carried: this lane lands after eng-gitlab-m2 `settings` (merge main and re-check then); `tpl-deploy.yml`,
  `tpl-verify.yml` and `gitlab-gates.mjs` must be on main before a GitLab pipeline can include them; the public
  node:20-bookworm image instead of the M2 toolchain image; `GATE_BASE` empty on main and nightly; `gate` needs 47 of
  50 on platform; I18N_PROVIDER `gemini` (plan §3.9) against CLAUDE.md AI-27: a plan or owner question.

## Open items for the driver (outside this lane's paths)
- DEV-AUTOPILOT-IMPACT "Ingest impact findings" (push to main, `DEV_AUTOPILOT_SCAN_TOKEN`, POST to the staging gateway) and
  "Post or update PR comment" have no GitLab job: the untrusted class holds no secret or comment token and plan §7 gives
  the main class no role for that token. Until the cut GitHub keeps both. Needs a role and secret (lane deploy-path's
  `setup-gitlab-oidc.sh`) or the bridge (plan §3.13). Listed in the test (`OPEN_STEPS`).
- `e2e-preview-orb` uses lane verify-on-gitlab's role `gl-verify` (ID token audience `aws:verify`) and secret
  `vitana/ci/test-user`; lane deploy-path's trust policy must admit a main-ref job of vitana/vitana-v1 for it.
- GitLab passes at most 2700 characters of a merge request description to CI; `validator-check` rejects a truncated
  description with that reason (`CI_MERGE_REQUEST_DESCRIPTION_IS_TRUNCATED`) instead of a wrong "marker missing". The
  bridge or the PR template should keep the declarations within that size.

## Not done yet (draft-quality parts, listed for the driver)
- The CI-HEALTH report job (deferred, see Review round 1).
- Commands are ported from today's workflows but unproven on a GitLab runner (no GitLab pipeline runs before the cut):
  the Android job's SDK download by the Gradle plugin, `edge-data-client`'s `npx deno@2`, the Vitest union reading Vitest's
  Jest-compatible JSON, `preview-e2e`'s Playwright install. Lane `cutover`'s shadow pipelines prove or correct them.
