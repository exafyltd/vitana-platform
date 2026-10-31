---
change_class: standard
---
# plan(ci-dockerhub-mirror): PR CI pulls its Postgres service image from Docker Hub, not the capped ECR Public mirror
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202610311247-830c` (Kiro IDE, workflow `wf_df00c2efa5289a76`,
owner backlog-cleanup task 2026-10-28). Code repo: `exafyltd/vitana-v1`; the spec lives in vitana-platform because
PLAN-SPAR only runs here (pattern of `.kiro/specs/fix-deeplink-scroll-test`). Premises pinned to vitana-v1
`origin/main` `847a9f686` and vitana-platform `origin/main` `a8d36bad3b`. Detail: `tasks.md`; lane file under `lanes/`.
<!-- plan:begin -->
## Goal
vitana-v1 `pr-gate` (`.github/workflows/PR-GATE.yml`) fails at `Initialize containers` because its `services:`
Postgres image cannot be pulled. Make the pull reliable with the same image and tag, no credentials, no secrets and no
change to what the job tests. Follow-up to `ci-ecr-public-auth` (VTID-05329), which left service containers out of
scope (its plan, premise 4).
## Today (evidence, read-only)
1. **The failing pull is ECR Public, not Docker Hub.** The task that started this plan assumed v1 pulls from Docker
   Hub. It does not: v1 moved every PR CI service image to `public.ecr.aws/docker/library/postgres:16` on 2026-10-09
   (VTID-05015 `ca550b0e0` for `PR-GATE.yml:36`; VTID-05016 for the four `SQL-*.yml`). The failure is that mirror's
   anonymous data cap. vitana-v1 run 41200356754 attempt 1, job 124534769161 (`pr-gate`, 2026-10-31T12:18Z):
   `docker pull public.ecr.aws/docker/library/postgres:16` → `Error response from daemon: error from registry: Data
   limit exceeded`, three tries, `##[error]Docker pull failed`. Attempt 2 (12:39Z) got past `Initialize containers`:
   the cap trips intermittently on the shared runner IPs. Anonymous ECR Public pulls are capped at 500 GB/month per
   source IP (the same cap `ci-ecr-public-auth` names for the image builds).
2. **Docker Hub works for hosted-runner service containers.** GitHub's docs state that GitHub-hosted runners are not
   subject to Docker Hub's pull rate limits, by agreement between GitHub and Docker. vitana-platform pulls the same
   official image from Docker Hub as `postgres:16` in every PR service container (`CICDL-GATEWAY-CI.yml:39`,
   `AURORA-I18N-INTEGRATION.yml:33`, 26 `SQL-*.yml`), and the last 20 `CICDL-GATEWAY-CI.yml` runs (2026-10-28T14:05Z
   to 2026-10-31T12:31Z) all succeeded, including 12:16Z and 12:31Z today, in the same window in which v1 hit the
   ECR Public cap.
3. **The 2026-10-09 Docker Hub failure was an outage.** VTID-05015's commit names the Docker Hub 429 on the
   production rollback *image builds* and then an `auth.docker.io` outage (504/timeouts). Platform service containers
   have pulled from Docker Hub without a repeat since.
4. **Every image reference in v1 PR CI** (`git grep -nE "image:|docker (run|pull)|container:|uses: docker://"
   origin/main -- .github/workflows`): only the five `services:` images below. No `container:` job, no `docker
   run`/`docker pull`, no `uses: docker://` step. All five run on `ubuntu-latest` (GitHub-hosted) and are triggered
   by `pull_request`:
   - `PR-GATE.yml:36` (service `pg`)
   - `SQL-CALENDAR-ENTRY-SHARE.yml:28`, `SQL-EVENT-SHARE-POSTS.yml:27`, `SQL-GROUP-PARTICIPANTS.yml:26`,
     `SQL-THREAD-JOIN-HARDENING.yml:27` (service `postgres`)
5. **vitana-platform PR CI needs no change.** Its service images are Docker Hub `postgres:16` (premise 2). Its only
   `docker run` (`AWS-STAGE-DEPLOY-KIRO-RUNNER.yml:83`) runs the locally built `kiro-runner:ci`, no pull. Dockerfile
   base images and deploy builds are out of scope.
6. **Protected gate file.** `.github/workflows/PR-GATE.yml` matches a glob in `scripts/collab/protected-gate-files.json`
   (vitana-platform). `queue.mjs` lane validation (the `globTouchesProtected(g)` check: "such a lane needs
   executor: claude") and Lane scope (`scopeCheck`, the `matchesAny(f, PROTECTED_GATE_PATHS)` branch after
   `fm.executor === 'claude'`) refuse a protected gate file for a non-`claude` lane, so the lane is `executor: claude`; while Claude is unavailable it goes to the exceptions seat
   `exafyltd` (collaboration §7). Its merge follows §3a/§7b for a protected gate file (the owner's
   instruction naming this plan). The four `SQL-*.yml` files are governance paths but not protected.
## Change (lane `v1-service-images`, vitana-v1)
1. In the five files of premise 4, change `image: public.ecr.aws/docker/library/postgres:16` to `image: postgres:16`
   (the same official image and tag, `docker.io/library/postgres:16`), and update the comment line above each so it
   names the reason: ECR Public's anonymous data cap failed pr-gate on 2026-10-31; GitHub-hosted runners are exempt
   from Docker Hub's pull limits; see this plan. `env`, `ports`, `options`, service names and every step stay
   byte-identical. The task suggested the opposite switch (Docker Hub → ECR Public); premise 1 shows v1 is already on
   ECR Public and that registry is the one failing.
2. Guard test `src/lib/pr-ci-service-images.test.ts` (Vitest, no new dependency, style of
   `src/lib/deploy-workflow.vtid-04908.test.ts`): `ROOT = join(__dirname, '..', '..')`; `readdirSync` every
   `.github/workflows/*.yml`; keep the files whose `on:` block names `pull_request`; collect each `image:` value that
   sits under a `services:` key or a `container:` key (indentation-based, plus the one-line `container: <image>` form).
   Assertions per image: it does not start with `public.ecr.aws/` (the anonymous-capped mirror); it carries an
   explicit tag (`:<tag>`, not `latest`). A sanity test asserts at least five images were found and that
   `PR-GATE.yml`'s `pg` image is among them, so an empty scan cannot pass. Red on `origin/main` (it names all five
   files), green on the lane head.
## Lanes
- `v1-service-images` (vitana-v1, `executor: claude`, seat `exafyltd`):
  changes 1 and 2, `docs/validation/<VTID>/**`. `depends_on: []`. Shares no file with the open `ci-ecr-public-auth`
  v1 lane (deploy workflows only).
## Out of scope
- Anything that deploys, Dockerfile base images, `AWS-PROD-*.yml`, and the `ci-ecr-public-auth` login steps.
- Authenticated ECR Public pulls for service containers (`services.<id>.credentials` with a token from an earlier
  job): needs AWS secrets in PR jobs and the IAM change of `ci-ecr-public-auth`; not needed given premise 2.
- A registry fallback (starting Postgres in a step with `docker pull` from two registries). Follow-up plan only if
  Docker Hub service pulls fail on hosted runners.
- vitana-platform workflow edits (premise 5).
## Test plan
- Lane: `npx vitest run src/lib/pr-ci-service-images.test.ts` fails on `origin/main` (five files named) and passes on
  the lane head; output in `docs/validation/<VTID>/red-on-base.txt` and `commands.log`. `npm run test:unit` stays green.
- CI proof: on the lane PR, `pr-gate` passes `Initialize containers` with `postgres:16` and the whole job is green
  (the migration dry run uses the service; semantics unchanged). Each of the four `SQL-*` workflows lists its own
  workflow file in its `pull_request.paths` filter, so all four run on the lane PR and must be green too.
- Staging (rule 47): `docs/validation/<VTID>/staging-tests.json`, `service: community-app`, one test
  `kind: "existing"`, `ref: "npx vitest run src/lib/pr-ci-service-images.test.ts"`, reason "CI-only change, the app
  bundle is unchanged". No suite targets production.
<!-- plan:end -->
