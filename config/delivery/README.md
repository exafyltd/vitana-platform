# config/delivery — the service list (VTID-05550, plan agentic-delivery §3.3)

`services.json` (schema `vitana.delivery-services/v1`) is the one list that drives both repositories' GitLab pipelines.
`scripts/eng/pipeline-gen.mjs` renders it into `infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml` and
`infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml`; M2's settings sync copies `infra/gitlab-engineering/ci/*.yml`
into `vitana/ci-config`, so a branch can never change the pipeline that judges it.

```
node scripts/eng/pipeline-gen.mjs          # render after editing services.json, then commit both files
node scripts/eng/pipeline-gen.mjs --check  # CI and preflight: exit 3 when a rendered file is stale
node --test scripts/eng/pipeline-gen.test.mjs scripts/eng/affected-parity.test.mjs scripts/eng/services-parity.test.mjs
```

## Top level
`images` (job images), `image_tools` (the tools on PATH of each image, from its Dockerfile), `apt_tools` and `npm_global_tools` (what an installed package adds). `pipeline-gen.test.mjs` checks that every generated job runs only tools its image has or an earlier line installs, and no GitHub Actions variable.

## Shape (per repository under `repositories.<key>`)
| Field | Meaning |
|---|---|
| `gitlab_project`, `github_repository`, `output`, `fixture` | where the pipeline runs, the GitHub twin, the rendered file, the PR-files fixture of the parity test |
| `services.<name>` | `paths` (GitLab `rules:changes` globs), `checks` (names in `checks`), `image` (`ecr_repository`, `context`, `dockerfile`), `staging` (`ecs_cluster`, `ecs_service`, `url`), `staging_verify` (the STAGING-VERIFY service id of `scripts/ci/staging-verify/lib.cjs`), `preview` (`spa` = the T4 merge-request preview), `env_overrides` (task-definition environment applied by `deploy-staging` in live mode only), `assist` (rule names). Platform services with `path_map: true` must equal `config/service-path-map.json`; `path_map: false` services and `area: true` entries are check areas the map does not list. |
| `shared_paths` | lockfiles and toolchain config: a change selects every check |
| `other_paths` | areas no single service owns (root config files, tools, content of unknown use): a change selects every check |
| `docs_paths` | documentation and inert files (GitHub workflow files are inert on GitLab): no check; governance and `gate` only |
| `checks.<name>` | `kind` (`test`, `check`, `build`), `script`, `apt` (Debian packages of `apt_tools`, installed by the first script line), `install` (a key of `install`: lockfile-keyed cache plus install lines), `install_cache`, `cache_paths` (more cached paths), `parallel` (shards), `needs`, `central` (needs the platform-main tools), `postgres`, `image`, `artifacts`, `duration` (the GitHub job in the fixture whose median duration, divided by the shards, must stay under `max_check_minutes`) |
| `assist_rules.<rule>` | T7: `trigger` (`merge_request` or `schedule`), `paths`, `script` (runs in a worktree of the merge request head with main's `scripts/`; ends with `assist_finish`) |
| `pr_gate_install` | the `install` whose lockfile keys the `pr-gate-report` cache; red-green installs it for a "fix" VTID |
| `notify_platform_paths` | vitana-v1: the paths whose landing starts the platform's screens-catalog pipeline |
| `github_workflows.<file>` | each GitHub workflow's fate at the cut (plan §2.2: `t1`…`t7`, `kept`, `dead`), the GitLab jobs that take its work, and whether it had a pull-request path filter (the parity tests compare only path-filtered workflows; always-on ones map to the governance jobs and the service checks, plan §3.4); `steps` maps each `run` step of the multi-gate workflows to its GitLab job(s) (or `{ "open": reason }`, an item for the driver); `replaced_by` names what plan §2.2 puts in place of a moved workflow that keeps no job (`retry`) |

## Selection rules (GitLab semantics)
- Globs follow GitLab `rules:changes` (Ruby `File.fnmatch` with `FNM_PATHNAME | FNM_DOTMATCH | FNM_EXTGLOB`): write
  `dir/**/*` for "everything below dir" (a trailing `**` matches one level only); `{a,b}` and dotfiles work.
- A check job's patterns are the paths of every service that lists it plus `shared_paths` and `other_paths`, at most 50
  (GitLab's limit per rule), compared with `refs/heads/main`.
- GitLab `rules:changes` has no negation, so a path that no pattern lists cannot select a job. `gate` therefore fails
  and names any changed file that no service, `shared_paths`, `other_paths` or `docs_paths` entry claims: add it here.
- `config/service-path-map.json` stays the map the gateway reads (`routes/cicd.ts:111`). These platform services are not in
  it and are listed here with `path_map: false`: `postgrest-aurora-proxy` (a staging deploy target of plan §3.10),
  `realtime-aurora`, `vcaop`, `vcaop-mcp`. Adding them to the map is a gateway change outside this lane.
