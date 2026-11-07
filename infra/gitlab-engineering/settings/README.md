# GitLab settings as code (plan eng-gitlab-m2, section 3.3)

`gitlab-settings.json` is the **single source of truth** for who may do what in the self-hosted GitLab. `scripts/eng/gitlab-settings.mjs`
reads GitLab, compares it with this file and corrects what differs, every 10 minutes (systemd timer on the GitLab host). A setting changed
by hand in GitLab is reported by `check` and put back by the next `apply`. To change a setting, change the file (see "How to change a
setting"), never GitLab.

Everything here is Free tier. No licence, no seat. The sync stops with a loud message if `GET /license` ever returns a licence (acceptance A7).

## Running it

```
node scripts/eng/gitlab-settings.mjs [apply|check] [--config FILE] [--ci-dir DIR] [--url URL] [--admin-token-file FILE] [--dry-run]
```

| Command | What it does | Exit |
|---|---|---|
| `apply` (default) | Corrects GitLab to match the file. A second run makes no write. `--dry-run` prints what it would do and writes nothing. | 0 done, 1 error |
| `check` (also `--check`) | Writes nothing. Prints the drift. | 0 no drift, exit 3 drift, 1 error |
| usage mistake | unknown option or command, missing value, REGION not set | 2 |

Defaults: `--config` is this folder's `gitlab-settings.json`, `--ci-dir` is `infra/gitlab-engineering/ci`, `--url` is `http://127.0.0.1` (the
GitLab host talks to itself), `--admin-token-file` is `/etc/vitana/settings-admin-token`. `REGION` and `DOMAIN` come from `/etc/vitana/env`.

The run reads everything first (GitLab, Secrets Manager, the files), then writes. If anything cannot be read, nothing is written and the exit
code is 1; the next run starts again. Every write is sent once, never retried by the client.

## The file (schema version 1)

Every key below is checked; an error names the key, for example `accounts[2].role`.

| Key | Meaning |
|---|---|
| `schema_version` | Must be `1`. |
| `gitlab_url` | The external URL of GitLab (https). Used only to warn when it differs from the host's `DOMAIN`. |
| `group` | The GitLab group that holds the projects (`vitana`). Milestone 1 creates it. |
| `owners` | Usernames of the people who own the system (default `["root"]` until the owner names their account). They are made Maintainer of existing projects and are the only people besides `bot-land` who may hold Maintainer on a `native` project. |
| `tokens` | Token policy of all service accounts and of the sync's own token: |
| `lifetime_days` | New tokens expire after this many days (at most 90: acceptance A3). |
| `rotate_below_days` | A token with fewer days left is rotated (30). |
| `runners` | The two instance runners the sync manages, by description: |
| `legacy` | Milestone 1's persistent runner `vitana-eng-1`. |
| `fleet` | The autoscaling fleet runner `vitana-eng-fleet`. The sync creates it and stores its token in `vitana/engineering/gitlab/fleet-runner-token`. |
| `description` | The runner's description (how the sync finds it). |
| `tags` | The runner's tags. The legacy runner is retagged `vitana-legacy` so no pipeline selects it; the fleet carries `vitana-eng`, the tag of the central CI. They must not overlap. |
| `paused` | Legacy runner only. Set `true` after acceptance A1. |
| `projects` | One entry per project, by path in the group. |
| `profile` | `mirror` or `native` (below). |
| `landing` | `true` when the merge bot lands merge requests there (native only). Read by `gitlab-land.mjs`. |
| `rehearsal` | `true` for the scratch project of the rehearsal (native, no webhook). |
| `required_jobs` | Job names that must be green before the bot lands a merge request. Read by `gitlab-land.mjs`. They must be names of jobs in the project's central CI file. |
| `ci_file` | The file in `vitana/ci-config` that is the project's pipeline (`ci_config_path` becomes `<file>@<group>/ci-config:main`). Left alone while the file exists neither in the CI folder nor in ci-config. |
| `webhook` | Optional. `url` (https) and `events` (`merge_request`, `pipeline`). Needs the signing token in `vitana/engineering/gitlab/webhook-signing-token`. Not set at the start: the gateway route goes live at cutover. |
| `url` | The webhook URL. |
| `events` | Which events GitLab sends. All others are switched off. |
| `accounts` | The service accounts, one per seat or bot (not per session). |
| `username` | The account name (lower case). Created if missing; a name held by a person is an error. |
| `name` | Display name. |
| `role` | `reporter`, `developer` or `maintainer` (project role). |
| `projects` | The projects the account is a member of with that role. Members of the managed accounts that the file does not list are removed; other people are never touched. |
| `scopes` | Token scopes: `api`, `read_api`, `read_repository`, `write_repository`. Default by role. |
| `token_file` | Optional. A file under `/etc/vitana/` that also receives the token (mode 0600), for `bot-land` and `bot-metrics`. |

Every account that can push or merge (developer, maintainer) is also made Reporter of `vitana/ci-config`: a pipeline reads its central
configuration with the rights of the user who triggers it. This is derived, not written in the file.

## Profiles

| | `mirror` (M1's behaviour) | `native` |
|---|---|---|
| Protected branch `main`: push | Maintainers | **No one** |
| merge | Maintainers | Maintainers |
| force push | allowed | **off** |
| Merge method | not managed | fast-forward (`ff`) |
| Squash | not managed | always |
| Pipelines must succeed / discussions resolved | not managed | yes / yes |
| Source branch removed after merge | not managed | yes |
| Automatic rebase | not managed | off |
| Squash and merge message template | not managed | `%{title}` (the VTID in the title reaches `main`) |

On the Free tier the access levels of a protected branch can only be set when it is created, so a changed level is repaired by removing and
protecting `main` again within the same second; if the second step fails it is tried once more and the run reports `UNPROTECTED`.

## What the sync creates and keeps

* **Service accounts** (`POST /service_accounts`): at most 100 per instance on the Free tier; the sync reports from 80.
* **Tokens**: one per account, named `vitana-settings`, 90 days, stored in `vitana/engineering/gitlab/agents/<username>`; `bot-land` and
  `bot-metrics` also in `/etc/vitana/bot-land-token` and `/etc/vitana/bot-metrics-token`. A token with fewer than 30 days left, or whose secret is lost, is
  rotated (`POST /personal_access_tokens/:id/rotate`). A changed scope list creates a new token and revokes the old one after the new one is stored.
  Other active tokens of the managed accounts are revoked when they have no expiry or one longer than the lifetime.
* **The sync's own admin token** in `/etc/vitana/settings-admin-token` (mode 0600, created once by `ops-install.sh` with `gitlab-rails runner`). With
  fewer than 10 days left the sync rotates it itself and rewrites the file atomically; it first checks the file can be written. If a rotation ever
  loses the new token (the file cannot be written after the call), the next run fails with 401: run `m2.sh install`, which mints a new one.
* **Fleet runner** `vitana-eng-fleet` (tag `vitana-eng`, not protected, no untagged jobs): created once; its token goes to
  `vitana/engineering/gitlab/fleet-runner-token`. If that secret holds no `glrt-` value the runner's token is reset and stored.
* **Legacy runner** `vitana-eng-1`: retagged `vitana-legacy` before any account token exists; paused when `runners.legacy.paused` is `true`.
* **Project webhooks**: one per project that has `webhook`, named `vitana-gateway`, with the HMAC signing token read from Secrets Manager. GitLab never
  returns the token, so the hook's description carries a fingerprint (12 hex characters of a SHA-256) to notice a rotated token. Hooks of other names are left alone.
* **Central CI**: every `*.yml` directly inside the CI folder is written to `vitana/ci-config`, branch `main`, under the same name, in one commit,
  only when the content differs. Files are never deleted.

Order of a run: licence guard, reads, admin token, legacy retag, accounts, ci-config files, projects (settings, protection, webhook), memberships,
fleet runner, and last the account tokens, so a protection and the retag exist before any credential does.

## Findings that need a person

`check` exits 3 and `apply` reports (exit 0) when the sync finds something it will not change by itself:

* a person with Maintainer (or Owner) on a `native` project who is neither in `owners` nor a `maintainer` account (a human Maintainer can bypass the bot);
* warnings: 80 or more service accounts, no legacy runner, a `ci_file` that exists nowhere, a webhook signing secret that is empty or malformed,
  an owner without an account, `gitlab_url` differing from `DOMAIN`.

## How to change a setting

1. Edit `gitlab-settings.json` in a pull request (a new seat is a new `accounts` entry; a project, a new `projects` entry).
2. After the merge to `main` the host's checkout is fast-forwarded within a minute and the next 10-minute run applies it. To apply at once: `m2.sh settings`.
3. `m2.sh status` runs `check`; it must exit 0.

Never change a setting in the GitLab UI: the next run reverts it, and `check` reports it before that.

## Secrets and files

| Where | What |
|---|---|
| `vitana/engineering/gitlab/agents/<username>` | the account's token (written by the sync) |
| `vitana/engineering/gitlab/fleet-runner-token` | the fleet runner's token (written by the sync; Terraform creates the empty secret) |
| `vitana/engineering/gitlab/webhook-signing-token` | `whsec_<base64 of 32 bytes>` (read only) |
| `/etc/vitana/settings-admin-token` | the sync's own admin token, root only, 0600 |
| `/etc/vitana/bot-land-token`, `/etc/vitana/bot-metrics-token` | tokens for the merge bot and the metrics job, 0600 |

Secrets are passed to the AWS CLI on standard input, never as an argument. No log line, error or output contains a token.

## Re-running the milestone 1 installer

`host/gitlab-configure.sh` of milestone 1 still writes `host/ci-platform.yml` and `host/ci-v1.yml` to `vitana/ci-config` under the names
`platform.gitlab-ci.yml` and `v1.gitlab-ci.yml`. Running it again puts those older texts back, until the next settings sync (within 10 minutes)
writes the files of `infra/gitlab-engineering/ci/` over them. Do not run it after `m2.sh install`.

## Free-tier endpoints used

All on GitLab documentation pages whose tier banner includes Free (checked 2026-11-05 against GitLab 19.x docs; the pinned instance is 19.5): `GET /license`; `GET|DELETE /personal_access_tokens/:id` (also `self`), `GET /personal_access_tokens`,
`POST /personal_access_tokens/:id/rotate`; `POST /users/:id/personal_access_tokens`; `GET /users?username=`; `GET|POST /service_accounts`; `GET /groups/:path`;
`GET|POST /projects`, `GET|PUT /projects/:id`; `GET|POST /projects/:id/protected_branches`, `PATCH` (force push only) and `DELETE /projects/:id/protected_branches/:name`;
`GET|POST /projects/:id/members`, `GET /projects/:id/members/all`, `PUT|DELETE /projects/:id/members/:user_id`; `GET|POST /projects/:id/hooks`,
`PUT|DELETE /projects/:id/hooks/:hook_id`; `GET /runners/all`, `GET|PUT /runners/:id`, `POST /user/runners`, `POST /runners/:id/reset_authentication_token`;
`GET /projects/:id/repository/files/:path`, `POST /projects/:id/repository/commits`. The list is repeated, with the documentation page of each, in
`scripts/eng/gitlab-settings.test.mjs`; the fake GitLab of the tests throws on any other call.
