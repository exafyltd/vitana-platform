# Design — ci-ecr-public-auth

## What exists (read these, do not copy them)
- Dockerfiles on the mirror (VTID-05017): platform `services/gateway/Dockerfile:1,12`,
  `services/gateway/Dockerfile.job:22,33`, `services/gateway/Dockerfile.auto-logger:1,15`,
  `services/kiro-runner/Dockerfile:10,18,29`; v1 `Dockerfile:7,20`.
- The VTID-05017 source-check test: platform `services/gateway/test/vtid-05017-base-images-ecr-public.test.ts`
  (globs Dockerfiles, checks every `FROM`). Its plan deferred authenticated pulls:
  `docs/validation/VTID-05017/plan-sparring.md:29-30`.
- Workflow steps (line numbers in `plan.md` premise 2): every affected job already has
  `aws-actions/configure-aws-credentials@v4` + `aws-actions/amazon-ecr-login@v2` (private ECR, eu-central-1),
  except the kiro-runner `build` job (`AWS-STAGE-DEPLOY-KIRO-RUNNER.yml:73-89`).
- v1 workflow-test pattern: `src/lib/deploy-workflow.vtid-04908.test.ts` (Vitest, `src/**/*.test.ts` per
  `vitest.config.ts`).
- IAM check pattern: `scripts/aws/iam/vtid-05023-iam-check.sh` (account guard, `simulate-principal-policy`, prints
  what is missing, changes nothing). Deploy role policy reference: `scripts/aws/iam/vtid-05023-deploy-role-policy.json:115-120`.

## Decisions
- **Login step, not a pull-through cache or a private mirror.** It needs no new AWS resources and no Dockerfile
  change. Every affected job already holds AWS credentials. A pull-through cache is the follow-up only if 429s
  persist with `authenticated` in the log.
- **Inline step, not a composite action.** Six insertions across two repos, with identical text. The guard test
  pins the text, which stops drift without adding `.github/actions/**` files in both repos.
- **Fail-soft.** The worst case equals today's anonymous pull. Failing hard would turn an IAM gap or a us-east-1
  outage into a red deploy, including a production rebuild/rollback. Loud: `::warning` + step summary. The lane
  log records the first `authenticated` run after the IAM change.
- **`--region us-east-1` hard-coded.** ECR Public auth exists only there. The rest of the job keeps
  `TARGET_AWS_REGION`.
- **Prod gateway step uses the build step's `if:`** (`rebuild-main` only). promote-staging and env-only never build,
  so they need no login.
- **kiro-runner `build` job: credentials only off `pull_request`.** No AWS secret reaches a job that builds
  unmerged PR code. PR builds stay anonymous (fail-soft path not even entered: the step is skipped).
- **IAM: inline least-privilege policy, applied by a human.** Two actions, the STS one conditioned on
  `sts:AWSServiceName`. Same file for the staging user (`put-user-policy`) and the prod OIDC role
  (`put-role-policy`). The check script prints both commands. Kiro and CI never run them (§7a).
- **One lane per repo, `executor: claude`.** `.github/**` is a governance path. The `AWS-PROD-*.yml` hunks are
  protected gate files and need a legacy Claude review or the owner's instruction.

## Step (identical in all six places; the kiro-runner `build` copy adds the `if:`)
```yaml
      - name: Login to Amazon ECR Public (authenticated base-image pulls)
        run: |
          if PW="$(aws ecr-public get-login-password --region us-east-1 2>/tmp/ecr-public.err)" \
             && printf '%s' "$PW" | docker login --username AWS --password-stdin public.ecr.aws >/dev/null 2>>/tmp/ecr-public.err; then
            echo "ecr-public-login: authenticated"
          else
            echo "::warning title=ECR Public login failed::anonymous public.ecr.aws pulls (429 risk): $(head -c 300 /tmp/ecr-public.err | tr '\n' ' ')"
            echo "### ECR Public login failed: anonymous base-image pulls (429 risk)" >> "$GITHUB_STEP_SUMMARY"
          fi
          unset PW
```

## Guard (both repos)
```
for wf in .github/workflows/AWS-*-DEPLOY-*.yml:
  for job in jobs:   # platform: js-yaml jobs.<id>.steps; v1 (no yaml dep): split text by "^  <id>:$" / "^      - name:"
    builds = steps whose run contains "docker build"
    for each build: dockerfile = -f <file> | <context>/Dockerfile (honour a leading `cd <dir>`)
    if no dockerfile has a FROM public.ecr.aws/ line: skip job
    login = first step whose run has "aws ecr-public get-login-password --region us-east-1" and "public.ecr.aws"
    assert login exists, index(login) < index(first build), index(login) > index(configure-aws-credentials, if any)
    assert login.run contains "else" and "::warning"
assert checked_jobs >= expected   # platform: 4 build jobs; v1: stage + prod build-push-deploy
```
